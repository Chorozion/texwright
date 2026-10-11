/**
 * texwright's PDF writer: pages with text, vector paths and images, embedded
 * font subsets, links, named destinations, bookmarks, page labels and
 * document information, serialized as a PDF 1.7 file with a classic
 * cross-reference table.
 *
 * Output is deterministic: the same calls with the same PdfInfo.date give
 * byte-identical files (object numbers follow call order, subset tags and the
 * file /ID are hashes of the content).
 */

import type { Font } from "../font/index.js";
import type { ImageRef } from "../layout/types.js";
import type { PdfDocumentWriter, PdfInfo, PdfPage } from "./api.js";
import { PdfError } from "./errors.js";
import { FontEntry } from "./fonts.js";
import { type ImageEntry, imageId, loadImage, writeImage } from "./images.js";
import { type OutlineEntry, type PageLabelRange, pageLabelsTree, writeNameTree, writeOutline } from "./navigation.js";
import { type FormEntry, type GraphicsStateDict, PageImpl, type PageHost, blendName } from "./page.js";
import { ObjectTable, destBytes, destString, literalBytes, num, pdfDate, pdfName, ref, textString } from "./serialize.js";

export { PdfError } from "./errors.js";

export interface PdfWriterOptions {
  /** Flate-compress content streams, fonts and PNG data (default true; false is for debugging). */
  compress?: boolean;
}

export interface PdfWriter extends PdfDocumentWriter {
  /** Problems that did not stop the document: dropped links, ignored URLs, unbalanced restore() and so on. */
  readonly warnings: string[];
  addPage(width: number, height: number): PdfPage;
  /** startPage is a 0-based page index; pages before the first range are numbered 1, 2, 3... */
  pageLabels(ranges: PageLabelRange[]): void;
}

interface Destination {
  page: number;
  x: number;
  y: number;
}

class Writer implements PdfWriter, PageHost {
  readonly warnings: string[] = [];
  private readonly compress: boolean;
  private readonly pages: PageImpl[] = [];
  private readonly fonts = new Map<Font, FontEntry>();
  private readonly images = new Map<string, ImageEntry>();
  private readonly dests = new Map<string, Destination>();
  private readonly outlines: OutlineEntry[] = [];
  private labels: PageLabelRange[] | undefined;
  private info: PdfInfo = {};
  private imageCount = 0;
  /** ExtGStates and patterns by their content, each with its resource name. */
  private readonly gstates = new Map<string, { name: string; dict: GraphicsStateDict }>();
  private readonly patternDicts = new Map<string, string>();
  private formCount = 0;
  private result: Uint8Array | undefined;

  constructor(options: PdfWriterOptions) {
    this.compress = options.compress !== false;
  }

  // ------------------------------------------------------------ PageHost

  checkOpen(): void {
    if (this.result) throw new PdfError("the PDF has already been finished");
  }

  fontEntry(font: Font): FontEntry {
    let e = this.fonts.get(font);
    if (!e) {
      if (!font || typeof font.advance !== "function") throw new PdfError("glyphs() needs a Font from the font module");
      e = new FontEntry(font, `F${this.fonts.size + 1}`, this.warnings);
      this.fonts.set(font, e);
    }
    return e;
  }

  imageEntry(image: ImageRef): ImageEntry {
    const e = image && this.images.get(image.id);
    if (!e) throw new PdfError(`image ${JSON.stringify(image?.id)} was not added to this document with addImage()`);
    if (!e.resName) e.resName = `Im${++this.imageCount}`;
    return e;
  }

  graphicsState(d: GraphicsStateDict): string {
    const key = `${d.ca} ${d.CA} ${d.BM ?? ""} ${d.smask ? `${d.smask.form.name} ${d.smask.luminance}` : ""}`;
    let e = this.gstates.get(key);
    if (!e) {
      e = { name: `GS${this.gstates.size + 1}`, dict: d };
      this.gstates.set(key, e);
    }
    return e.name;
  }

  pattern(dict: string): string {
    let name = this.patternDicts.get(dict);
    if (!name) {
      name = `P${this.patternDicts.size + 1}`;
      this.patternDicts.set(dict, name);
    }
    return name;
  }

  formName(): string {
    return `Fm${++this.formCount}`;
  }

  addDestination(name: string, page: number, x: number, y: number): void {
    if (this.dests.has(name)) {
      this.warnings.push(`destination ${JSON.stringify(name)} defined twice; the first definition is kept`);
      return;
    }
    this.dests.set(name, { page, x, y });
  }

