/**
 * A PNG encoder for page previews: 8-bit RGB or RGBA, not interlaced, zlib
 * compressed into a single IDAT chunk.
 *
 * Rows are stored unfiltered: anti-aliased text and flat colour on white
 * compress better that way than with any of the PNG row filters, and
 * deflate's fast mode (level 3) encodes a page in a few milliseconds where
 * the default level takes four times as long for files only a tenth smaller.
 */

import { deflateSync } from "node:zlib";
import { crc32 } from "../pdf/png.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Encodes `rgb` (width * height * channels bytes, row-major; 3 for RGB, 4 for RGBA unpremultiplied) as a PNG file. */
export function encodePng(width: number, height: number, rgb: Uint8Array, channels: 3 | 4 = 3): Uint8Array {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) || (channels !== 3 && channels !== 4) || rgb.length !== width * height * channels) {
    throw new RangeError(`encodePng: ${rgb.length} bytes do not make a ${width}x${height} ${channels === 4 ? "RGBA" : "RGB"} image`);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: RGBA or RGB
  // Compression, filter method and interlace are all 0.
  const row = channels * width;
  const raw = new Uint8Array(height * (row + 1)); // each row: filter type 0, then the samples
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
  const idat = deflateSync(raw, { level: 3 });
  const parts = [Uint8Array.from(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
