/**
 * Installed fonts: discovery and per-character fallback.
 *
 * The first query builds a light index of every installed face (family,
 * style, file, collection index) by reading only each file's table
 * directory and its head, maxp, OS/2 and name tables. A face's cmap is read
 * the first time a query needs it, and a whole font is parsed only when it
 * is returned. Answers are cached per code-point block, so after the first
 * call a lookup is a map hit or a few binary searches.
 */

import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { type Cmap, parseCmap } from "./cmap.js";
import { FontError } from "./errors.js";
import { type Font, parseFont } from "./font.js";
import { Reader } from "./reader.js";
import { FLAVOR_OTTO, FLAVOR_TRUE, FLAVOR_TRUETYPE, TAG_TTCF } from "./sfnt.js";
import { NameTable, fontNames, fsTypeAllowsEmbedding, parseHead, parseMaxpNumGlyphs, parseOs2, styleFlags } from "./tables.js";

/** One installed face, as indexed (no glyph data loaded). */
export interface SystemFontFace {
  readonly file: string;
  readonly index: number;
  readonly family: string;
  readonly subfamily: string;
  readonly postscriptName: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly weight: number;
  /** PANOSE serif classification: true serif, false sans, undefined unknown. */
  readonly serif: boolean | undefined;
  readonly monospace: boolean;
  readonly glyphCount: number;
}

interface Face extends SystemFontFace {
  /** The family as older software names it (name ID 1), when it differs: "Arial Black" for Arial's Black weight. */
  readonly legacyFamily?: string;
  readonly cmapOffset: number;
  readonly cmapLength: number;
  /** undefined: not loaded yet; null: unusable (missing, symbol-only or corrupt). */
  cmap?: Cmap | null;
  broken?: boolean;
}

export interface FallbackOptions {
  bold?: boolean;
  italic?: boolean;
  /** Prefer serif (true, the default) or sans-serif (false) faces. */
  serif?: boolean;
}

const MAX_DEPTH = 8;
const MAX_FILES = 20000;
const MAX_FACES_PER_FILE = 256;
const MAX_NAME_TABLE = 1 << 20;
const MAX_CMAP_TABLE = 32 << 20;
const FONT_EXTENSIONS = new Set([".ttf", ".otf", ".ttc"]);

/** The platform's font folders (existing or not). */
export function systemFontDirs(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
    const dirs = [join(windir, "Fonts")];
    const local = process.env.LOCALAPPDATA || (home ? join(home, "AppData", "Local") : "");
    if (local) dirs.push(join(local, "Microsoft", "Windows", "Fonts"));
    return dirs;
  }
  if (process.platform === "darwin") {
    return ["/System/Library/Fonts", "/Library/Fonts", ...(home ? [join(home, "Library", "Fonts")] : [])];
  }
  return [
    "/usr/share/fonts",
    "/usr/local/share/fonts",
    ...(home ? [join(home, ".fonts"), join(home, ".local", "share", "fonts")] : []),
  ];
}

let overrideDirs: string[] | undefined;

/**
 * Replaces the folders searched for installed fonts (undefined restores the
 * platform defaults) and clears every cache.
 */
export function setSystemFontDirs(dirs: string[] | undefined): void {
  overrideDirs = dirs ? [...dirs] : undefined;
  filesCache = undefined;
  faces = undefined;
  orders.clear();
  blockCache.clear();
  cpCache.clear();
  fontCache.clear();
}

let filesCache: string[] | undefined;

/**
 * Font files (.ttf, .otf, .ttc) under the font folders, searched
 * recursively up to 8 levels and 20,000 files, sorted.
 */
export function systemFontFiles(dirs?: string[]): string[] {
  if (!dirs && filesCache) return filesCache;
  const roots = dirs ?? overrideDirs ?? systemFontDirs();
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const path = join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = statSync(path);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) walk(path, depth + 1);
      else if (isFile && FONT_EXTENSIONS.has(extname(e.name).toLowerCase())) out.push(path);
    }
  };
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    walk(root, 0);
  }
  if (!dirs) filesCache = out;
  return out;
}

/** Errors that mean "skip this font": bad font data or a failed file read. */
function skippable(e: unknown): boolean {
  return e instanceof FontError || (e instanceof Error && typeof (e as { code?: unknown }).code === "string");
}

