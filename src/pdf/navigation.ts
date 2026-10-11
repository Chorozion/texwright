/**
 * Document navigation: the named-destination name tree, the outline
 * (bookmark) tree and page labels.
 */

import { PdfError } from "./errors.js";
import { type ObjectTable, destString, pdfString, ref, textString } from "./serialize.js";

/** Entries per name-tree node. */
const FANOUT = 64;

/**
 * Writes a name tree for `entries` (key bytes -> value in PDF syntax) and
 * returns the root's object number. Keys are sorted by byte value; more
 * than FANOUT entries are split into kids with /Limits.
 */
export function writeNameTree(table: ObjectTable, entries: [Uint8Array, string][]): number {
  const sorted = [...entries].sort((a, b) => Buffer.compare(a[0], b[0]));
  const root = table.alloc();
  if (sorted.length <= FANOUT) {
    table.set(root, `<< /Names [${sorted.map(([k, v]) => `${pdfString(k)} ${v}`).join(" ")}] >>`);
    return root;
  }
  interface Node {
    n: number;
    first: Uint8Array;
    last: Uint8Array;
  }
  let level: Node[] = [];
  for (let i = 0; i < sorted.length; i += FANOUT) {
    const part = sorted.slice(i, i + FANOUT);
    const n = table.alloc();
    const first = part[0][0];
    const last = part[part.length - 1][0];
    table.set(
      n,
      `<< /Limits [${pdfString(first)} ${pdfString(last)}] /Names [${part.map(([k, v]) => `${pdfString(k)} ${v}`).join(" ")}] >>`,
    );
    level.push({ n, first, last });
  }
  while (level.length > FANOUT) {
    const next: Node[] = [];
    for (let i = 0; i < level.length; i += FANOUT) {
      const part = level.slice(i, i + FANOUT);
      const n = table.alloc();
      const first = part[0].first;
      const last = part[part.length - 1].last;
      table.set(n, `<< /Limits [${pdfString(first)} ${pdfString(last)}] /Kids [${part.map((k) => ref(k.n)).join(" ")}] >>`);
      next.push({ n, first, last });
    }
    level = next;
  }
  table.set(root, `<< /Kids [${level.map((k) => ref(k.n)).join(" ")}] >>`);
  return root;
}

export interface OutlineEntry {
  title: string;
  level: number;
  dest: string;
}

interface Item {
  title: string;
  dest: string | undefined;
  level: number;
  children: Item[];
  n: number;
}

const MAX_DEPTH = 64;

/** Items at this level and above are open (their children shown); deeper ones are closed. */
const OPEN_LEVELS = 1;

/**
 * Writes the outline tree and returns the /Outlines dictionary's object
 * number. Levels may skip (a level 3 entry after a level 1 entry becomes its
 * child); entries before any shallower one hang off the root. An entry whose
 * destination does not exist is kept without a target and reported.
 */
export function writeOutline(table: ObjectTable, entries: OutlineEntry[], hasDest: (name: string) => boolean, warnings: string[]): number {
  const rootItem: Item = { title: "", dest: undefined, level: 0, children: [], n: 0 };
  const stack: Item[] = [rootItem];
  for (const e of entries) {
    while (stack.length > 1 && stack[stack.length - 1].level >= e.level) stack.pop();
    // Nesting is capped so the tree (and the recursion writing it) stays shallow.
    if (stack.length > MAX_DEPTH) stack.length = MAX_DEPTH;
    let dest: string | undefined = e.dest;
    if (!hasDest(e.dest)) {
      warnings.push(`outline entry ${JSON.stringify(e.title)} points to undefined destination ${JSON.stringify(e.dest)}; kept without a target`);
      dest = undefined;
    }
    const item: Item = { title: e.title, dest, level: e.level, children: [], n: 0 };
    stack[stack.length - 1].children.push(item);
    stack.push(item);
  }
  const root = table.alloc();
  const assign = (it: Item) => {
    for (const c of it.children) {
      c.n = table.alloc();
      assign(c);
    }
  };
  assign(rootItem);

  /** Descendants visible when `it` is open (its closed children hide theirs). */
  const visible = (it: Item): number => {
    let count = 0;
    for (const c of it.children) count += 1 + (isOpen(c) ? visible(c) : 0);
    return count;
  };
  const isOpen = (it: Item) => it.level <= OPEN_LEVELS;

  const write = (parent: Item, parentRef: number) => {
    const kids = parent.children;
    kids.forEach((c, i) => {
      let d = `<< /Title ${textString(c.title)} /Parent ${ref(parentRef)}`;
      if (i > 0) d += ` /Prev ${ref(kids[i - 1].n)}`;
      if (i < kids.length - 1) d += ` /Next ${ref(kids[i + 1].n)}`;
      if (c.children.length) {
        const count = visible(c);
        d += ` /First ${ref(c.children[0].n)} /Last ${ref(c.children[c.children.length - 1].n)} /Count ${isOpen(c) ? count : -count}`;
      }
      if (c.dest !== undefined) d += ` /Dest ${destString(c.dest)}`;
      table.set(c.n, d + " >>");
      write(c, c.n);
    });
  };
  write(rootItem, root);
  const top = rootItem.children;
  table.set(
    root,
    top.length
      ? `<< /Type /Outlines /First ${ref(top[0].n)} /Last ${ref(top[top.length - 1].n)} /Count ${visible(rootItem)} >>`
      : "<< /Type /Outlines /Count 0 >>",
  );
  return root;
}

export interface PageLabelRange {
  startPage: number;
  style: "D" | "r" | "R" | "a" | "A";
  prefix?: string;
  start?: number;
}

/** The /PageLabels number tree (inline) for `ranges`; startPage is a 0-based page index. */
export function pageLabelsTree(ranges: PageLabelRange[], pageCount: number, warnings: string[]): string {
  const byStart = new Map<number, PageLabelRange>();
  for (const r of ranges) {
    if (!Number.isInteger(r.startPage) || r.startPage < 0 || r.startPage >= pageCount) {
      warnings.push(`page label range starting at page index ${r.startPage} is outside the document (${pageCount} pages); ignored`);
      continue;
    }
    byStart.set(r.startPage, r);
  }
  if (!byStart.has(0)) byStart.set(0, { startPage: 0, style: "D" });
  const nums = [...byStart.values()]
    .sort((a, b) => a.startPage - b.startPage)
    .map((r) => {
      if (!["D", "r", "R", "a", "A"].includes(r.style)) throw new PdfError(`unknown page label style ${JSON.stringify(r.style)}`);
      let d = `<< /S /${r.style}`;
      if (r.prefix) d += ` /P ${textString(r.prefix)}`;
      if (r.start !== undefined && r.start !== 1) {
        if (!Number.isInteger(r.start) || r.start < 1) throw new PdfError(`page label start must be an integer of at least 1, got ${r.start}`);
        d += ` /St ${r.start}`;
      }
      return `${r.startPage} ${d} >>`;
    });
  return `<< /Nums [${nums.join(" ")}] >>`;
}
