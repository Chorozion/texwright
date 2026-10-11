/**
 * A small XML parser for SVG files.
 *
 * It reads elements, attributes, text, CDATA sections, comments and
 * processing instructions, and decodes the five predefined entities and
 * numeric character references. It never processes a DOCTYPE: the
 * declaration and any internal subset are skipped unread, so custom entities
 * are never defined and never expanded (no "billion laughs", no external
 * entities). References to undefined entities are dropped and reported.
 *
 * Every step scans forward only, so parsing is linear in the input size.
 * Input length, nesting depth, element count and attribute count are capped.
 * Malformed input yields `error` instead of an exception.
 */

export interface XmlElement {
  readonly type: "element";
  /** Qualified name as written, with an `svg:` prefix removed. */
  name: string;
  /** Attributes by qualified name (`xlink:href`, `xml:space`, ...). A Map, so no name can reach Object.prototype. */
  attrs: Map<string, string>;
  children: XmlNode[];
  parent: XmlElement | undefined;
  /** Offset of the element's `<` in the source. */
  offset: number;
}

export interface XmlText {
  readonly type: "text";
  value: string;
}

export type XmlNode = XmlElement | XmlText;

export interface XmlLimits {
  /** Longest input accepted, in UTF-16 code units. */
  maxLength: number;
  /** Deepest element nesting accepted. */
  maxDepth: number;
  /** Most elements accepted. */
  maxElements: number;
  /** Most attributes on one element. */
  maxAttributes: number;
}

export const DEFAULT_XML_LIMITS: Readonly<XmlLimits> = {
  maxLength: 32 * 1024 * 1024,
  maxDepth: 256,
  maxElements: 250_000,
  maxAttributes: 1024,
};

export interface XmlError {
  message: string;
  offset: number;
  line: number;
  col: number;
}

export interface XmlResult {
  root?: XmlElement;
  error?: XmlError;
  /** Names of entity references that were not expanded, each once, in order of appearance. */
  unexpandedEntities: string[];
  /** True when a DOCTYPE declaration was present (and skipped). */
  doctype: boolean;
  /** Number of elements read. */
  elements: number;
}

class SyntaxErr {
  constructor(
    readonly message: string,
    readonly offset: number,
  ) {}
}

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
/** Longest entity reference looked at, `&` and `;` included; anything longer is a literal `&`. */
const MAX_ENTITY_REF = 40;

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isNameStart(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || c === 0x3a || c >= 0x80;
}

function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e;
}

