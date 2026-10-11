/**
 * Static assets: themes, the bundled fonts for HTML, and images.
 *
 * Image access is the main security boundary: documents may come from an
 * agent or another untrusted source, so images are read only from the
 * input's directory (plus --allow-path entries), only with image file
 * extensions, and never from the network unless --allow-net is set.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Pos } from "../ast.js";
import type { Diagnostics, Fix } from "../diagnostics.js";
import { closestFix } from "../fixes.js";
import { fontsDir } from "../font/registry.js";
import { toWoff } from "../font/woff.js";
import { noteRead } from "../util/reads.js";
import { realPath } from "../util/paths.js";

const here = dirname(fileURLToPath(import.meta.url));

let rootCache: string | undefined;

/** Root of the package (works from src/ and from dist/src/). Found once per process. */
export function packageRoot(): string {
  if (rootCache) return rootCache;
  let dir = here;
  for (let k = 0; k < 5; k++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "themes"))) return (rootCache = dir);
    dir = dirname(dir);
  }
  return (rootCache = resolve(here, "..", ".."));
}

/** The package's theme files read so far (they ship with the package and do not change). */
const themeFiles = new Map<string, string>();

/** A theme file's text, or undefined when there is no such theme. */
function themeFile(name: string): string | undefined {
  let css = themeFiles.get(name);
  if (css === undefined) {
    const file = join(packageRoot(), "themes", `${name}.css`);
    if (!existsSync(file)) return undefined;
    css = readFileSync(file, "utf8");
    themeFiles.set(name, css);
  }
  return css;
}

export const THEMES = ["article", "modern", "compact"] as const;
export type ThemeName = (typeof THEMES)[number];

/** A theme's CSS. A first line `/* @extends other *\/` prepends that theme. */
export function themeCss(name: string, seen: string[] = []): string | undefined {
  if (!/^[a-z0-9-]+$/i.test(name) || seen.includes(name)) return undefined;
  const css = themeFile(name);
  if (css === undefined) return undefined;
  const parent = /^\/\* @extends ([a-z0-9-]+) \*\//i.exec(css)?.[1];
  const base = parent ? (themeCss(parent, [...seen, name]) ?? "") : "";
  return base ? `${base}\n${css}` : css;
}

export function listThemes(): string[] {
  return [...THEMES];
}

/**
 * The bundled font families a theme embeds, from a `/* @fonts a, b *\/` line in
 * its own file ("none" for none); a theme without one inherits its parent's.
 */
export function themeFonts(name: string, seen: string[] = []): string[] {
  if (!/^[a-z0-9-]+$/i.test(name) || seen.includes(name)) return [];
  const css = themeFile(name);
  if (css === undefined) return [];
  const own = /\/\* @fonts ([^*]*)\*\//.exec(css)?.[1];
  if (own !== undefined) return own.split(/[\s,]+/).filter((f) => f && f !== "none");
  const parent = /^\/\* @extends ([a-z0-9-]+) \*\//i.exec(css)?.[1];
  return parent ? themeFonts(parent, [...seen, name]) : [];
}

/** Families a theme may name to get the bundled faces, embedded as WOFF. */
const BUNDLED_FACES: Record<string, { file: string; weight: number; style: string }[]> = {
  "texwright-serif": [
    { file: "Main-Regular", weight: 400, style: "normal" },
    { file: "Main-Bold", weight: 700, style: "normal" },
    { file: "Main-Italic", weight: 400, style: "italic" },
    { file: "Main-BoldItalic", weight: 700, style: "italic" },
  ],
  "texwright-mono": [{ file: "Typewriter-Regular", weight: 400, style: "normal" }],
  // The face diagrams set their labels in (src/diagram/text.ts), under the name their SVG uses.
  KaTeX_SansSerif: [
    { file: "SansSerif-Regular", weight: 400, style: "normal" },
    { file: "SansSerif-Bold", weight: 700, style: "normal" },
    { file: "SansSerif-Italic", weight: 400, style: "italic" },
  ],
};

const faceCache = new Map<string, string>();
let fontDataSkipped = 0;

/**
 * Runs fn with bundledFontCss() returning no rules. For check(), which writes
 * HTML only for the diagnostics that raises and throws the text away:
 * converting the fonts to WOFF is a good part of the time a check takes.
 */
