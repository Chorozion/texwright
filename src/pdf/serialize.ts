/**
 * PDF lexical primitives: numbers, names, strings, dates, and the indirect
 * object table that becomes the file body, cross-reference table and
 * trailer.
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { PdfError } from "./errors.js";
import { Lru } from "../util/lru.js";

// ------------------------------------------------------------------ numbers

const LIMIT = 1e20;

/**
 * A number in PDF syntax: at most four decimals, no exponent, never "-0".
 * Integers print as integers. Throws PdfError for NaN and infinities.
 */
export function num(v: number): string {
  if (Number.isInteger(v) && v > -1e15 && v < 1e15) return v === 0 ? "0" : String(v);
  if (!Number.isFinite(v)) throw new PdfError(`cannot write the number ${v} to a PDF`);
  if (v > LIMIT) v = LIMIT;
  else if (v < -LIMIT) v = -LIMIT;
  const s = v.toFixed(4);
  let end = s.length;
  while (s.charCodeAt(end - 1) === 48) end--;
  if (s.charCodeAt(end - 1) === 46) end--;
  const out = end === s.length ? s : s.slice(0, end);
  return out === "-0" ? "0" : out;
}

/** v rounded to four decimals: the value a reader parses back from num(v). */
export function round4(v: number): number {
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}

/** v rounded to two decimals (used for TJ adjustments). */
export function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

// -------------------------------------------------------------------- names

const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25, 0x23]);

/** A PDF name object: "/" plus the UTF-8 bytes, with #xx escapes where needed. */
export function pdfName(s: string): string {
  let out = "/";
  for (const b of Buffer.from(s, "utf8")) {
    if (b < 0x21 || b > 0x7e || DELIMITERS.has(b)) out += "#" + hex2(b);
    else out += String.fromCharCode(b);
  }
  return out;
}

/**
 * A PostScript font name usable as a PDF name without escapes: printable
 * ASCII minus delimiters and spaces, at most 63 characters, never empty.
 */
export function sanitizeFontName(s: string): string {
  let out = "";
  for (let i = 0; i < s.length && out.length < 63; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x20 && c < 0x7f && !DELIMITERS.has(c)) out += s[i];
  }
  return out || "Font";
}

// ------------------------------------------------------------------ strings

const HEX = "0123456789ABCDEF";

export function hex2(b: number): string {
  return HEX[(b >> 4) & 15] + HEX[b & 15];
}

export function hex4(v: number): string {
  return HEX[(v >> 12) & 15] + HEX[(v >> 8) & 15] + HEX[(v >> 4) & 15] + HEX[v & 15];
}

/** A literal string from bytes: \\, ( and ) escaped, anything outside printable ASCII as octal. */
export function literalBytes(bytes: Uint8Array): string {
  let out = "(";
  for (const b of bytes) {
    if (b === 0x5c || b === 0x28 || b === 0x29) out += "\\" + String.fromCharCode(b);
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += "\\" + b.toString(8).padStart(3, "0");
  }
  return out + ")";
}

/** Lone surrogates replaced with U+FFFD, so every string encodes as valid UTF-16. */
export function wellFormed(s: string): string {
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c > 0xdfff) continue;
    if (c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
    }
    out += s.slice(start, i) + "�";
    start = i + 1;
  }
  return start === 0 ? s : out + s.slice(start);
}

/**
 * A text string (document information, titles, /Lang): a literal for
 * printable ASCII, else UTF-16BE with a byte order mark as a hex string.
 */
export function textString(s: string): string {
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      ascii = false;
      break;
    }
  }
  if (ascii) return literalBytes(Buffer.from(s, "latin1"));
  const w = wellFormed(s);
  let out = "<FEFF";
  for (let i = 0; i < w.length; i++) out += hex4(w.charCodeAt(i));
  return out + ">";
}

/**
 * The bytes naming a destination. Names are byte strings in PDF and only
 * need to match between links and the name tree; printable ASCII is kept as
 * is and anything else is written as a UTF-16BE text string, which readers
 * such as pdf.js decode back to the original name.
 */
export function destBytes(name: string): Buffer {
  let ascii = true;
  for (let i = 0; i < name.length && ascii; i++) {
    const c = name.charCodeAt(i);
    ascii = c >= 0x20 && c < 0x7f;
  }
  if (ascii) return Buffer.from(name, "latin1");
  const w = wellFormed(name);
  const out = Buffer.alloc(2 + 2 * w.length);
  out[0] = 0xfe;
  out[1] = 0xff;
  for (let i = 0; i < w.length; i++) out.writeUInt16BE(w.charCodeAt(i), 2 + 2 * i);
  return out;
}

