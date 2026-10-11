/**
 * Raster images as PDF image XObjects. JPEG data is embedded unchanged
 * (/DCTDecode). PNG is decoded and checked in full; 8-bit gray, RGB and
 * palette data that PDF can read as stored keeps the PNG's own zlib stream
 * (/FlateDecode with /Predictor 15), everything else is re-encoded as 8-bit
 * samples, and alpha goes to a separate /SMask image.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import type { ImageRef } from "../layout/types.js";
import { PdfError } from "./errors.js";
import { isJpeg, parseJpeg } from "./jpeg.js";
import { decodePng, isPng } from "./png.js";
import { type ObjectTable, ref } from "./serialize.js";

interface XObjectData {
  /** Dictionary entries without /Length (and /Filter, given separately). */
  dict: string;
  data: Uint8Array;
  filter: string;
}

export interface ImageEntry {
  ref: ImageRef;
  /** Resource name (without slash), assigned the first time the image is drawn. */
  resName?: string;
  image: XObjectData;
  smask?: XObjectData;
}

const predictorParms = (colors: number, width: number) => ` /DecodeParms << /Predictor 15 /Colors ${colors} /Columns ${width} >>`;

/**
 * 8-bit samples as image data: PNG row filters (/Predictor 15, which suits
 * photos and gradients) and Flate when compressing, raw samples otherwise.
 * `filters` gives each row's filter (from the source PNG); without it each
 * row gets the best of None, Sub, Up and Paeth.
 */
function encodeSamples(samples: Uint8Array, width: number, height: number, colors: number, compress: boolean, filters?: Uint8Array): { data: Uint8Array; parms: string } {
  // A predictor needs a filter to hang on, so it is only used when compressing.
  if (!compress) return { data: samples, parms: "" };
  return { data: deflateSync(predictRows(samples, width, height, colors, filters)), parms: predictorParms(colors, width) };
}

const residualCost = (r: number) => (r < 128 ? r : 256 - r);

function paeth(a: number, b: number, c: number): number {
  let pa = b - c;
  let pb = a - c;
  let pc = pa + pb;
  if (pa < 0) pa = -pa;
  if (pb < 0) pb = -pb;
  if (pc < 0) pc = -pc;
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * PNG filtering for /Predictor 15. Row y uses filters[y] when given, else
 * the filter among None, Sub, Up and Paeth with the smallest sum of absolute
 * residuals (libpng's heuristic).
 */
export function predictRows(src: Uint8Array, width: number, height: number, bpp: number, filters?: Uint8Array): Uint8Array {
  const rowBytes = width * bpp;
  const out = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const s = y * rowBytes;
    const up = s - rowBytes; // start of the previous row when y > 0
    let filter = filters ? filters[y] : 0;
    if (!filters) {
      let cNone = 0;
      let cSub = 0;
      let cUp = 0;
      let cPaeth = 0;
      for (let i = 0; i < rowBytes; i++) {
        const x = src[s + i];
        const a = i >= bpp ? src[s + i - bpp] : 0;
        const b = y > 0 ? src[up + i] : 0;
        const c = y > 0 && i >= bpp ? src[up + i - bpp] : 0;
        cNone += residualCost(x);
        cSub += residualCost((x - a) & 255);
        cUp += residualCost((x - b) & 255);
        cPaeth += residualCost((x - paeth(a, b, c)) & 255);
      }
      let best = cNone;
      if (cSub < best) (best = cSub), (filter = 1);
      if (cUp < best) (best = cUp), (filter = 2);
      if (cPaeth < best) filter = 4;
    }
    const o = y * (rowBytes + 1) + 1;
    out[o - 1] = filter;
    const lead = Math.min(bpp, rowBytes);
    if (filter === 0 || (y === 0 && filter === 2)) {
      out.set(src.subarray(s, s + rowBytes), o);
    } else if (filter === 1 || (y === 0 && filter === 4)) {
      // Paeth without a row above is Sub.
      for (let i = 0; i < lead; i++) out[o + i] = src[s + i];
      for (let i = lead; i < rowBytes; i++) out[o + i] = src[s + i] - src[s + i - bpp];
    } else if (filter === 2) {
      for (let i = 0; i < rowBytes; i++) out[o + i] = src[s + i] - src[up + i];
    } else if (filter === 3) {
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? src[s + i - bpp] : 0;
        const b = y > 0 ? src[up + i] : 0;
        out[o + i] = src[s + i] - ((a + b) >> 1);
      }
    } else {
      // Paeth with a row above: the first pixel has no left neighbour and predicts from above.
      for (let i = 0; i < lead; i++) out[o + i] = src[s + i] - src[up + i];
      for (let i = lead; i < rowBytes; i++) out[o + i] = src[s + i] - paeth(src[s + i - bpp], src[up + i], src[up + i - bpp]);
    }
  }
  return out;
}

