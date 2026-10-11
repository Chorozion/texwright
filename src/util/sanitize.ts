/**
 * Raw HTML sanitizer: an HTML tokenizer and an allowlist serializer.
 *
 * The tokenizer follows the WHATWG tokenizer where it matters for safety:
 * tag names run to whitespace, `/` or `>` (so `<scr<script>` is one odd tag),
 * attributes may be quoted, unquoted or valueless, a tag cut off by the end
 * of the input is dropped, comments end at `-->`, `--!>` or an abrupt `<!-->`,
 * `<!...>` and `<?...>` are bogus comments, and script, style, iframe,
 * noscript and friends hold raw text up to their end tag. Character
 * references are decoded (numeric ones with the WHATWG replacements, named
 * ones from the HTML 4 set plus common HTML 5 punctuation names), so URL
 * checks see what a browser would see.
 *
 * The serializer writes only allowlisted elements and attributes, always
 * re-escaped, so its output can't contain markup the checks didn't see: text
 * is escaped, attribute values are double-quoted and escaped, unclosed
 * elements are closed and stray end tags are dropped. Elements that hold
 * code or inert content (script, style, iframe, object, embed, noscript,
 * template, textarea, title...) are dropped with everything inside them;
 * other unknown elements lose their tags but keep their text.
 *
 * `HtmlSanitizer` is a session that can be fed several fragments of one
 * document (Markdown hands over inline HTML tag by tag): open elements and
 * "inside a dropped element" carry over between fragments, and `close()`
 * closes whatever is still open.
 */

export interface SanitizeOptions {
  /**
   * Rewrites an `<img>` src that passed the scheme check (already
   * entity-decoded). Return undefined or "" to drop the attribute. Without
   * it, `file:` image URLs are refused.
   */
  imageSrc?: (src: string) => string | undefined;
  /** Deepest nesting of kept elements; deeper tags are dropped, their text kept. Default 256. */
  maxDepth?: number;
}

export interface SanitizeResult {
  html: string;
  /** Whether anything was removed for safety: elements, tags, attributes, URLs, unfinished tags. */
  removed: boolean;
  /** What was removed, de-duplicated, e.g. "<script> element", "onerror attribute", "javascript: URL". */
  removals: string[];
}

/** Sanitize one self-contained fragment. */
export function sanitizeHtml(html: string, options: SanitizeOptions = {}): SanitizeResult {
  const session = new HtmlSanitizer(options);
  const part = session.feed(html);
  return { html: part.html + session.close(), removed: part.removed, removals: part.removals };
}

// ------------------------------------------------------------------ policy

/** Allowed elements: sanitize-html's defaults plus the extras texwright always allowed. */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "footer", "header", "h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "main", "nav", "section",
  "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure", "hr", "li", "menu", "ol", "p", "pre", "ul",
  "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code", "data", "dfn", "em", "i", "kbd", "mark", "q",
  "rb", "rp", "rt", "rtc", "ruby", "s", "samp", "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr",
  "caption", "col", "colgroup", "table", "tbody", "td", "tfoot", "th", "thead", "tr",
  "img", "del", "ins", "details", "summary",
]);

