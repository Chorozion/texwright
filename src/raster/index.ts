/**
 * Page previews: the pages texwright typesets for PDF, drawn as PNG images
 * by texwright's own rasterizer (no browser, no PDF renderer), so an agent
 * can look at what it produced.
 *
 * The document is laid out exactly as for the PDF, the same pages shipped
 * through the same walker, and every drawing call carried out on pixels:
 * glyphs from their font outlines, vector figures with fills, strokes,
 * dashes and clipping, PNG and baseline JPEG images.
 */

import { shipout } from "../layout/index.js";
import type { AnchorInfo } from "../layout/pagebuilder.js";
import { type PdfInput, type PdfLayoutOptions, layoutPages } from "../typeset/index.js";
import { createRasterWriter } from "./writer.js";

export { encodePng } from "./png.js";
export { decodeJpeg } from "./jpeg.js";
export { RasterPage } from "./page.js";
export { MAX_DPI, MAX_PAGE_PIXELS, MIN_DPI, type RasterWriter, type RasterWriterOptions, createRasterWriter } from "./writer.js";

export interface RenderOptions {
  /** Pixels per inch (default 100; 10 to 1200). */
  dpi?: number;
  /** 1-based page numbers to draw (default all). */
  pages?: number[];
}

export interface RenderedPage {
  /** 1-based page number. */
  page: number;
  /** Size in pixels. */
  width: number;
  height: number;
  png: Uint8Array;
}

export interface RenderResult {
  /** Pages in the whole document. */
  pageCount: number;
  /** The pages drawn, in page order, each once. */
  pages: RenderedPage[];
  /** Problems that did not stop drawing: missing pages asked for, images shown as placeholders, glyphs that could not be drawn. */
  warnings: string[];
  /** Where every anchor (heading, figure, table, equation id) landed. */
  anchors: ReadonlyMap<string, AnchorInfo>;
}

/**
 * Lays the document out as typesetPdf does and draws the chosen pages.
 * Layout diagnostics go to input.diagnostics, as for PDF output. Output is
 * deterministic: the same input gives the same bytes.
 */
export function renderPages(input: PdfInput, layout: PdfLayoutOptions, opts: RenderOptions = {}): RenderResult {
  const writer = createRasterWriter({ dpi: opts.dpi, pages: opts.pages });
  const { pages, ship, anchors } = layoutPages(input, layout, writer);
  shipout(writer, pages, ship);
  writer.finish();
  const warnings: string[] = [];
  const missing = [...new Set(opts.pages ?? [])].filter((n) => !(Number.isInteger(n) && n >= 1 && n <= pages.length)).sort((a, b) => a - b);
  if (missing.length) warnings.push(`no page ${missing.join(", ")}: the document has ${pages.length} page${pages.length === 1 ? "" : "s"}`);
  warnings.push(...writer.warnings);
  return {
    pageCount: pages.length,
    pages: writer.pages.map((p) => ({ page: p.number, width: p.pixelWidth, height: p.pixelHeight, png: p.png() })),
    warnings,
    anchors,
  };
}