function readAt(fd: number, offset: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  if (got < length) throw new FontError(`file ends before offset ${offset + length}`);
  return buf;
}

/** Index entries for every usable face in one file. */
function scanFile(file: string): Face[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  const out: Face[] = [];
  try {
    const size = fstatSync(fd).size;
    if (size < 12) return [];
    const header = new Reader(readAt(fd, 0, 12), file);
    let starts = [0];
    if (header.u32(0) === TAG_TTCF) {
      const n = header.u32(8);
      if (n < 1 || n > MAX_FACES_PER_FILE) return [];
      const r = new Reader(readAt(fd, 12, 4 * n), file);
      starts = [];
      for (let i = 0; i < n; i++) starts.push(r.u32(4 * i));
    }
    starts.forEach((start, index) => {
      try {
        const face = scanFace(fd, size, file, start, index);
        if (face) out.push(face);
      } catch (e) {
        if (!skippable(e)) throw e;
      }
    });
  } catch (e) {
    if (!skippable(e)) throw e;
  } finally {
    closeSync(fd);
  }
  return out;
}

function scanFace(fd: number, size: number, file: string, start: number, index: number): Face | undefined {
  if (start + 12 > size) return undefined;
  const hdr = new Reader(readAt(fd, start, 12), file);
  const flavor = hdr.u32(0);
  if (flavor !== FLAVOR_TRUETYPE && flavor !== FLAVOR_OTTO && flavor !== FLAVOR_TRUE) return undefined;
  const numTables = hdr.u16(4);
  if (numTables === 0 || start + 12 + 16 * numTables > size) return undefined;
  const dir = new Reader(readAt(fd, start + 12, 16 * numTables), file);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const tag = dir.tag(16 * i);
    const offset = dir.u32(16 * i + 8);
    const length = dir.u32(16 * i + 12);
    if (offset > size || offset + length > size + 3) return undefined;
    if (!tables.has(tag)) tables.set(tag, { offset, length: Math.max(0, Math.min(length, size - offset)) });
  }
  const outlines = (tables.has("glyf") && tables.has("loca")) || tables.has("CFF ") || tables.has("CFF2");
  const cmap = tables.get("cmap");
  if (!outlines || !cmap || !tables.has("hmtx") || !tables.has("hhea")) return undefined;
  const table = (tag: string, max: number): Reader | undefined => {
    const t = tables.get(tag);
    if (!t || t.length > max) return undefined;
    return new Reader(readAt(fd, t.offset, t.length), `${file} '${tag}'`);
  };
  const headR = table("head", 1024);
  const maxpR = table("maxp", 1024);
  if (!headR || !maxpR) return undefined;
  const head = parseHead(headR);
  const glyphCount = parseMaxpNumGlyphs(maxpR);
  const os2R = table("OS/2", 4096);
  const os2 = os2R ? parseOs2(os2R) : undefined;
  if (os2 && !fsTypeAllowsEmbedding(os2.fsType)) return undefined;
  const nameR = table("name", MAX_NAME_TABLE);
  const names = fontNames(nameR ? new NameTable(nameR) : undefined);
  if (!names.familyName || names.familyName.startsWith(".") || /^last ?resort/i.test(names.familyName)) return undefined;
  // Only the post header is needed (italicAngle); format 2 tables can be large.
  const postRec = tables.get("post");
  const italicAngle = postRec && postRec.length >= 8 ? new Reader(readAt(fd, postRec.offset, 8), `${file} 'post'`).fixed(4) : 0;
  const { bold, italic, weight } = styleFlags(os2, head.macStyle, names.subfamilyName, italicAngle);
  let serif: boolean | undefined;
  if (os2 && os2.panoseFamily === 2 && os2.panoseSerif >= 2 && os2.panoseSerif <= 15) serif = os2.panoseSerif <= 10;
  return {
    file,
    index,
    family: names.familyName,
    subfamily: names.subfamilyName,
    ...(names.legacyFamily && names.legacyFamily !== names.familyName ? { legacyFamily: names.legacyFamily } : {}),
    postscriptName: names.postscriptName,
    bold,
    italic,
    weight,
    serif,
    monospace: os2 ? os2.panoseFamily === 2 && os2.panoseProportion === 9 : false,
    glyphCount,
    cmapOffset: cmap.offset,
    cmapLength: cmap.length,
  };
}

