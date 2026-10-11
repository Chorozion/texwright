/**
 * Citation processor: turns Cite nodes into inlines and builds the reference
 * list, in the numeric or the author-year style.
 *
 * cite() must be called in document order. In the author-year style a year
 * that later needs a disambiguating letter ("2020" becoming "2020b" once a
 * second Doe 2020 is cited) is updated in place: the Text nodes returned by
 * earlier cite() calls are patched, so keep the returned nodes rather than
 * copies until bibliography() has run.
 */

import { closestFix } from "../fixes.js";
import { plainText, type CiteItem, type Inline, type Pos } from "../ast.js";
import type { Diagnostics } from "../diagnostics.js";
import { authorYearReference } from "./authoryear.js";
import {
  NBSP,
  creators,
  familyName,
  isOthers,
  link,
  locatorLabel,
  shortNames,
  stripMarkup,
  text,
  titleForCitation,
  yearNumber,
  yearOf,
  type Style,
  type TextNode,
} from "./format.js";
import { numericReference } from "./numeric.js";
import { entrySource } from "./source.js";
import type { BibEntry } from "./types.js";

type CiteNode = Extract<Inline, { t: "Cite" }>;

export interface BibItem {
  key: string;
  /** HTML anchor, "ref-" + the key slugified. Citations link to "#" + id. */
  id: string;
  /** "[1]" in the numeric style; absent in author-year. */
  label?: string;
  content: Inline[];
}

export interface CiteProcessor {
  cite(node: CiteNode): Inline[];
  bibliography(): BibItem[];
}

export function createCiteProcessor(entries: BibEntry[], style: Style, diagnostics: Diagnostics): CiteProcessor {
  return new Processor(entries, style, diagnostics);
}

interface Ref {
  item: CiteItem;
  key: string;
  entry?: BibEntry;
}

let sharedCollator: Intl.Collator | undefined;
/** Made on first use: creating it starts up ICU, some 20 ms that documents without sorted citations need not pay. */
const collator = (): Intl.Collator => (sharedCollator ??= new Intl.Collator("en", { sensitivity: "base", numeric: true }));

class Processor implements CiteProcessor {
  private readonly byKey = new Map<string, BibEntry>();
  /** Keys in first-use order (cited or nocited). */
  private readonly used = new Set<string>();
  /** Numeric style: keys in citation-number order. */
  private readonly numbered: string[] = [];
  private readonly numbers = new Map<string, number>();
  private readonly nocited = new Set<string>();
  private readonly anchors = new Map<string, string>();
  private readonly takenAnchors = new Set<string>();
  private readonly reported = new Set<string>();
  /** Author-year style: entries sharing an author label and year, the letter each got, and the year nodes to patch. */
  private readonly groups = new Map<string, string[]>();
  private readonly letters = new Map<string, string>();
  private readonly yearNodes = new Map<string, TextNode[]>();

  constructor(
    entries: BibEntry[],
    private readonly style: Style,
    private readonly diagnostics: Diagnostics,
  ) {
    for (const e of entries) if (!this.byKey.has(e.id)) this.byKey.set(e.id, e);
    // Hand-written entries are all listed, numbered in the order they were written.
    for (const e of entries) {
      if (!e.formatted || this.numbers.has(e.id)) continue;
      this.used.add(e.id);
      this.anchor(e.id);
      this.numbered.push(e.id);
      this.numbers.set(e.id, this.numbered.length);
    }
  }

  cite(node: CiteNode): Inline[] {
    if (node.mode === "nocite") {
      for (const item of node.items) this.nocite(item.key, node.pos);
      return [];
    }
    const refs: Ref[] = node.items.map((item) => ({ item, key: item.key, entry: this.resolve(item.key, node.pos) }));
    if (refs.length === 0) return [];
    if (this.style === "author-year") return this.authorYearCite(refs, node.mode);
    for (const r of refs) {
      if (r.entry && !this.numbers.has(r.key)) {
        this.numbered.push(r.key);
        this.numbers.set(r.key, this.numbered.length);
      }
    }
    return this.numericCite(refs, node.mode);
  }

