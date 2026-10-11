/**
 * A PNG decoder for embedding: chunks with CRC checks, IHDR/PLTE/tRNS/IDAT,
 * zlib inflate (node:zlib), the five row filters, Adam7 interlacing, bit
 * depths 1 to 16 and colour types 0, 2, 3, 4 and 6. Output is 8-bit samples
 * with alpha split off. Gamma, colour profiles and text chunks are ignored.
 *
 * Every size comes from the header and is checked before anything is
 * allocated from it; the pixel buffers are only allocated once the inflated
 * data has proved to be as long as the header says.
 */

import { constants, inflateSync } from "node:zlib";
import { PdfError } from "./errors.js";

export const MAX_PIXELS = 100_000_000;
/** Upper bound for the inflated, still filtered image data. */
const MAX_RAW_BYTES = 512 * 1024 * 1024;
/** Inflated data beyond what the header needs is ignored up to this much. */
const SLACK = 1 << 16;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(b: Uint8Array): boolean {
  if (b.length < 8) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== SIGNATURE[i]) return false;
  return true;
}

export interface DecodedPng {
  width: number;
  height: number;
  /** "gray": 1 sample per pixel, "rgb": 3, "indexed": 1 palette index. */
  color: "gray" | "rgb" | "indexed";
  /**
   * 8-bit samples, row-major, no padding. Absent only when `stream` was
   * requested and holds the colour data.
   */
  pixels?: Uint8Array;
  /**
   * The PNG's own zlib stream, when it can stand as the colour data of a PDF
   * image unchanged (8-bit gray, RGB or palette, not interlaced): /FlateDecode
   * with /Predictor 15, one or three colours, `width` columns.
   */
  stream?: Uint8Array;
  /** The filter type of every row (non-interlaced images), a good choice for re-encoding. */
  rowFilters?: Uint8Array;
  /** RGB triples for "indexed" (at least as many entries as any index used). */
  palette?: Uint8Array;
  /** 8-bit alpha per pixel, absent when the image is fully opaque. */
  alpha?: Uint8Array;
}

let crcTable: Uint32Array | undefined;