let faces: Face[] | undefined;

function allFaces(): Face[] {
  if (!faces) {
    faces = [];
    for (const file of systemFontFiles()) faces.push(...scanFile(file));
  }
  return faces;
}

/** The index of installed faces (built on first use, then cached). */
export function systemFonts(): readonly SystemFontFace[] {
  return allFaces();
}

// ---------------------------------------------------------------------------
// Fallback order

const SERIF = [
  "times new roman", "cambria", "georgia", "constantia", "sitka text", "book antiqua", "palatino linotype",
  "liberation serif", "dejavu serif", "noto serif", "tinos", "times", "new york", "charter", "stix two text", "freeserif",
];
const SANS = [
  "segoe ui", "arial", "calibri", "helvetica neue", "helvetica", "verdana", "tahoma", "liberation sans",
  "dejavu sans", "noto sans", "arimo", "lucida grande", "freesans",
];
const SYMBOLS = [
  "cambria math", "stix two math", "segoe ui symbol", "noto sans math", "noto sans symbols", "noto sans symbols 2",
  "apple symbols", "dejavu sans", "symbola", "freeserif", "arial unicode ms",
];
const CJK = [
  "microsoft yahei", "microsoft yahei ui", "simsun", "nsimsun", "dengxian", "microsoft jhenghei", "yu gothic",
  "yu gothic ui", "meiryo", "ms gothic", "malgun gothic", "pingfang sc", "pingfang tc", "hiragino sans",
  "hiragino sans gb", "hiragino mincho pron", "apple sd gothic neo", "noto sans cjk sc", "noto sans cjk jp",
  "noto sans cjk kr", "noto sans cjk tc", "noto serif cjk sc", "source han sans sc", "source han serif sc",
  "wenquanyi zen hei", "wenquanyi micro hei", "droid sans fallback", "simsun-extb", "simsun-extg", "mingliu-extb",
];
const EMOJI = ["segoe ui emoji", "noto emoji", "twemoji mozilla"];
const SCRIPTS = [
  "nirmala ui", "segoe ui historic", "ebrima", "gadugi", "leelawadee ui", "myanmar text", "javanese text",
  "mongolian baiti", "microsoft himalaya", "microsoft yi baiti", "microsoft new tai lue", "microsoft tai le",
  "microsoft phagspa", "sylfaen", "mv boli", "kokila", "mangal",
];

function familyRank(family: string, preferSerif: boolean): number {
  const f = family.toLowerCase();
  const groups = preferSerif ? [SERIF, SANS, SYMBOLS, CJK, EMOJI, SCRIPTS] : [SANS, SERIF, SYMBOLS, CJK, EMOJI, SCRIPTS];
  for (let g = 0; g < groups.length; g++) {
    const i = groups[g].indexOf(f);
    if (i >= 0) return g * 1000 + i;
  }
  if (f.startsWith("noto serif")) return preferSerif ? 6000 : 6001;
  if (f.startsWith("noto sans")) return preferSerif ? 6001 : 6000;
  return 100000;
}

function styleKey(opts: FallbackOptions | undefined): string {
  return `${opts?.bold ? "b" : ""}${opts?.italic ? "i" : ""}${opts?.serif === false ? "s" : ""}`;
}

const orders = new Map<string, Face[]>();

function searchOrder(opts: FallbackOptions | undefined): Face[] {
  const key = styleKey(opts);
  let order = orders.get(key);
  if (!order) {
    const preferSerif = opts?.serif !== false;
    const wantWeight = opts?.bold ? 700 : 400;
    const wantItalic = !!opts?.italic;
    const scored = allFaces().map((face) => {
      let rank = familyRank(face.family, preferSerif);
      if (rank >= 100000 && face.serif !== undefined && face.serif !== preferSerif) rank += 1;
      const style = (face.italic !== wantItalic ? 10 : 0) + Math.abs(face.weight - wantWeight) / 100;
      return { face, rank, style };
    });
    scored.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.style - b.style ||
        a.face.family.localeCompare(b.face.family) ||
        (a.face.file < b.face.file ? -1 : a.face.file > b.face.file ? 1 : 0) ||
        a.face.index - b.face.index,
    );
    order = scored.map((s) => s.face);
    orders.set(key, order);
  }
  return order;
}

