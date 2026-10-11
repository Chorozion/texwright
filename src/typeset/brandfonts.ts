/**
 * The document's own typefaces: pandoc's `mainfont`, `sansfont` and `monofont` front-matter
 * keys (and fontspec's `\setmainfont` in LaTeX, which the parser stores under the same keys).
 *
 * A value is one of:
 *   - a font file next to the document: `fonts/Inter-Regular.ttf` (TrueType, OpenType, WOFF, WOFF2);
 *     the bold and italic files are found by their usual names (Inter-Bold.ttf, Inter-Italic.ttf ...)
 *     or given with fontspec's options: `mainfontoptions: [BoldFont=Inter-SemiBold.ttf]`;
 *   - a family name: `Inter`. Font files in the document's folder and its `fonts/` folder are
 *     searched first (so a brand's files can travel with the document), then installed fonts;
 *   - a map of files: `{regular: a.ttf, bold: b.ttf, italic: c.ttf, bolditalic: d.ttf}`.
 *
 * Files are read only from the folders the document may read from. A face that cannot be found,
 * read, or embedded under its license is FONT002, and the theme's own face is kept.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Diagnostics } from "../diagnostics.js";
import { type Font, parseFont } from "../font/index.js";
import { findSystemFont } from "../font/system.js";
import { toWoff } from "../font/woff.js";
import { type ImagePolicy, fontDataSkippedNow, isInside } from "../write/assets.js";
import { noteRead } from "../util/reads.js";
import type { Theme } from "./style.js";

type Family = Theme["serif"];
type Style = "regular" | "bold" | "italic" | "boldItalic";

const FONT_FILE = /\.(ttf|otf|ttc|otc|woff2?)$/i;
const MAX_SCAN = 300;
const MAX_FONT_BYTES = 40 * 1024 * 1024;

/** The keys, in the order they apply: the body face (mainfont) wins over sansfont for body text. */
export const FONT_KEYS = ["sansfont", "monofont", "mainfont"] as const;

/** The theme with the document's faces in place of its own. */
export function withDocumentFonts(t: Theme, extra: Record<string, unknown> | undefined, policy: ImagePolicy, diagnostics: Diagnostics): Theme {
  if (!extra || !FONT_KEYS.some((k) => extra[k] !== undefined)) return t;
  const found = documentFamilies(extra, policy, diagnostics);
  let out = t;
  for (const key of FONT_KEYS) {
    const fam = found.get(key);
    if (!fam) continue;
    if (key === "monofont") out = { ...out, mono: fam.regular };
    else if (key === "sansfont") out = { ...out, sans: fam };
    // The body face: the serif slot in the article theme, the sans slot in themes that set the body in sans.
    else out = out.bodySans ? { ...out, sans: fam } : { ...out, serif: fam };
  }
  return out;
}

const resolved = new WeakMap<object, Map<string, Family>>();

/** The faces the document asks for, by key. Layout can run more than once (max-pages): they are found, and reported, once. */
function documentFamilies(extra: Record<string, unknown>, policy: ImagePolicy, diagnostics: Diagnostics): Map<string, Family> {
  let found = resolved.get(extra);
  if (!found) {
    const loader = new FontLoader(policy, diagnostics);
    found = new Map();
    for (const key of FONT_KEYS) {
      const value = extra[key];
      if (value === undefined || value === null || value === "") continue;
      const fam = loader.family(key, value, extra[`${key}options`]);
      if (fam) found.set(key, fam);
    }
    resolved.set(extra, found);
  }
  return found;
}

const woffCache = new Map<string, string>();

/**
 * CSS for HTML output: @font-face rules embedding the document's font files (TrueType and
 * OpenType as WOFF, WOFF and WOFF2 as they are), and the rules that use them. An installed font
 * is named but not embedded, since its license is the reader's machine's. `bodySans` is true
 * for the themes that set the body in sans (modern, compact).
 */
