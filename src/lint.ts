/**
 * Lint: problems a reader would notice that do not stop a build.
 *
 * Document lint runs on the tree and so in every output:
 *   A11Y001  an image with no alt text that is not the picture of a captioned figure
 *   A11Y002  coloured text whose contrast with its background is below 4.5:1 (WCAG AA)
 *
 * Layout lint runs on the pages the PDF engine built:
 *   LAY004   a numbered figure or table more than two pages after the page of its first reference
 *            (and more than one after the page its source is on: the writer may have put it far away)
 *   LAY005   (a note) the first line of a paragraph of four or more lines alone at the foot of a page,
 *            or the short last line (under half the column) of one of three or more alone at the head
 *            of the next: the page builder weighs these against other breaks, as TeX does, and can lose
 *   LAY006   a table, image or display wider than the text column by more than 2pt
 *
 * Every check is one pass over what is already there: no extra layout.
 */

import { type Block, type Document, type Inline, type Pos, blockInlines, childBlocks, plainText } from "./ast.js";
import type { Diagnostics } from "./diagnostics.js";
import type { AnchorInfo, Page } from "./layout/pagebuilder.js";
import { floatSourcePage, paragraphLine } from "./layout/pagebuilder.js";
import type { Color, HNode, VNode } from "./layout/types.js";

// ------------------------------------------------------------------ colour

/** WCAG 2 relative luminance of an sRGB colour with components 0..1. */
export function luminance([r, g, b]: Color): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrast(a: Color, b: Color): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function hexColor(h: string | undefined): Color | undefined {
  return h && /^#[0-9a-f]{6}$/i.test(h) ? ([1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255) as Color) : undefined;
}

const WHITE: Color = [1, 1, 1];
/** Callout backgrounds as the PDF engine paints them (src/typeset/typesetter.ts). */
const CALLOUT_BG: Record<string, Color> = { warning: [0.984, 0.937, 0.914], caution: [0.984, 0.937, 0.914], danger: [0.984, 0.937, 0.914], tip: [0.929, 0.965, 0.937] };
const CALLOUTS = new Set(["note", "tip", "hint", "important", "warning", "caution", "danger", "info", "box"]);
const DEFAULT_CALLOUT_BG: Color = [0.933, 0.949, 0.969];

/** The background a Div paints behind its text, if it paints one. */
function divBackground(b: Extract<Block, { t: "Div" }>): Color | undefined {
  const own = hexColor(b.attr.attrs?.background);
  if (own) return own;
  const kind = b.attr.classes?.find((c) => CALLOUTS.has(c));
  return kind ? (CALLOUT_BG[kind] ?? DEFAULT_CALLOUT_BG) : undefined;
}

/** WCAG AA's minimum contrast for body-size text. */
export const MIN_CONTRAST = 4.5;

// ------------------------------------------------------------------ document lint

/** A11Y001 and A11Y002 over the document tree. */
export function lintDocument(doc: Document, diagnostics: Diagnostics): void {
  const reported = new Set<string>();
  const inlines = (run: Inline[], bg: Color, captioned: boolean, pos: Pos | undefined): void => {
    for (const i of run) {
      if (i.t === "Image") {
        if (!captioned && !plainText(i.alt).trim() && !i.attr?.attrs?.alt && !i.title) {
          diagnostics.add("A11Y001", `Image ${i.src.startsWith("data:") ? "" : `${i.src} `}has no alt text and no caption`, i.pos ?? pos, {
            hint: "Describe it in the brackets, ![what it shows](file), or give the figure a caption; screen readers read nothing otherwise",
          });
        }
      } else if (i.t === "Span" && i.attr.classes?.includes("color")) {
        const fg = hexColor(i.attr.attrs?.color);
        const ratio = fg ? contrast(fg, bg) : 21;
        const key = `${i.attr.attrs?.color}/${bg.join(",")}`;
        if (ratio < MIN_CONTRAST && !reported.has(key)) {
          reported.add(key);
          const text = plainText(i.content).trim();
          diagnostics.add("A11Y002", `Text colour ${i.attr.attrs!.color} has contrast ${ratio.toFixed(1)}:1 with its background${text ? ` ("${text.length > 30 ? `${text.slice(0, 29)}…` : text}")` : ""}, below ${MIN_CONTRAST}:1`, pos, {
            hint: "Use a darker colour (blue!60!black, red!70!black) so the text stays readable in print and on screen",
          });
        }
      }
      if (i.t === "Note") blocks(i.blocks, bg, captioned);
      if ("content" in i && Array.isArray(i.content)) inlines(i.content as Inline[], bg, captioned, pos);
    }
  };
  const blocks = (list: Block[], bg: Color, captioned: boolean): void => {
    for (const b of list) {
      const inner = b.t === "Div" ? (divBackground(b) ?? bg) : bg;
      const cap = captioned || (b.t === "Figure" && !!plainText(b.caption).trim());
      const pos = "pos" in b ? b.pos : undefined;
      for (const run of blockInlines(b)) inlines(run, inner, cap, pos);
      for (const kids of childBlocks(b)) blocks(kids, inner, cap);
    }
  };
  blocks(doc.blocks, WHITE, false);
}