function faceCmap(face: Face): Cmap | null {
  if (face.cmap === undefined) {
    face.cmap = null;
    if (face.cmapLength > 0 && face.cmapLength <= MAX_CMAP_TABLE) {
      let fd: number | undefined;
      try {
        fd = openSync(face.file, "r");
        const cmap = parseCmap(new Reader(readAt(fd, face.cmapOffset, face.cmapLength), `${face.file} 'cmap'`), face.glyphCount);
        face.cmap = cmap && !cmap.symbol ? cmap : null;
      } catch (e) {
        if (!skippable(e)) throw e;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  }
  return face.cmap;
}

function covers(face: Face, cp: number): boolean {
  if (face.broken) return false;
  const cmap = faceCmap(face);
  return !!cmap && cmap.lookup(cp) !== 0;
}

const fontCache = new Map<string, Font>();

/** Parses a face's font (cached); undefined when the file turns out to be unusable. */
function loadFace(face: Face): Font | undefined {
  const key = `${face.file}#${face.index}`;
  let font = fontCache.get(key);
  if (!font) {
    try {
      const data = readFileSync(face.file);
      font = parseFont(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), face.index);
    } catch (e) {
      if (!skippable(e)) throw e;
      face.broken = true;
      return undefined;
    }
    fontCache.set(key, font);
  }
  return font;
}

const BLOCK_SHIFT = 7;
const CP_CACHE_LIMIT = 8192;
const blockCache = new Map<string, Face>();
const cpCache = new Map<string, Face | null>();

/**
 * An installed font that has a glyph for `codePoint`, preferring the
 * requested style and well-known text fonts, or undefined when no installed
 * font covers it. Fonts whose licence forbids embedding, symbol-encoded
 * fonts and bitmap-only fonts are never returned.
 */
export function fallbackFor(codePoint: number, opts?: FallbackOptions): Font | undefined {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return undefined;
  const key = styleKey(opts);
  const cpKey = `${key}:${codePoint}`;
  for (;;) {
    let face = cpCache.get(cpKey);
    if (face === undefined) {
      face = null;
      const blockKey = `${key}:${codePoint >> BLOCK_SHIFT}`;
      const recent = blockCache.get(blockKey);
      if (recent && covers(recent, codePoint)) face = recent;
      else {
        for (const f of searchOrder(opts)) {
          if (covers(f, codePoint)) {
            face = f;
            break;
          }
        }
        if (face) blockCache.set(blockKey, face);
      }
      if (cpCache.size >= CP_CACHE_LIMIT) cpCache.clear();
      cpCache.set(cpKey, face);
    }
    if (!face) return undefined;
    const font = loadFace(face);
    if (font) return font;
    // The face failed to parse; it is now marked broken, so search again.
    cpCache.clear();
    blockCache.clear();
  }
}

/**
 * An installed font by family name (case-insensitive), choosing the face
 * closest to the requested style; undefined when the family is not installed.
 */
export function findSystemFont(family: string, opts?: { bold?: boolean; italic?: boolean }): Font | undefined {
  const want = family.trim().toLowerCase();
  const wantWeight = opts?.bold ? 700 : 400;
  const wantItalic = !!opts?.italic;
  // The typographic family ("Arial"), or the name older software uses for one weight of it ("Arial Black").
  let candidates = allFaces().filter((f) => !f.broken && f.family.toLowerCase() === want);
  if (!candidates.length) candidates = allFaces().filter((f) => !f.broken && f.legacyFamily?.toLowerCase() === want);
  candidates = candidates
    .sort(
      (a, b) =>
        (a.italic !== wantItalic ? 10 : 0) + Math.abs(a.weight - wantWeight) / 100 -
        ((b.italic !== wantItalic ? 10 : 0) + Math.abs(b.weight - wantWeight) / 100),
    );
  for (const face of candidates) {
    const font = loadFace(face);
    if (font) return font;
  }
  return undefined;
}
