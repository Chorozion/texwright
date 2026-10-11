/**
 * Numbering and cross-references.
 *
 * One pass in document order assigns numbers to sections, figures, tables,
 * equations (row by row for align/gather), theorem-like blocks and captioned
 * listings, and records every label. A second pass checks every reference.
 */

import { closestFix } from "../fixes.js";
import {
  type Block,
  type Document,
  type Inline,
  type Pos,
  blockInlines,
  childBlocks,
  plainText,
  slugify,
  walkBlocks,
  walkInlines,
} from "../ast.js";
import type { Diagnostics } from "../diagnostics.js";
import { ROW_NUMBERED, SINGLE_NUMBERED, extractLabels, parseRows } from "./math.js";

export type LabelKind = "sec" | "fig" | "tbl" | "eq" | "thm" | "lst";

export interface LabelInfo {
  label: string;
  kind: LabelKind;
  id: string;
  /** "3", "2.1", "A", "4a". Absent for unnumbered targets. */
  number?: string;
  /** Kind name for "auto" references: "Figure", "Section", "Theorem"... */
  name: string;
  /** Plain-text title, used when the target has no number. */
  title?: string;
  pos?: Pos;
}

export interface Numbering {
  labels: Map<string, LabelInfo>;
  /** Every id written into the output, to keep them unique. */
  ids: Set<string>;
}

const DEFAULT_NAMES: Record<LabelKind | "appendix" | "chapter", string> = {
  sec: "Section",
  fig: "Figure",
  tbl: "Table",
  eq: "Equation",
  thm: "Theorem",
  lst: "Listing",
  appendix: "Appendix",
  chapter: "Chapter",
};

const PREFIX_KIND: Record<string, LabelKind> = {
  sec: "sec",
  ch: "sec",
  chap: "sec",
  app: "sec",
  fig: "fig",
  tbl: "tbl",
  tab: "tbl",
  eq: "eq",
  eqn: "eq",
  lst: "lst",
  thm: "thm",
  lem: "thm",
  def: "thm",
  cor: "thm",
  prop: "thm",
  rem: "thm",
  ex: "thm",
};

function letters(n: number, upper = true): string {
  let s = "";
  let x = n;
  while (x > 0) {
    x--;
    s = String.fromCharCode((upper ? 65 : 97) + (x % 26)) + s;
    x = Math.floor(x / 26);
  }
  return s;
}

