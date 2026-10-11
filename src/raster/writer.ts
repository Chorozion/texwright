/**
 * A PdfDocumentWriter that draws pages into pixels instead of writing a
 * PDF, so the shipper (layout/shipout.ts) and the typesetter, which
 * registers images through addImage, work with it unchanged.
 *
 * Pages that were not asked for are accepted and ignored, so a document can
 * be laid out in full (page references need every page) while only some
 * pages are drawn. Bookmarks, page labels and document information have
 * nothing to draw.
 */

import type { Font } from "../font/index.js";
import { FontError } from "../font/index.js";
import type { ImageRef, PathCommand } from "../layout/types.js";
import type { PdfDocumentWriter, PdfPage } from "../pdf/api.js";
import { PdfError } from "../pdf/errors.js";
import { imageId } from "../pdf/images.js";
import { RasterImage } from "./image.js";
import { type GlyphMask, type RasterHost, RasterPage } from "./page.js";
import { CoverageRasterizer } from "./rasterizer.js";

export interface RasterWriterOptions {
  /** Pixels per inch (default 100). */
  dpi?: number;
  /** 1-based numbers of the pages to draw; every page when absent. */
  pages?: Iterable<number>;
  /** Pages start transparent instead of white, and their PNGs keep the alpha channel. */
  transparent?: boolean;
}

export interface RasterWriter extends PdfDocumentWriter {
  readonly dpi: number;
  /** Problems that did not stop drawing: images shown as placeholders, glyphs a font could not draw. */
  readonly warnings: string[];
  /** The pages drawn, in order. */
  readonly pages: readonly RasterPage[];
}

export const MIN_DPI = 10;
export const MAX_DPI = 1200;
/** A page larger than this many pixels is refused rather than allocated. */
export const MAX_PAGE_PIXELS = 50_000_000;
/** Memory for cached glyph masks before the cache starts over. */
const MASK_CACHE_BYTES = 64 * 1024 * 1024;

/** Pixels for a length in points, rounded up, except that a hair over a whole number (rounding error) adds no pixel. */
function pixels(pt: number, dpi: number): number {
  return Math.max(1, Math.ceil((pt * dpi) / 72 - 1e-6));
}

/** Stands in for a page that is laid out but not drawn. */
class SkippedPage implements PdfPage {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  glyphs(): void {}
  path(): void {}
  rect(): void {}
  image(): void {}
  group(): void {}
  save(): void {}
  restore(): void {}
  transform(): void {}
  clip(): void {}
  link(): void {}
  destination(): void {}
}

class Writer implements RasterWriter, RasterHost {
  readonly dpi: number;
  readonly warnings: string[] = [];
  readonly pages: RasterPage[] = [];
  private readonly wanted: Set<number> | undefined;
  private readonly transparent: boolean;
  private readonly images = new Map<string, RasterImage>();
  private readonly placeholders = new Set<string>();
  private readonly outlines = new Map<Font, Map<number, PathCommand[] | undefined>>();
  private readonly brokenFonts = new Set<Font>();
  private masks = new Map<Font, Map<string, Map<number, GlyphMask | null>>>();
  private maskBytes = 0;
  private ras: CoverageRasterizer | undefined;
  private count = 0;
  private finished = false;

  constructor(options: RasterWriterOptions) {
    const dpi = options.dpi ?? 100;
    if (!(typeof dpi === "number" && dpi >= MIN_DPI && dpi <= MAX_DPI)) throw new RangeError(`dpi must be a number from ${MIN_DPI} to ${MAX_DPI}, got ${String(dpi)}`);
    this.dpi = dpi;
    this.wanted = options.pages ? new Set(options.pages) : undefined;
    this.transparent = options.transparent === true;
  }

  // ---------------------------------------------------------- RasterHost

  checkOpen(): void {
    if (this.finished) throw new PdfError("the preview has already been finished");
  }

  rasterizer(width: number, height: number): CoverageRasterizer {
    if (!this.ras || this.ras.width !== width || this.ras.height !== height) this.ras = new CoverageRasterizer(width, height);
    return this.ras;
  }

