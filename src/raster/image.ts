/**
 * Raster images for page previews: PNG and JPEG decoded to 8-bit RGB with
 * colour premultiplied by alpha (so filtering and compositing need no
 * special case for transparent pixels), and box-filtered reductions for
 * drawing an image at a fraction of its size.
 */

import { PdfError } from "../pdf/errors.js";
import { isJpeg, parseJpeg } from "../pdf/jpeg.js";
import { decodePng, isPng } from "../pdf/png.js";
import { decodeJpeg } from "./jpeg.js";

export interface Bitmap {
  width: number;
  height: number;
  /** RGB, premultiplied by alpha when there is an alpha channel. */
  rgb: Uint8Array;
  alpha?: Uint8Array;
}

/** Larger images are not decoded for previews; they show as a placeholder. */
export const MAX_PREVIEW_PIXELS = 50_000_000;

/**
 * A registered image: decoded at once for PNG (which also proves it valid),
 * on first use for JPEG. `problem` says why there is no bitmap to draw.
 */
export class RasterImage {
  readonly width: number;
  readonly height: number;
  private bitmap?: Bitmap;
  private jpeg?: Uint8Array;
  private reductions = new Map<number, Bitmap>();
  problem?: string;

  /** Validates `bytes` exactly as the PDF writer does: PdfError for anything it would refuse. */
  constructor(bytes: Uint8Array) {
    if (!(bytes instanceof Uint8Array)) throw new PdfError("image data must be a Uint8Array");
    if (isJpeg(bytes)) {
      const info = parseJpeg(bytes);
      this.width = info.width;
      this.height = info.height;
      if (info.progressive) this.problem = "a progressive JPEG";
      else if (info.width * info.height > MAX_PREVIEW_PIXELS) this.problem = "a JPEG too large to preview";
      else this.jpeg = bytes;
      return;
    }
    if (isPng(bytes)) {
      const png = decodePng(bytes);
      this.width = png.width;
      this.height = png.height;
      if (png.width * png.height > MAX_PREVIEW_PIXELS) {
        this.problem = "a PNG too large to preview";
        return;
      }
      const n = png.width * png.height;
      const src = png.pixels!;
      const rgb = new Uint8Array(3 * n);
      if (png.color === "rgb") rgb.set(src);
      else if (png.color === "gray") for (let i = 0; i < n; i++) rgb[3 * i] = rgb[3 * i + 1] = rgb[3 * i + 2] = src[i];
      else {
        const pal = png.palette!;
        for (let i = 0; i < n; i++) {
          const e = 3 * src[i];
          rgb[3 * i] = pal[e];
          rgb[3 * i + 1] = pal[e + 1];
          rgb[3 * i + 2] = pal[e + 2];
        }
      }
      const alpha = png.alpha;
      if (alpha) for (let i = 0; i < 3 * n; i++) rgb[i] = Math.round((rgb[i] * alpha[(i / 3) | 0]) / 255);
      this.bitmap = { width: png.width, height: png.height, rgb, alpha };
      return;
    }
    throw new PdfError("unsupported image format: expected PNG or JPEG data");
  }

  /**
   * The bitmap reduced by a whole factor (1 for the image itself), or
   * undefined with `problem` set when the image cannot be drawn.
   */
  pixels(factor: number): Bitmap | undefined {
    if (!this.bitmap && this.jpeg) {
      const bytes = this.jpeg;
      this.jpeg = undefined;
      try {
        const d = decodeJpeg(bytes);
        if (d === "progressive") this.problem = "a progressive JPEG";
        else this.bitmap = { width: d.width, height: d.height, rgb: d.rgb };
      } catch (e) {
        this.problem = `a JPEG that could not be decoded (${(e as Error).message})`;
      }
    }
    const full = this.bitmap;
    if (!full || factor <= 1) return full;
    let r = this.reductions.get(factor);
    if (!r) {
      r = reduce(full, factor);
      this.reductions.set(factor, r);
    }
    return r;
  }
}

/** Box filter: each output pixel averages a factor x factor block (fewer at the right and bottom edges). */
function reduce(b: Bitmap, factor: number): Bitmap {
  const w = Math.ceil(b.width / factor);
  const h = Math.ceil(b.height / factor);
  const rgb = new Uint8Array(3 * w * h);
  const alpha = b.alpha ? new Uint8Array(w * h) : undefined;
  const sum = new Float64Array(4 * w);
  const count = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    sum.fill(0);
    count.fill(0);
    const y1 = Math.min(b.height, (y + 1) * factor);
    for (let sy = y * factor; sy < y1; sy++) {
      for (let sx = 0; sx < b.width; sx++) {
        const x = (sx / factor) | 0;
        const i = sy * b.width + sx;
        sum[4 * x] += b.rgb[3 * i];
        sum[4 * x + 1] += b.rgb[3 * i + 1];
        sum[4 * x + 2] += b.rgb[3 * i + 2];
        if (b.alpha) sum[4 * x + 3] += b.alpha[i];
        count[x]++;
      }
    }
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      rgb[3 * o] = Math.round(sum[4 * x] / count[x]);
      rgb[3 * o + 1] = Math.round(sum[4 * x + 1] / count[x]);
      rgb[3 * o + 2] = Math.round(sum[4 * x + 2] / count[x]);
      if (alpha) alpha[o] = Math.round(sum[4 * x + 3] / count[x]);
    }
  }
  return { width: w, height: h, rgb, alpha };
}