  bibliography(): BibItem[] {
    if (this.style === "numeric") {
      const keys = [...this.numbered, ...[...this.nocited].filter((k) => !this.numbers.has(k))];
      return keys.map((key, k) => ({ key, id: this.anchor(key), label: `[${k + 1}]`, content: numericReference(this.entry(key)) }));
    }
    const keys = [...this.used].sort((a, b) => this.compareAuthorYear(a, b));
    return keys.map((key) => ({ key, id: this.anchor(key), content: authorYearReference(this.entry(key), this.yearLabel(key)) }));
  }

  // ---------------------------------------------------------------- registry

  private entry(key: string): BibEntry {
    return this.byKey.get(key) as BibEntry;
  }

  private resolve(key: string, pos: Pos | undefined): BibEntry | undefined {
    const entry = this.byKey.get(key);
    if (!entry) {
      this.reportUnknown(key, pos);
      return undefined;
    }
    if (!this.used.has(key)) {
      this.used.add(key);
      this.checkFields(key, entry);
      this.anchor(key);
      if (this.style === "author-year") this.disambiguate(key, entry);
    }
    return entry;
  }

  private nocite(key: string, pos: Pos | undefined): void {
    const keys = key === "*" ? [...this.byKey.keys()] : [key];
    for (const k of keys) {
      if (this.resolve(k, pos)) this.nocited.add(k);
    }
  }

  private anchor(key: string): string {
    let id = this.anchors.get(key);
    if (id === undefined) {
      const base = `ref-${slug(key)}`;
      id = base;
      for (let n = 2; this.takenAnchors.has(id); n++) id = `${base}-${n}`;
      this.anchors.set(key, id);
      this.takenAnchors.add(id);
    }
    return id;
  }

  private href(key: string): string {
    return `#${this.anchor(key)}`;
  }