  image(ref: ImageRef): RasterImage {
    const img = ref && this.images.get(ref.id);
    if (!img) throw new PdfError(`image ${JSON.stringify(ref?.id)} was not added to this document with addImage()`);
    return img;
  }

  placeholder(ref: ImageRef, image: RasterImage): void {
    if (this.placeholders.has(ref.id)) return;
    this.placeholders.add(ref.id);
    this.warnings.push(`${image.problem ?? "an image"} (${image.width}x${image.height} pixels) is drawn as a grey box`);
  }

  glyphOutline(font: Font, gid: number): PathCommand[] | undefined {
    let glyphs = this.outlines.get(font);
    if (!glyphs) {
      glyphs = new Map();
      this.outlines.set(font, glyphs);
    }
    if (glyphs.has(gid)) return glyphs.get(gid);
    let outline: PathCommand[] | undefined;
    try {
      outline = font.outline(gid);
    } catch (e) {
      if (!(e instanceof FontError)) throw e;
      if (!this.brokenFonts.has(font)) {
        this.brokenFonts.add(font);
        this.warnings.push(`${font.postscriptName}: glyphs with corrupt outlines are left out (glyph ${gid}: ${e.message})`);
      }
    }
    glyphs.set(gid, outline);
    return outline;
  }

  glyphMasks(font: Font, scale: string): Map<number, GlyphMask | null> {
    let byScale = this.masks.get(font);
    if (!byScale) {
      byScale = new Map();
      this.masks.set(font, byScale);
    }
    let masks = byScale.get(scale);
    if (!masks) {
      masks = new Map();
      byScale.set(scale, masks);
    }
    return masks;
  }

  cachedMask(bytes: number): void {
    this.maskBytes += bytes + 64;
    // Masks are cheap to remake; past the budget the cache starts over (maps handed out keep working).
    if (this.maskBytes > MASK_CACHE_BYTES) {
      this.masks = new Map();
      this.maskBytes = 0;
    }
  }

  // --------------------------------------------------- PdfDocumentWriter

  addImage(bytes: Uint8Array): ImageRef {
    this.checkOpen();
    if (!(bytes instanceof Uint8Array)) throw new PdfError("addImage() needs a Uint8Array");
    const id = imageId(bytes);
    let img = this.images.get(id);
    if (!img) {
      img = new RasterImage(bytes);
      this.images.set(id, img);
    }
    return { id, pixelWidth: img.width, pixelHeight: img.height };
  }

  addPage(width: number, height: number): PdfPage {
    this.checkOpen();
    if (!(typeof width === "number" && width > 0 && width < Infinity && typeof height === "number" && height > 0 && height < Infinity)) {
      throw new PdfError(`page size ${width}x${height} is invalid`);
    }
    const n = ++this.count;
    // The page before is complete: encoding it now frees its pixels.
    this.pages[this.pages.length - 1]?.png();
    if (this.wanted && !this.wanted.has(n)) return new SkippedPage(width, height);
    const w = pixels(width, this.dpi);
    const h = pixels(height, this.dpi);
    if (w * h > MAX_PAGE_PIXELS) throw new PdfError(`page ${n} would be ${w}x${h} pixels at ${this.dpi} dpi, more than the ${MAX_PAGE_PIXELS / 1e6} megapixel limit`);
    const page = new RasterPage(this, n, width, height, w, h, this.transparent);
    this.pages.push(page);
    return page;
  }

  outline(): void {
    this.checkOpen();
  }

  setInfo(): void {
    this.checkOpen();
  }

  /**
   * Finishes the last page. Previews are read page by page (`pages`, each
   * page's png()), so there is no single file to return: the result is empty.
   */
  finish(): Uint8Array {
    if (!this.finished) {
      this.pages[this.pages.length - 1]?.png();
      this.finished = true;
    }
    return new Uint8Array(0);
  }
}

/** A writer that draws pages into pixels. Throws RangeError for a dpi outside 10..1200. */
export function createRasterWriter(options: RasterWriterOptions = {}): RasterWriter {
  return new Writer(options);
}