/** Attributes allowed on every element, and per element. */
const GLOBAL_ATTRS = new Set(["id", "class", "title", "lang", "dir", "aria-label", "colspan", "rowspan", "align"]);
const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(["href", "name", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height"]),
  abbr: new Set(["title"]),
};
const LINK_SCHEMES = new Set(["http", "https", "mailto"]);
const IMAGE_SCHEMES = new Set(["data", "http", "https"]);
const IMAGE_SCHEMES_RESOLVED = new Set(["data", "file", "http", "https"]);

/** Elements dropped together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title",
  "xmp", "noembed", "noframes", "plaintext", "option", "frameset", "applet",
]);
/** Elements whose content the tokenizer reads as raw text up to the matching end tag. */
const RAW_TEXT = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "textarea", "title", "plaintext"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr", "keygen", "frame"]);

/** Elements whose start closes an open <p> (WHATWG "close a p element in button scope"). */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul", "summary",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const P_SCOPE = new Set(["table", "td", "th", "caption"]);
const LIST_SCOPE = new Set(["ul", "ol", "menu", "table", "td", "th", "caption", "blockquote", "section", "article", "aside", "nav", "dl", "details", "figure"]);
const DL_SCOPE = new Set(["dl", "table", "td", "th", "caption", "ul", "ol", "menu", "blockquote"]);
const ROW_SCOPE = new Set(["table", "thead", "tbody", "tfoot"]);
const CELL_SCOPE = new Set(["tr", "table"]);
const SECTION_SCOPE = new Set(["table"]);

const DEFAULT_MAX_DEPTH = 256;

// ------------------------------------------------------------------ the session

interface TagToken {
  end: boolean;
  name: string;
  attrs: [string, string][];
  next: number;
}

export class HtmlSanitizer {
  private readonly stack: string[] = [];
  /** How many of each element are open, so scope checks needn't walk the stack. */
  private readonly open = new Map<string, number>();
  /** Inside an element dropped with its content (not raw text): its name and nesting. */
  private drop: { name: string; depth: number } | null = null;
  /** Inside a raw-text element: the end tag name that closes it. */
  private raw: string | null = null;
  private readonly maxDepth: number;
  private out = "";
  private removals = new Set<string>();

  constructor(private readonly options: SanitizeOptions = {}) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /** True while inside an element being dropped with its content; trusted content between fragments should be skipped too. */
  get dropping(): boolean {
    return this.raw !== null || this.drop !== null;
  }

  /** Sanitize the next fragment. */
  feed(text: string): SanitizeResult {
    this.out = "";
    this.removals = new Set();
    const find = new Finder(text);
    let lower: string | undefined;
    const n = text.length;
    let i = 0;
    // Text waiting to be written runs from textStart; a lone "<" just extends it.
    let textStart = 0;
    const flush = (to: number) => {
      if (to > textStart) this.text(text.slice(textStart, to));
    };
    while (i < n) {
      if (this.raw) {
        lower ??= asciiLower(text);
        const at = this.raw === "plaintext" ? -1 : rawTextEnd(lower, i, this.raw);
        textStart = n; // raw text is dropped
        if (at < 0) break;
        const tag = readTag(text, at);
        this.raw = null;
        if (!tag) {
          this.removed("unfinished tag");
          break;
        }
        this.endTag(tag.name);
        i = textStart = tag.next;
        continue;
      }
      const lt = find.find("<", i);
      if (lt < 0) break;
      i = lt;
      const c1 = text[i + 1];
      // Where a comment-like construct at i ends; -1 when the "<" is plain text.
      let skipTo = -1;
      if (text.startsWith("<!--", i)) {
        skipTo = commentEnd(text, i, find);
      } else if (c1 === "!" || c1 === "?") {
        const gt = find.find(">", i + 2);
        skipTo = gt < 0 ? n : gt + 1;
      } else if (c1 === "/" && !isAsciiAlpha(text.charCodeAt(i + 2))) {
        // "</>" is ignored; "</" followed by anything else but a letter is a bogus comment.
        const gt = text[i + 2] === ">" ? i + 2 : find.find(">", i + 2);
        skipTo = gt < 0 ? n : gt + 1;
      } else if (c1 === "/" || isAsciiAlpha(text.charCodeAt(i + 1))) {
        flush(i);
        const tag = readTag(text, i);
        if (!tag) {
          this.removed("unfinished tag");
          textStart = n;
          break;
        }
        if (tag.end) this.endTag(tag.name);
        else this.startTag(tag.name, tag.attrs);
        i = textStart = tag.next;
        continue;
      }
      if (skipTo < 0) {
        i++;
        continue;
      }
      flush(i);
      i = textStart = skipTo;
    }
    flush(n);
    const removals = [...this.removals];
    return { html: this.out, removed: removals.length > 0, removals };
  }

  /** End tags for every element still open. */
  close(): string {
    let html = "";
    while (this.stack.length) html += `</${this.pop()}>`;
    this.drop = null;
    this.raw = null;
    return html;
  }

  private removed(what: string): void {
    if (this.removals.size < 10) this.removals.add(what);
  }

  private text(raw: string): void {
    if (this.drop || !raw) return;
    this.out += textToHtml(raw);
  }

  private startTag(name: string, attrs: [string, string][]): void {
    if (this.drop) {
      if (name === this.drop.name) this.drop.depth++;
      if (RAW_TEXT.has(name)) this.raw = name;
      return;
    }
    if (RAW_TEXT.has(name)) {
      this.removed(`<${name}> element`);
      this.raw = name;
      return;
    }
    if (DROP_WITH_CONTENT.has(name)) {
      this.removed(`<${name}> element`);
      if (!VOID.has(name)) this.drop = { name, depth: 1 };
      return;
    }
    if (!ALLOWED_TAGS.has(name)) {
      this.removed(`<${name}> tag`);
      return;
    }
    this.autoClose(name);
    if (this.stack.length >= this.maxDepth) {
      this.removed("tags nested too deeply");
      return;
    }
    let html = `<${name}`;
    for (const [attr, value] of attrs) {
      const kept = this.attribute(name, attr, value);
      if (kept !== undefined) html += ` ${attr}="${escapeAttr(kept)}"`;
    }
    this.out += `${html}>`;
    if (!VOID.has(name)) {
      this.stack.push(name);
      this.open.set(name, (this.open.get(name) ?? 0) + 1);
    }
  }

  /** The value to keep for an attribute, or undefined to drop it. */
  private attribute(tag: string, attr: string, value: string): string | undefined {
    if (!GLOBAL_ATTRS.has(attr) && !TAG_ATTRS[tag]?.has(attr)) {
      this.removed(`${attr} attribute`);
      return undefined;
    }
    if (value === "" && attr !== "alt") return undefined;
    if (tag === "a" && attr === "href") {
      const scheme = unsafeScheme(value, LINK_SCHEMES);
      if (scheme !== null) {
        this.removed(`${scheme || "protocol-relative"} URL`);
        return undefined;
      }
    }
    if (tag === "img" && attr === "src") {
      const schemes = this.options.imageSrc ? IMAGE_SCHEMES_RESOLVED : IMAGE_SCHEMES;
      const scheme = unsafeScheme(value, schemes) ?? (isNonImageData(value) ? "data" : null);
      if (scheme !== null) {
        this.removed(`${scheme || "protocol-relative"} URL`);
        return undefined;
      }
      if (this.options.imageSrc) {
        const src = this.options.imageSrc(value);
        if (!src || unsafeScheme(src, IMAGE_SCHEMES_RESOLVED) !== null || isNonImageData(src)) return undefined;
        return src;
      }
    }
    return value;
  }

  private endTag(name: string): void {
    if (this.drop) {
      if (name === this.drop.name && --this.drop.depth === 0) this.drop = null;
      return;
    }
    if (!ALLOWED_TAGS.has(name) || VOID.has(name)) return;
    if (!this.open.get(name)) return; // stray end tag
    this.popTo(this.stack.lastIndexOf(name));
  }

  /** Close elements the new one implicitly ends, the way browsers do (<p> before a block, <li> before <li>...). */
  private autoClose(name: string): void {
    if (CLOSES_P.has(name)) this.closeInScope(["p"], P_SCOPE);
    if (HEADINGS.has(name) && HEADINGS.has(this.stack[this.stack.length - 1] ?? "")) this.popTo(this.stack.length - 1);
    if (name === "li") this.closeInScope(["li"], LIST_SCOPE);
    else if (name === "dt" || name === "dd") this.closeInScope(["dt", "dd"], DL_SCOPE);
    else if (name === "tr") this.closeInScope(["tr"], ROW_SCOPE);
    else if (name === "td" || name === "th") this.closeInScope(["td", "th"], CELL_SCOPE);
    else if (name === "thead" || name === "tbody" || name === "tfoot") this.closeInScope(["thead", "tbody", "tfoot"], SECTION_SCOPE);
  }

  private closeInScope(targets: string[], boundary: ReadonlySet<string>): void {
    if (!targets.some((t) => this.open.get(t))) return;
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const el = this.stack[k]!;
      if (targets.includes(el)) {
        this.popTo(k);
        return;
      }
      if (boundary.has(el)) return;
    }
  }

  private popTo(k: number): void {
    while (this.stack.length > k) this.out += `</${this.pop()}>`;
  }

  private pop(): string {
    const name = this.stack.pop()!;
    this.open.set(name, (this.open.get(name) ?? 1) - 1);
    return name;
  }
}

