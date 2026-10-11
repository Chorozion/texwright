/**
 * The CSS subset SVG figures use: declaration lists (`style` attributes and
 * rule bodies) and style sheets with simple selectors.
 *
 * Selectors: type (with or without a namespace prefix), `*`, `.class`,
 * `#id`, attribute tests (`[a]`, `[a=v]`, `~=`, `|=`, `^=`, `$=`, `*=`,
 * with an `i` flag), the structural pseudo-classes (:first-child,
 * :last-child, :only-child, :nth-child(), :nth-last-child(), the -of-type
 * forms, :root, :empty) and :not(), :is() and :where() of simple
 * selectors, in compounds, with descendant, child and sibling combinators
 * and comma lists. Pseudo-classes for user interaction (:hover, :focus,
 * ...) never match a still image; pseudo-elements and anything else drop
 * the selector, while the rest of its list still applies. At-rules are
 * skipped.
 */

import type { XmlElement } from "./xml.js";

export interface Declaration {
  name: string;
  value: string;
  important: boolean;
}

interface AttrTest {
  name: string;
  op?: "=" | "~=" | "|=" | "^=" | "$=" | "*=";
  value: string;
  caseless: boolean;
}

type Pseudo =
  | { kind: "nth"; a: number; b: number; last: boolean; ofType: boolean }
  | { kind: "root" | "empty" | "never" }
  | { kind: "not" | "is"; list: Compound[] };

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: AttrTest[];
  pseudos: Pseudo[];
}

type Combinator = " " | ">" | "+" | "~";

export interface Selector {
  /** Compounds left to right. */
  parts: Compound[];
  /** Combinator before parts[k + 1]: descendant, child, next sibling or later sibling. */
  combinators: Combinator[];
  /** ids * 1e6 + (classes, attributes, pseudo-classes) * 1e3 + types. */
  specificity: number;
}

export interface Rule {
  selectors: Selector[];
  decls: Declaration[];
  /** Source order across all style sheets of the document. */
  order: number;
}

/** Splits at top-level occurrences of `sep`, ignoring separators inside quotes and parentheses. */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function stripComments(s: string): string {
  if (!s.includes("/*")) return s;
  let out = "";
  let i = 0;
  for (;;) {
    const a = s.indexOf("/*", i);
    if (a < 0) break;
    out += s.slice(i, a) + " ";
    const b = s.indexOf("*/", a + 2);
    if (b < 0) return out;
    i = b + 2;
  }
  return out + s.slice(i);
}

/** Parses `name: value; name: value !important`. Names are lower-cased. */
export function parseDeclarations(text: string): Declaration[] {
  const out: Declaration[] = [];
  for (const part of splitTopLevel(stripComments(text), ";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    if (!name || !/^-?[a-z][a-z0-9-]*$/.test(name)) continue;
    let important = false;
    const m = /!\s*important\s*$/i.exec(value);
    if (m) {
      important = true;
      value = value.slice(0, m.index).trim();
    }
    if (value) out.push({ name, value, important });
  }
  return out;
}

const NAME_START = /[A-Za-z_\u0080-\uffff]/;
const NAME_CHAR = /[A-Za-z0-9_\-\u0080-\uffff]/;

/** Pseudo-classes for interaction and history: they match nothing in a still image. */
const DYNAMIC = new Set(["hover", "focus", "focus-within", "focus-visible", "active", "visited", "target", "checked", "disabled", "enabled", "indeterminate", "default"]);

/** A hand-rolled reader over one selector (no regular expressions with backtracking on untrusted input). */
class SelectorReader {
  i = 0;
  constructor(readonly s: string) {}

  peek(): string {
    return this.s[this.i] ?? "";
  }

  spaces(): boolean {
    const start = this.i;
    while (/\s/.test(this.peek())) this.i++;
    return this.i > start;
  }

  ident(): string | undefined {
    const start = this.i;
    if (this.peek() === "-") this.i++;
    if (this.peek() === "\\") {
      this.i += 2;
    } else if (!NAME_START.test(this.peek())) {
      this.i = start;
      return undefined;
    } else this.i++;
    while (this.i < this.s.length) {
      const c = this.peek();
      if (c === "\\") this.i += 2;
      else if (NAME_CHAR.test(c)) this.i++;
      else break;
    }
    return this.s.slice(start, this.i).replace(/\\(.)/g, "$1");
  }

  /** A quoted string or an identifier, for attribute values. */
  value(): string | undefined {
    const q = this.peek();
    if (q === '"' || q === "'") {
      const end = this.s.indexOf(q, this.i + 1);
      if (end < 0) return undefined;
      const v = this.s.slice(this.i + 1, end);
      this.i = end + 1;
      return v;
    }
    const start = this.i;
    while (this.i < this.s.length && !/[\s\]]/.test(this.peek())) this.i++;
    return this.i > start ? this.s.slice(start, this.i) : undefined;
  }

  /** The text up to the parenthesis that closes the one just read. */
  argument(): string | undefined {
    let depth = 1;
    const start = this.i;
    for (; this.i < this.s.length; this.i++) {
      const c = this.peek();
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        const arg = this.s.slice(start, this.i);
        this.i++;
        return arg;
      }
    }
    return undefined;
  }
}