  private reportUnknown(key: string, pos: Pos | undefined): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    const near = closestKeys(key, [...this.byKey.keys()]);
    const hint =
      this.byKey.size === 0
        ? "The bibliography has no entries; check that the bibliography file is given and parses."
        : near.length > 0
          ? `Did you mean ${orList(near.map((k) => `"${k}"`))}?`
          : "Check the key against the bibliography file.";
    const fix = closestFix(key, this.byKey.keys());
    this.diagnostics.add("CITE001", `Citation key "${key}" not found in the bibliography`, pos, {
      hint,
      fix: fix && { old: key, new: fix.replacement, safe: fix.safe },
    });
  }

  private checkFields(key: string, e: BibEntry): void {
    if (e.formatted) return;
    const missing = [!e.title && "title", !yearOf(e) && "year"].filter((f): f is string => typeof f === "string");
    if (missing.length === 0) return;
    this.diagnostics.add("CITE004", `Bibliography entry "${key}" has no ${missing.join(" or ")}`, entrySource(e), {
      hint: `Add ${missing.map((f) => (f === "year" ? "a year or date" : "a title")).join(" and ")} to the entry.`,
    });
  }

  // ---------------------------------------------------------------- author-year disambiguation

  private disambiguate(key: string, e: BibEntry): void {
    const group = `${plainText(this.authorLabel(e))}\u0000${yearOf(e) ?? ""}`;
    const members = this.groups.get(group) ?? [];
    members.push(key);
    this.groups.set(group, members);
    if (members.length < 2) return;
    members.sort((a, b) => collator().compare(sortTitle(this.entry(a)), sortTitle(this.entry(b))) || compareKeys(a, b));
    members.forEach((k, index) => {
      const letter = letterFor(index);
      if (this.letters.get(k) === letter) return;
      this.letters.set(k, letter);
      for (const node of this.yearNodes.get(k) ?? []) node.text = this.yearLabel(k);
    });
  }

  private yearLabel(key: string): string {
    const year = yearOf(this.entry(key)) ?? "n.d.";
    const letter = this.letters.get(key);
    if (!letter) return year;
    return /^\d+$/.test(year) ? year + letter : `${year}-${letter}`;
  }

  /** A year Text node that disambiguation can still update. */
  private liveYear(key: string): TextNode {
    const node = text(this.yearLabel(key));
    const nodes = this.yearNodes.get(key) ?? [];
    nodes.push(node);
    this.yearNodes.set(key, nodes);
    return node;
  }

  private compareAuthorYear(a: string, b: string): number {
    const ea = this.entry(a);
    const eb = this.entry(b);
    const ya = yearNumber(ea) ?? Infinity;
    const yb = yearNumber(eb) ?? Infinity;
    return (
      collator().compare(sortAuthor(ea), sortAuthor(eb)) ||
      (ya === yb ? 0 : ya < yb ? -1 : 1) ||
      collator().compare(sortTitle(ea), sortTitle(eb)) ||
      compareKeys(a, b)
    );
  }

  // ---------------------------------------------------------------- citations

  /** "Doe", "Doe and Roe", "Doe et al.", or the title when there is no author or editor. */
  private authorLabel(e: BibEntry): Inline[] {
    const head = creators(e);
    const short = head ? shortNames(head.names) : "";
    if (short) return [text(short)];
    return titleForCitation(e, this.style) ?? [text(e.id)];
  }

  private numericCite(refs: Ref[], mode: CiteNode["mode"]): Inline[] {
    const number = (r: Ref): Inline => link(this.href(r.key), [text(String(this.numbers.get(r.key)))]);
    switch (mode) {
      case "text":
        return joinAnd(
          refs.map((r) =>
            r.entry
              ? [...prefix(r.item), ...this.authorLabel(r.entry), text(`${NBSP}[`), number(r), ...extras(r.item), text("]")]
              : [text(`[?${r.key}]`)],
          ),
        );
      case "author":
        return joinAnd(refs.map((r) => (r.entry ? [...prefix(r.item), link(this.href(r.key), this.authorLabel(r.entry))] : [text(`?${r.key}`)])));
      case "year":
        return join(
          refs.map((r) => (r.entry ? [...prefix(r.item), link(this.href(r.key), [text(yearOf(r.entry) ?? "n.d.")]), ...extras(r.item)] : [text(`?${r.key}`)])),
          ", ",
        );
      default:
        return [text("["), ...this.numericList(refs, number), text("]")];
    }
  }

  /** "1, 3–5": sorted and compressed; with any prefix, locator or suffix, citation order and ";" between items. */
  private numericList(refs: Ref[], number: (r: Ref) => Inline): Inline[] {
    const unknown = [...new Set(refs.filter((r) => !r.entry).map((r) => r.key))].map((k) => [text(`?${k}`)]);
    if (refs.some((r) => r.item.prefix?.trim() || r.item.locator?.trim() || r.item.suffix?.trim())) {
      return join(
        refs.map((r) => (r.entry ? [...prefix(r.item), number(r), ...extras(r.item)] : [text(`?${r.key}`)])),
        "; ",
      );
    }
    const known = [...new Map(refs.filter((r) => r.entry).map((r) => [this.numbers.get(r.key) as number, r])).entries()].sort((a, b) => a[0] - b[0]);
    const parts: Inline[][] = [];
    for (let k = 0; k < known.length; ) {
      let j = k;
      while (j + 1 < known.length && known[j + 1][0] === known[j][0] + 1) j++;
      if (j - k >= 2) parts.push([number(known[k][1]), text("–"), number(known[j][1])]);
      else for (let x = k; x <= j; x++) parts.push([number(known[x][1])]);
      k = j + 1;
    }
    return join([...parts, ...unknown], ", ");
  }

  private authorYearCite(refs: Ref[], mode: CiteNode["mode"]): Inline[] {
    const year = (r: Ref): Inline => link(this.href(r.key), [this.liveYear(r.key)]);
    switch (mode) {
      case "author":
        return joinAnd(refs.map((r) => (r.entry ? [...prefix(r.item), link(this.href(r.key), this.authorLabel(r.entry))] : [text(`${r.key}?`)])));
      case "year":
        return join(
          refs.map((r) => (r.entry ? [...prefix(r.item), year(r), ...extras(r.item)] : [text(`${r.key}?`)])),
          ", ",
        );
      case "text":
        return joinAnd(
          this.groupByAuthor(refs).map((g) => {
            const [first, ...rest] = g;
            if (!first.entry) return [text(`(${first.key}?)`)];
            const out: Inline[] = [...prefix(first.item), ...this.authorLabel(first.entry), text(" ("), year(first), ...extras(first.item)];
            for (const r of rest) out.push(text(", "), year(r), ...extras(r.item));
            out.push(text(")"));
            return out;
          }),
        );
      default: {
        const groups = this.groupByAuthor(refs).map((g) => {
          const [first, ...rest] = g;
          if (!first.entry) return [text(`${first.key}?`)];
          const out: Inline[] = [
            ...prefix(first.item),
            link(this.href(first.key), [...this.authorLabel(first.entry), text(" "), this.liveYear(first.key)]),
            ...extras(first.item),
          ];
          for (const r of rest) out.push(text(", "), year(r), ...extras(r.item));
          return out;
        });
        return [text("("), ...join(groups, "; "), text(")")];
      }
    }
  }

  /** Items by the same authors share one author label: "(Doe 2019, 2020; Roe 2018)". An item with a prefix starts a new group. */
  private groupByAuthor(refs: Ref[]): Ref[][] {
    const groups: { label?: string; refs: Ref[] }[] = [];
    for (const r of refs) {
      const label = r.entry ? plainText(this.authorLabel(r.entry)) : undefined;
      const same = label !== undefined && !r.item.prefix?.trim() ? groups.find((g) => g.label === label) : undefined;
      if (same) same.refs.push(r);
      else groups.push({ label, refs: [r] });
    }
    return groups.map((g) => g.refs);
  }
}

