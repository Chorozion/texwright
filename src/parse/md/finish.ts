/**
 * Passes over the finished block tree: attach `\label{}` to the nearest
 * enclosing labelable block, and give every heading a unique id.
 */
import { plainText, slugify, walkBlocks, type Block, type Inline } from "../../ast.js";
import { pushInline, trimInlines } from "./runs.js";

type Labelable = Extract<Block, { t: "Heading" | "Figure" | "Table" | "Theorem" }>;

/**
 * `\label{x}` placeholders (Spans in `spans`) go to the innermost heading,
 * figure, table or theorem around them that has no label yet. Those with no
 * such block stay as empty Spans with `attr.id`.
 */
export function attachLabels(blocks: Block[], spans: Set<Inline>, target: Labelable | null = null): Block[] {
  /** Notes inside a run that no label can change still get their own labels attached. */
  const visitNotes = (inlines: Inline[]): void => {
    for (const n of inlines) {
      if (n.t === "Note") n.blocks = attachLabels(n.blocks, spans, null);
      else if ("content" in n && Array.isArray(n.content)) visitNotes(n.content);
    }
  };
  /** Remove the label placeholders that `to` takes; returns the new run, or null if unchanged. */
  const take = (inlines: Inline[], to: Labelable | null): Inline[] | null => {
    // Nothing to take: no labels at all, or no block that could take one (the common case, done without copying).
    if (!spans.size || !to || to.label) {
      visitNotes(inlines);
      return null;
    }
    let changed = false;
    let afterLabel = false;
    const out: Inline[] = [];
    for (const n of inlines) {
      if (spans.has(n) && n.t === "Span" && n.attr.id && to && !to.label) {
        to.label = n.attr.id;
        to.id ??= slugify(n.attr.id);
        changed = afterLabel = true;
        continue;
      }
      if (n.t === "Note") n.blocks = attachLabels(n.blocks, spans, null);
      else if ("content" in n && Array.isArray(n.content)) {
        const inner = take(n.content, to);
        if (inner) n.content = inner;
      }
      // "text \label{x} more" must not become "text  more".
      const prev = out[out.length - 1];
      const doubled = afterLabel && n.t === "Text" && prev?.t === "Text" && prev.text.endsWith(" ") && n.text.startsWith(" ");
      pushInline(out, doubled ? { t: "Text", text: n.text.slice(1) } : n);
      afterLabel = false;
    }
    return changed ? trimInlines(out) : null;
  };
  const apply = (inlines: Inline[], to: Labelable | null): Inline[] => take(inlines, to) ?? inlines;

  const out: Block[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case "Heading":
        b.content = apply(b.content, b);
        break;
      case "Figure":
        if (b.caption) b.caption = apply(b.caption, b);
        b.content = attachLabels(b.content, spans, b);
        break;
      case "Table":
        if (b.caption) b.caption = apply(b.caption, b);
        for (const row of [...b.head, ...b.body]) for (const cell of row) cell.content = apply(cell.content, b);
        break;
      case "Theorem":
        if (b.title) b.title = apply(b.title, b);
        b.blocks = attachLabels(b.blocks, spans, b);
        break;
      case "Para":
      case "Plain":
        b.content = apply(b.content, target);
        if (b.content.length === 0) continue; // the paragraph held only the label
        break;
      case "BlockQuote":
      case "Div":
        b.blocks = attachLabels(b.blocks, spans, target);
        break;
      case "List":
        b.items = b.items.map((item) => attachLabels(item, spans, target));
        break;
      case "DefList":
        for (const item of b.items) {
          item.term = apply(item.term, target);
          item.defs = item.defs.map((def) => attachLabels(def, spans, target));
        }
        break;
      default:
        break;
    }
    out.push(b);
  }
  return out;
}

function explicitId(b: Block): string | undefined {
  switch (b.t) {
    case "Heading":
    case "Figure":
    case "Table":
    case "Theorem":
    case "MathBlock":
      return b.id;
    case "Div":
      return b.attr.id;
    case "CodeBlock":
      return b.attr?.id;
    default:
      return undefined;
  }
}

/** Headings without an id get one from their text, made unique with -1, -2, ... */
export function assignHeadingIds(blocks: Block[]): void {
  const used = new Set<string>();
  const unnamed: Extract<Block, { t: "Heading" }>[] = [];
  walkBlocks(blocks, (b) => {
    const id = explicitId(b);
    if (id) used.add(id);
    else if (b.t === "Heading") unnamed.push(b);
  });
  // Ids only get used, never freed, so each base resumes after the suffix it last took
  // (counting up from 1 for every heading is quadratic in headings with the same text).
  const next = new Map<string, number>();
  for (const b of unnamed) {
    if (b.id) continue; // the same node reached twice
    const base = slugify(plainText(b.content));
    let id = base;
    if (used.has(id)) {
      let n = next.get(base) ?? 1;
      while (used.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
      next.set(base, n + 1);
    }
    used.add(id);
    b.id = id;
  }
}