/** 1-based line and column of an offset. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let start = 0;
  const end = Math.min(offset, text.length);
  for (let i = text.indexOf("\n"); i >= 0 && i < end; i = text.indexOf("\n", i + 1)) {
    line++;
    start = i + 1;
  }
  return { line, col: end - start + 1 };
}

class Parser {
  private i = 0;
  private readonly n: number;
  private readonly stack: XmlElement[] = [];
  private root: XmlElement | undefined;
  private count = 0;
  private readonly unknown = new Set<string>();
  doctype = false;

  constructor(
    private readonly s: string,
    private readonly limits: XmlLimits,
  ) {
    this.n = s.length;
  }

  get unexpanded(): string[] {
    return [...this.unknown];
  }

  get elements(): number {
    return this.count;
  }

  private fail(message: string, offset = this.i): never {
    throw new SyntaxErr(message, offset);
  }

  parse(): XmlElement {
    const s = this.s;
    if (s.charCodeAt(0) === 0xfeff) this.i = 1;
    while (this.i < this.n) {
      const lt = s.indexOf("<", this.i);
      if (lt < 0) {
        this.text(this.i, this.n);
        this.i = this.n;
        break;
      }
      if (lt > this.i) this.text(this.i, lt);
      this.i = lt;
      const c1 = s.charCodeAt(lt + 1);
      if (c1 === 0x21 /* ! */) {
        if (s.startsWith("<!--", lt)) this.comment();
        else if (s.startsWith("<![CDATA[", lt)) this.cdata();
        else if (s.startsWith("<!DOCTYPE", lt) || s.startsWith("<!doctype", lt)) this.skipDoctype();
        else this.fail("unexpected markup declaration '<!'");
      } else if (c1 === 0x3f /* ? */) {
        const end = s.indexOf("?>", lt + 2);
        if (end < 0) this.fail("processing instruction is not closed with '?>'");
        this.i = end + 2;
      } else if (c1 === 0x2f /* / */) {
        this.endTag();
        if (this.stack.length === 0) break; // the root closed; anything after it is ignored
      } else {
        this.startTag();
        if (this.stack.length === 0 && this.root) break; // a self-closing root
      }
    }
    if (this.stack.length > 0) {
      const open = this.stack[this.stack.length - 1];
      this.fail(`element <${open.name}> is not closed`, open.offset);
    }
    if (!this.root) this.fail("no root element", 0);
    return this.root;
  }

  private comment(): void {
    const end = this.s.indexOf("-->", this.i + 4);
    if (end < 0) this.fail("comment is not closed with '-->'");
    this.i = end + 3;
  }

  private cdata(): void {
    const start = this.i + 9;
    const end = this.s.indexOf("]]>", start);
    if (end < 0) this.fail("CDATA section is not closed with ']]>'");
    const top = this.stack[this.stack.length - 1];
    if (top) this.appendText(top, this.s.slice(start, end).replace(/\r\n?/g, "\n"));
    this.i = end + 3;
  }

  /** Skips `<!DOCTYPE ...>` including an internal subset, reading nothing from it. */
  private skipDoctype(): void {
    if (this.root || this.stack.length) this.fail("DOCTYPE inside the document");
    this.doctype = true;
    const s = this.s;
    let i = this.i + 9;
    let depth = 0;
    while (i < this.n) {
      const c = s.charCodeAt(i);
      if (c === 0x22 || c === 0x27) {
        const q = s.indexOf(c === 0x22 ? '"' : "'", i + 1);
        if (q < 0) break;
        i = q + 1;
      } else if (c === 0x3c && s.startsWith("<!--", i)) {
        const e = s.indexOf("-->", i + 4);
        if (e < 0) break;
        i = e + 3;
      } else if (c === 0x5b /* [ */) {
        depth++;
        i++;
      } else if (c === 0x5d /* ] */) {
        depth = Math.max(0, depth - 1);
        i++;
      } else if (c === 0x3e /* > */ && depth === 0) {
        this.i = i + 1;
        return;
      } else i++;
    }
    this.fail("DOCTYPE declaration is not closed", this.i);
  }

  private readName(): string {
    const s = this.s;
    const start = this.i;
    if (start >= this.n || !isNameStart(s.charCodeAt(start))) return "";
    let i = start + 1;
    while (i < this.n && isNameChar(s.charCodeAt(i))) i++;
    this.i = i;
    return s.slice(start, i);
  }

  private skipWs(): boolean {
    const start = this.i;
    while (this.i < this.n && isWs(this.s.charCodeAt(this.i))) this.i++;
    return this.i > start;
  }

  private startTag(): void {
    const lt = this.i;
    if (this.root && this.stack.length === 0) this.fail("more than one root element");
    this.i++;
    let name = this.readName();
    if (!name) this.fail("expected an element name after '<'");
    if (name.startsWith("svg:")) name = name.slice(4);
    if (++this.count > this.limits.maxElements) this.fail(`more than ${this.limits.maxElements} elements`, lt);
    if (this.stack.length >= this.limits.maxDepth) this.fail(`elements nested more than ${this.limits.maxDepth} levels deep`, lt);
    const attrs = new Map<string, string>();
    for (;;) {
      const ws = this.skipWs();
      if (this.i >= this.n) this.fail(`start tag <${name}> is not closed`, lt);
      const c = this.s.charCodeAt(this.i);
      if (c === 0x3e /* > */) {
        this.i++;
        this.open(name, attrs, lt, false);
        return;
      }
      if (c === 0x2f /* / */) {
        if (this.s.charCodeAt(this.i + 1) !== 0x3e) this.fail("expected '>' after '/'");
        this.i += 2;
        this.open(name, attrs, lt, true);
        return;
      }
      if (!ws) this.fail(`expected whitespace, '>' or '/>' in <${name}>`);
      const aname = this.readName();
      if (!aname) this.fail(`unexpected character '${this.s[this.i]}' in <${name}>`);
      this.skipWs();
      if (this.s.charCodeAt(this.i) !== 0x3d /* = */) this.fail(`attribute '${aname}' has no value`);
      this.i++;
      this.skipWs();
      const q = this.s.charCodeAt(this.i);
      if (q !== 0x22 && q !== 0x27) this.fail(`value of attribute '${aname}' is not quoted`);
      const end = this.s.indexOf(q === 0x22 ? '"' : "'", this.i + 1);
      if (end < 0) this.fail(`value of attribute '${aname}' is not closed`);
      if (attrs.has(aname)) this.fail(`attribute '${aname}' appears twice in <${name}>`);
      if (attrs.size >= this.limits.maxAttributes) this.fail(`more than ${this.limits.maxAttributes} attributes in <${name}>`);
      attrs.set(aname, this.decode(this.i + 1, end, true));
      this.i = end + 1;
    }
  }

  private open(name: string, attrs: Map<string, string>, offset: number, selfClosing: boolean): void {
    const parent = this.stack[this.stack.length - 1];
    const el: XmlElement = { type: "element", name, attrs, children: [], parent, offset };
    if (parent) parent.children.push(el);
    else this.root = el;
    if (!selfClosing) this.stack.push(el);
  }

  private endTag(): void {
    const lt = this.i;
    this.i += 2;
    let name = this.readName();
    if (name.startsWith("svg:")) name = name.slice(4);
    this.skipWs();
    if (this.s.charCodeAt(this.i) !== 0x3e) this.fail("end tag is not closed with '>'");
    this.i++;
    const top = this.stack.pop();
    if (!top) this.fail(`end tag </${name}> without a start tag`, lt);
    if (top.name !== name) this.fail(`end tag </${name}> does not match <${top.name}>`, lt);
  }

  private text(from: number, to: number): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) return; // text outside the root element is ignored
    const value = this.decode(from, to, false).replace(/\r\n?/g, "\n");
    if (value) this.appendText(top, value);
  }

  private appendText(el: XmlElement, value: string): void {
    const last = el.children[el.children.length - 1];
    if (last && last.type === "text") last.value += value;
    else el.children.push({ type: "text", value });
  }

  /** Decodes entity and character references in s[from, to). Attribute values also get whitespace normalized. */
  private decode(from: number, to: number, attr: boolean): string {
    // Work on the segment only, so searches never run past its end (linear overall).
    const s = this.s.slice(from, to);
    const raw = (a: number, b: number) => (attr ? s.slice(a, b).replace(/[\t\n\r]/g, " ") : s.slice(a, b));
    to = s.length;
    let amp = s.indexOf("&");
    if (amp < 0) return raw(0, to);
    let out = "";
    let last = 0;
    while (amp >= 0 && amp < to) {
      out += raw(last, amp);
      // Find ';' within a short window; a bare '&' is kept as text.
      let semi = -1;
      const limit = Math.min(to, amp + MAX_ENTITY_REF);
      for (let k = amp + 1; k < limit; k++) {
        const c = s.charCodeAt(k);
        if (c === 0x3b) {
          semi = k;
          break;
        }
        if (isWs(c) || c === 0x26 || c === 0x3c) break;
      }
      if (semi < 0) {
        out += "&";
        last = amp + 1;
      } else {
        const body = s.slice(amp + 1, semi);
        if (body.charCodeAt(0) === 0x23 /* # */) out += charRef(body);
        else if (Object.prototype.hasOwnProperty.call(PREDEFINED, body)) out += PREDEFINED[body];
        else this.unknown.add(body); // never expanded; dropped
        last = semi + 1;
      }
      amp = s.indexOf("&", last);
    }
    return out + raw(last, to);
  }
}

