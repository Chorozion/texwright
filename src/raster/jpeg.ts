/**
 * A baseline JPEG decoder (ITU T.81 sequential DCT with Huffman coding,
 * 8-bit samples: SOF0 and SOF1), for drawing JPEG images into page
 * previews. Handles interleaved and single-component scans, restart
 * intervals, any sampling factors (4:4:4, 4:2:2, 4:2:0 and the rest, with
 * chroma upsampled by linear interpolation), grayscale, RGB, YCbCr, CMYK
 * and YCCK (Adobe APP14). Progressive files are reported, not decoded.
 *
 * Sizes come from the frame header and are checked (by parseJpeg) before
 * anything is allocated; entropy-coded data that ends early decodes as
 * zeros rather than failing, as most viewers show truncated files.
 */

import { PdfError } from "../pdf/errors.js";
import { parseJpeg } from "../pdf/jpeg.js";

export interface DecodedJpeg {
  width: number;
  height: number;
  /** 8-bit RGB, row-major. */
  rgb: Uint8Array;
}

/** Zigzag position -> natural (row-major) position in an 8x8 block. */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44,
  51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/**
 * The 8-point IDCT is x[n] = sum over u of K(n, u) X[u] with
 * K(n, u) = C(u) / 2 cos((2n + 1) u pi / 16), C(0) = 1 / sqrt 2. Since
 * K(7 - n, u) = (-1)^u K(n, u), the even terms E and odd terms O of the first
 * four outputs give all eight: x[n] = E[n] + O[n], x[7 - n] = E[n] - O[n].
 * The even part folds once more (A, B, D below); the odd part uses ODD.
 */
const A = Math.SQRT1_2 / 2; // K(n, 0), and |K(n, 4)|
const B = Math.cos(Math.PI / 8) / 2;
const D = Math.cos((3 * Math.PI) / 8) / 2;
/** ODD[n * 4 + k] = K(n, 2k + 1) for n < 4. */
const ODD = new Float64Array(16);
for (let n = 0; n < 4; n++) {
  for (let k = 0; k < 4; k++) ODD[n * 4 + k] = Math.cos(((2 * n + 1) * (2 * k + 1) * Math.PI) / 16) / 2;
}

/** Codes of up to this many bits decode with one table lookup. */
const FAST_BITS = 9;

interface Huffman {
  /** (length << 8) | value for every FAST_BITS-bit prefix that starts with a short code; 0 otherwise. */
  fast: Uint16Array;
  /** Largest code of each length (-1 when none), lengths 1..16. */
  maxCode: Int32Array;
  /** Index into values of the first code of each length, minus that code. */
  delta: Int32Array;
  values: Uint8Array;
}

function buildHuffman(counts: Uint8Array, values: Uint8Array): Huffman {
  const fast = new Uint16Array(1 << FAST_BITS);
  const maxCode = new Int32Array(17).fill(-1);
  const delta = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const n = counts[len - 1];
    delta[len] = k - code;
    for (let i = 0; i < n; i++, k++, code++) {
      if (len <= FAST_BITS) {
        const shift = FAST_BITS - len;
        const base = code << shift;
        for (let j = 0; j < 1 << shift; j++) fast[base + j] = (len << 8) | values[k];
      }
    }
    if (n) maxCode[len] = code - 1;
    if (code > 1 << len) throw new PdfError("JPEG Huffman table has too many codes");
    code <<= 1;
  }
  return { fast, maxCode, delta, values };
}

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** Blocks per line and per column in the padded plane. */
  bw: number;
  bh: number;
  /** Width and height in samples (unpadded). */
  w: number;
  ht: number;
  plane: Uint8ClampedArray;
  dc?: Huffman;
  ac?: Huffman;
  pred: number;
}

/** Bit reader over entropy-coded data: skips stuffed zero bytes, stops at markers. */
class Bits {
  private acc = 0;
  private n = 0;
  /** The marker that ended the data so far (-1 for none); bits past it read as zeros. */
  private marker = -1;

  constructor(
    private readonly b: Uint8Array,
    private p: number,
  ) {}

  private fill(): void {
    while (this.n <= 24) {
      let byte = 0;
      if (this.marker < 0 && this.p < this.b.length) {
        byte = this.b[this.p];
        if (byte === 0xff) {
          const next = this.b[this.p + 1];
          if (next === 0) this.p += 2;
          else {
            this.marker = next ?? 0xd9;
            byte = 0;
          }
        } else this.p++;
      }
      this.acc = ((this.acc << 8) | byte) >>> 0;
      this.n += 8;
    }
  }

