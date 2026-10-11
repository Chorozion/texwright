/**
 * JPEG header parsing for pass-through embedding (/DCTDecode): walks the
 * marker segments up to the first scan to find the frame header (size and
 * components) and the Adobe APP14 marker. The compressed data is embedded
 * unchanged.
 */

import { PdfError } from "./errors.js";
import { MAX_PIXELS } from "./png.js";

export interface JpegInfo {
  width: number;
  height: number;
  components: 1 | 3 | 4;
  /** Baseline (SOF0), extended sequential (SOF1) or progressive (SOF2). */
  progressive: boolean;
  /** An Adobe APP14 marker is present (CMYK data is then stored inverted). */
  adobe: boolean;
}

export function isJpeg(b: Uint8Array): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export function parseJpeg(b: Uint8Array): JpegInfo {
  if (!isJpeg(b)) throw new PdfError("not a JPEG file");
  let p = 2;
  let adobe = false;
  let frame: Omit<JpegInfo, "adobe"> | undefined;
  for (;;) {
    // Markers may be preceded by any number of 0xFF fill bytes; stray bytes
    // between segments are skipped, as libjpeg does.
    while (p < b.length && b[p] !== 0xff) p++;
    while (p < b.length && b[p] === 0xff) p++;
    if (p >= b.length) throw new PdfError("JPEG ends before its first scan");
    const marker = b[p++];
    if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // no length
    if (marker === 0xd9) throw new PdfError("JPEG ends before its first scan");
    if (p + 2 > b.length) throw new PdfError("JPEG is truncated inside a marker segment");
    const len = (b[p] << 8) | b[p + 1];
    if (len < 2 || p + len > b.length) throw new PdfError("JPEG marker segment runs past the end of the file");
    const seg = p + 2;
    const segEnd = p + len;
    if (marker === 0xda) {
      if (!frame) throw new PdfError("JPEG scan before its frame header");
      return { ...frame, adobe };
    }
    if (marker === 0xee && segEnd - seg >= 5) {
      adobe = b[seg] === 0x41 && b[seg + 1] === 0x64 && b[seg + 2] === 0x6f && b[seg + 3] === 0x62 && b[seg + 4] === 0x65;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (frame) throw new PdfError("JPEG has two frame headers");
      if (marker > 0xc2) throw new PdfError(`JPEG coding process SOF${marker - 0xc0} (lossless or arithmetic) cannot be embedded`);
      if (segEnd - seg < 6) throw new PdfError("JPEG frame header is too short");
      const precision = b[seg];
      const height = (b[seg + 1] << 8) | b[seg + 2];
      const width = (b[seg + 3] << 8) | b[seg + 4];
      const components = b[seg + 5];
      if (precision !== 8) throw new PdfError(`JPEG with ${precision}-bit samples cannot be embedded`);
      if (width === 0 || height === 0) throw new PdfError(`JPEG has invalid size ${width}x${height}`);
      if (width * height > MAX_PIXELS) throw new PdfError(`JPEG of ${width}x${height} pixels exceeds the ${MAX_PIXELS / 1e6} megapixel limit`);
      if (components !== 1 && components !== 3 && components !== 4) throw new PdfError(`JPEG with ${components} components cannot be embedded`);
      if (segEnd - seg < 6 + 3 * components) throw new PdfError("JPEG frame header is too short");
      frame = { width, height, components, progressive: marker === 0xc2 };
    }
    p = segEnd;
  }
}
