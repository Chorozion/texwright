/**
 * Shipping pages out: walks each page box like TeX's hlist_out/vlist_out
 * (see walk.ts) and turns what it finds into PdfPage drawing calls.
 *
 * Layout is top-down with the origin at the text area's top-left corner;
 * PDF puts the origin at the page's bottom-left with y up. With page height
 * P and margins (top T, left L), a layout point (x, y) lands at
 * (L + x, P - T - y).
 */

import type { PdfDocumentWriter, PdfPage } from "../pdf/api.js";
import type { DrawOp, Drawing, VBox } from "./types.js";
import { Walker } from "./walk.js";

export interface ShipOptions {
  pageWidth: number;
  pageHeight: number;
  /** Where the text area's top-left corner sits; right and bottom are informational. */
  margins: { top: number; left: number; right?: number; bottom?: number };
}

export type Shippable = VBox | { box: VBox; pageWidth?: number; pageHeight?: number; margins?: ShipOptions["margins"] };

/** Draws a Drawing's ops with its origin (left end of its baseline) at PDF point (x, y). */
export function drawOps(page: PdfPage, d: Drawing, x: number, y: number): void {
  page.save();
  page.transform([1, 0, 0, 1, x, y]);
  emitOps(page, d.ops);
  page.restore();
}

/** Carries out drawing operations; saves left open are restored at the end, and a restore never pops past the start. */
function emitOps(page: PdfPage, ops: DrawOp[]): void {
  let depth = 0;
  for (const op of ops) {
    switch (op.op) {
      case "path":
        page.path(op.d, {
          fill: op.fill,
          stroke: op.stroke,
          fillAlpha: op.fillAlpha,
          strokeAlpha: op.strokeAlpha,
          lineWidth: op.lineWidth,
          evenOdd: op.evenOdd,
          dash: op.dash,
          lineCap: op.lineCap,
          lineJoin: op.lineJoin,
          miterLimit: op.miterLimit,
        });
        break;
      case "glyphs":
        page.glyphs(op.run.font, op.run.size, op.x, op.y, op.run.gids, op.run.advances, op.run.text, op.run.color, op.run.yOffsets, op.alpha, op.run.hscale);
        break;
      case "image":
        page.image(op.image, op.x, op.y, op.width, op.height, op.alpha, op.pixelated);
        break;
      case "group": {
        const mask = op.mask;
        page.group(
          { bbox: op.bbox, opacity: op.opacity, blend: op.blend, mask: mask && { luminance: mask.luminance, draw: () => emitOps(page, mask.ops) } },
          () => emitOps(page, op.ops),
        );
        break;
      }
      case "save":
        page.save();
        depth++;
        break;
      case "restore":
        // Never pop past the state saved for this drawing.
        if (depth > 0) {
          page.restore();
          depth--;
        }
        break;
      case "transform":
        page.transform(op.m);
        break;
      case "clip":
        page.clip(op.d, op.evenOdd);
        break;
    }
  }
  while (depth-- > 0) page.restore();
}

/**
 * Ships one page: adds it to the writer and draws the box. Pass the same
 * Walker for consecutive pages so a link that crosses a page break continues.
 */
export function shipPage(writer: PdfDocumentWriter, box: VBox, opts: ShipOptions, walker?: { use(page: PdfPage, opts: ShipOptions): Walker }): PdfPage {
  const page = writer.addPage(opts.pageWidth, opts.pageHeight);
  const w = walker ? walker.use(page, opts) : makeWalker(writer).use(page, opts);
  w.vbox(box, 0, 0);
  w.endPage();
  if (!walker) w.finish();
  return page;
}

/** A walker bound to the current page, re-targetable page by page. */
export function makeWalker(writer: PdfDocumentWriter): { use(page: PdfPage, opts: ShipOptions): Walker; walker: Walker } {
  let page: PdfPage | null = null;
  let X = (x: number) => x;
  let Y = (y: number) => y;
  const walker = new Walker({
    glyphs(run, x, baseline) {
      page!.glyphs(run.font, run.size, X(x), Y(baseline), run.gids, run.advances, run.text, run.color, run.yOffsets, undefined, run.hscale);
    },
    rule(x, top, width, height, color) {
      page!.rect(X(x), Y(top + height), width, height, color ?? [0, 0, 0]);
    },
    image(node, x, baseline) {
      page!.image(node.image, X(x), Y(baseline), node.width, node.height);
    },
    drawing(node, x, baseline) {
      drawOps(page!, node, X(x), Y(baseline));
    },
    anchor(id, x, y) {
      page!.destination(id, X(x), Y(y));
    },
    link(target, x, top, width, height) {
      page!.link(X(x), Y(top + height), width, height, target);
    },
    outline(title, level, dest) {
      writer.outline(title, level, dest);
    },
  });
  return {
    walker,
    use(p, opts) {
      page = p;
      const { top, left } = opts.margins;
      X = (x) => left + x;
      Y = (y) => opts.pageHeight - top - y;
      return walker;
    },
  };
}

/**
 * Ships pages in order (VBoxes, or the page builder's Page objects) and
 * returns the PdfPages created. A page may override size and margins.
 */
export function shipout(writer: PdfDocumentWriter, pages: readonly Shippable[], opts: ShipOptions): PdfPage[] {
  const bound = makeWalker(writer);
  const out: PdfPage[] = [];
  for (const p of pages) {
    const o: ShipOptions =
      "box" in p ? { pageWidth: p.pageWidth ?? opts.pageWidth, pageHeight: p.pageHeight ?? opts.pageHeight, margins: p.margins ?? opts.margins } : opts;
    out.push(shipPage(writer, "box" in p ? p.box : p, o, bound));
  }
  bound.walker.finish();
  return out;
}
