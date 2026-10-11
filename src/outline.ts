/**
 * A document's outline for agents: what is where, without reading the whole
 * file. Headings, figures, tables, equations, theorems and captioned
 * listings come in document order with their numbers, labels and source
 * lines; citations are counted per key. An agent can jump to "the table in
 * section 3" or check that every figure is referenced, at a fraction of the
 * tokens the document itself would cost.
 */

import { type Block, type Document, type Inline, plainText, walkBlocks } from "./ast.js";
import { allInlines } from "./transform/numbering.js";

export interface OutlineItem {
  kind: "heading" | "figure" | "table" | "equation" | "theorem" | "listing";
  /** Source line (1-based), when known. */
  line?: number;
  /** Heading level (1 = top level the document uses). */
  level?: number;
  /** "2.3", "Figure 4" style numbers as printed (without the kind name). */
  number?: string;
  /** Labels to reference it by: one, or one per numbered row of an align. */
  labels?: string[];
  /** Heading text, caption, or a theorem's title ("Fermat"); long captions are shortened. */
  text?: string;
  /** For theorems: the environment ("lemma", "proof"). */
  env?: string;
  /** How many references (@x, \ref{x}) point at its labels. */
  refs?: number;
}

export interface Outline {
  title?: string;
  words: number;
  items: OutlineItem[];
  /** Cited keys with how often and where each is first cited. */
  citations: { key: string; count: number; line?: number }[];
  footnotes: number;
}

const MAX_TEXT = 80;

function short(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1).trimEnd()}…` : t;
}

/** Build the outline of a numbered document (after the numbering and citation passes). */
export function buildOutline(doc: Document): Outline {
  const items: OutlineItem[] = [];
  let top = 6;
  for (const b of doc.blocks) if (b.t === "Heading") top = Math.min(top, b.level);

  // References per label, so an agent can spot figures nobody mentions.
  const refCount = new Map<string, number>();
  const citations = new Map<string, { key: string; count: number; line?: number }>();
  let footnotes = 0;
  let words = 0;
  const countWords = (inl: Inline[]) => {
    for (const w of plainText(inl).split(/\s+/)) if (w) words++;
  };
  const visitInline = (i: Inline) => {
    if (i.t === "Ref") refCount.set(i.label, (refCount.get(i.label) ?? 0) + 1);
    else if (i.t === "Cite") {
      for (const item of i.items) {
        const c = citations.get(item.key) ?? { key: item.key, count: 0, line: i.pos?.line };
        c.count++;
        citations.set(item.key, c);
      }
    } else if (i.t === "Note") footnotes++;
  };

  const add = (item: OutlineItem, b: Block) => {
    if (b.pos?.line) item.line = b.pos.line;
    for (const k of Object.keys(item) as (keyof OutlineItem)[]) if (item[k] === undefined || item[k] === "") delete item[k];
    items.push(item);
  };

  walkBlocks(doc.blocks, (b) => {
    switch (b.t) {
      case "Heading":
        add({ kind: "heading", level: b.level - top + 1, number: b.number, labels: b.label ? [b.label] : undefined, text: short(plainText(b.content)) }, b);
        break;
      case "Figure":
        add({ kind: "figure", number: b.number, labels: b.label ? [b.label] : undefined, text: b.caption ? short(plainText(b.caption)) : undefined }, b);
        break;
      case "Table":
        add({ kind: "table", number: b.number, labels: b.label ? [b.label] : undefined, text: b.caption ? short(plainText(b.caption)) : undefined }, b);
        break;
      case "MathBlock": {
        const numbers = b.lineNumbers ? b.lineNumbers.filter((n): n is string => !!n) : b.number ? [b.number] : [];
        const labels = [b.label, ...(b.lineLabels ?? [])].filter((l, k, all): l is string => !!l && all.indexOf(l) === k);
        if (numbers.length || labels.length) add({ kind: "equation", number: numbers.join(", ") || undefined, labels: labels.length ? labels : undefined }, b);
        break;
      }
      case "Theorem":
        add(
          {
            kind: "theorem",
            env: b.kind,
            number: b.number,
            labels: b.label ? [b.label] : undefined,
            text: b.title?.length ? short(plainText(b.title)) : undefined,
          },
          b,
        );
        break;
      case "CodeBlock": {
        const caption = b.attr?.attrs?.caption;
        if (caption || b.attr?.id) add({ kind: "listing", number: b.attr?.attrs?.number, labels: b.attr?.attrs?.label ? [b.attr.attrs.label] : b.attr?.id ? [b.attr.id] : undefined, text: caption ? short(caption) : undefined }, b);
        break;
      }
      case "Para":
      case "Plain":
        countWords(b.content);
        break;
    }
  });
  allInlines(doc, visitInline);

  for (const item of items) {
    const n = (item.labels ?? []).reduce((s, l) => s + (refCount.get(l) ?? 0), 0);
    if (item.labels?.length && item.kind !== "heading") item.refs = n;
  }

  const out: Outline = { words, items, citations: [...citations.values()], footnotes };
  if (doc.meta.title) out.title = plainText(doc.meta.title);
  return out;
}

/** The outline as short lines: "L51 figure 1 [fig:pipeline] refs 1: The pipeline. Three readers ...". */
export function formatOutline(o: Outline): string {
  const lines: string[] = [];
  if (o.title) lines.push(`title: ${o.title}`);
  for (const i of o.items) {
    const indent = i.kind === "heading" ? "  ".repeat(Math.max(0, (i.level ?? 1) - 1)) : "  ";
    const head = i.kind === "heading" ? `${i.number ?? ""}` : `${i.env ?? i.kind}${i.number ? ` ${i.number}` : ""}`;
    const labels = i.labels?.length ? ` [${i.labels.join(", ")}]` : "";
    const refs = i.refs !== undefined ? ` refs ${i.refs}` : "";
    const text = i.text ? `${head ? " " : ""}${i.text}` : "";
    lines.push(`L${i.line ?? "?"} ${indent}${head}${text}${labels}${refs}`.replace(/\s+$/, ""));
  }
  if (o.citations.length) lines.push(`citations: ${o.citations.map((c) => `${c.key}×${c.count}`).join(", ")}`);
  lines.push(`words ${o.words}, footnotes ${o.footnotes}`);
  return lines.join("\n");
}