function charRef(body: string): string {
  let cp: number;
  if (body[1] === "x" || body[1] === "X") cp = /^#[xX][0-9a-fA-F]{1,6}$/.test(body) ? parseInt(body.slice(2), 16) : NaN;
  else cp = /^#[0-9]{1,7}$/.test(body) ? parseInt(body.slice(1), 10) : NaN;
  if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  return String.fromCodePoint(cp);
}

/** Parses an XML document. Never throws for bad input; see `error`. */
export function parseXml(text: string, limits?: Partial<XmlLimits>): XmlResult {
  const lim: XmlLimits = { ...DEFAULT_XML_LIMITS, ...limits };
  if (text.length > lim.maxLength) {
    return {
      error: { message: `file is larger than ${lim.maxLength} characters`, offset: 0, line: 1, col: 1 },
      unexpandedEntities: [],
      doctype: false,
      elements: 0,
    };
  }
  const p = new Parser(text, lim);
  try {
    const root = p.parse();
    return { root, unexpandedEntities: p.unexpanded, doctype: p.doctype, elements: p.elements };
  } catch (e) {
    if (!(e instanceof SyntaxErr)) throw e;
    const { line, col } = lineCol(text, e.offset);
    return { error: { message: e.message, offset: e.offset, line, col }, unexpandedEntities: p.unexpanded, doctype: p.doctype, elements: p.elements };
  }
}

/** Concatenated text content of an element (descendant text in document order). */
export function textContent(el: XmlElement): string {
  let out = "";
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.type === "text") out += c.value;
      else walk(c);
    }
  };
  walk(el);
  return out;
}
