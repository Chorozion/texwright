/**
 * Fit a document to a page limit (`max-pages` in front matter), the request
 * agents get most often for résumés, one-pagers and abstracts. When the text
 * runs over, the layout is tightened in small steps, margins first and then
 * the body size, until it fits; every step keeps the theme's proportions, and
 * there are floors (half-inch margins, 8 pt text) below which nothing goes.
 * The agent is told what changed, or by how much the content is still over.
 */

import { Diagnostics } from "./diagnostics.js";
import { type PdfInput, type PdfLayoutOptions, geometry, theme, typesetPdf } from "./typeset/index.js";

/** Tightening steps, mildest first: margin scale and change of body size in points. */
const STEPS: readonly { margin: number; font: number }[] = [
  { margin: 0.85, font: 0 },
  { margin: 0.7, font: 0 },
  { margin: 0.7, font: -0.5 },
  { margin: 0.7, font: -1 },
  { margin: 0.6, font: -1 },
  { margin: 0.6, font: -1.5 },
  { margin: 0.5, font: -2 },
  { margin: 0.5, font: -2.5 },
];
const MIN_MARGIN = 36; // half an inch
const MIN_FONT = 8;

const inches = (pt: number) => `${(pt / 72).toFixed(2).replace(/\.?0+$/, "")}in`;

function describeMargins(m: readonly number[]): string {
  return m.every((x) => Math.abs(x - m[0]!) < 0.01) ? inches(m[0]!) : m.map(inches).join(", ");
}

/**
 * The layout to typeset `input` with so that it fits in `maxPages`: the given one when it already
 * fits, else the mildest tightening that does (reported as LAY002), else the given one with a
 * LAY003 warning. Trial layouts report into a scratch list, so only the final one's diagnostics count.
 */
export function fitToPages(input: PdfInput, layout: PdfLayoutOptions, maxPages: number, diagnostics: Diagnostics): PdfLayoutOptions {
  const scratch = new Diagnostics();
  const pagesFor = (l: PdfLayoutOptions) => typesetPdf({ ...input, diagnostics: scratch }, l).pageCount;
  const first = pagesFor(layout);
  if (first <= maxPages) return layout;

  const baseFont = layout.fontSize ?? theme(layout.theme).size;
  const g = geometry(layout.paper, layout.landscape, layout.margin);
  const baseMargins = [g.top, g.right, g.bottom, g.left];
  let last = first;
  let lastDescription = "";
  for (const step of STEPS) {
    const font = Math.max(MIN_FONT, baseFont + step.font);
    // Never widen a margin, and never cut one below the floor (unless it started there).
    const margins = baseMargins.map((m) => Math.min(m, Math.max(MIN_MARGIN, m * step.margin)));
    const candidate: PdfLayoutOptions = { ...layout, fontSize: font, margin: margins.map((m) => `${m.toFixed(2)}pt`).join(",") };
    last = pagesFor(candidate);
    lastDescription = `${font}pt text with ${describeMargins(margins)} margins`;
    if (last <= maxPages) {
      const changes: string[] = [];
      if (font !== baseFont) changes.push(`body ${font}pt (was ${baseFont}pt)`);
      if (margins.some((m, k) => Math.abs(m - baseMargins[k]!) > 0.01)) changes.push(`margins ${describeMargins(margins)} (were ${describeMargins(baseMargins)})`);
      diagnostics.add("LAY002", `Fitted to ${maxPages} page${maxPages === 1 ? "" : "s"} (it was ${first}): ${changes.join(", ")}`, undefined, {
        hint: "Shorten the content to keep the theme's own sizes",
      });
      return candidate;
    }
  }
  diagnostics.add("LAY003", `The document is ${first} pages, over its max-pages of ${maxPages}; even with ${lastDescription} it is ${last}`, undefined, {
    hint: `Cut roughly ${Math.max(1, Math.round((1 - maxPages / last) * 100))}% of the content, or raise max-pages`,
  });
  return layout;
}