// ------------------------------------------------------------------ tokenizer pieces

/** indexOf with memory: repeated searches for the same needle never rescan text already known to be free of it. */
class Finder {
  private memo = new Map<string, { from: number; at: number }>();
  constructor(private readonly text: string) {}
  find(needle: string, from: number): number {
    const m = this.memo.get(needle);
    if (m && from >= m.from && (m.at < 0 || from <= m.at)) return m.at;
    const at = this.text.indexOf(needle, from);
    this.memo.set(needle, { from, at });
    return at;
  }
}

const isAsciiAlpha = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isTagSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/** Where a comment starting at `i` ("<!--") ends: after "-->", "--!>", or the abrupt "<!-->" / "<!--->". */
function commentEnd(text: string, i: number, find: Finder): number {
  if (text.startsWith("<!-->", i)) return i + 5;
  if (text.startsWith("<!--->", i)) return i + 6;
  const a = find.find("-->", i + 4);
  const b = find.find("--!>", i + 4);
  if (a < 0 && b < 0) return text.length;
  if (b < 0 || (a >= 0 && a < b)) return a + 3;
  return b + 4;
}

/** In lowercased text, the start of the first `</name` followed by whitespace, `/` or `>` (or the end), or -1. */
function rawTextEnd(lower: string, from: number, name: string): number {
  const needle = `</${name}`;
  let at = lower.indexOf(needle, from);
  while (at >= 0) {
    const after = lower[at + needle.length];
    if (after === undefined || after === ">" || after === "/" || isTagSpace(after)) return at;
    at = lower.indexOf(needle, at + 1);
  }
  return -1;
}