export function documentFontCss(extra: Record<string, unknown> | undefined, policy: ImagePolicy, diagnostics: Diagnostics, bodySans: boolean): string {
  if (!extra || !FONT_KEYS.some((k) => extra[k] !== undefined)) return "";
  const found = documentFamilies(extra, policy, diagnostics);
  const rules: string[] = [];
  const stack = (key: string, fam: Family): string => {
    const name = `tw-${key}`;
    const seen = new Set<Font>();
    const styles: [Font, number, string][] = [
      [fam.regular, 400, "normal"],
      [fam.bold, 700, "normal"],
      [fam.italic, 400, "italic"],
      [fam.boldItalic, 700, "italic"],
    ];
    let embedded = false;
    for (const [font, weight, style] of styles) {
      const file = fileOf.get(font);
      if (!file || fontDataSkippedNow()) continue;
      if (seen.has(font)) continue; // one file, one rule; the browser derives a missing bold or italic
      seen.add(font);
      let data = woffCache.get(file);
      const ext = extname(file).toLowerCase();
      const format = ext === ".woff2" ? "woff2" : "woff";
      if (data === undefined) {
        const bytes = new Uint8Array(readFileSync(file));
        data = Buffer.from(ext === ".woff" || ext === ".woff2" ? bytes : toWoff(bytes)).toString("base64");
        // A few font files at a time: each is the whole font, base64 encoded.
        if (woffCache.size >= 16) woffCache.delete(woffCache.keys().next().value!);
        woffCache.set(file, data);
      }
      rules.push(`@font-face{font-family:"${name}";font-weight:${weight};font-style:${style};src:url(data:font/${format};base64,${data}) format("${format}")}`);
      embedded = true;
    }
    const family = JSON.stringify(fam.regular.familyName);
    return embedded ? `"${name}", ${family}` : family;
  };
  const main = found.get("mainfont");
  const sans = found.get("sansfont");
  const mono = found.get("monofont");
  if (sans) {
    const s = stack("sansfont", sans);
    rules.push(bodySans && !main ? `body{font-family:${s}, sans-serif}` : `h1,h2,h3,h4,h5,h6{font-family:${s}, sans-serif}`);
  }
  if (main) rules.push(`body{font-family:${stack("mainfont", main)}, ${bodySans ? "sans-serif" : "serif"}}`);
  if (mono) rules.push(`code,kbd,pre{font-family:${stack("monofont", mono)}, monospace}`);
  return rules.join("\n");
}
/** The file each face was read from, for HTML's @font-face rules; installed fonts have none. */
const fileOf = new WeakMap<Font, string>();
/** Font files parsed, by path, with the size and time of the version read. */
const parsedFonts = new Map<string, { stamp: string; font: Font }>();

class FontLoader {
  private readonly roots: string[];
  private local: { file: string; font: Font }[] | undefined;

  constructor(
    private readonly policy: ImagePolicy,
    private readonly diagnostics: Diagnostics,
  ) {
    this.roots = [policy.baseDir, ...policy.allowPaths];
  }

