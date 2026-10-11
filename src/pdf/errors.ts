/**
 * The one error type the PDF writer throws: bad input images, fonts whose
 * licence forbids embedding, malformed drawing calls and use after finish().
 */
export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}
