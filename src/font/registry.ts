/**
 * The fonts bundled in the package's fonts/ folder: Latin Modern Roman and
 * Mono for text (GUST Font License) and KaTeX's Computer Modern derivatives
 * for mathematics (SIL Open Font License 1.1). See fonts/README.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FontError } from "./errors.js";
import { type Font, parseFont } from "./font.js";

export type BundledFamily =
  | "Main"
  | "Math"
  | "AMS"
  | "Caligraphic"
  | "Fraktur"
  | "SansSerif"
  | "Script"
  | "Typewriter"
  | "Size1"
  | "Size2"
  | "Size3"
  | "Size4"
  | "LMRoman"
  | "LMMono";

export type BundledStyle = "Regular" | "Bold" | "Italic" | "BoldItalic";

/** Styles shipped for each family; the first is the default. */
export const BUNDLED_STYLES: Readonly<Record<BundledFamily, readonly BundledStyle[]>> = {
  Main: ["Regular", "Bold", "Italic", "BoldItalic"],
  Math: ["Italic", "BoldItalic"],
  AMS: ["Regular"],
  Caligraphic: ["Regular", "Bold"],
  Fraktur: ["Regular", "Bold"],
  SansSerif: ["Regular", "Bold", "Italic"],
  Script: ["Regular"],
  Typewriter: ["Regular"],
  Size1: ["Regular"],
  Size2: ["Regular"],
  Size3: ["Regular"],
  Size4: ["Regular"],
  LMRoman: ["Regular", "Bold", "Italic", "BoldItalic"],
  LMMono: ["Regular"],
};

/** File names of the Latin Modern faces (10 pt design size); every other family is KaTeX_<Family>-<Style>.ttf. */
const LM_FILES: Partial<Record<BundledFamily, Partial<Record<BundledStyle, string>>>> = {
  LMRoman: { Regular: "lmroman10-regular.otf", Bold: "lmroman10-bold.otf", Italic: "lmroman10-italic.otf", BoldItalic: "lmroman10-bolditalic.otf" },
  LMMono: { Regular: "lmmono10-regular.otf" },
};

const here = dirname(fileURLToPath(import.meta.url));
let fontsDirCache: string | undefined;

/** The package's fonts/ folder (works from src/font/ and from compiled output). */
export function fontsDir(): string {
  if (!fontsDirCache) {
    let dir = here;
    for (let k = 0; k < 6; k++) {
      if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "fonts"))) {
        fontsDirCache = join(dir, "fonts");
        return fontsDirCache;
      }
      dir = dirname(dir);
    }
    fontsDirCache = resolve(here, "..", "..", "fonts");
  }
  return fontsDirCache;
}

/** File path of a bundled font. Throws FontError for a style the family lacks. */
export function bundledFontPath(family: BundledFamily, style?: BundledStyle): string {
  const styles = BUNDLED_STYLES[family];
  if (!styles) throw new FontError(`no bundled font family '${family}'`);
  const s = style ?? styles[0];
  if (!styles.includes(s)) {
    throw new FontError(`no bundled font ${family}-${s}; available styles: ${styles.join(", ")}`);
  }
  return join(fontsDir(), LM_FILES[family]?.[s] ?? `KaTeX_${family}-${s}.ttf`);
}

const cache = new Map<string, Font>();

/** A bundled font, parsed once and cached. The default style is the family's first (Math: Italic). */
export function bundledFont(family: BundledFamily, style?: BundledStyle): Font {
  const path = bundledFontPath(family, style);
  let font = cache.get(path);
  if (!font) {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new FontError(`bundled font missing: ${path}`);
    }
    font = parseFont(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    cache.set(path, font);
  }
  return font;
}