  // --------------------------------------------------- PdfDocumentWriter

  addImage(bytes: Uint8Array): ImageRef {
    this.checkOpen();
    if (!(bytes instanceof Uint8Array)) throw new PdfError("addImage() needs a Uint8Array");
    const id = imageId(bytes);
    let e = this.images.get(id);
    if (!e) {
      e = loadImage(bytes, id, this.compress);
      this.images.set(id, e);
    }
    return { ...e.ref };
  }

  addPage(width: number, height: number): PdfPage {
    this.checkOpen();
    if (!(typeof width === "number" && width > 0 && width < Infinity && typeof height === "number" && height > 0 && height < Infinity)) {
      throw new PdfError(`page size ${width}x${height} is invalid`);
    }
    if (width > 14400 || height > 14400) {
      this.warnings.push(`page ${this.pages.length + 1} is ${width}x${height} pt; many readers cannot show pages larger than 14400 pt`);
    }
    const page = new PageImpl(this, this.pages.length, width, height);
    this.pages.push(page);
    return page;
  }

  outline(title: string, level: number, dest: string): void {
    this.checkOpen();
    if (typeof title !== "string" || typeof dest !== "string") throw new PdfError("outline() needs a title and a destination name");
    if (!Number.isInteger(level) || level < 1) throw new PdfError(`outline level must be an integer of at least 1, got ${level}`);
    this.outlines.push({ title, level, dest });
  }

  pageLabels(ranges: PageLabelRange[]): void {
    this.checkOpen();
    if (!Array.isArray(ranges)) throw new PdfError("pageLabels() needs an array of ranges");
    this.labels = ranges.map((r) => ({ ...r }));
  }

  setInfo(info: PdfInfo): void {
    this.checkOpen();
    this.info = { ...this.info, ...info };
  }