  bits(count: number): number {
    if (this.n < count) this.fill();
    this.n -= count;
    return (this.acc >>> this.n) & ((1 << count) - 1);
  }

  decode(t: Huffman): number {
    if (this.n < 16) this.fill();
    const peek = (this.acc >>> (this.n - FAST_BITS)) & ((1 << FAST_BITS) - 1);
    const f = t.fast[peek];
    if (f) {
      this.n -= f >> 8;
      return f & 255;
    }
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | ((this.acc >>> (this.n - len)) & 1);
      if (code <= t.maxCode[len]) {
        this.n -= len;
        return t.values[t.delta[len] + code];
      }
    }
    throw new PdfError("JPEG data holds an invalid Huffman code");
  }

  /** A value of `s` bits, sign-extended as in T.81 F.2.2.1. */
  receive(s: number): number {
    if (s === 0) return 0;
    const v = this.bits(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  }

  /** Byte-aligns at a restart marker and moves past it. */
  restart(): void {
    this.acc = 0;
    this.n = 0;
    if (this.marker >= 0xd0 && this.marker <= 0xd7) {
      this.p += 2;
      this.marker = -1;
      return;
    }
    // No marker seen yet: find the next RSTn (skipping any padding bits).
    while (this.p + 1 < this.b.length && !(this.b[this.p] === 0xff && this.b[this.p + 1] >= 0xd0 && this.b[this.p + 1] <= 0xd7)) this.p++;
    if (this.p + 1 < this.b.length) this.p += 2;
    this.marker = -1;
  }

  /** Position of the marker that ended the scan, for reading the segments after it. */
  end(): number {
    let p = this.p;
    while (p + 1 < this.b.length && !(this.b[p] === 0xff && this.b[p + 1] !== 0 && !(this.b[p + 1] >= 0xd0 && this.b[p + 1] <= 0xd7))) p++;
    return p;
  }
}

/**
 * Decodes a JPEG to RGB. Returns "progressive" for progressive files;
 * throws PdfError for files it cannot read (parseJpeg's checks, then
 * corrupt tables or Huffman data).
 */