export function crc32(b: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

/** Adam7 passes: x0, y0, dx, dy. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

interface Header {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  interlace: number;
}

interface Chunks {
  header: Header;
  palette?: Uint8Array;
  trns?: Uint8Array;
  zdata: Uint8Array;
}

function readChunks(b: Uint8Array): Chunks {
  if (!isPng(b)) throw new PdfError("not a PNG file");
  let p = 8;
  let header: Header | undefined;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (p < b.length) {
    if (p + 12 > b.length) throw new PdfError("PNG is truncated inside a chunk header");
    const len = u32(b, p);
    if (len > 0x7fffffff || p + 12 + len > b.length) throw new PdfError("PNG chunk runs past the end of the file");
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const data = b.subarray(p + 8, p + 8 + len);
    if (crc32(b, p + 4, p + 8 + len) !== u32(b, p + 8 + len)) throw new PdfError(`PNG chunk ${JSON.stringify(type)} fails its CRC check`);
    p += 12 + len;
    if (!header && type !== "IHDR") throw new PdfError("PNG does not start with IHDR");
    if (type === "IEND") break;
    switch (type) {
      case "IHDR":
        if (header) throw new PdfError("PNG has two IHDR chunks");
        header = parseHeader(data);
        break;
      case "PLTE":
        if (len % 3 !== 0 || len === 0 || len > 768) throw new PdfError(`PNG palette has ${len} bytes`);
        if (idat.length) throw new PdfError("PNG palette after image data");
        palette = data;
        break;
      case "tRNS":
        trns = data;
        break;
      case "IDAT":
        if (len) idat.push(data);
        break;
      default:
        // Unknown critical chunks (upper-case first letter) cannot be skipped safely.
        if (type.charCodeAt(0) < 0x61) throw new PdfError(`PNG has an unknown critical chunk ${JSON.stringify(type)}`);
    }
  }
  if (!header) throw new PdfError("PNG has no IHDR chunk");
  if (!idat.length) throw new PdfError("PNG has no image data");
  if (header.colorType === 3 && !palette) throw new PdfError("paletted PNG has no PLTE chunk");
  return { header, palette, trns, zdata: idat.length === 1 ? idat[0] : Buffer.concat(idat) };
}

/**
 * Decodes a PNG. With `keepStream`, an image whose colour data PDF can use
 * as stored comes back with `stream` (and without `pixels` when no alpha has
 * to be computed from it), which spares decoding and re-compressing it.
 */
export function decodePng(b: Uint8Array, opts: { keepStream?: boolean } = {}): DecodedPng {
  const chunks = readChunks(b);
  const { header, palette, zdata } = chunks;
  let trns = chunks.trns;
  const { width, height, depth, colorType, interlace } = header;

  const channels = CHANNELS[colorType];
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]];
  const sizes = passes.map(([x0, y0, dx, dy]) => {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    return { w, h, rowBytes: Math.ceil((w * bitsPerPixel) / 8) };
  });
  let expected = 0;
  for (const s of sizes) if (s.w && s.h) expected += (s.rowBytes + 1) * s.h;
  if (expected > MAX_RAW_BYTES) throw new PdfError(`PNG of ${width}x${height} pixels is too large to embed`);

  let raw: Uint8Array;
  try {
    raw = inflateSync(zdata, { maxOutputLength: expected + SLACK, finishFlush: constants.Z_SYNC_FLUSH });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError) throw new PdfError("PNG holds more image data than its size needs");
    throw new PdfError(`PNG image data is corrupt: ${(e as Error).message}`);
  }
  if (raw.length < expected) throw new PdfError(`PNG image data is truncated (${raw.length} of ${expected} bytes)`);

  const color = colorType === 3 ? "indexed" : colorType === 2 || colorType === 6 ? "rgb" : "gray";
  const rowBytes0 = sizes[0].rowBytes;
  const rowFilters = interlace ? undefined : new Uint8Array(height);
  if (rowFilters) {
    for (let r = 0; r < height; r++) {
      const f = raw[r * (rowBytes0 + 1)];
      if (f > 4) throw new PdfError(`PNG row has invalid filter type ${f}`);
      rowFilters[r] = f;
    }
  }

  // The stored stream is the colour data as it stands: no decoding needed
  // unless a tRNS chunk asks for an alpha mask.
  const passThrough = opts.keepStream === true && !interlace && depth === 8 && (colorType === 0 || colorType === 2 || colorType === 3);
  if (passThrough && !trns) {
    let outPalette: Uint8Array | undefined;
    if (colorType === 3) {
      // Indices are unchecked here, so every 8-bit index gets an entry (black past the end).
      outPalette = new Uint8Array(768);
      outPalette.set(palette!);
    }
    return { width, height, color, stream: zdata, rowFilters, palette: outPalette };
  }

  // Pixel buffers: allocated only now that the data is known to be complete.
  const outChannels = color === "rgb" ? 3 : 1;
  const pixels = new Uint8Array(width * height * outChannels);
  const hasAlpha = colorType === 4 || colorType === 6 || trns !== undefined;
  const alpha = hasAlpha ? new Uint8Array(width * height).fill(255) : undefined;

  // tRNS: a colour key for gray/RGB, per-entry alpha for palettes.
  let keyGray = -1;
  let keyR = -1;
  let keyG = -1;
  let keyB = -1;
  if (trns) {
    if (colorType === 0) {
      if (trns.length < 2) throw new PdfError("PNG tRNS chunk is too short");
      keyGray = (trns[0] << 8) | trns[1];
    } else if (colorType === 2) {
      if (trns.length < 6) throw new PdfError("PNG tRNS chunk is too short");
      keyR = (trns[0] << 8) | trns[1];
      keyG = (trns[2] << 8) | trns[3];
      keyB = (trns[4] << 8) | trns[5];
    } else if (colorType === 3) {
      // Entries past the palette's end are meaningless; ignore them.
      if (trns.length > palette!.length / 3) trns = trns.subarray(0, palette!.length / 3);
    }
  }
  const trnsTable = colorType === 3 && trns ? trns : undefined;

  let maxIndex = 0;
  let at = 0;
  for (let pi = 0; pi < passes.length; pi++) {
    const { w, h, rowBytes } = sizes[pi];
    if (!w || !h) continue;
    const [x0, y0, dx, dy] = passes[pi];
    let prev = -1;
    for (let r = 0; r < h; r++) {
      const start = at + 1;
      unfilterRow(raw, raw[at], start, rowBytes, bpp, prev);
      prev = start;
      at = start + rowBytes;
      const y = y0 + r * dy;
      if (dx === 1 && depth === 8) {
        // Fast paths: a whole row of 8-bit samples.
        const px0 = y * width;
        switch (colorType) {
          case 0:
            pixels.set(raw.subarray(start, start + w), px0);
            if (keyGray >= 0) for (let c = 0; c < w; c++) if (raw[start + c] === keyGray) alpha![px0 + c] = 0;
            break;
          case 2:
            pixels.set(raw.subarray(start, start + 3 * w), 3 * px0);
            if (keyR >= 0) {
              for (let c = 0, s = start; c < w; c++, s += 3) {
                if (raw[s] === keyR && raw[s + 1] === keyG && raw[s + 2] === keyB) alpha![px0 + c] = 0;
              }
            }
            break;
          case 3:
            pixels.set(raw.subarray(start, start + w), px0);
            for (let c = 0; c < w; c++) {
              const v = raw[start + c];
              if (v > maxIndex) maxIndex = v;
              if (trnsTable && v < trnsTable.length) alpha![px0 + c] = trnsTable[v];
            }
            break;
          case 4:
            for (let c = 0, s = start; c < w; c++, s += 2) {
              pixels[px0 + c] = raw[s];
              alpha![px0 + c] = raw[s + 1];
            }
            break;
          default:
            for (let c = 0, s = start, o = 3 * px0; c < w; c++, s += 4, o += 3) {
              pixels[o] = raw[s];
              pixels[o + 1] = raw[s + 1];
              pixels[o + 2] = raw[s + 2];
              alpha![px0 + c] = raw[s + 3];
            }
        }
        continue;
      }
      for (let c = 0; c < w; c++) {
        const px = y * width + x0 + c * dx;
        const s = c * channels; // sample index within the row
        switch (colorType) {
          case 0: {
            const v = sample(raw, start, s, depth);
            pixels[px] = depth === 16 ? v >> 8 : depth < 8 ? Math.round((v * 255) / ((1 << depth) - 1)) : v;
            if (v === keyGray) alpha![px] = 0;
            break;
          }
          case 2: {
            const rr = sample(raw, start, s, depth);
            const gg = sample(raw, start, s + 1, depth);
            const bb = sample(raw, start, s + 2, depth);
            const shift = depth === 16 ? 8 : 0;
            pixels[3 * px] = rr >> shift;
            pixels[3 * px + 1] = gg >> shift;
            pixels[3 * px + 2] = bb >> shift;
            if (rr === keyR && gg === keyG && bb === keyB) alpha![px] = 0;
            break;
          }
          case 3: {
            const v = sample(raw, start, s, depth);
            pixels[px] = v;
            if (v > maxIndex) maxIndex = v;
            if (trnsTable && v < trnsTable.length) alpha![px] = trnsTable[v];
            break;
          }
          case 4: {
            const shift = depth === 16 ? 8 : 0;
            pixels[px] = sample(raw, start, s, depth) >> shift;
            alpha![px] = sample(raw, start, s + 1, depth) >> shift;
            break;
          }
          default: {
            const shift = depth === 16 ? 8 : 0;
            pixels[3 * px] = sample(raw, start, s, depth) >> shift;
            pixels[3 * px + 1] = sample(raw, start, s + 1, depth) >> shift;
            pixels[3 * px + 2] = sample(raw, start, s + 2, depth) >> shift;
            alpha![px] = sample(raw, start, s + 3, depth) >> shift;
          }
        }
      }
    }
  }

  let outPalette: Uint8Array | undefined;
  if (colorType === 3) {
    // Indices past the palette's end show black, as most decoders do.
    outPalette = new Uint8Array(Math.max(palette!.length / 3, maxIndex + 1) * 3);
    outPalette.set(palette!);
  }
  let opaque = true;
  if (alpha) {
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] !== 255) {
        opaque = false;
        break;
      }
    }
  }
  return {
    width,
    height,
    color,
    pixels,
    stream: passThrough ? zdata : undefined,
    rowFilters,
    palette: passThrough && outPalette ? padPalette(outPalette) : outPalette,
    alpha: alpha && !opaque ? alpha : undefined,
  };
}