// ------------------------------------------------------------------ layout lint

/**
 * Pages a float may land after its first reference before LAY004 speaks. One page is the ideal, but
 * two is ordinary float drift (a figure that misses the rest of its page and the next is already full):
 * at 1, two of the 80 benchmark documents, both laid out as LaTeX would, were flagged.
 */
const FLOAT_DRIFT = 2;

/**
 * Allowance before a box counts as wider than the column: under about 2 mm into the margin is hard to
 * see. (At 2pt, three benchmark documents more were flagged for displays 4 to 6pt over.)
 */
const WIDTH_FUZZ = 6;

/** The text of a line, as its glyphs spell it. */
function lineText(n: HNode | VNode): string {
  if (n.t === "glyphs") return n.text.join("");
  if (n.t === "glue") return " ";
  if (n.t === "hbox" || n.t === "vbox") return (n.children as (HNode | VNode)[]).map(lineText).join("");
  return "";
}

/** Width of a line's content, without the stretch its glue was set with. */
function naturalWidth(n: HNode | VNode): number {
  if (n.t !== "hbox") return "width" in n ? (n.width ?? 0) : 0;
  let w = 0;
  for (const c of n.children) w += c.t === "glue" || c.t === "kern" || c.t === "glyphs" || c.t === "hbox" || c.t === "vbox" || c.t === "image" || c.t === "drawing" || c.t === "rule" ? (c.width ?? 0) : 0;
  return w;
}

/**
 * How wide a box's material is, whatever width it was packed to: a display or table packed to the
 * column can still hold more. Paragraph lines count at their own width (overfull lines are LAY001's),
 * and the margin kerns of character protrusion count for nothing.
 */
export function inkWidth(n: HNode | VNode): number {
  switch (n.t) {
    case "glyphs":
    case "glue":
    case "image":
    case "drawing":
      return n.width;
    case "kern":
      return n.subtype === "margin" ? 0 : n.width;
    case "rule":
      return n.width ?? 0;
    case "hbox": {
      if (paragraphLine(n)) return n.width;
      // The rightmost ink: each child starts where the previous one's advance ends (its declared
      // width; glue as it was set, so a display squeezed to fit has shrunk its spaces), and may
      // reach past that advance (scripts on an integral). Overhang does not push what follows.
      const set = n.glueSet;
      let x = 0;
      let right = 0;
      for (const c of n.children) {
        let advance: number;
        if (c.t === "glue") {
          advance = set && set.sign !== "none" ? (set.sign === "shrink" ? (c.shrinkOrder === set.order ? c.width - set.ratio * c.shrink : c.width) : c.stretchOrder === set.order ? c.width + set.ratio * c.stretch : c.width) : c.width;
        } else if (c.t === "kern") advance = c.subtype === "margin" ? 0 : c.width;
        else advance = "width" in c ? (c.width ?? 0) : 0;
        if (c.t !== "glue" && c.t !== "kern") right = Math.max(right, x + Math.max(advance, inkWidth(c)));
        x += advance;
      }
      return Math.max(right, 0);
    }
    case "vbox": {
      let w = 0;
      for (const c of n.children) w = Math.max(w, ("shift" in c ? (c.shift ?? 0) : 0) + inkWidth(c));
      return w;
    }
    default:
      return 0;
  }
}

/** Anchor ids inside a box, depth first. */
function anchorsIn(n: HNode | VNode, out: string[] = []): string[] {
  if (n.t === "anchor") out.push(n.id);
  else if (n.t === "hbox" || n.t === "vbox") for (const c of n.children as (HNode | VNode)[]) anchorsIn(c, out);
  return out;
}

/** The source line of the paragraph whose text holds `snippet`, found by its first words. */
function findParagraph(doc: Document, snippet: string): Pos | undefined {
  const words = snippet.split(String.fromCharCode(173)).join("").replace(/-\s*$/, "").trim().split(/\s+/).slice(0, 4).join(" ");
  if (words.length < 6) return undefined;
  let found: Pos | undefined;
  const visit = (list: Block[]) => {
    for (const b of list) {
      if (found) return;
      if ((b.t === "Para" || b.t === "Plain") && b.pos && plainText(b.content).replace(/\s+/g, " ").includes(words)) found = b.pos;
      for (const kids of childBlocks(b)) visit(kids);
    }
  };
  visit(doc.blocks);
  return found;
}

/** The table or code block whose text starts like `text` (neither has an anchor without a label). */
function findTable(doc: Document, text: string): Block | undefined {
  const squeeze = (t: string) => t.replace(/\s+/g, "");
  const key = squeeze(text).slice(0, 16);
  if (key.length < 4) return undefined;
  let found: Block | undefined;
  const visit = (list: Block[]) => {
    for (const b of list) {
      if (found) return;
      if (b.t === "Table" && squeeze([...b.head, ...b.body].map((row) => row.map((cell) => plainText(cell.content)).join("")).join("")).includes(key)) found = b;
      else if (b.t === "CodeBlock" && squeeze(b.text).includes(key)) found = b;
      for (const kids of childBlocks(b)) visit(kids);
    }
  };
  visit(doc.blocks);
  return found;
}