/** an+b of :nth-child(): odd, even, 3, 2n+1, -n+3, n. */
function parseNth(arg: string): { a: number; b: number } | undefined {
  const t = arg.replace(/\s+/g, "").toLowerCase();
  if (t === "odd") return { a: 2, b: 1 };
  if (t === "even") return { a: 2, b: 0 };
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t);
  if (m) {
    const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
    return { a, b: m[2] ? Number(m[2]) : 0 };
  }
  if (/^[+-]?\d+$/.test(t)) return { a: 0, b: Number(t) };
  return undefined;
}

/** A compound selector starting at the reader's position; counts go to `spec`. */
function readCompound(r: SelectorReader, spec: { ids: number; classes: number; types: number }, nested: boolean): Compound | undefined {
  const c: Compound = { classes: [], attrs: [], pseudos: [] };
  let any = false;
  // Type or universal, with an optional namespace prefix.
  if (r.peek() === "*") {
    r.i++;
    any = true;
  } else {
    const save = r.i;
    const name = r.ident();
    if (name !== undefined) {
      c.tag = name;
      any = true;
      spec.types++;
    } else r.i = save;
  }
  if (r.peek() === "|") {
    r.i++;
    if (r.peek() === "*") {
      r.i++;
      if (c.tag) spec.types--;
      c.tag = undefined;
    } else {
      const name = r.ident();
      if (name === undefined) return undefined;
      if (!c.tag) spec.types++;
      c.tag = name;
    }
    any = true;
  }
  for (;;) {
    const ch = r.peek();
    if (ch === "#") {
      r.i++;
      const id = r.ident();
      if (id === undefined) return undefined;
      if (c.id !== undefined && c.id !== id) c.pseudos.push({ kind: "never" });
      c.id = id;
      spec.ids++;
    } else if (ch === ".") {
      r.i++;
      const cls = r.ident();
      if (cls === undefined) return undefined;
      c.classes.push(cls);
      spec.classes++;
    } else if (ch === "[") {
      r.i++;
      r.spaces();
      let name = r.ident();
      if (name === undefined) return undefined;
      if (r.peek() === "|" && r.s[r.i + 1] !== "=") {
        r.i++;
        const local = r.ident();
        if (local === undefined) return undefined;
        name = `${name}:${local}`;
      }
      r.spaces();
      const test: AttrTest = { name, value: "", caseless: false };
      const two = r.s.slice(r.i, r.i + 2);
      if (two === "~=" || two === "|=" || two === "^=" || two === "$=" || two === "*=") {
        test.op = two;
        r.i += 2;
      } else if (r.peek() === "=") {
        test.op = "=";
        r.i++;
      }
      if (test.op) {
        r.spaces();
        const v = r.value();
        if (v === undefined) return undefined;
        test.value = v;
        r.spaces();
        if (/[iIsS]/.test(r.peek())) {
          test.caseless = r.peek().toLowerCase() === "i";
          r.i++;
          r.spaces();
        }
      }
      if (r.peek() !== "]") return undefined;
      r.i++;
      c.attrs.push(test);
      spec.classes++;
    } else if (ch === ":") {
      r.i++;
      if (r.peek() === ":") return undefined; // pseudo-elements draw nothing in SVG
      const name = r.ident()?.toLowerCase();
      if (name === undefined) return undefined;
      if (r.peek() === "(") {
        r.i++;
        const arg = r.argument();
        if (arg === undefined) return undefined;
        if (name === "nth-child" || name === "nth-last-child" || name === "nth-of-type" || name === "nth-last-of-type") {
          const ab = parseNth(arg.replace(/\s+of\s+.*$/i, ""));
          if (!ab) return undefined;
          c.pseudos.push({ kind: "nth", ...ab, last: name.includes("last"), ofType: name.endsWith("of-type") });
          spec.classes++;
        } else if ((name === "not" || name === "is" || name === "where" || name === "matches") && !nested) {
          const list: Compound[] = [];
          const inner = { ids: 0, classes: 0, types: 0 };
          for (const part of splitTopLevel(arg, ",")) {
            const sub = new SelectorReader(part.trim());
            const comp = readCompound(sub, inner, true);
            if (!comp || sub.i !== sub.s.length) return undefined;
            list.push(comp);
          }
          if (!list.length) return undefined;
          c.pseudos.push({ kind: name === "not" ? "not" : "is", list });
          // :where() adds nothing; :not() and :is() count their (most specific) argument, approximated by its total.
          if (name !== "where") {
            spec.ids += Math.min(inner.ids, 1);
            spec.classes += inner.ids ? 0 : Math.min(inner.classes, 1);
            spec.types += inner.ids || inner.classes ? 0 : Math.min(inner.types, 1);
          }
        } else if (name === "lang" || name === "dir") {
          c.pseudos.push({ kind: "never" });
          spec.classes++;
        } else return undefined;
      } else {
        spec.classes++;
        if (name === "first-child") c.pseudos.push({ kind: "nth", a: 0, b: 1, last: false, ofType: false });
        else if (name === "last-child") c.pseudos.push({ kind: "nth", a: 0, b: 1, last: true, ofType: false });
        else if (name === "only-child") c.pseudos.push({ kind: "nth", a: 0, b: 1, last: false, ofType: false }, { kind: "nth", a: 0, b: 1, last: true, ofType: false });
        else if (name === "first-of-type") c.pseudos.push({ kind: "nth", a: 0, b: 1, last: false, ofType: true });
        else if (name === "last-of-type") c.pseudos.push({ kind: "nth", a: 0, b: 1, last: true, ofType: true });
        else if (name === "only-of-type") c.pseudos.push({ kind: "nth", a: 0, b: 1, last: false, ofType: true }, { kind: "nth", a: 0, b: 1, last: true, ofType: true });
        else if (name === "root") c.pseudos.push({ kind: "root" });
        else if (name === "empty") c.pseudos.push({ kind: "empty" });
        else if (name === "link" || name === "any-link") c.pseudos.push({ kind: "is", list: [{ tag: "a", classes: [], attrs: [{ name: "href", value: "", caseless: false }], pseudos: [] }] });
        else if (DYNAMIC.has(name)) c.pseudos.push({ kind: "never" });
        else return undefined;
      }
    } else break;
    any = true;
  }
  return any ? c : undefined;
}