export function withoutFontData<T>(fn: () => T): T {
  fontDataSkipped++;
  try {
    return fn();
  } finally {
    fontDataSkipped--;
  }
}

/** True inside withoutFontData(): font files are not to be read and encoded. */
export function fontDataSkippedNow(): boolean {
  return fontDataSkipped > 0;
}

/**
 * @font-face rules for the given bundled families, with the fonts embedded as
 * WOFF data URIs so the HTML stays one self-contained file.
 */
export function bundledFontCss(families: readonly string[]): string {
  if (fontDataSkipped) return "";
  const rules: string[] = [];
  for (const [family, faces] of Object.entries(BUNDLED_FACES)) {
    if (!families.includes(family)) continue;
    for (const f of faces) {
      let data = faceCache.get(f.file);
      if (data === undefined) {
        data = Buffer.from(toWoff(new Uint8Array(readFileSync(join(fontsDir(), `KaTeX_${f.file}.ttf`))))).toString("base64");
        faceCache.set(f.file, data);
      }
      rules.push(`@font-face{font-family:"${family}";font-weight:${f.weight};font-style:${f.style};src:url(data:font/woff;base64,${data}) format("woff")}`);
    }
  }
  return rules.join("\n");
}

// ------------------------------------------------------------------ images

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
};
/** Extensions tried, in order, when LaTeX source names an image without one. */
const PROBE_ORDER = [".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf"];

export interface ImagePolicy {
  baseDir: string;
  allowPaths: string[];
  allowNet: boolean;
  embed: boolean;
}

export interface ResolvedImage {
  /** URL to put in the src attribute. */
  src: string;
  /** Absolute path for local files (used to rasterize PDF figures). */
  path?: string;
  mime?: string;
  missing?: boolean;
  blocked?: boolean;
}

/** A UNC or other network path (\\host\share, //host/share, \\?\UNC\...): never touched. */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../"));
}

/** Containment on the path's text alone, with no file system access. */
export function isInsideLexically(file: string, roots: string[]): boolean {
  if (isNetworkPath(file)) return false;
  const target = resolve(file);
  return roots.some((r) => contained(resolve(r), target));
}

/**
 * Whether `file` lies inside one of `roots`. The lexical check runs first, so
 * paths that are plainly outside (including network paths) never reach the
 * file system; symlinks are then resolved and checked again.
 */