function padPalette(p: Uint8Array): Uint8Array {
  const out = new Uint8Array(768);
  out.set(p.subarray(0, 768));
  return out;
}

/** Sample `i` of a row of `depth`-bit samples starting at byte `start`. */
function sample(b: Uint8Array, start: number, i: number, depth: number): number {
  switch (depth) {
    case 8:
      return b[start + i];
    case 16:
      return (b[start + 2 * i] << 8) | b[start + 2 * i + 1];
    default: {
      const bit = i * depth;
      return (b[start + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    }
  }
}

function parseHeader(d: Uint8Array): Header {
  if (d.length !== 13) throw new PdfError(`PNG IHDR has ${d.length} bytes`);
  const width = u32(d, 0);
  const height = u32(d, 4);
  const depth = d[8];
  const colorType = d[9];
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) throw new PdfError(`PNG has invalid size ${width}x${height}`);
  if (width * height > MAX_PIXELS) throw new PdfError(`PNG of ${width}x${height} pixels exceeds the ${MAX_PIXELS / 1e6} megapixel limit`);
  if (!DEPTHS[colorType]) throw new PdfError(`PNG has invalid colour type ${colorType}`);
  if (!DEPTHS[colorType].includes(depth)) throw new PdfError(`PNG colour type ${colorType} cannot have bit depth ${depth}`);
  if (d[10] !== 0 || d[11] !== 0) throw new PdfError("PNG uses an unknown compression or filter method");
  if (d[12] > 1) throw new PdfError(`PNG has invalid interlace method ${d[12]}`);
  return { width, height, depth, colorType, interlace: d[12] };
}

/**
 * Reverses a row's filter in place. `prev` is the start of the previous
 * (already unfiltered) row of the same pass, or -1 for the first row.
 */
export function unfilterRow(b: Uint8Array, filter: number, start: number, len: number, bpp: number, prev: number): void {
  const end = start + len;
  const lead = Math.min(end, start + bpp); // bytes without a left neighbour
  switch (filter) {
    case 0:
      return;
    case 1:
      for (let i = lead; i < end; i++) b[i] += b[i - bpp];
      return;
    case 2:
      if (prev >= 0) for (let i = start, j = prev; i < end; i++, j++) b[i] += b[j];
      return;
    case 3:
      if (prev < 0) {
        for (let i = lead; i < end; i++) b[i] += b[i - bpp] >> 1;
      } else {
        let i = start;
        let j = prev;
        for (; i < lead; i++, j++) b[i] += b[j] >> 1;
        for (; i < end; i++, j++) b[i] += (b[i - bpp] + b[j]) >> 1;
      }
      return;
    case 4:
      if (prev < 0) {
        // Without a row above, Paeth picks the left neighbour (Sub).
        for (let i = lead; i < end; i++) b[i] += b[i - bpp];
      } else {
        let i = start;
        let j = prev;
        // Without a left neighbour, Paeth picks the byte above (Up).
        for (; i < lead; i++, j++) b[i] += b[j];
        for (; i < end; i++, j++) {
          const a = b[i - bpp];
          const up = b[j];
          const c = b[j - bpp];
          let pa = up - c;
          let pb = a - c;
          let pc = pa + pb;
          if (pa < 0) pa = -pa;
          if (pb < 0) pb = -pb;
          if (pc < 0) pc = -pc;
          b[i] += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
        }
      }
      return;
    default:
      throw new PdfError(`PNG row has invalid filter type ${filter}`);
  }
}