export function numberDocument(doc: Document, diagnostics: Diagnostics): Numbering {
  const names = { ...DEFAULT_NAMES, ...namesFromMeta(doc) };
  const labels = new Map<string, LabelInfo>();
  const ids = new Set<string>();
  const numberSections = doc.meta.numberSections ?? false;
  const within = doc.meta.numberWithin ?? 0;

  // Smallest heading level among numbered headings: a document whose top headings are ## numbers them 1, 2, 3.
  let topLevel = 6;
  for (const b of doc.blocks) if (b.t === "Heading" && b.numbered) topLevel = Math.min(topLevel, b.level);

  const sectionCounters = [0, 0, 0, 0, 0, 0, 0];
  let inAppendix = false;
  let currentSection = ""; // number of the innermost numbered section, for \label in running text
  let topSection = ""; // number of the current top-level section, for numberWithin
  const counters = new Map<string, number>();
  /** Counters numbered within sections on their own (\newtheorem{x}{X}[section]). */
  const withinSectionKeys = new Set<string>();

  const next = (key: string, withinSection = !!within): string => {
    if (withinSection) withinSectionKeys.add(key);
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return withinSection && topSection ? `${topSection}.${n}` : String(n);
  };

  const uniqueId = (wanted: string): string => {
    let id = wanted || "x";
    for (let k = 1; ids.has(id); k++) id = `${wanted}-${k}`;
    ids.add(id);
    return id;
  };

  const register = (label: string | undefined, info: Omit<LabelInfo, "label">) => {
    if (!label) return;
    const existing = labels.get(label);
    if (existing) {
      diagnostics.add("REF002", `Label "${label}" is defined more than once`, info.pos, {
        hint: existing.pos?.line ? `First defined at line ${existing.pos.line}` : undefined,
      });
      return;
    }
    labels.set(label, { label, ...info });
  };

  const visitInlinesForLabels = (inlines: Inline[]) => {
    walkInlines(inlines, (i) => {
      // An empty span carrying an id is a \label with no labelable parent: it points at the current section.
      if (i.t === "Span" && i.attr.id && i.content.length === 0 && !ids.has(i.attr.id)) {
        const label = i.attr.id;
        const id = uniqueId(slugify(label));
        i.attr.id = id;
        register(label, { kind: "sec", id, name: names.sec, number: currentSection || undefined, pos: i.pos });
      }
      if (i.t === "Note") visit(i.blocks, null);
    });
  };

  const visit = (blocks: Block[], parentFigure: { number?: string; sub: number } | null) => {
    for (const b of blocks) {
      switch (b.t) {
        case "Heading": {
          const classes = b.attr?.classes ?? [];
          if (classes.includes("appendix") && !inAppendix && b.level === topLevel) {
            inAppendix = true;
            sectionCounters.fill(0);
          }
          let number: string | undefined;
          if (b.numbered && numberSections && b.level >= topLevel) {
            sectionCounters[b.level]!++;
            for (let k = b.level + 1; k < sectionCounters.length; k++) sectionCounters[k] = 0;
            const parts: string[] = [];
            for (let k = topLevel; k <= b.level; k++) {
              const v = sectionCounters[k]!;
              parts.push(k === topLevel && inAppendix ? letters(v) : String(v));
            }
            number = parts.join(".");
            b.number = number;
            currentSection = number;
          }
          if (b.level === topLevel) {
            topSection = number ?? "";
            for (const key of counters.keys()) if (within || withinSectionKeys.has(key)) counters.set(key, 0);
          }
          b.id = uniqueId(b.id ?? (b.label ? slugify(b.label) : slugify(plainText(b.content))));
          register(b.label, {
            kind: "sec",
            id: b.id,
            number,
            name: inAppendix && b.level === topLevel ? names.appendix : names.sec,
            title: plainText(b.content),
            pos: b.pos,
          });
          break;
        }
        case "Figure": {
          const algorithm = b.attr?.classes?.includes("algorithm") ?? false;
          let number: string | undefined;
          if (b.numbered) {
            if (parentFigure) {
              parentFigure.sub++;
              number = `${parentFigure.number ?? ""}${letters(parentFigure.sub, false)}`;
            } else {
              number = next(algorithm ? "algorithm" : "figure");
            }
            b.number = number;
          }
          b.id = uniqueId(b.id ?? (b.label ? slugify(b.label) : `figure-${number ?? ids.size}`));
          register(b.label, { kind: "fig", id: b.id, number, name: algorithm ? "Algorithm" : names.fig, title: plainText(b.caption), pos: b.pos });
          visit(b.content, parentFigure ? null : { number, sub: 0 });
          if (b.caption) visitInlinesForLabels(b.caption);
          continue;
        }
        case "Table": {
          let number: string | undefined;
          if (b.caption && b.caption.length && !(b.attr?.classes ?? []).includes("unnumbered")) {
            number = next("table");
            b.number = number;
          }
          b.id = uniqueId(b.id ?? (b.label ? slugify(b.label) : `table-${number ?? ids.size}`));
          register(b.label, { kind: "tbl", id: b.id, number, name: names.tbl, title: plainText(b.caption), pos: b.pos });
          break;
        }
        case "MathBlock":
          numberMath(b);
          break;
        case "Theorem": {
          let number: string | undefined;
          const display = b.name ?? b.kind.charAt(0).toUpperCase() + b.kind.slice(1);
          b.name = display;
          if (b.numbered) {
            number = next(`thm:${b.counter ?? b.kind}`, b.withinSection || !!within);
            b.number = number;
          }
          b.id = uniqueId(b.id ?? (b.label ? slugify(b.label) : `${slugify(b.kind)}-${number ?? ids.size}`));
          register(b.label, { kind: "thm", id: b.id, number, name: display, title: plainText(b.title), pos: b.pos });
          break;
        }
        case "CodeBlock": {
          const caption = b.attr?.attrs?.caption;
          const label = b.attr?.id && /^lst:/.test(b.attr.id) ? b.attr.id : undefined;
          if (caption || label) {
            const number = caption ? next("listing") : undefined;
            const id = uniqueId(label ? slugify(label) : `listing-${number}`);
            b.attr = { ...b.attr, id, attrs: { ...(b.attr?.attrs ?? {}), ...(number ? { number } : {}), ...(label ? { label } : {}) } };
            register(label, { kind: "lst", id, number, name: names.lst, title: caption, pos: b.pos });
          }
          break;
        }
        case "Div":
          if (b.attr.id && !ids.has(b.attr.id)) b.attr.id = uniqueId(b.attr.id);
          break;
        default:
          break;
      }
      for (const inl of blockInlines(b)) visitInlinesForLabels(inl);
      for (const child of childBlocks(b)) visit(child, null);
    }
  };

  const numberMath = (b: Extract<Block, { t: "MathBlock" }>) => {
    const env = b.env?.replace(/\*$/, "");
    const starred = !!b.env?.endsWith("*");
    if (env && ROW_NUMBERED.has(env) && !starred && b.numbered) {
      const body = env === "alignat" ? b.tex.replace(/^\s*\{[^}]*\}/, "") : b.tex;
      const rows = parseRows(body);
      b.lineNumbers = rows.map((r) => (r.suppressed ? null : next("equation")));
      b.lineLabels = rows.map((r) => r.label ?? null);
      b.number = b.lineNumbers.find((n) => n !== null) ?? undefined;
      // Each labelled row gets its own anchor; the block takes the first one.
      let firstId: string | undefined;
      rows.forEach((r, k) => {
        if (!r.label) return;
        const id = uniqueId(slugify(r.label));
        firstId ??= id;
        register(r.label, { kind: "eq", id, number: b.lineNumbers?.[k] ?? undefined, name: names.eq, pos: b.pos });
      });
      b.label = rows.find((r) => r.label)?.label ?? b.label;
      b.id = firstId ?? uniqueId(b.id ?? `eq-${b.number ?? ids.size}`);
      return;
    }
    // Single-number blocks: equation, multline, labelled $$...$$
    const { labels: inner } = extractLabels(b.tex);
    const label = b.label ?? inner[0];
    if (inner.length > 1) {
      diagnostics.add("REF002", `Equation has ${inner.length} \\label commands; only "${inner[0]}" is used`, b.pos, {
        hint: "Use align or gather to number and label several lines",
        severity: "warning",
      });
    }
    const numbered = b.numbered && !starred && (env === undefined || SINGLE_NUMBERED.has(env) || !!label);
    if (numbered) b.number = next("equation");
    b.label = label;
    b.id = uniqueId(b.id ?? (label ? slugify(label) : `eq-${b.number ?? ids.size}`));
    register(label, { kind: "eq", id: b.id, number: b.number, name: names.eq, pos: b.pos });
  };

  visit(doc.blocks, null);
  checkReferences(doc, labels, diagnostics);
  resolveMathRefs(doc, labels, diagnostics);
  formatCrefs(doc, labels, names);
  return { labels, ids };
}