// ------------------------------------------------------------------ helpers

function prefix(item: CiteItem): Inline[] {
  const p = item.prefix?.trim();
  return p ? [text(`${p} `)] : [];
}

/** ", p. 4" and the suffix; a suffix that starts with punctuation is attached as is. */
function extras(item: CiteItem): Inline[] {
  let s = "";
  const locator = item.locator?.trim();
  if (locator) s += `, ${locatorLabel(locator)}`;
  const suffix = item.suffix?.trim();
  if (suffix) s += /^[,;:.]/.test(suffix) ? suffix : `, ${suffix}`;
  return s ? [text(s)] : [];
}

function join(parts: Inline[][], sep: string): Inline[] {
  return parts.flatMap((p, k) => (k === 0 ? p : [text(sep), ...p]));
}

/** "A", "A and B", "A, B, and C". */
function joinAnd(parts: Inline[][]): Inline[] {
  if (parts.length <= 2) return join(parts, " and ");
  return [...join(parts.slice(0, -1), ", "), text(", and "), ...parts[parts.length - 1]];
}

function orList(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** 0 -> "a", 25 -> "z", 26 -> "aa". */
function letterFor(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s;
  return s;
}

function slug(key: string): string {
  return (
    key
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "entry"
  );
}

const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const sortTitle = (e: BibEntry): string => stripMarkup(e.title ?? "");

/** First author's family name (or editor's, or the title). */
function sortAuthor(e: BibEntry): string {
  const first = creators(e)?.names.find((n) => !isOthers(n));
  return first ? familyName(first) : sortTitle(e);
}

/** Up to three keys closest to `key` by edit distance (case-insensitive), nearest first. */
function closestKeys(key: string, keys: string[]): string[] {
  const target = key.toLowerCase();
  const limit = Math.max(2, Math.floor(target.length / 3));
  return keys
    .map((k) => ({ k, d: editDistance(target, k.toLowerCase()) }))
    .filter((x) => x.d <= limit)
    .sort((a, b) => a.d - b.d || compareKeys(a.k, b.k))
    .slice(0, 3)
    .map((x) => x.k);
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
