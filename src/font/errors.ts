/**
 * The one error type the font module throws for bad font data.
 *
 * Every read is bounds-checked, so a corrupt or hostile font surfaces as a
 * FontError with a message naming the table and offset, never as a
 * RangeError from a DataView or an out-of-bounds read.
 */
export class FontError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FontError";
  }
}
