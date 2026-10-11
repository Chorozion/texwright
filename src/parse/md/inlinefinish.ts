/**
 * After the scan and emphasis: the passes over a paragraph's items that turn
 * them into texwright inline nodes. In order: adjacent text is joined, bare
 * URLs and e-mail addresses become links, typography is applied (outside
 * code, math, URLs and image descriptions), and the items become nodes.
 */
import type { Inline, Pos } from "../../ast.js";
import { ItemList, type DisplayMath, type Item } from "./items.js";
import { findLinks, hasLink } from "./linkify.js";
import { trimInlines } from "./runs.js";
import type { AttrSpec } from "./scan.js";
import { replaceTypography, smartQuotes, type QuoteAtom } from "./typography.js";
import { normalizeLink, normalizeLinkText, validateLink } from "./url.js";

/** One element of a finished run: an inline node, or display math the caller splits the block at. */
export type RunPart = Inline | DisplayMath;

export interface FinishHost {
  /** Display math had to be shown inline (inside emphasis or a link). */
  displayShownInline(pos: Pos): void;
}

/**
 * Run the text passes over `list` and convert it. Display math is kept at
 * the top level only. Footnote text gets the same passes as the body, so its
 * quotes curl and its bare links work; `textPasses` false leaves text as written.
 */
export function finishItems(list: ItemList, host: FinishHost, textPasses: boolean, source: string, warnDisplay = true): RunPart[] {
  joinText(list);
  if (textPasses) {
    // Bare links are only looked for when the source text as a whole has one.
    if (hasLink(source)) linkifyTexts(list);
    typography(list);
  }
  return convert(list, host, "top", warnDisplay);
}

// ---------------------------------------------------------------- joining text

const isPlainText = (it: Item | null): it is Item => !!it && !it.special && !it.opaque && !it.kids && it.node?.t === "Text";

/** Adjacent plain text items become one (escapes and character references stay apart until the end). */
function joinText(list: ItemList): void {
  for (let it = list.head; it; it = it.next) {
    if (it.kids) joinText(it.kids);
    while (isPlainText(it) && isPlainText(it.next)) {
      const next: Item = it.next;
      (it.node as { text: string }).text += (next.node as { text: string }).text;
      list.remove(next);
    }
  }
}

// ---------------------------------------------------------------- bare links

/** Bare URLs and e-mail addresses in text outside links (and outside `<a>` raw HTML). */
function linkifyTexts(list: ItemList): void {
  // The pass works on the run as a flat sequence of tokens, last to first,
  // so that it skips exactly what the old reader skipped: from the end of a
  // link back to its start, or to the start of a link nested in it (an
  // autolink inside link text), and text before an unmatched `</a>`.
  interface Tok {
    kind: "open" | "close" | "linkOpen" | "linkClose" | "text" | "special" | "html" | "other";
    level: number;
    item?: Item;
    list?: ItemList;
  }
  const toks: Tok[] = [];
  const flatten = (l: ItemList, level: number): void => {
    for (let it = l.head; it; it = it.next) {
      const node = it.node;
      if (!node) continue;
      if (it.kids && node.t !== "Image") {
        const link = node.t === "Link";
        toks.push({ kind: link ? "linkOpen" : "open", level });
        flatten(it.kids, level + 1);
        toks.push({ kind: link ? "linkClose" : "close", level });
      } else if (node.t === "Text" && !it.opaque) toks.push({ kind: it.special ? "special" : "text", level, item: it, list: l });
      else if (node.t === "RawInline" && node.format === "html") toks.push({ kind: "html", level, item: it });
      else toks.push({ kind: "other", level });
    }
  };
  flatten(list, 0);
  let htmlLinks = 0;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    if (t.kind === "linkClose") {
      i--;
      while (i > 0 && toks[i].level !== t.level && toks[i].kind !== "linkOpen") i--;
      continue;
    }
    if (t.kind === "html") {
      const html = (t.item!.node as { text: string }).text;
      if (/^<a[>\s]/i.test(html) && htmlLinks > 0) htmlLinks--;
      if (/^<\/a\s*>/i.test(html)) htmlLinks++;
    }
    if (htmlLinks > 0 || t.kind !== "text") continue;
    linkifyText(t.item!, t.list!, i > 0 && toks[i - 1].kind === "special");
  }
}

/** Split one text item around the bare links in it. */
function linkifyText(it: Item, l: ItemList, afterSpecial: boolean): void {
  const text = (it.node as { text: string }).text;
  if (!hasLink(text)) return;
  let found = findLinks(text);
  // Right after an escape or a character reference, text that starts with a link is not one (`http\://x`).
  if (found.length && found[0].index === 0 && afterSpecial) found = found.slice(1);
  const pieces: Item[] = [];
  let last = 0;
  for (const m of found) {
    const url = normalizeLink(m.url);
    if (!validateLink(url)) continue;
    let shown: string;
    if (m.schema === "mailto:" && !/^mailto:/i.test(m.text)) shown = normalizeLinkText("mailto:" + m.text).replace(/^mailto:/, "");
    else shown = normalizeLinkText(m.text);
    if (m.index > last) pieces.push(textItem(text.slice(last, m.index)));
    const kids = new ItemList();
    kids.push({ t: "Text", text: shown });
    pieces.push({ node: { t: "Link", url, content: [] }, delim: null, prev: null, next: null, kids, auto: true });
    last = m.lastIndex;
  }
  if (!pieces.length) return;
  if (last < text.length) pieces.push(textItem(text.slice(last)));
  let at = it;
  for (const p of pieces) {
    l.insertAfter(at, p);
    at = p;
  }
  l.remove(it);
}