  family(key: string, value: unknown, options: unknown): Family | undefined {
    const opts = fontspecOptions(options);
    let fam: Partial<Record<Style, Font>> = {};
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const map = value as Record<string, unknown>;
      const pick = (...names: string[]) => names.map((n) => map[n]).find((v) => typeof v === "string") as string | undefined;
      const file = (name: string | undefined, style: Style) => (name ? this.file(key, name, style) : undefined);
      fam = {
        regular: file(pick("regular", "upright", "normal", "path", "file"), "regular"),
        bold: file(pick("bold"), "bold"),
        italic: file(pick("italic"), "italic"),
        boldItalic: file(pick("bolditalic", "boldItalic", "bold-italic"), "boldItalic"),
      };
    } else if (typeof value === "string") {
      const name = value.trim();
      const dir = opts.path ? resolve(this.policy.baseDir, opts.path) : this.policy.baseDir;
      const ext = opts.extension ?? "";
      if (FONT_FILE.test(name + ext)) {
        const regularPath = resolve(dir, name + ext);
        fam.regular = this.file(key, regularPath, "regular");
        for (const style of ["bold", "italic", "boldItalic"] as const) {
          const given = style === "bold" ? opts.bold : style === "italic" ? opts.italic : opts.boldItalic;
          fam[style] = given ? this.file(key, resolve(dir, given + (FONT_FILE.test(given) ? "" : ext)), style) : this.sibling(regularPath, style);
        }
      } else {
        fam = this.byName(name);
        if (!fam.regular) {
          // A family that is simply not on this machine is a common pandoc habit and falls back cleanly,
          // so it is information; a file the document names but that cannot be used stays a warning.
          this.diagnostics.add("FONT002", `Font "${name}" for ${key} was not found; the theme's face is used`, undefined, {
            severity: "info",
            hint: "Put its .ttf/.otf/.woff2 files next to the document or in a fonts/ folder, give a file name (mainfont: fonts/Brand-Regular.ttf), or install the font",
          });
          return undefined;
        }
      }
    } else {
      this.diagnostics.add("OPT001", `Front matter "${key}" has an unusable value ${JSON.stringify(value)}`, undefined, { hint: "Give a family name, a font file, or {regular: ..., bold: ..., italic: ...}" });
      return undefined;
    }
    if (!fam.regular) return undefined;
    // Missing styles fall back the way a browser would without synthesizing: bold italic to bold, then to the upright.
    const regular = fam.regular;
    const bold = fam.bold ?? regular;
    const italic = fam.italic ?? regular;
    return { regular, bold, italic, boldItalic: fam.boldItalic ?? (fam.bold && !fam.italic ? bold : italic) };
  }

  /** A font file the document may read, or undefined with FONT002. */
  private file(key: string, path: string, style: Style): Font | undefined {
    const abs = resolve(this.policy.baseDir, path);
    if (!isInside(abs, this.roots)) {
      this.diagnostics.add("FONT002", `Font file ${path} for ${key} is outside the document's folder`, undefined, { hint: "Copy the font next to the document, or pass --allow-path" });
      return undefined;
    }
    const font = this.load(abs);
    if (!font) {
      this.diagnostics.add("FONT002", `Font file ${path} for ${key} (${style}) could not be read`, undefined, { hint: "Use a TrueType, OpenType, WOFF or WOFF2 file" });
      return undefined;
    }
    if (!font.embeddingAllowed) {
      this.diagnostics.add("FONT002", `The license of ${font.familyName} does not allow embedding it in a PDF; the theme's face is used`, undefined);
      return undefined;
    }
    return font;
  }

  private load(abs: string): Font | undefined {
    try {
      noteRead(abs);
      if (!existsSync(abs)) return undefined;
      const st = statSync(abs);
      if (st.size > MAX_FONT_BYTES) return undefined;
      // Parsed once per version of the file, so a watch session or a warm server keeps the same Font.
      const stamp = `${st.size}:${st.mtimeMs}`;
      const known = parsedFonts.get(abs);
      if (known?.stamp === stamp) return known.font;
      woffCache.delete(abs);
      const font = parseFont(new Uint8Array(readFileSync(abs)));
      fileOf.set(font, abs);
      parsedFonts.delete(abs);
      parsedFonts.set(abs, { stamp, font });
      if (parsedFonts.size > 32) parsedFonts.delete(parsedFonts.keys().next().value!);
      return font;
    } catch {
      return undefined;
    }
  }

  /** Inter-Regular.ttf -> Inter-Bold.ttf, Inter-Italic.ttf, Inter-BoldItalic.ttf (and the common spellings). */
  private sibling(regularPath: string, style: Exclude<Style, "regular">): Font | undefined {
    const dir = dirname(regularPath);
    const ext = extname(regularPath);
    const stem = basename(regularPath, ext);
    const base = stem.replace(/[-_ ]?(Regular|Roman|Book|Normal|Upright)$/i, "");
    const names: Record<typeof style, string[]> = {
      bold: ["Bold"],
      italic: ["Italic", "Oblique"],
      boldItalic: ["BoldItalic", "BoldOblique", "Bold-Italic", "Bold Italic"],
    };
    for (const s of names[style])
      for (const sep of ["-", "_", " ", ""]) {
        const candidate = join(dir, `${base}${sep}${s}${ext}`);
        if (candidate !== regularPath && existsSync(candidate) && isInside(candidate, this.roots)) {
          const f = this.load(candidate);
          if (f?.embeddingAllowed) return f;
        }
      }
    // Same family among the document's font files.
    return this.byName(this.load(regularPath)?.familyName ?? base, true)[style];
  }

  /** A family by name: font files beside the document first, then installed fonts. */
  private byName(name: string, localOnly = false): Partial<Record<Style, Font>> {
    const want = norm(name);
    const out: Partial<Record<Style, Font>> = {};
    for (const { font } of this.localFonts()) {
      if (norm(font.familyName) !== want && norm(font.postscriptName).split("-")[0] !== want) continue;
      const style: Style = font.bold ? (font.italic ? "boldItalic" : "bold") : font.italic ? "italic" : "regular";
      const prev = out[style];
      // Of several weights, the one nearest 400 (regular) or 700 (bold).
      const target = font.bold ? 700 : 400;
      if (!prev || Math.abs(font.weight - target) < Math.abs(prev.weight - target)) out[style] = font;
    }
    if (out.regular || localOnly) return out;
    const sys = (bold: boolean, italic: boolean) => {
      const f = findSystemFont(name, { bold, italic });
      return f && norm(f.familyName) === want && f.embeddingAllowed ? f : undefined;
    };
    return { regular: sys(false, false), bold: sys(true, false), italic: sys(false, true), boldItalic: sys(true, true) };
  }

  /** Font files in the document's folder and its fonts/ folder, parsed once. */
  private localFonts(): { file: string; font: Font }[] {
    if (this.local) return this.local;
    this.local = [];
    for (const dir of [this.policy.baseDir, join(this.policy.baseDir, "fonts")]) {
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => FONT_FILE.test(n)).slice(0, MAX_SCAN);
      } catch {
        continue;
      }
      for (const n of names) {
        const file = join(dir, n);
        const font = this.load(file);
        if (font?.embeddingAllowed) this.local.push({ file, font });
      }
    }
    return this.local;
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

/** fontspec's options: "Path=fonts/, BoldFont=Inter-Bold.ttf, Extension=.ttf", as a string or a list. */
function fontspecOptions(v: unknown): { path?: string; bold?: string; italic?: string; boldItalic?: string; extension?: string } {
  const items = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  const out: ReturnType<typeof fontspecOptions> = {};
  for (const item of items) {
    const m = /^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/.exec(item);
    if (!m) continue;
    const k = m[1]!.toLowerCase();
    const val = m[2]!.replace(/^\{|\}$/g, "");
    if (k === "path") out.path = val;
    else if (k === "boldfont") out.bold = val;
    else if (k === "italicfont") out.italic = val;
    else if (k === "bolditalicfont") out.boldItalic = val;
    else if (k === "extension") out.extension = val;
  }
  return out;
}
