/**
 * Bounds-checked big-endian reads over a slice of font data.
 *
 * A Reader covers one table (or one whole file). Offsets are relative to the
 * start of the slice, and every read is checked against the slice length, so
 * an offset taken from a hostile table can never reach outside that table.
 */

import { FontError } from "./errors.js";

export class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly length: number;
  /** Used in error messages, for example "font" or "table 'GPOS'". */
  readonly label: string;

  constructor(bytes: Uint8Array, label = "font") {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.length = bytes.length;
    this.label = label;
  }

  fail(message: string): never {
    throw new FontError(`${this.label}: ${message}`);
  }

  /** Throws unless `n` bytes starting at `off` lie inside the slice. */
  check(off: number, n: number): void {
    if (!(off >= 0 && n >= 0 && off + n <= this.length)) {
      this.fail(`read of ${n} bytes at offset ${off} is outside the ${this.length}-byte data`);
    }
  }

  /** True when `n` bytes at `off` lie inside the slice. */
  has(off: number, n: number): boolean {
    return off >= 0 && n >= 0 && off + n <= this.length;
  }

  u8(off: number): number {
    this.check(off, 1);
    return this.bytes[off];
  }

  i8(off: number): number {
    this.check(off, 1);
    return this.view.getInt8(off);
  }

  u16(off: number): number {
    this.check(off, 2);
    return this.view.getUint16(off);
  }

  i16(off: number): number {
    this.check(off, 2);
    return this.view.getInt16(off);
  }

  u24(off: number): number {
    this.check(off, 3);
    const b = this.bytes;
    return (b[off] << 16) | (b[off + 1] << 8) | b[off + 2];
  }

  u32(off: number): number {
    this.check(off, 4);
    return this.view.getUint32(off);
  }

  i32(off: number): number {
    this.check(off, 4);
    return this.view.getInt32(off);
  }

  /** 16.16 fixed-point number. */
  fixed(off: number): number {
    return this.i32(off) / 65536;
  }

  /** Four-byte tag as a string. */
  tag(off: number): string {
    this.check(off, 4);
    const b = this.bytes;
    return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
  }

  /** A checked sub-slice. */
  sub(off: number, length: number, label?: string): Reader {
    this.check(off, length);
    return new Reader(this.bytes.subarray(off, off + length), label ?? this.label);
  }

  /** A checked sub-slice from `off` to the end. */
  from(off: number, label?: string): Reader {
    this.check(off, 0);
    return new Reader(this.bytes.subarray(off), label ?? this.label);
  }

  /** A copy of `length` bytes at `off`. */
  copy(off: number, length: number): Uint8Array {
    this.check(off, length);
    // new Uint8Array(view) copies; Buffer.prototype.slice would not.
    return new Uint8Array(this.bytes.subarray(off, off + length));
  }
}