export function decodeJpeg(b: Uint8Array): DecodedJpeg | "progressive" {
  const info = parseJpeg(b);
  if (info.progressive) return "progressive";
  const quant: Uint16Array[] = [];
  const dcTables: Huffman[] = [];
  const acTables: Huffman[] = [];
  let comps: Component[] = [];
  let width = 0;
  let height = 0;
  let hmax = 1;
  let vmax = 1;
  let restartInterval = 0;
  let adobeTransform = -1;
  let jfif = false;
  let p = 2;
  for (;;) {
    while (p < b.length && b[p] !== 0xff) p++;
    while (p < b.length && b[p] === 0xff) p++;
    if (p >= b.length) break;
    const marker = b[p++];
    if (marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (p + 2 > b.length) break;
    const len = (b[p] << 8) | b[p + 1];
    const seg = p + 2;
    const end = p + len;
    if (len < 2 || end > b.length) throw new PdfError("JPEG marker segment runs past the end of the file");
    switch (marker) {
      case 0xdb: {
        // DQT
        let q = seg;
        while (q < end) {
          const pq = b[q] >> 4;
          const tq = b[q] & 15;
          q++;
          if (tq > 3) throw new PdfError("JPEG quantization table id is out of range");
          const table = new Uint16Array(64);
          for (let i = 0; i < 64; i++) {
            if (q + (pq ? 2 : 1) > end) throw new PdfError("JPEG quantization table is truncated");
            table[ZIGZAG[i]] = pq ? (b[q] << 8) | b[q + 1] : b[q];
            q += pq ? 2 : 1;
          }
          quant[tq] = table;
        }
        break;
      }
      case 0xc4: {
        // DHT
        let q = seg;
        while (q < end) {
          if (q + 17 > end) throw new PdfError("JPEG Huffman table is truncated");
          const tc = b[q] >> 4;
          const th = b[q] & 15;
          const counts = b.subarray(q + 1, q + 17);
          let total = 0;
          for (const c of counts) total += c;
          if (th > 3 || tc > 1 || total > 256 || q + 17 + total > end) throw new PdfError("JPEG Huffman table is malformed");
          const table = buildHuffman(counts, b.subarray(q + 17, q + 17 + total));
          (tc ? acTables : dcTables)[th] = table;
          q += 17 + total;
        }
        break;
      }
      case 0xc0:
      case 0xc1: {
        // SOF0/SOF1 (parseJpeg has checked precision, size and component count)
        height = (b[seg + 1] << 8) | b[seg + 2];
        width = (b[seg + 3] << 8) | b[seg + 4];
        const n = b[seg + 5];
        comps = [];
        for (let i = 0; i < n; i++) {
          const o = seg + 6 + 3 * i;
          const h = b[o + 1] >> 4;
          const v = b[o + 1] & 15;
          if (h < 1 || h > 4 || v < 1 || v > 4) throw new PdfError("JPEG sampling factor is out of range");
          comps.push({ id: b[o], h, v, tq: b[o + 2] & 3, bw: 0, bh: 0, w: 0, ht: 0, plane: new Uint8ClampedArray(0), pred: 0 });
        }
        hmax = Math.max(...comps.map((c) => c.h));
        vmax = Math.max(...comps.map((c) => c.v));
        const mcusX = Math.ceil(width / (8 * hmax));
        const mcusY = Math.ceil(height / (8 * vmax));
        for (const c of comps) {
          c.w = Math.ceil((width * c.h) / hmax);
          c.ht = Math.ceil((height * c.v) / vmax);
          c.bw = mcusX * c.h;
          c.bh = mcusY * c.v;
          c.plane = new Uint8ClampedArray(c.bw * 8 * c.bh * 8);
        }
        break;
      }
      case 0xdd:
        restartInterval = (b[seg] << 8) | b[seg + 1];
        break;
      case 0xe0:
        jfif ||= len >= 7 && b[seg] === 0x4a && b[seg + 1] === 0x46 && b[seg + 2] === 0x49 && b[seg + 3] === 0x46 && b[seg + 4] === 0;
        break;
      case 0xee:
        if (len >= 14 && b[seg] === 0x41 && b[seg + 1] === 0x64 && b[seg + 2] === 0x6f && b[seg + 3] === 0x62 && b[seg + 4] === 0x65) adobeTransform = b[seg + 11];
        break;
      case 0xda: {
        // SOS: decode the scan, then continue after the data.
        if (!comps.length) throw new PdfError("JPEG scan before its frame header");
        const ns = b[seg];
        if (ns < 1 || ns > 4 || len < 6 + 2 * ns) throw new PdfError("JPEG scan header is malformed");
        const scan: Component[] = [];
        for (let i = 0; i < ns; i++) {
          const id = b[seg + 1 + 2 * i];
          const c = comps.find((k) => k.id === id);
          if (!c) throw new PdfError(`JPEG scan names unknown component ${id}`);
          const dc = dcTables[b[seg + 2 + 2 * i] >> 4];
          const ac = acTables[b[seg + 2 + 2 * i] & 15];
          if (!dc || !ac) throw new PdfError("JPEG scan uses a Huffman table that was not defined");
          c.dc = dc;
          c.ac = ac;
          scan.push(c);
        }
        for (const c of scan) if (!quant[c.tq]) throw new PdfError("JPEG component uses a quantization table that was not defined");
        p = decodeScan(b, end, scan, quant, restartInterval, Math.ceil(width / (8 * hmax)), Math.ceil(height / (8 * vmax)));
        continue;
      }
      default:
        break;
    }
    p = end;
  }
  if (!comps.length) throw new PdfError("JPEG has no frame header");

  // Clamped output rounds and clamps every value written to it.
  const out = new Uint8ClampedArray(width * height * 3);
  const planes = comps.map((c) => upsample(c, width, height, hmax, vmax));
  const n = comps.length;
  const count = width * height;
  if (n === 1) {
    const g = planes[0];
    for (let i = 0, o = 0; i < count; i++, o += 3) out[o] = out[o + 1] = out[o + 2] = g[i];
    return { width, height, rgb: new Uint8Array(out.buffer) };
  }
  const ids = comps.map((c) => c.id).join(",");
  // Colour transform: Adobe's flag when present; else JFIF and the usual case are YCbCr, ids R,G,B mean RGB.
  const transform = adobeTransform >= 0 ? adobeTransform : n === 3 && !jfif && ids === "82,71,66" ? 0 : n === 3 ? 1 : 0;
  const [c0, c1, c2] = planes;
  if (transform) {
    for (let i = 0, o = 0; i < count; i++, o += 3) {
      const y = c0[i];
      const cb = c1[i] - 128;
      const cr = c2[i] - 128;
      out[o] = y + 1.402 * cr;
      out[o + 1] = y - 0.344136 * cb - 0.714136 * cr;
      out[o + 2] = y + 1.772 * cb;
    }
  } else {
    for (let i = 0, o = 0; i < count; i++, o += 3) {
      out[o] = c0[i];
      out[o + 1] = c1[i];
      out[o + 2] = c2[i];
    }
  }
  if (n === 4) {
    // Adobe files store CMYK inverted (and YCCK's colour part is inverted CMY), so
    // the values are already 1 - C and so on; otherwise they are inverted here.
    const k = planes[3];
    const inverted = adobeTransform >= 0;
    for (let i = 0, o = 0; i < count; i++, o += 3) {
      const kk = inverted ? k[i] : 255 - k[i];
      for (let ch = 0; ch < 3; ch++) out[o + ch] = ((inverted ? out[o + ch] : 255 - out[o + ch]) * kk) / 255;
    }
  }
  return { width, height, rgb: new Uint8Array(out.buffer) };
}

/** Decodes one scan's entropy-coded data starting at `start`; returns where the data ends. */
function decodeScan(b: Uint8Array, start: number, scan: Component[], quant: Uint16Array[], restartInterval: number, mcusX: number, mcusY: number): number {
  const bits = new Bits(b, start);
  const coef = new Float64Array(64);
  const tmp = new Float64Array(64);
  for (const c of scan) c.pred = 0;
  const single = scan.length === 1;
  // A single-component scan covers just that component's blocks, not whole MCUs.
  const unitsX = single ? Math.ceil(scan[0].w / 8) : mcusX;
  const unitsY = single ? Math.ceil(scan[0].ht / 8) : mcusY;
  let todo = restartInterval;
  for (let my = 0; my < unitsY; my++) {
    for (let mx = 0; mx < unitsX; mx++) {
      if (restartInterval) {
        if (todo === 0) {
          bits.restart();
          for (const c of scan) c.pred = 0;
          todo = restartInterval;
        }
        todo--;
      }
      for (const c of scan) {
        const q = quant[c.tq];
        const bh = single ? 1 : c.v;
        const bw = single ? 1 : c.h;
        for (let by = 0; by < bh; by++) {
          for (let bx = 0; bx < bw; bx++) {
            coef.fill(0);
            const t = bits.decode(c.dc!);
            if (t > 16) throw new PdfError("JPEG DC difference is out of range");
            c.pred += bits.receive(t);
            coef[0] = c.pred * q[0];
            let ac = false;
            for (let k = 1; k < 64; ) {
              const rs = bits.decode(c.ac!);
              const r = rs >> 4;
              const s = rs & 15;
              if (s === 0) {
                if (r !== 15) break;
                k += 16;
                continue;
              }
              k += r;
              if (k > 63) break;
              const z = ZIGZAG[k];
              coef[z] = bits.receive(s) * q[z];
              ac = true;
              k++;
            }
            const row = single ? my : my * c.v + by;
            const col = single ? mx : mx * c.h + bx;
            const at = (row * 8 * c.bw + col) * 8;
            const stride = c.bw * 8;
            if (ac) idct(coef, tmp, c.plane, at, stride);
            else {
              // Only the DC term: a flat block at F(0,0) / 8, level-shifted.
              const flat = coef[0] / 8 + 128;
              for (let yy = 0; yy < 8; yy++) c.plane.fill(flat, at + yy * stride, at + yy * stride + 8);
            }
          }
        }
      }
    }
  }
  return bits.end();
}

/** One 8-point IDCT: reads src[s + u * ss] for u = 0..7, writes dst[d + n * ds] for n = 0..7. */
function idct8(src: Float64Array, s: number, ss: number, dst: Float64Array, d: number, ds: number): void {
  const x0 = src[s];
  const x1 = src[s + ss];
  const x2 = src[s + 2 * ss];
  const x3 = src[s + 3 * ss];
  const x4 = src[s + 4 * ss];
  const x5 = src[s + 5 * ss];
  const x6 = src[s + 6 * ss];
  const x7 = src[s + 7 * ss];
  const t0 = A * (x0 + x4);
  const t1 = A * (x0 - x4);
  const t2 = B * x2 + D * x6;
  const t3 = D * x2 - B * x6;
  const e0 = t0 + t2;
  const e1 = t1 + t3;
  const e2 = t1 - t3;
  const e3 = t0 - t2;
  const o0 = ODD[0] * x1 + ODD[1] * x3 + ODD[2] * x5 + ODD[3] * x7;
  const o1 = ODD[4] * x1 + ODD[5] * x3 + ODD[6] * x5 + ODD[7] * x7;
  const o2 = ODD[8] * x1 + ODD[9] * x3 + ODD[10] * x5 + ODD[11] * x7;
  const o3 = ODD[12] * x1 + ODD[13] * x3 + ODD[14] * x5 + ODD[15] * x7;
  dst[d] = e0 + o0;
  dst[d + ds] = e1 + o1;
  dst[d + 2 * ds] = e2 + o2;
  dst[d + 3 * ds] = e3 + o3;
  dst[d + 4 * ds] = e3 - o3;
  dst[d + 5 * ds] = e2 - o2;
  dst[d + 6 * ds] = e1 - o1;
  dst[d + 7 * ds] = e0 - o0;
}

/** Inverse DCT of a dequantized block into the plane at `at`, level-shifted (the clamped plane rounds and clamps). */
function idct(coef: Float64Array, tmp: Float64Array, out: Uint8ClampedArray, at: number, stride: number): void {
  // Rows first; a row of zeros transforms to zeros.
  for (let y = 0; y < 64; y += 8) {
    if (coef[y + 1] === 0 && coef[y + 2] === 0 && coef[y + 3] === 0 && coef[y + 4] === 0 && coef[y + 5] === 0 && coef[y + 6] === 0 && coef[y + 7] === 0) {
      tmp.fill(A * coef[y], y, y + 8);
    } else idct8(coef, y, 1, tmp, y, 1);
  }
  // Then columns, in place.
  for (let x = 0; x < 8; x++) idct8(tmp, x, 8, tmp, x, 8);
  for (let y = 0; y < 8; y++) {
    const o = at + y * stride;
    for (let x = 0; x < 8; x++) out[o + x] = tmp[y * 8 + x] + 128;
  }
}

/**
 * A component at full image size. Subsampled components are interpolated
 * linearly between sample centres (each sample sits at the middle of the
 * pixels it stands for), clamped at the edges.
 */
function upsample(c: Component, width: number, height: number, hmax: number, vmax: number): Uint8ClampedArray {
  const stride = c.bw * 8;
  const out = new Uint8ClampedArray(width * height);
  const p = c.plane;
  if (c.h === hmax && c.v === vmax) {
    for (let y = 0; y < height; y++) out.set(p.subarray(y * stride, y * stride + width), y * width);
    return out;
  }
  const sx = c.h / hmax;
  const sy = c.v / vmax;
  const maxX = c.w - 1;
  const maxY = c.ht - 1;
  // Where each output column samples the component: two neighbours and a weight.
  const x0s = new Int32Array(width);
  const x1s = new Int32Array(width);
  const fxs = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const f = Math.min(maxX, Math.max(0, (x + 0.5) * sx - 0.5));
    const i = Math.floor(f);
    x0s[x] = i;
    x1s[x] = Math.min(i + 1, maxX);
    fxs[x] = f - i;
  }
  // Each output row blends two component rows, then interpolates across.
  const row = new Float64Array(c.w);
  for (let y = 0; y < height; y++) {
    const f = Math.min(maxY, Math.max(0, (y + 0.5) * sy - 0.5));
    const j = Math.floor(f);
    const fy = f - j;
    const r0 = j * stride;
    const r1 = Math.min(j + 1, maxY) * stride;
    for (let i = 0; i < c.w; i++) row[i] = p[r0 + i] + (p[r1 + i] - p[r0 + i]) * fy;
    const o = y * width;
    for (let x = 0; x < width; x++) {
      const a = row[x0s[x]];
      out[o + x] = a + (row[x1s[x]] - a) * fxs[x];
    }
  }
  return out;
}