/** LAY004, LAY005 and LAY006 over built pages. */
export function lintLayout(pages: readonly Page[], anchors: ReadonlyMap<string, AnchorInfo>, doc: Document, textWidth: number, diagnostics: Diagnostics): void {
  // Blocks by anchor id, for positions.
  const byId = new Map<string, Block>();
  const index = (list: Block[]) => {
    for (const b of list) {
      const id = "id" in b && typeof b.id === "string" ? b.id : undefined;
      if (id) byId.set(id, b);
      for (const kids of childBlocks(b)) index(kids);
    }
  };
  index(doc.blocks);

  // LAY004: the first page that links to each figure and table.
  const firstRef = new Map<string, number>();
  for (const p of pages) {
    for (const m of p.marks.all) {
      if (m.t === "link-start" && "dest" in m.target && !firstRef.has(m.target.dest)) firstRef.set(m.target.dest, p.number);
    }
  }
  // The page each float's source was reached on: a float placed there or on the next page is where
  // it belongs, however far its first reference is (the writer put it there).
  const source = new Map<string, number>();
  for (const p of pages) {
    for (const c of p.body.children) {
      const src = c.t === "vbox" ? floatSourcePage(c) : undefined;
      if (src !== undefined) for (const id of anchorsIn(c)) source.set(id, src);
    }
  }
  for (const [id, b] of byId) {
    if ((b.t !== "Figure" && b.t !== "Table") || !b.number) continue;
    const at = anchors.get(id)?.page;
    const ref = firstRef.get(id);
    const src = source.get(id);
    if (at === undefined || ref === undefined || at - ref <= FLOAT_DRIFT || (src !== undefined && at - src <= 1)) continue;
    const what = `${b.t === "Figure" && b.attr?.classes?.includes("algorithm") ? "Algorithm" : b.t} ${b.number}`;
    diagnostics.add("LAY004", `${what} is on page ${at}, ${at - ref} pages after its first reference on page ${ref}`, b.pos, {
      hint: `Move its source nearer that reference, make it smaller, or split what is between them; floats wait for a page with room`,
    });
  }

  for (let k = 0; k < pages.length; k++) {
    const page = pages[k]!;
    const text = page.text;
    // LAY005: paragraph lines left alone across this page's foot.
    if (text && k + 1 < pages.length) {
      const boxes = (b: typeof text) => b.children.filter((c) => c.t === "hbox" || c.t === "vbox" || c.t === "image" || c.t === "drawing");
      const last = boxes(text).at(-1);
      const next = pages[k + 1]!.text;
      const first = next ? boxes(next)[0] : undefined;
      const orphan = last && paragraphLine(last);
      const widow = first && paragraphLine(first);
      if (orphan && orphan.index === 0 && orphan.count >= 4) {
        const line = lineText(last!).trim();
        diagnostics.add("LAY005", `Page ${page.number} ends with the first line of a paragraph alone (an orphan): "${line.slice(0, 40)}${line.length > 40 ? "…" : ""}"`, findParagraph(doc, line), {
          hint: "Shorten or lengthen the text above by a line, or add \\newpage before the paragraph",
        });
      }
      if (widow && widow.index === widow.count - 1 && widow.count >= 3 && naturalWidth(first!) < textWidth / 2) {
        const line = lineText(first!).trim();
        diagnostics.add("LAY005", `Page ${page.number + 1} starts with the last line of a paragraph alone (a widow): "${line.slice(0, 40)}${line.length > 40 ? "…" : ""}"`, findParagraph(doc, line), {
          hint: "Shorten the paragraph by a few words, or lengthen the text above by a line",
        });
      }
    }
    // LAY006: displays, tables and images wider than the column (lines are LAY001's).
    const wide = [...(text?.children ?? []), ...page.body.children.filter((c) => c !== text)];
    for (const c of wide) {
      if ((c.t !== "hbox" && c.t !== "vbox" && c.t !== "image" && c.t !== "drawing") || paragraphLine(c)) continue;
      const over = Math.max(c.width, inkWidth(c)) - textWidth;
      if (over <= WIDTH_FUZZ) continue;
      const id = anchorsIn(c)[0];
      const b = id ? byId.get(id) : findTable(doc, lineText(c));
      const what = b?.t === "Table" ? "A table" : b?.t === "Figure" ? "A figure" : b?.t === "MathBlock" ? "A displayed formula" : b?.t === "CodeBlock" ? "A code block" : c.t === "image" ? "An image" : "A box";
      diagnostics.add("LAY006", `${what} on page ${page.number} is ${over.toFixed(1)}pt wider than the text column`, b && "pos" in b ? b.pos : undefined, {
        hint: b?.t === "CodeBlock" ? "Break the long code lines; code is not wrapped" : "Give it a width (width=100%), use fewer or narrower columns, or break the formula over lines",
      });
    }
  }
}
