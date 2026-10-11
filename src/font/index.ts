/**
 * texwright's font engine: a TrueType/OpenType reader and subsetter written
 * for the PDF writer, the line breaker and the math typesetter.
 */

export { FontError } from "./errors.js";
export { type Bounds, type Font, parseFont } from "./font.js";
export { collectionSize, tableChecksum } from "./sfnt.js";
export { isWebFont, webFontToSfnt } from "./webfont.js";
export type { LigatureResult } from "./layout.js";
export { BUNDLED_STYLES, type BundledFamily, type BundledStyle, bundledFont, bundledFontPath, fontsDir } from "./registry.js";
export {
  type FallbackOptions,
  type SystemFontFace,
  fallbackFor,
  findSystemFont,
  setSystemFontDirs,
  systemFontDirs,
  systemFontFiles,
  systemFonts,
} from "./system.js";