export function isInside(file: string, roots: string[]): boolean {
  if (!isInsideLexically(file, roots)) return false;
  try {
    const target = realPath(file);
    return roots.some((r) => {
      try {
        return contained(realPath(r), target);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function insideAllowed(file: string, policy: ImagePolicy): boolean {
  return isInside(file, [policy.baseDir, ...policy.allowPaths]);
}

type Report = { code: Parameters<Diagnostics["add"]>[0]; message: string; hint?: string; fix?: Pick<Fix, "old" | "new" | "safe"> };
const imageCache = new WeakMap<ImagePolicy, Map<string, { result: ResolvedImage; reports: Report[] }>>();

/**
 * Resolve an image reference under a policy. Results are cached per policy,
 * so the PDF writer's repeated passes neither touch the disk again nor
 * re-encode embedded images; problems are reported at every occurrence.
 */
export function resolveImage(src: string, policy: ImagePolicy, diagnostics: Diagnostics, pos?: Pos): ResolvedImage {
  let cache = imageCache.get(policy);
  if (!cache) {
    cache = new Map();
    imageCache.set(policy, cache);
  }
  let entry = cache.get(src);
  if (!entry) {
    const reports: Report[] = [];
    const recorder = {
      add(code: Report["code"], message: string, _where?: unknown, extra?: { hint?: string; fix?: Report["fix"] }) {
        reports.push({ code, message, hint: extra?.hint, fix: extra?.fix });
      },
    } as unknown as Diagnostics;
    entry = { result: resolveUncached(src, policy, recorder), reports };
    cache.set(src, entry);
  }
  for (const r of entry.reports) diagnostics.add(r.code, r.message, pos, { hint: r.hint, fix: r.fix });
  return entry.result;
}

/**
 * An image in the missing one's folder whose name differs only slightly (letter case, a typo, or
 * another image extension), as a fix to the reference as written. It is marked safe only when it
 * cannot be a different picture: unambiguous, and the same digits.
 */
function nearMissImage(abs: string, src: string, policy: ImagePolicy): Fix | undefined {
  const written = src.split(/[\\/]/).pop() ?? "";
  if (!written || !src.endsWith(written) || /%[0-9a-f]{2}/i.test(written)) return undefined;
  // Only folders the document may read from, after symlinks, are listed.
  if (!existsSync(dirname(abs)) || !insideAllowed(dirname(abs), policy)) return undefined;
  let names: string[];
  try {
    names = readdirSync(dirname(abs)).slice(0, 5000);
  } catch {
    return undefined;
  }
  const images = names.filter((n) => IMAGE_TYPES[extname(n).toLowerCase()]);
  const want = basename(abs);
  const stem = (n: string) => n.slice(0, n.length - extname(n).length);
  let match = images.find((n) => n.toLowerCase() === want.toLowerCase() || (!extname(want) && stem(n).toLowerCase() === want.toLowerCase()));
  let safe = !!match && extname(want) !== "";
  if (!match) {
    const typo = closestFix(want, images, 2);
    const sameStem = images.filter((n) => extname(want) && stem(n) === stem(want));
    // A typo is safe when it is unambiguous and leaves the digits alone ("fig1" for "fig2"
    // is another picture); another extension is safe when only one image has the stem.
    const digits = (n: string) => n.replace(/\D/g, "");
    if (typo) {
      match = typo.replacement;
      safe = typo.safe && digits(stem(typo.replacement)) === digits(stem(want));
    } else if (sameStem.length === 1) {
      match = sameStem[0];
      safe = true;
    }
  }
  if (!match) return undefined;
  return { line: 0, col: 0, old: src, new: src.slice(0, src.length - written.length) + match, safe };
}

function resolveUncached(src: string, policy: ImagePolicy, diagnostics: Diagnostics, pos?: Pos): ResolvedImage {
  if (/^data:image\//i.test(src)) return { src };
  if (/^https?:\/\//i.test(src)) {
    if (policy.allowNet) return { src };
    diagnostics.add("IMG002", `Remote image blocked: ${src}`, pos, { hint: "Download it next to the document, or pass --allow-net" });
    return { src: "", blocked: true };
  }
  let clean = src.replace(/^file:\/\//i, "");
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // "100%.png" is a valid file name and an invalid URI escape: use it as written.
  }
  const outside = () => {
    diagnostics.add("IMG001", `Image outside the document folder was not read: ${src}`, pos, {
      hint: "Move it next to the document, or pass --allow-path <folder>",
    });
    return { src: "", blocked: true };
  };
  // Decide on the path's text before touching the disk: a UNC path would make
  // even an existence check open a network connection.
  if (isNetworkPath(clean)) return outside();
  const abs = isAbsolute(clean) ? clean : resolve(policy.baseDir, clean);
  const roots = [policy.baseDir, ...policy.allowPaths];
  if (!isInsideLexically(abs, roots)) return outside();
  const candidates = extname(abs) ? [abs] : PROBE_ORDER.map((ext) => abs + ext);
  for (const c of candidates) noteRead(c);
  const found = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!found) {
    const near = nearMissImage(abs, src, policy);
    diagnostics.add("IMG001", `Image not found: ${src}`, pos, {
      hint: near
        ? `There is ${basename(near.new)} in the same folder`
        : extname(abs)
          ? `Looked for ${abs}`
          : `Tried ${PROBE_ORDER.join(", ")} after ${clean}`,
      fix: near,
    });
    return { src: "", missing: true };
  }
  const mime = IMAGE_TYPES[extname(found).toLowerCase()];
  if (!mime) {
    diagnostics.add("IMG001", `Not an image type texwright can show: ${src}`, pos, { hint: `Use one of ${Object.keys(IMAGE_TYPES).join(" ")}` });
    return { src: "", missing: true };
  }
  // Again after resolving symlinks.
  if (!insideAllowed(found, policy)) return outside();
  if (policy.embed && mime !== "application/pdf") {
    return { src: `data:${mime};base64,${readFileSync(found).toString("base64")}`, path: found, mime };
  }
  return { src: pathToFileURL(found).href, path: found, mime };
}