function textItem(text: string): Item {
  return { node: { t: "Text", text }, delim: null, prev: null, next: null };
}

// ---------------------------------------------------------------- typography

/** Replacements in plain text, then curly quotes across the whole run. */
function typography(list: ItemList): void {
  const atoms: QuoteAtom[] = [];
  const walk = (l: ItemList, level: number, inAuto: boolean): void => {
    for (let it = l.head; it; it = it.next) {
      const node = it.node;
      if (!node) continue;
      if (it.kids) {
        if (node.t === "Image") {
          atoms.push({ editable: false, text: it.raw ?? "", level });
          continue;
        }
        walk(it.kids, level + 1, inAuto || !!it.auto);
        continue;
      }
      switch (node.t) {
        case "Text": {
          // Links made from URLs keep their dashes and dots, but not their straight quotes.
          const fixed = it.special || it.opaque;
          if (!fixed && !inAuto) node.text = replaceTypography(node.text);
          atoms.push({ editable: !fixed, text: node.text, level, set: (t) => (node.text = t) });
          break;
        }
        case "SoftBreak":
        case "LineBreak":
          atoms.push({ editable: false, text: "", level, breaks: true });
          break;
        case "Code":
        case "RawInline":
          atoms.push({ editable: false, text: node.text, level });
          break;
        case "Math":
        case "Cite":
        case "Ref":
        case "Span":
        case "$display":
          atoms.push({ editable: false, text: it.raw ?? "", level });
          break;
      }
    }
  };
  walk(list, 0, false);
  smartQuotes(atoms);
}

// ---------------------------------------------------------------- conversion

/**
 * Items into nodes. Display math stays a block-level part at the top
 * level; inside emphasis or a link it is shown inline with a warning, and
 * in an image description it is shown inline without one.
 */
function convert(list: ItemList, host: FinishHost, where: "top" | "nested" | "image", warnDisplay: boolean): RunPart[] {
  const out: RunPart[] = [];
  for (let it = list.head; it; it = it.next) {
    const node = it.node;
    if (!node) continue;
    if (node.t === "$display") {
      if (where === "top") out.push(node);
      else {
        if (where === "nested" && warnDisplay) host.displayShownInline(node.pos);
        pushPart(out, { t: "Math", tex: node.tex, pos: node.pos });
      }
      continue;
    }
    if (!it.kids) {
      pushPart(out, node.t === "Text" ? { t: "Text", text: node.text } : node);
      continue;
    }
    const content = convert(it.kids, host, node.t === "Image" || where === "image" ? "image" : "nested", warnDisplay) as Inline[];
    switch (node.t) {
      case "Emph":
      case "Strong":
      case "Strike":
      case "Superscript":
      case "Subscript":
        out.push({ t: node.t, content });
        break;
      case "Link": {
        const link: Inline = { t: "Link", url: node.url, content: [] };
        if (node.title !== undefined) link.title = node.title;
        link.content = content;
        out.push(link);
        break;
      }
      case "Image":
        out.push(imageNode(node, trimInlines(content), it.attr ?? null, it.tailAttr));
        break;
      default:
        out.push(node);
    }
  }
  return out;
}

function pushPart(out: RunPart[], node: Inline): void {
  const last = out[out.length - 1];
  if (node.t === "Text" && last && last.t === "Text") out[out.length - 1] = { t: "Text", text: last.text + node.text };
  else out.push(node);
}

/**
 * An image with its description; `width` and `height` come out of the
 * attribute list. A heading's or caption's final list right after the
 * image (`tail`) is applied afterwards, the old reader's way: its width and
 * height are set, and the rest replaces the image's attributes.
 */
function imageNode(img: Extract<Inline, { t: "Image" }>, alt: Inline[], attr: AttrSpec | null, tail?: AttrSpec): Inline {
  const out: Extract<Inline, { t: "Image" }> = { t: "Image", src: img.src, alt };
  if (img.title !== undefined) out.title = img.title;
  if (img.pos) out.pos = img.pos;
  if (attr) applyImageAttr(out, attr);
  if (tail) applyImageAttr(out, tail);
  return out;
}

function applyImageAttr(img: Extract<Inline, { t: "Image" }>, attr: AttrSpec): void {
  const attrs = { ...attr.attrs };
  // An empty width or height is dropped.
  if (attrs.width !== undefined) {
    if (attrs.width) img.width = attrs.width;
    delete attrs.width;
  }
  if (attrs.height !== undefined) {
    if (attrs.height) img.height = attrs.height;
    delete attrs.height;
  }
  const a: NonNullable<typeof img.attr> = {};
  if (attr.id) a.id = attr.id;
  if (attr.classes.length) a.classes = [...attr.classes];
  if (Object.keys(attrs).length) a.attrs = attrs;
  if (Object.keys(a).length) img.attr = a;
}