/** A byte string: literal when it is printable ASCII, hex otherwise. */
export function pdfString(bytes: Uint8Array): string {
  for (const b of bytes) if (b < 0x20 || b > 0x7e) return `<${Buffer.from(bytes).toString("hex").toUpperCase()}>`;
  return literalBytes(bytes);
}

/** A destination name as a PDF string. */
export function destString(name: string): string {
  return pdfString(destBytes(name));
}

/** PDF date string in UTC, D:YYYYMMDDHHmmSS+00'00'. */
export function pdfDate(d: Date): string {
  const t = d.getTime();
  if (!Number.isFinite(t)) throw new PdfError("invalid date in PdfInfo");
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const year = Math.min(9999, Math.max(0, d.getUTCFullYear()));
  return `D:${p(year, 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
}

// ------------------------------------------------------------------ objects

/** An indirect object body: a plain object, or a stream (dictionary entries plus data). */
export type ObjectBody = string | { dict: string; data: Uint8Array };

/**
 * Indirect objects numbered 1..n. Numbers are handed out with alloc() and
 * bodies filled in later with set(), so objects can reference each other
 * before they are written.
 */
/** Compressed streams by content, for documents rendered again (watch, a warm server): unchanged pages and font subsets are not compressed twice. */
const deflated = new Lru<Uint8Array>("deflate", 2000, 24 * 1024 * 1024);

function deflate(data: Uint8Array): Uint8Array {
  if (data.length < 1024) return deflateSync(data);
  const key = createHash("sha256").update(data).digest("base64");
  let out = deflated.get(key);
  if (!out) {
    out = deflateSync(data);
    deflated.set(key, out, out.length + 64);
  }
  return out;
}

export class ObjectTable {
  private readonly bodies: (ObjectBody | undefined)[] = [];
  constructor(readonly compress: boolean) {}

  alloc(): number {
    this.bodies.push(undefined);
    return this.bodies.length;
  }

  set(n: number, body: ObjectBody): void {
    this.bodies[n - 1] = body;
  }

  /** A stream object; flate-compressed unless the data is already encoded (`filter` given) or compression is off. */
  stream(n: number, dictEntries: string, data: Uint8Array, opts: { filter?: string; compress?: boolean } = {}): void {
    if (opts.filter) {
      this.set(n, { dict: `${dictEntries} /Filter ${opts.filter}`, data });
    } else if (this.compress && opts.compress !== false) {
      this.set(n, { dict: `${dictEntries} /Filter /FlateDecode`, data: deflate(data) });
    } else {
      this.set(n, { dict: dictEntries, data });
    }
  }

  /** Serializes header, objects, cross-reference table and trailer. */
  serialize(root: number, info: number): Uint8Array {
    const chunks: Buffer[] = [];
    const md5 = createHash("md5");
    let offset = 0;
    const push = (b: Buffer) => {
      chunks.push(b);
      md5.update(b);
      offset += b.length;
    };
    // A comment with four bytes above 127 tells transfer tools the file is binary.
    push(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"));
    const offsets: number[] = [];
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i];
      if (body === undefined) throw new PdfError(`internal error: object ${i + 1} was never written`);
      offsets.push(offset);
      if (typeof body === "string") {
        push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1"));
      } else {
        const entries = body.dict ? `${body.dict} ` : "";
        push(Buffer.from(`${i + 1} 0 obj\n<< ${entries}/Length ${body.data.length} >>\nstream\n`, "latin1"));
        push(Buffer.from(body.data.buffer, body.data.byteOffset, body.data.byteLength));
        push(Buffer.from("\nendstream\nendobj\n", "latin1"));
      }
    }
    const xrefAt = offset;
    const size = this.bodies.length + 1;
    let xref = `xref\n0 ${size}\n0000000000 65535 f\r\n`;
    for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n\r\n`;
    push(Buffer.from(xref, "latin1"));
    const id = md5.digest("hex").toUpperCase();
    const trailer = `trailer\n<< /Size ${size} /Root ${root} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    chunks.push(Buffer.from(trailer, "latin1"));
    // A fresh, exactly sized array: never a view into Node's shared buffer pool.
    const out = new Uint8Array(offset + chunks[chunks.length - 1].length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** "n 0 R" */
export function ref(n: number): string {
  return `${n} 0 R`;
}