/**
 * Read a start or end tag at `i` (text[i] is "<"), following the WHATWG
 * tokenizer states. Returns null when the input ends inside the tag.
 * Attribute names are lowercased and values decoded; duplicates keep the first.
 */
function readTag(text: string, i: number): TagToken | null {
  const n = text.length;
  let p = i + 1;
  const end = text[p] === "/";
  if (end) p++;
  const nameStart = p;
  while (p < n && !isTagSpace(text[p]) && text[p] !== "/" && text[p] !== ">") p++;
  if (p >= n) return null;
  const name = asciiLower(text.slice(nameStart, p)).replace(/\0/g, "�");
  const attrs: [string, string][] = [];
  const seen = new Set<string>();
  const add = (attrName: string, value: string) => {
    if (seen.has(attrName)) return;
    seen.add(attrName);
    attrs.push([attrName, value]);
  };
  for (;;) {
    // Before attribute name.
    while (p < n && isTagSpace(text[p])) p++;
    if (p >= n) return null;
    let c = text[p];
    if (c === ">") return { end, name, attrs, next: p + 1 };
    if (c === "/") {
      // Self-closing flag (ignored: HTML ignores it on non-void elements) or a stray slash.
      p++;
      continue;
    }
    // Attribute name: the first character may be "=".
    const attrStart = p;
    p++;
    while (p < n && !isTagSpace(text[p]) && text[p] !== "/" && text[p] !== ">" && text[p] !== "=") p++;
    if (p >= n) return null;
    const attrName = asciiLower(text.slice(attrStart, p)).replace(/\0/g, "�");
    // After attribute name.
    while (p < n && isTagSpace(text[p])) p++;
    if (p >= n) return null;
    c = text[p];
    if (c !== "=") {
      add(attrName, "");
      continue;
    }
    p++;
    // Before attribute value.
    while (p < n && isTagSpace(text[p])) p++;
    if (p >= n) return null;
    c = text[p];
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, p + 1);
      if (close < 0) return null;
      add(attrName, decodeAttribute(text.slice(p + 1, close)));
      p = close + 1;
      // After a quoted value anything but space, "/" or ">" starts the next attribute directly.
      continue;
    }
    if (c === ">") {
      add(attrName, "");
      return { end, name, attrs, next: p + 1 };
    }
    const valueStart = p;
    while (p < n && !isTagSpace(text[p]) && text[p] !== ">") p++;
    if (p >= n) return null;
    add(attrName, decodeAttribute(text.slice(valueStart, p)));
  }
}