/** Decodes or parses `bytes` (sniffed: PNG or JPEG) into XObject data. */
export function loadImage(bytes: Uint8Array, id: string, compress: boolean): ImageEntry {
  if (!(bytes instanceof Uint8Array)) throw new PdfError("image data must be a Uint8Array");
  if (isJpeg(bytes)) {
    const info = parseJpeg(bytes);
    const cs = info.components === 1 ? "/DeviceGray" : info.components === 3 ? "/DeviceRGB" : "/DeviceCMYK";
    const decode = info.components === 4 && info.adobe ? " /Decode [1 0 1 0 1 0 1 0]" : "";
    return {
      ref: { id, pixelWidth: info.width, pixelHeight: info.height },
      image: {
        dict: `/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8${decode}`,
        data: new Uint8Array(bytes),
        filter: "/DCTDecode",
      },
    };
  }
  if (isPng(bytes)) {
    // When compressing, 8-bit gray, RGB and palette data is embedded as the PNG stores it.
    const png = decodePng(bytes, { keepStream: compress });
    const { width, height } = png;
    const head = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8`;
    let cs: string;
    let colors: number;
    if (png.color === "indexed") {
      const pal = png.palette!;
      cs = `[/Indexed /DeviceRGB ${pal.length / 3 - 1} <${Buffer.from(pal).toString("hex").toUpperCase()}>]`;
      colors = 1;
    } else {
      cs = png.color === "rgb" ? "/DeviceRGB" : "/DeviceGray";
      colors = png.color === "rgb" ? 3 : 1;
    }
    const filter = compress ? "/FlateDecode" : "";
    // The source's row filters are a cheap, good choice unless the encoder left every row unfiltered.
    const filters = png.rowFilters?.some((f) => f !== 0) ? png.rowFilters : undefined;
    let main: { data: Uint8Array; parms: string };
    if (png.stream) {
      main = { data: new Uint8Array(png.stream), parms: predictorParms(colors, width) };
    } else if (png.color === "indexed") {
      // Palette indices compress best unfiltered.
      main = { data: compress ? deflateSync(png.pixels!) : png.pixels!, parms: "" };
    } else {
      main = encodeSamples(png.pixels!, width, height, colors, compress, filters);
    }
    const entry: ImageEntry = {
      ref: { id, pixelWidth: width, pixelHeight: height },
      image: { dict: `${head} /ColorSpace ${cs}${main.parms}`, data: main.data, filter },
    };
    if (png.alpha) {
      const mask = encodeSamples(png.alpha, width, height, 1, compress, filters);
      entry.smask = { dict: `${head} /ColorSpace /DeviceGray${mask.parms}`, data: mask.data, filter };
    }
    return entry;
  }
  throw new PdfError("unsupported image format: expected PNG or JPEG data");
}

/** A stable identifier for image bytes. */
export function imageId(bytes: Uint8Array): string {
  return "img-" + createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** Writes an image (and its soft mask) at object number `self`. */
export function writeImage(table: ObjectTable, self: number, entry: ImageEntry): void {
  let smaskRef = "";
  if (entry.smask) {
    const n = table.alloc();
    const m = entry.smask;
    table.stream(n, m.dict, m.data, m.filter ? { filter: m.filter } : { compress: false });
    smaskRef = ` /SMask ${ref(n)}`;
  }
  const im = entry.image;
  table.stream(self, im.dict + smaskRef, im.data, im.filter ? { filter: im.filter } : { compress: false });
}