/** cleveref's names: abbreviated in \cref, full in \Cref, singular and plural. */
const CREF_NAMES: Partial<Record<LabelKind | "appendix" | "chapter", { lower: [string, string]; upper: [string, string] }>> = {
  sec: { lower: ["section", "sections"], upper: ["Section", "Sections"] },
  fig: { lower: ["fig.", "figs."], upper: ["Figure", "Figures"] },
  tbl: { lower: ["table", "tables"], upper: ["Table", "Tables"] },
  eq: { lower: ["eq.", "eqs."], upper: ["Equation", "Equations"] },
  lst: { lower: ["listing", "listings"], upper: ["Listing", "Listings"] },
  appendix: { lower: ["appendix", "appendices"], upper: ["Appendix", "Appendices"] },
  chapter: { lower: ["chapter", "chapters"], upper: ["Chapter", "Chapters"] },
};

const plural = (w: string) => (/[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(w) ? `${w}es` : `${w}s`);

/** A sortable key for "3", "2.1", "A.2", "4a": numeric parts compare as numbers. */
function numberKey(n: string | undefined): (number | string)[] {
  return (n ?? "").split(/[.\-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

function compareNumbers(a: string | undefined, b: string | undefined): number {
  const x = numberKey(a);
  const y = numberKey(b);
  for (let k = 0; k < Math.max(x.length, y.length); k++) {
    const p = x[k];
    const q = y[k];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p === "number" && typeof q === "number") return p - q;
    return String(p).localeCompare(String(q));
  }
  return 0;
}

/** True when b follows a directly: "3" then "4", "2.1" then "2.2". */
function follows(a: string | undefined, b: string | undefined): boolean {
  const x = numberKey(a);
  const y = numberKey(b);
  if (x.length !== y.length || !x.length) return false;
  for (let k = 0; k < x.length - 1; k++) if (x[k] !== y[k]) return false;
  const p = x[x.length - 1];
  const q = y[y.length - 1];
  return typeof p === "number" && typeof q === "number" && q === p + 1;
}

/** "A", "A and B", "A, B and C", as cleveref joins them. */
function joinList(parts: Inline[][]): Inline[] {
  const out: Inline[] = [];
  parts.forEach((p, k) => {
    if (k) out.push({ t: "Text", text: k === parts.length - 1 ? " and " : ", " });
    out.push(...p);
  });
  return out;
}

/**
 * Writes out each \cref group: references of one kind together under one name, singular or
 * plural, sorted, and runs of three or more consecutive numbers as a range ("eqs. (1) to (3)").
 */
function formatCrefs(doc: Document, labels: Map<string, LabelInfo>, names: Record<string, string>): void {
  allInlines(doc, (i) => {
    if (i.t !== "Span" || !i.attr.classes?.includes("tw-cref")) return;
    const capital = i.attr.classes.includes("tw-cref-cap");
    const refs = i.content.filter((x): x is Extract<Inline, { t: "Ref" }> => x.t === "Ref");
    if (!refs.length) return;
    // Groups by kind and name, in order of first appearance.
    const groups = new Map<string, { info?: LabelInfo; refs: Extract<Inline, { t: "Ref" }>[] }>();
    for (const r of refs) {
      const info = labels.get(r.label);
      const key = info ? `${info.kind}:${info.name}` : `?:${r.label}`;
      const g = groups.get(key) ?? { info, refs: [] };
      g.refs.push(r);
      groups.set(key, g);
    }
    const parts: Inline[][] = [];
    for (const { info, refs: rs } of groups.values()) {
      if (!info) {
        parts.push(rs.map((r) => ({ ...r, style: "number" as const })));
        continue;
      }
      rs.sort((a, b) => compareNumbers(labels.get(a.label)?.number, labels.get(b.label)?.number));
      const isEq = info.kind === "eq";
      const ref = (r: Extract<Inline, { t: "Ref" }>): Inline => ({ ...r, style: isEq ? "eq" : "number" });
      // Runs of consecutive numbers.
      const runs: Extract<Inline, { t: "Ref" }>[][] = [];
      for (const r of rs) {
        const last = runs[runs.length - 1];
        if (last && follows(labels.get(last[last.length - 1]!.label)?.number, labels.get(r.label)?.number)) last.push(r);
        else runs.push([r]);
      }
      const items: Inline[][] = [];
      for (const run of runs) {
        if (run.length >= 3) items.push([ref(run[0]!), { t: "Text", text: " to " }, ref(run[run.length - 1]!)]);
        else for (const r of run) items.push([ref(r)]);
      }
      // The document's own names win (localized "Abbildung"); else cleveref's.
      const custom = info.name !== DEFAULT_NAMES[info.kind as LabelKind] && info.name !== names.appendix && info.name !== names.chapter;
      const fixed = !custom ? CREF_NAMES[info.name === names.appendix ? "appendix" : info.name === names.chapter ? "chapter" : info.kind] : undefined;
      const many = rs.length > 1;
      let name: string;
      if (fixed) name = (capital ? fixed.upper : fixed.lower)[many ? 1 : 0];
      else {
        const base = capital ? info.name : info.name.toLowerCase();
        name = many ? plural(base) : base;
      }
      parts.push([{ t: "Text", text: `${name} ` }, ...joinList(items)]);
    }
    i.content = joinList(parts);
  });
}

const MATH_REF = /\\(ref|eqref|autoref|cref|Cref)\*?\s*\{([^{}]*)\}/g;

/**
 * \ref and friends inside formulas ("\text{by Lemma~\ref{lem:a}}"): the math
 * engine knows no labels, so the numbers are written into the source here.
 */
function resolveMathRefs(doc: Document, labels: Map<string, LabelInfo>, diagnostics: Diagnostics): void {
  const resolve = (tex: string, pos: Pos | undefined): string => {
    if (!tex.includes("ref")) return tex;
    return tex.replace(MATH_REF, (_, cmd: string, label: string) => {
      const key = label.trim();
      const info = labels.get(key);
      if (!info) {
        const fix = closestFix(key, labels.keys());
        diagnostics.add("REF001", `Reference to undefined label "${key}"`, pos, { fix: fix && { old: key, new: fix.replacement, safe: fix.safe } });
      }
      const style = cmd === "eqref" ? "eq" : cmd === "ref" ? "number" : "auto";
      return `\\text{${(refText(info, style) ?? "??").replace(/[{}\\$&#^_%~]/g, "")}}`;
    });
  };
  allInlines(doc, (i) => {
    if (i.t === "Math") i.tex = resolve(i.tex, i.pos);
  });
  walkBlocks(doc.blocks, (b) => {
    if (b.t === "MathBlock") b.tex = resolve(b.tex, b.pos);
  });
}

function namesFromMeta(doc: Document): Partial<Record<LabelKind | "appendix", string>> {
  const raw = doc.meta.extra?.["ref-names"] ?? doc.meta.extra?.refNames;
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<LabelKind | "appendix", string>> = {};
  const map: Record<string, LabelKind | "appendix"> = {
    section: "sec",
    figure: "fig",
    table: "tbl",
    equation: "eq",
    theorem: "thm",
    listing: "lst",
    appendix: "appendix",
  };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const kind = map[k.toLowerCase()];
    if (kind && typeof v === "string") out[kind] = v;
  }
  return out;
}

function forEachInline(blocks: Block[], fn: (i: Inline) => void): void {
  for (const b of blocks) {
    for (const run of blockInlines(b)) {
      walkInlines(run, (i) => {
        fn(i);
        if (i.t === "Note") forEachInline(i.blocks, fn);
      });
    }
    for (const child of childBlocks(b)) forEachInline(child, fn);
  }
}

/** Every inline in the document, including notes, captions, cells and the abstract. */
export function allInlines(doc: Document, fn: (i: Inline) => void): void {
  const metaRuns = [doc.meta.title, doc.meta.subtitle, doc.meta.date, ...(doc.meta.author ?? [])];
  for (const run of metaRuns) if (run) walkInlines(run, fn);
  if (doc.meta.abstract) forEachInline(doc.meta.abstract, fn);
  forEachInline(doc.blocks, fn);
}

function checkReferences(doc: Document, labels: Map<string, LabelInfo>, diagnostics: Diagnostics): void {
  allInlines(doc, (i) => {
    if (i.t !== "Ref") return;
    const info = labels.get(i.label);
    if (!info) {
      const near = closest(i.label, [...labels.keys()], 3);
      const fix = closestFix(i.label, labels.keys());
      diagnostics.add("REF001", `Reference to undefined label "${i.label}"`, i.pos, {
        hint: near.length ? `Did you mean ${near.map((n) => `"${n}"`).join(", ")}?` : labels.size ? undefined : "No labels are defined in this document",
        fix: fix && { old: i.label, new: fix.replacement, safe: fix.safe },
      });
      return;
    }
    const prefix = /^([A-Za-z]+):/.exec(i.label)?.[1]?.toLowerCase();
    const expected = prefix ? PREFIX_KIND[prefix] : undefined;
    if (expected && expected !== info.kind) {
      diagnostics.add("REF003", `Label "${i.label}" looks like a ${expected} label but is attached to a ${info.kind}`, i.pos);
    }
  });
}

/** Text a reference prints, before linking. Page references return null (filled in by the PDF writer). */
export function refText(info: LabelInfo | undefined, style: "number" | "auto" | "eq" | "page"): string | null {
  if (!info) return "??";
  if (style === "page") return null;
  const num = info.number;
  switch (style) {
    case "number":
      return num ?? info.title ?? "??";
    case "eq":
      return num ? `(${num})` : "(??)";
    case "auto":
      if (info.kind === "eq") return num ? `${info.name} (${num})` : info.name;
      return num ? `${info.name} ${num}` : info.title ? `“${info.title}”` : info.name;
  }
}

export function closest(word: string, candidates: string[], max: number): string[] {
  const scored = candidates
    .map((c) => ({ c, d: editDistance(word.toLowerCase(), c.toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(word.length / 3)))
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c));
  return scored.slice(0, max).map((x) => x.c);
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}