  finish(): Uint8Array {
    if (this.result) return this.result.slice();
    if (!this.pages.length) throw new PdfError("a PDF needs at least one page");
    const t = new ObjectTable(this.compress);
    const catalog = t.alloc();
    const pagesRoot = t.alloc();
    const info = t.alloc();
    const pageNums = this.pages.map(() => t.alloc());
    const contentNums = this.pages.map(() => t.alloc());

    // Fonts and images actually drawn, in the order they were first used.
    const fontNums = new Map<FontEntry, number>();
    const imageNums = new Map<ImageEntry, number>();
    for (const p of this.pages) {
      for (const f of p.fonts) if (!fontNums.has(f)) fontNums.set(f, 0);
      for (const im of p.images) if (!imageNums.has(im)) imageNums.set(im, 0);
    }
    for (const f of fontNums.keys()) fontNums.set(f, t.alloc());
    for (const im of imageNums.keys()) imageNums.set(im, t.alloc());
    // Forms, ExtGStates and patterns, by resource name.
    const formNums = new Map<FormEntry, number>();
    for (const p of this.pages) for (const f of p.forms) formNums.set(f, t.alloc());
    const gsNums = new Map<string, number>();
    const gsByName = new Map([...this.gstates.values()].map((e) => [e.name, e.dict]));
    for (const p of this.pages) for (const name of p.graphicsStates) if (!gsNums.has(name)) gsNums.set(name, t.alloc());
    const patternNums = new Map<string, number>();
    const patternByName = new Map([...this.patternDicts].map(([dict, name]) => [name, dict]));
    for (const p of this.pages) for (const name of p.patterns) if (!patternNums.has(name)) patternNums.set(name, t.alloc());
    for (const [name, n] of gsNums) {
      const d = gsByName.get(name)!;
      let dict = `<< /Type /ExtGState /ca ${num(d.ca)} /CA ${num(d.CA)}`;
      if (d.BM) dict += ` /BM /${blendName(d.BM)}`;
      if (d.smask) dict += ` /SMask << /Type /Mask /S /${d.smask.luminance ? "Luminosity" : "Alpha"} /G ${ref(formNums.get(d.smask.form)!)} /BC [0 0 0] >>`;
      else if (d.BM) dict += " /SMask /None";
      t.set(n, dict + " >>");
    }
    for (const [name, n] of patternNums) t.set(n, patternByName.get(name)!);

    // Pages, their content and their link annotations.
    this.pages.forEach((page, i) => {
      const annots: number[] = [];
      for (const link of page.links) {
        let action: string;
        if (link.dest !== undefined) {
          if (!this.dests.has(link.dest)) {
            this.warnings.push(`page ${i + 1}: link to undefined destination ${JSON.stringify(link.dest)} dropped`);
            continue;
          }
          action = `/Dest ${destString(link.dest)}`;
        } else {
          action = `/A << /S /URI /URI ${literalBytes(Buffer.from(link.uri!, "latin1"))} >>`;
        }
        const n = t.alloc();
        t.set(n, `<< /Type /Annot /Subtype /Link /Rect [${link.rect.map(num).join(" ")}] /Border [0 0 0] /F 4 /P ${ref(pageNums[i])} ${action} >>`);
        annots.push(n);
      }
      let resources = "";
      if (page.fonts.size) resources += ` /Font << ${[...page.fonts].map((f) => `${pdfName(f.resName)} ${ref(fontNums.get(f)!)}`).join(" ")} >>`;
      const xobjects = [...page.images].map((im) => `${pdfName(im.resName!)} ${ref(imageNums.get(im)!)}`);
      for (const f of page.forms) if (f.painted) xobjects.push(`${pdfName(f.name)} ${ref(formNums.get(f)!)}`);
      if (xobjects.length) resources += ` /XObject << ${xobjects.join(" ")} >>`;
      if (page.graphicsStates.size) resources += ` /ExtGState << ${[...page.graphicsStates].map((g) => `${pdfName(g)} ${ref(gsNums.get(g)!)}`).join(" ")} >>`;
      if (page.patterns.size) resources += ` /Pattern << ${[...page.patterns].map((g) => `${pdfName(g)} ${ref(patternNums.get(g)!)}`).join(" ")} >>`;
      // A page's forms share its resources (each form is drawn on that page only).
      for (const f of page.forms) {
        t.stream(
          formNums.get(f)!,
          ` /Type /XObject /Subtype /Form /BBox [${f.bbox.map(num).join(" ")}] /Group << /S /Transparency /CS /DeviceRGB /I true /K false >> /Resources <<${resources} >>`,
          Buffer.from(f.content, "latin1"),
        );
      }
      t.set(
        pageNums[i],
        `<< /Type /Page /Parent ${ref(pagesRoot)} /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources <<${resources} >> /Contents ${ref(contentNums[i])}` +
          (annots.length ? ` /Annots [${annots.map(ref).join(" ")}]` : "") +
          " >>",
      );
      t.stream(contentNums[i], "", Buffer.from(page.content(), "latin1"));
    });
    t.set(pagesRoot, `<< /Type /Pages /Kids [${pageNums.map(ref).join(" ")}] /Count ${pageNums.length} >>`);

    // Font subsets are computed here, once, from every glyph drawn.
    for (const [f, n] of fontNums) f.write(t, n);
    for (const [im, n] of imageNums) writeImage(t, n, im);

    let extra = "";
    if (this.dests.size) {
      const entries: [Uint8Array, string][] = [...this.dests].map(([name, d]) => [
        destBytes(name),
        `[${ref(pageNums[d.page])} /XYZ ${num(d.x)} ${num(d.y)} null]`,
      ]);
      extra += ` /Names << /Dests ${ref(writeNameTree(t, entries))} >>`;
    }
    if (this.outlines.length) {
      const root = writeOutline(t, this.outlines, (name) => this.dests.has(name), this.warnings);
      extra += ` /Outlines ${ref(root)} /PageMode /UseOutlines`;
    }
    if (this.labels?.length) extra += ` /PageLabels ${pageLabelsTree(this.labels, this.pages.length, this.warnings)}`;
    if (this.info.lang) extra += ` /Lang ${textString(this.info.lang)}`;
    t.set(catalog, `<< /Type /Catalog /Pages ${ref(pagesRoot)}${extra} /ViewerPreferences << /DisplayDocTitle true >> >>`);

    const meta = this.info;
    const date = pdfDate(meta.date ?? new Date());
    let infoDict = "";
    const field = (key: string, v: string | undefined) => {
      if (typeof v === "string" && v !== "") infoDict += ` /${key} ${textString(v)}`;
    };
    field("Title", meta.title);
    field("Author", meta.author);
    field("Subject", meta.subject);
    field("Keywords", meta.keywords);
    field("Creator", meta.creator);
    field("Producer", meta.producer ?? "texwright");
    t.set(info, `<<${infoDict} /CreationDate ${textString(date)} /ModDate ${textString(date)} >>`);

    this.result = t.serialize(catalog, info);
    return this.result.slice();
  }
}

/** A new, empty PDF document. */
export function createPdfWriter(options: PdfWriterOptions = {}): PdfWriter {
  return new Writer(options);
}