// ------------------------------------------------------------------ URLs

/**
 * The scheme that makes `url` unsafe ("" for a protocol-relative URL), or
 * null when it is allowed. Control characters and whitespace are removed
 * first, as URL parsers do (and more), so "jav&#x09;ascript:" is caught.
 */
function unsafeScheme(url: string, allowed: ReadonlySet<string>): string | null {
  const v = url.replace(/[\u0000- \u007f-\u009f]+/g, "");
  if (/^[\\/]{2}/.test(v)) return "";
  const colon = v.indexOf(":");
  if (colon < 0) return null;
  const delim = v.search(/[/?#\\]/);
  if (delim >= 0 && delim < colon) return null; // a relative path with a colon further on
  const scheme = v.slice(0, colon).toLowerCase();
  return allowed.has(scheme) ? null : `${scheme.slice(0, 20)}:`;
}

function isNonImageData(url: string): boolean {
  const v = url.replace(/[\u0000- \u007f-\u009f]+/g, "").toLowerCase();
  return v.startsWith("data:") && !v.startsWith("data:image/");
}

// ------------------------------------------------------------------ escaping and character references

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

function escapeChar(c: string): string {
  return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c;
}

function escapeText(s: string): string {
  return s.replace(/[&<>]/g, escapeChar);
}

/**
 * Text content to HTML: character references are decoded and re-escaped;
 * a well-formed named reference this table doesn't know (`&NotSubset;`)
 * is passed through for the browser to decode, which is safe in text.
 */
function textToHtml(raw: string): string {
  const s = raw.replace(/\0/g, "�").replace(/\r\n?/g, "\n");
  let out = "";
  let chunk = 0;
  for (let i = s.indexOf("&"); i >= 0 && i < s.length; i = s.indexOf("&", i)) {
    out += escapeText(s.slice(chunk, i));
    const ref = readReference(s, i, false);
    if (ref) {
      out += escapeText(ref.text);
      i = chunk = ref.next;
      continue;
    }
    const m = /^&[A-Za-z][A-Za-z0-9]{0,31};/.exec(s.slice(i, i + 34));
    if (m) {
      out += m[0];
      i = chunk = i + m[0].length;
      continue;
    }
    out += "&amp;";
    i = chunk = i + 1;
  }
  return out + escapeText(s.slice(chunk));
}

/** Decode the character references in an attribute value. */
export function decodeAttribute(raw: string): string {
  const s = raw.replace(/\0/g, "�");
  if (!s.includes("&")) return s;
  let out = "";
  let chunk = 0;
  for (let i = s.indexOf("&"); i >= 0 && i < s.length; i = s.indexOf("&", i)) {
    out += s.slice(chunk, i);
    const ref = readReference(s, i, true);
    if (ref) {
      out += ref.text;
      i = chunk = ref.next;
    } else {
      out += "&";
      i = chunk = i + 1;
    }
  }
  return out + s.slice(chunk);
}

/** The character reference at `i` (s[i] is "&"): its text and where it ends, or null. */
function readReference(s: string, i: number, inAttribute: boolean): { text: string; next: number } | null {
  if (s[i + 1] === "#") {
    let p = i + 2;
    const hex = s[p] === "x" || s[p] === "X";
    if (hex) p++;
    const digitsStart = p;
    let code = 0;
    while (p < s.length) {
      const c = s.charCodeAt(p);
      const d = c >= 48 && c <= 57 ? c - 48 : hex && c >= 97 && c <= 102 ? c - 87 : hex && c >= 65 && c <= 70 ? c - 55 : -1;
      if (d < 0) break;
      code = Math.min(code * (hex ? 16 : 10) + d, 0x110000);
      p++;
    }
    if (p === digitsStart) return null;
    if (s[p] === ";") p++;
    return { text: numericReference(code), next: p };
  }
  let p = i + 1;
  while (p < s.length && p - i <= 32 && /[A-Za-z0-9]/.test(s[p]!)) p++;
  const name = s.slice(i + 1, p);
  if (!name) return null;
  if (s[p] === ";") {
    const text = NAMED.get(name);
    if (text !== undefined) return { text, next: p + 1 };
  }
  // Legacy references work without the semicolon: the longest one that prefixes the name.
  for (let len = Math.min(name.length, 6); len >= 2; len--) {
    const prefix = name.slice(0, len);
    if (!LEGACY.has(prefix)) continue;
    const after = s[i + 1 + len];
    // In attributes, "&copy=x" and "&notit" stay as written (WHATWG rule, for URLs with query strings).
    if (inAttribute && after !== ";" && after !== undefined && /[A-Za-z0-9=]/.test(after)) return null;
    return { text: NAMED.get(prefix)!, next: i + 1 + len };
  }
  return null;
}

const WINDOWS_1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030,
  0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022,
  0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

/** A numeric character reference's text, with the WHATWG replacements. */
function numericReference(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(WINDOWS_1252[code] ?? code);
}

// Named references: the HTML 4 set (all of which HTML 5 keeps) plus common HTML 5 punctuation names.
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const NAMED_LIST =
  "quot:34 amp:38 lt:60 gt:62 QUOT:34 AMP:38 LT:60 GT:62 COPY:169 REG:174 apos:39 " +
  "OElig:338 oelig:339 Scaron:352 scaron:353 Yuml:376 fnof:402 circ:710 tilde:732 " +
  "Alpha:913 Beta:914 Gamma:915 Delta:916 Epsilon:917 Zeta:918 Eta:919 Theta:920 Iota:921 Kappa:922 Lambda:923 Mu:924 Nu:925 Xi:926 Omicron:927 Pi:928 Rho:929 Sigma:931 Tau:932 Upsilon:933 Phi:934 Chi:935 Psi:936 Omega:937 " +
  "alpha:945 beta:946 gamma:947 delta:948 epsilon:949 zeta:950 eta:951 theta:952 iota:953 kappa:954 lambda:955 mu:956 nu:957 xi:958 omicron:959 pi:960 rho:961 sigmaf:962 sigma:963 tau:964 upsilon:965 phi:966 chi:967 psi:968 omega:969 thetasym:977 upsih:978 piv:982 " +
  "ensp:8194 emsp:8195 thinsp:8201 zwnj:8204 zwj:8205 lrm:8206 rlm:8207 ndash:8211 mdash:8212 lsquo:8216 rsquo:8217 sbquo:8218 ldquo:8220 rdquo:8221 bdquo:8222 dagger:8224 Dagger:8225 bull:8226 hellip:8230 permil:8240 prime:8242 Prime:8243 lsaquo:8249 rsaquo:8250 oline:8254 frasl:8260 euro:8364 " +
  "image:8465 weierp:8472 real:8476 trade:8482 alefsym:8501 larr:8592 uarr:8593 rarr:8594 darr:8595 harr:8596 crarr:8629 lArr:8656 uArr:8657 rArr:8658 dArr:8659 hArr:8660 " +
  "forall:8704 part:8706 exist:8707 empty:8709 nabla:8711 isin:8712 notin:8713 ni:8715 prod:8719 sum:8721 minus:8722 lowast:8727 radic:8730 prop:8733 infin:8734 ang:8736 and:8743 or:8744 cap:8745 cup:8746 int:8747 there4:8756 sim:8764 cong:8773 asymp:8776 ne:8800 equiv:8801 le:8804 ge:8805 sub:8834 sup:8835 nsub:8836 sube:8838 supe:8839 oplus:8853 otimes:8855 perp:8869 sdot:8901 " +
  "lceil:8968 rceil:8969 lfloor:8970 rfloor:8971 lang:10216 rang:10217 loz:9674 spades:9824 clubs:9827 hearts:9829 diams:9830 " +
  "Tab:9 NewLine:10 excl:33 num:35 dollar:36 percnt:37 lpar:40 rpar:41 ast:42 midast:42 plus:43 comma:44 period:46 sol:47 colon:58 semi:59 equals:61 quest:63 commat:64 " +
  "lsqb:91 lbrack:91 bsol:92 rsqb:93 rbrack:93 Hat:94 lowbar:95 UnderBar:95 grave:96 DiacriticalGrave:96 lcub:123 lbrace:123 verbar:124 vert:124 VerticalLine:124 rcub:125 rbrace:125 " +
  "NonBreakingSpace:160 hyphen:8208 dash:8208 hairsp:8202 ZeroWidthSpace:8203 NoBreak:8288 horbar:8213 Vert:8214 nldr:8229 mldr:8230 " +
  "check:10003 checkmark:10003 cross:10007 star:9734 starf:9733 bigstar:9733 phone:9742 female:9792 male:9794 sung:9834 flat:9837 natural:9838 sharp:9839 " +
  "deg:176 half:189 frac13:8531 frac23:8532 frac15:8533 frac18:8539 leq:8804 geq:8805 approx:8776 pm:177 div:247 setminus:8726 compfn:8728 " +
  "larrhk:8617 rarrhk:8618 map:8614 mapsto:8614 LeftArrow:8592 RightArrow:8594 UpArrow:8593 DownArrow:8595 LeftRightArrow:8596 Rightarrow:8658 Leftarrow:8656 Leftrightarrow:8660 iff:8660 " +
  "ell:8467 hbar:8463 planck:8463 aleph:8501 beth:8502 Re:8476 Im:8465 naturals:8469 integers:8484 rationals:8474 reals:8477 complexes:8450 primes:8473 " +
  "emptyset:8709 varnothing:8709 in:8712 isinv:8712 notinva:8713 subset:8834 supset:8835 subseteq:8838 supseteq:8839 Union:8899 Intersection:8898 wedge:8743 vee:8744 " +
  "times:215 cdot:267 centerdot:183 middot:183 lowast:8727 star:9734 compfn:8728 nabla:8711 Del:8711 PartialD:8706 Sum:8721 Product:8719 Integral:8747 oint:8750 conint:8750 " +
  "langle:10216 rangle:10217 LeftAngleBracket:10216 RightAngleBracket:10217 lfloor:8970 rfloor:8971 lceil:8968 rceil:8969 boxh:9472 boxv:9474 block:9608 squ:9633 square:9633 FilledSmallSquare:9724 " +
  "laquo:171 raquo:187 lsaquo:8249 rsaquo:8250 OpenCurlyQuote:8216 CloseCurlyQuote:8217 OpenCurlyDoubleQuote:8220 CloseCurlyDoubleQuote:8221 bullet:8226 dagger:8224 ddagger:8225 Dagger:8225 trade:8482 TRADE:8482 copysr:8471 numero:8470 ohm:937 angst:197 mho:8487";

const NAMED: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  LATIN1.split(" ").forEach((name, k) => map.set(name, String.fromCharCode(160 + k)));
  for (const pair of NAMED_LIST.split(/\s+/)) {
    const [name, code] = pair.split(":");
    if (name && code && !map.has(name)) map.set(name, String.fromCodePoint(Number(code)));
  }
  return map;
})();

/** References browsers decode even without a semicolon (the WHATWG legacy list). */
const LEGACY: ReadonlySet<string> = new Set([...LATIN1.split(" "), "amp", "lt", "gt", "quot", "AMP", "LT", "GT", "QUOT", "COPY", "REG"]);

/** For tests: the named references this module decodes. */
export function namedReferences(): ReadonlyMap<string, string> {
  return NAMED;
}