/** Parses one complex selector; undefined when it uses unsupported syntax. */
export function parseSelector(text: string): Selector | undefined {
  const t = text.trim();
  if (!t || t.length > 1000) return undefined;
  const r = new SelectorReader(t);
  const parts: Compound[] = [];
  const combinators: Combinator[] = [];
  const spec = { ids: 0, classes: 0, types: 0 };
  for (;;) {
    const c = readCompound(r, spec, false);
    if (!c) return undefined;
    parts.push(c);
    const space = r.spaces();
    if (r.i >= t.length) break;
    const ch = r.peek();
    if (ch === ">" || ch === "+" || ch === "~") {
      r.i++;
      r.spaces();
      combinators.push(ch);
    } else if (space) combinators.push(" ");
    else return undefined;
  }
  return { parts, combinators, specificity: spec.ids * 1e6 + spec.classes * 1e3 + spec.types };
}

export interface StylesheetResult {
  rules: Rule[];
  /** Selectors that were dropped as unsupported. */
  unsupported: number;
}

/**
 * Parses a style sheet. `order` numbers continue from `firstOrder`.
 * At most `maxRules` rules are kept.
 */
export function parseStylesheet(css: string, firstOrder = 0, maxRules = 10_000): StylesheetResult {
  const s = stripComments(css);
  const rules: Rule[] = [];
  let unsupported = 0;
  let order = firstOrder;
  let i = 0;
  const n = s.length;
  while (i < n && rules.length < maxRules) {
    // Prelude up to '{' or ';' (statement at-rules).
    let j = i;
    let quote = "";
    while (j < n) {
      const c = s[j];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{" || c === ";") break;
      j++;
    }
    const prelude = s.slice(i, j).trim();
    if (j >= n) break;
    if (s[j] === ";") {
      i = j + 1;
      continue;
    }
    // Find the matching '}'.
    let depth = 0;
    let k = j;
    quote = "";
    for (; k < n; k++) {
      const c = s[k];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    const body = s.slice(j + 1, k);
    i = k + 1;
    if (prelude.startsWith("@")) continue; // @media, @font-face, @keyframes, ...: skipped
    const selectors: Selector[] = [];
    for (const part of splitTopLevel(prelude, ",")) {
      const sel = parseSelector(part);
      if (sel) selectors.push(sel);
      else unsupported++;
    }
    if (selectors.length === 0) continue;
    const decls = parseDeclarations(body);
    if (decls.length) rules.push({ selectors, decls, order: order++ });
  }
  return { rules, unsupported };
}

function classList(el: XmlElement): string[] {
  const c = el.attrs.get("class");
  return c ? c.trim().split(/\s+/) : [];
}

/** The attribute an attribute selector names: `xlink:href` for `[xlink|href]`, the plain name otherwise. */
function attrValue(el: XmlElement, name: string): string | undefined {
  return el.attrs.get(name) ?? (name.startsWith("*:") ? el.attrs.get(name.slice(2)) : undefined);
}

function matchAttr(t: AttrTest, el: XmlElement): boolean {
  let have = attrValue(el, t.name);
  if (have === undefined) return false;
  if (!t.op) return true;
  let want = t.value;
  if (t.caseless) {
    have = have.toLowerCase();
    want = want.toLowerCase();
  }
  switch (t.op) {
    case "=":
      return have === want;
    case "~=":
      return want !== "" && !/\s/.test(want) && have.split(/\s+/).includes(want);
    case "|=":
      return have === want || have.startsWith(want + "-");
    case "^=":
      return want !== "" && have.startsWith(want);
    case "$=":
      return want !== "" && have.endsWith(want);
    case "*=":
      return want !== "" && have.includes(want);
  }
}

/** The element children of an element's parent. */
function siblings(el: XmlElement): XmlElement[] {
  return el.parent ? (el.parent.children.filter((c) => c.type === "element") as XmlElement[]) : [el];
}

function matchPseudo(p: Pseudo, el: XmlElement, budget: { steps: number }): boolean {
  switch (p.kind) {
    case "never":
      return false;
    case "root":
      return !el.parent;
    case "empty":
      return el.children.every((c) => c.type !== "element" && !(c.type === "text" && c.value !== ""));
    case "nth": {
      let sibs = siblings(el);
      if (p.ofType) sibs = sibs.filter((x) => x.name === el.name);
      budget.steps -= sibs.length >> 4;
      const idx = sibs.indexOf(el);
      const n = p.last ? sibs.length - idx : idx + 1;
      if (p.a === 0) return n === p.b;
      const k = (n - p.b) / p.a;
      return Number.isInteger(k) && k >= 0;
    }
    case "not":
      return !p.list.some((c) => matchCompound(c, el, () => classList(el), budget));
    case "is":
      return p.list.some((c) => matchCompound(c, el, () => classList(el), budget));
  }
}

function matchCompound(c: Compound, el: XmlElement, classes: () => string[], budget: { steps: number }): boolean {
  if (c.tag !== undefined && c.tag !== el.name) return false;
  if (c.id !== undefined && el.attrs.get("id") !== c.id) return false;
  if (c.classes.length) {
    const have = classes();
    for (const k of c.classes) if (!have.includes(k)) return false;
  }
  for (const a of c.attrs) if (!matchAttr(a, el)) return false;
  for (const p of c.pseudos) if (!matchPseudo(p, el, budget)) return false;
  return true;
}

/** Does the selector match the element? `budget.steps` is decremented per compound test. */
export function matches(sel: Selector, el: XmlElement, budget: { steps: number }): boolean {
  const last = sel.parts.length - 1;
  let cache: string[] | undefined;
  const own = () => (cache ??= classList(el));
  budget.steps--;
  if (!matchCompound(sel.parts[last], el, own, budget)) return false;
  return matchFrom(sel, last - 1, el, budget);
}

/** Whether parts[0..k] match, going left from `el` (which matched parts[k + 1]) by the combinator between them. */
function matchFrom(sel: Selector, k: number, el: XmlElement, budget: { steps: number }): boolean {
  if (k < 0) return true;
  const comb = sel.combinators[k];
  const test = (e: XmlElement): boolean => {
    if (--budget.steps < 0) return false;
    return matchCompound(sel.parts[k], e, () => classList(e), budget) && matchFrom(sel, k - 1, e, budget);
  };
  if (comb === ">" || comb === " ") {
    for (let p = el.parent; p; p = p.parent) {
      if (test(p)) return true;
      if (comb === ">" || budget.steps < 0) return false;
    }
    return false;
  }
  const sibs = siblings(el);
  const idx = sibs.indexOf(el);
  if (comb === "+") return idx > 0 && test(sibs[idx - 1]);
  for (let i = idx - 1; i >= 0; i--) {
    if (test(sibs[i])) return true;
    if (budget.steps < 0) return false;
  }
  return false;
}
