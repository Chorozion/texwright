/**
 * A safe YAML 1.2 subset, enough for front matter and `-M key=value` values.
 *
 * Supported: block mappings and sequences nested by indentation (including
 * compact `- key: value` entries and sequences at their key's indentation),
 * flow sequences and mappings (`[a, b]`, `{a: 1}`, single pairs `[a: 1]`),
 * plain, single-quoted and double-quoted scalars (all YAML escapes, line
 * folding), literal `|` and folded `>` block scalars with chomping (`-`, `+`)
 * and explicit indentation indicators, comments (`#` at a line start or after
 * whitespace, exactly as YAML has it), an optional leading `---` and a
 * trailing `...`. Plain scalars resolve with the YAML 1.2 core schema: null
 * and `~`, true/false, decimal, `0o` octal and `0x` hex integers, floats with
 * `.inf` and `.nan`; everything else stays a string (so `2026-10-06` is text,
 * not a date). Mapping keys are always strings: the key's text as written.
 *
 * Rejected with an error: anchors (`&a`), aliases (`*a`), tags (`!x`), merge
 * keys (`<<`), explicit keys (`? k`), complex (collection) keys, directives,
 * more than one document, tabs used for indentation, and duplicate keys.
 * Without aliases a value can never be bigger than the text spelling it out,
 * so there are no alias bombs by construction; nesting depth and input length
 * are capped as well.
 *
 * The parser never throws: problems come back as `error` with the 1-based
 * line and column where they were found. It runs in time linear in the input.
 */

export interface YamlError {
  message: string;
  /** 1-based line within the YAML text. */
  line: number;
  /** 1-based column. */
  col: number;
}

export interface YamlResult {
  /** The parsed value; `undefined` when there is an error. Empty input is `null`. */
  value: unknown;
  error?: YamlError;
}

export interface YamlOptions {
  /** Deepest nesting of mappings and sequences. Default 100. */
  maxDepth?: number;
  /** Longest accepted input in characters. Default 2,000,000. */
  maxLength?: number;
}

export const YAML_DEFAULT_MAX_DEPTH = 100;
export const YAML_DEFAULT_MAX_LENGTH = 2_000_000;

export function parseYaml(text: string, options: YamlOptions = {}): YamlResult {
  const maxLength = options.maxLength ?? YAML_DEFAULT_MAX_LENGTH;
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (src.length > maxLength) {
    return { value: undefined, error: { message: `YAML text is longer than ${maxLength} characters`, line: 1, col: 1 } };
  }
  src = src.replace(/\r\n?/g, "\n");
  const parser = new YamlParser(src, options.maxDepth ?? YAML_DEFAULT_MAX_DEPTH);
  try {
    return { value: parser.document() };
  } catch (e) {
    if (e instanceof YamlFailure) return { value: undefined, error: { message: e.message, ...lineCol(src, e.offset) } };
    if (e instanceof RangeError) return { value: undefined, error: { message: "YAML nests too deeply", line: 1, col: 1 } };
    throw e;
  }
}

/** Resolve a plain (unquoted) scalar with the YAML 1.2 core schema. */
export function resolvePlainScalar(text: string): unknown {
  switch (text) {
    case "":
    case "~":
    case "null":
    case "Null":
    case "NULL":
      return null;
    case "true":
    case "True":
    case "TRUE":
      return true;
    case "false":
    case "False":
    case "FALSE":
      return false;
    case ".inf":
    case ".Inf":
    case ".INF":
    case "+.inf":
    case "+.Inf":
    case "+.INF":
      return Number.POSITIVE_INFINITY;
    case "-.inf":
    case "-.Inf":
    case "-.INF":
      return Number.NEGATIVE_INFINITY;
    case ".nan":
    case ".NaN":
    case ".NAN":
      return Number.NaN;
    default:
      break;
  }
  const c = text.charCodeAt(0);
  // Only text that starts like a number can be one; this keeps the regexes off ordinary strings.
  if (!((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return text;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  if (/^0o[0-7]+$/.test(text)) return Number.parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  return text;
}

class YamlFailure extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

function lineCol(src: string, offset: number): { line: number; col: number } {
  const at = Math.max(0, Math.min(offset, src.length));
  let line = 1;
  let lineStart = 0;
  for (let i = src.indexOf("\n"); i >= 0 && i < at; i = src.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, col: at - lineStart + 1 };
}

/** Assign without ever touching the prototype, so a "__proto__" key stays data. */
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isFlowIndicator(c: string | undefined): boolean {
  return c === "," || c === "[" || c === "]" || c === "{" || c === "}";
}

type FlowNode = { value: unknown; kind: "plain" | "quoted" | "collection"; text: string };

class YamlParser {
  private pos = 0;
  /**
   * Column of the content the parser stands on after skipToContent(), or -1
   * at the end of the input (or at a document marker).
   */
  private indent = -1;
  private depth = 0;

  constructor(
    private readonly s: string,
    private readonly maxDepth: number,
  ) {}

  private fail(message: string, at: number = this.pos): never {
    throw new YamlFailure(message, at);
  }

  // ------------------------------------------------------------ document

  document(): unknown {
    const s = this.s;
    this.skipToContent();
    if (this.indent === 0 && s[this.pos] === "%") this.fail("YAML directives (%YAML, %TAG) are not supported");
    let value: unknown = null;
    let parsed = false;
    if (this.pos < s.length && this.indent < 0 && s.startsWith("---", this.pos)) {
      // Document start marker; the root may start on the same line ("--- |").
      this.pos += 3;
      this.skipInlineSpace();
      const c = s[this.pos];
      if (c === undefined || c === "\n" || c === "#") {
        this.finishLine();
        this.skipToContent();
      } else {
        value = this.inlineValue(-1);
        parsed = true;
      }
    }
    if (!parsed && this.indent >= 0) value = this.blockNode(-1, this.indent);
    if (this.pos < s.length) {
      if (this.indent < 0 && s.startsWith("...", this.pos)) {
        this.pos += 3;
        this.finishLine();
        this.skipToContent();
        if (this.pos >= s.length) return value;
        this.fail("Only one YAML document is supported");
      }
      if (this.indent < 0) this.fail("Only one YAML document is supported");
      this.fail("Unexpected content here; check the indentation");
    }
    return value;
  }

  // ------------------------------------------------------------ lines and space

  private wsOrEnd(i: number): boolean {
    const c = this.s[i];
    return c === undefined || c === " " || c === "\t" || c === "\n";
  }

  private lineEnd(p: number): number {
    const i = this.s.indexOf("\n", p);
    return i < 0 ? this.s.length : i;
  }

  private column(p: number): number {
    return p - (this.s.lastIndexOf("\n", p - 1) + 1);
  }

  /** A `---` or `...` document marker at the start of a line. */
  private isMarkerAt(p: number): boolean {
    const s = this.s;
    return (p === 0 || s[p - 1] === "\n") && (s.startsWith("---", p) || s.startsWith("...", p)) && this.wsOrEnd(p + 3);
  }

  private skipInlineSpace(): void {
    const s = this.s;
    while (s[this.pos] === " " || s[this.pos] === "\t") this.pos++;
  }

  /**
   * From the start of a line, skip blank lines and comment lines and stop on
   * the first content character; sets `indent` to its column (-1 at the end
   * or at a document marker).
   */
  private skipToContent(): void {
    const s = this.s;
    const n = s.length;
    let p = this.pos;
    while (p < n) {
      const lineStart = p;
      while (s[p] === " ") p++;
      if (p >= n) break;
      const c = s[p];
      if (c === "\n") {
        p++;
        continue;
      }
      if (c === "#") {
        p = this.lineEnd(p);
        continue;
      }
      if (c === "\t") {
        let q = p;
        while (s[q] === " " || s[q] === "\t") q++;
        if (q >= n || s[q] === "\n") {
          p = q;
          continue;
        }
        if (s[q] === "#") {
          p = this.lineEnd(q);
          continue;
        }
        this.fail("Tabs can't be used for indentation in YAML; use spaces", p);
      }
      this.pos = p;
      this.indent = p === lineStart && this.isMarkerAt(p) ? -1 : p - lineStart;
      return;
    }
    this.pos = n;
    this.indent = -1;
  }

  /** After a value: allow trailing space and a comment, then consume the line break. */
  private finishLine(): void {
    const s = this.s;
    const start = this.pos;
    this.skipInlineSpace();
    if (s[this.pos] === "#") {
      const prev = s[this.pos - 1];
      if (this.pos === start && this.pos > 0 && prev !== "\n" && prev !== " " && prev !== "\t") this.fail("Put a space before '#' to start a comment");
      this.pos = this.lineEnd(this.pos);
    }
    if (this.pos >= s.length) return;
    if (s[this.pos] === "\n") {
      this.pos++;
      return;
    }
    if (s[this.pos] === ":") {
      this.fail("Unexpected ':'; a nested mapping must start on its own line. Quote the value if the colon is part of it");
    }
    this.fail("Unexpected text after the value");
  }

  private enter(at: number): void {
    if (++this.depth > this.maxDepth) this.fail(`YAML nests deeper than ${this.maxDepth} levels`, at);
  }

  /** Characters that start a node we refuse, with the reason. */
  private rejectUnsupported(): void {
    const s = this.s;
    const c = s[this.pos];
    if (c === "&") this.fail("YAML anchors (&name) are not supported; write the value out");
    if (c === "*") this.fail("YAML aliases (*name) are not supported; write the value out");
    if (c === "!") this.fail("YAML tags (!tag) are not supported");
    if (c === "@" || c === "`") this.fail(`'${c}' is reserved in YAML and can't start a plain value; quote the value`);
    if (c === "?" && this.wsOrEnd(this.pos + 1)) this.fail("Explicit mapping keys ('? key') are not supported");
  }

  /** Can a plain scalar start at `p`? */
  private startsPlain(p: number, flow: boolean): boolean {
    const s = this.s;
    const c = s[p];
    if (c === undefined || c === " " || c === "\t" || c === "\n") return false;
    if (c === "-" || c === "?" || c === ":") {
      const d = s[p + 1];
      return !(d === undefined || d === " " || d === "\t" || d === "\n" || (flow && isFlowIndicator(d)));
    }
    return !",[]{}#&*!|>'\"%@`".includes(c);
  }

  // ------------------------------------------------------------ block nodes

  /** A node at the start of its content (`col` is its column); `parentIndent` bounds plain continuation lines and block scalars. */
  private blockNode(parentIndent: number, col: number): unknown {
    const s = this.s;
    this.rejectUnsupported();
    const c = s[this.pos];
    if (c === "-" && this.wsOrEnd(this.pos + 1)) return this.blockSequence(col);
    if (c === "|" || c === ">") return this.blockScalar(parentIndent);
    if (this.isKeyAhead()) return this.blockMapping(col);
    return this.scalarOrFlow(parentIndent);
  }

  /** A value on the same line as its key. */
  private inlineValue(ownerIndent: number): unknown {
    const s = this.s;
    this.rejectUnsupported();
    const c = s[this.pos];
    if (c === "-" && this.wsOrEnd(this.pos + 1)) this.fail("A block sequence can't start on the same line as its key; start it on the next line");
    if (c === "|" || c === ">") return this.blockScalar(ownerIndent);
    return this.scalarOrFlow(ownerIndent);
  }

  private scalarOrFlow(parentIndent: number): unknown {
    const s = this.s;
    const start = this.pos;
    const c = s[start];
    let value: unknown;
    if (c === "[" || c === "{") value = this.flowCollection();
    else if (c === '"') value = this.doubleQuoted();
    else if (c === "'") value = this.singleQuoted();
    else if (this.startsPlain(start, false)) return this.plainBlock(parentIndent);
    else this.fail(`Unexpected '${c}'; quote the value if it is text`);
    this.skipInlineSpace();
    if (s[this.pos] === ":" && this.wsOrEnd(this.pos + 1)) {
      if (c === "[" || c === "{") this.fail("Collections can't be used as mapping keys", start);
      this.fail("A mapping key must be on one line, and a nested mapping must start on its own line");
    }
    this.finishLine();
    this.skipToContent();
    return value;
  }

  /** Whether the current line holds `key:` (followed by space or the line end) at the current position. */
  private isKeyAhead(): boolean {
    const s = this.s;
    const n = s.length;
    let p = this.pos;
    const c = s[p];
    if (c === '"' || c === "'") {
      p = this.quotedEndOnLine(p);
      if (p < 0) return false;
      while (s[p] === " " || s[p] === "\t") p++;
      return s[p] === ":" && this.wsOrEnd(p + 1);
    }
    if (!this.startsPlain(p, false)) return false;
    for (; p < n; p++) {
      const ch = s[p];
      if (ch === "\n") return false;
      if ((ch === " " || ch === "\t") && s[p + 1] === "#") return false;
      if (ch === ":" && this.wsOrEnd(p + 1)) return true;
    }
    return false;
  }

  /** Index just after the quoted scalar starting at `p`, or -1 when it doesn't close on this line. */
  private quotedEndOnLine(p: number): number {
    const s = this.s;
    const n = s.length;
    const q = s[p];
    for (let i = p + 1; i < n; i++) {
      const c = s[i];
      if (c === "\n") return -1;
      if (q === "'" && c === "'") {
        if (s[i + 1] === "'") {
          i++;
          continue;
        }
        return i + 1;
      }
      if (q === '"') {
        if (c === "\\") {
          if (s[i + 1] === "\n") return -1;
          i++;
          continue;
        }
        if (c === '"') return i + 1;
      }
    }
    return -1;
  }

  private blockMapping(indent: number): Record<string, unknown> {
    const s = this.s;
    this.enter(this.pos);
    const map: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (;;) {
      const keyAt = this.pos;
      const key = this.mappingKey();
      if (seen.has(key)) this.fail(`Duplicate key "${key}"`, keyAt);
      seen.add(key);
      define(map, key, this.valueAfterIndicator(indent, true));
      if (this.indent < indent) break;
      if (this.indent > indent) this.fail("Bad indentation: this line is indented more than the keys above it");
      if (s[this.pos] === "-" && this.wsOrEnd(this.pos + 1)) this.fail("Expected a key (key: value) here, not a sequence entry");
      this.rejectUnsupported();
      if (!this.isKeyAhead()) this.fail("Expected a key (key: value) at this indentation");
    }
    this.depth--;
    return map;
  }

  /** Read a key and its ':' indicator. */
  private mappingKey(): string {
    const s = this.s;
    const start = this.pos;
    let key: string;
    if (s[start] === '"') key = this.doubleQuoted();
    else if (s[start] === "'") key = this.singleQuoted();
    else {
      key = this.plainLine(false);
      if (key === "<<") this.fail("Merge keys (<<) are not supported; write the keys out", start);
    }
    this.skipInlineSpace();
    if (s[this.pos] !== ":") this.fail("Expected ':' after the key");
    this.pos++;
    return key;
  }

  /** The value after `key:` or `- `: on the same line, or on the following lines. */
  private valueAfterIndicator(ownerIndent: number, mappingValue: boolean): unknown {
    const s = this.s;
    this.skipInlineSpace();
    const c = s[this.pos];
    if (c === undefined || c === "\n" || c === "#") {
      this.finishLine();
      this.skipToContent();
      if (this.indent > ownerIndent) return this.blockNode(ownerIndent, this.indent);
      // A sequence may sit at its key's own indentation.
      if (mappingValue && this.indent === ownerIndent && s[this.pos] === "-" && this.wsOrEnd(this.pos + 1)) return this.blockSequence(ownerIndent);
      return null;
    }
    if (mappingValue) return this.inlineValue(ownerIndent);
    return this.blockNode(ownerIndent, this.column(this.pos));
  }

  private blockSequence(indent: number): unknown[] {
    const s = this.s;
    this.enter(this.pos);
    const list: unknown[] = [];
    for (;;) {
      this.pos++; // the '-'
      list.push(this.valueAfterIndicator(indent, false));
      if (this.indent === indent && s[this.pos] === "-" && this.wsOrEnd(this.pos + 1)) continue;
      if (this.indent > indent) this.fail("Bad indentation: this line is indented more than the '- ' entries above it");
      break;
    }
    this.depth--;
    return list;
  }

  // ------------------------------------------------------------ scalars

  /**
   * One line of a plain scalar: stops at the line end, at ': ' (or ':' before a
   * flow indicator in flow context), at ' #', and in flow context at , [ ] { }.
   * Leaves `pos` just after the last non-space character taken.
   */
  private plainLine(flow: boolean): string {
    const s = this.s;
    const n = s.length;
    const start = this.pos;
    let p = start;
    let end = start;
    while (p < n) {
      const c = s[p];
      if (c === "\n") break;
      if (c === " " || c === "\t") {
        if (s[p + 1] === "#") break;
        p++;
        continue;
      }
      if (c === ":") {
        const d = s[p + 1];
        if (d === undefined || d === " " || d === "\t" || d === "\n" || (flow && isFlowIndicator(d))) break;
      } else if (flow && isFlowIndicator(c)) {
        break;
      }
      p++;
      end = p;
    }
    this.pos = end;
    return s.slice(start, end);
  }

  /** A plain scalar in block context, possibly continued on lines indented more than `parentIndent`. */
  private plainBlock(parentIndent: number): unknown {
    const s = this.s;
    const n = s.length;
    let text = this.plainLine(false);
    let multiline = false;
    for (;;) {
      let p = this.pos;
      while (s[p] === " " || s[p] === "\t") p++;
      if (s[p] !== "\n") break;
      let breaks = 0;
      let next = -1;
      while (p < n) {
        p++; // past "\n"
        const lineStart = p;
        while (s[p] === " ") p++;
        const indent = p - lineStart;
        while (s[p] === " " || s[p] === "\t") p++;
        if (p >= n) break;
        if (s[p] === "\n") {
          breaks++;
          continue;
        }
        if (s[p] === "#") break;
        if (indent === 0 && this.isMarkerAt(lineStart)) break;
        if (indent <= parentIndent) break;
        next = p;
        break;
      }
      if (next < 0) break;
      text += breaks ? "\n".repeat(breaks) : " ";
      this.pos = next;
      text += this.plainLine(false);
      multiline = true;
    }
    this.finishLine();
    this.skipToContent();
    return multiline ? text : resolvePlainScalar(text);
  }

  /** Skip a line break inside a quoted scalar plus blank lines and the next line's leading space. */
  private quotedBreak(p: number, open: number): { breaks: number; next: number } {
    const s = this.s;
    const n = s.length;
    let breaks = 0;
    for (;;) {
      p++; // past "\n"
      const lineStart = p;
      if (this.isMarkerAt(lineStart)) this.fail("A document marker can't appear inside a quoted string", lineStart);
      while (s[p] === " " || s[p] === "\t") p++;
      if (p >= n) this.fail("Unclosed quoted string", open);
      if (s[p] === "\n") {
        breaks++;
        continue;
      }
      return { breaks, next: p };
    }
  }

  private singleQuoted(): string {
    const s = this.s;
    const n = s.length;
    const open = this.pos;
    let p = open + 1;
    let out = "";
    let chunk = p;
    for (;;) {
      if (p >= n) this.fail("Unclosed single-quoted string", open);
      const c = s[p];
      if (c === "'") {
        if (s[p + 1] === "'") {
          out += s.slice(chunk, p + 1);
          p += 2;
          chunk = p;
          continue;
        }
        out += s.slice(chunk, p);
        this.pos = p + 1;
        return out;
      }
      if (c === "\n") {
        out += trimEndSpace(s.slice(chunk, p));
        const f = this.quotedBreak(p, open);
        out += f.breaks ? "\n".repeat(f.breaks) : " ";
        p = chunk = f.next;
        continue;
      }
      p++;
    }
  }

  private doubleQuoted(): string {
    const s = this.s;
    const n = s.length;
    const open = this.pos;
    let p = open + 1;
    let out = "";
    let chunk = p;
    for (;;) {
      if (p >= n) this.fail("Unclosed double-quoted string", open);
      const c = s[p];
      if (c === '"') {
        out += s.slice(chunk, p);
        this.pos = p + 1;
        return out;
      }
      if (c === "\\") {
        out += s.slice(chunk, p);
        if (s[p + 1] === "\n") {
          // Escaped line break: the lines join without a space.
          const f = this.quotedBreak(p + 1, open);
          out += "\n".repeat(f.breaks);
          p = chunk = f.next;
          continue;
        }
        const [text, length] = this.escape(p);
        out += text;
        p = chunk = p + length;
        continue;
      }
      if (c === "\n") {
        out += trimEndSpace(s.slice(chunk, p));
        const f = this.quotedBreak(p, open);
        out += f.breaks ? "\n".repeat(f.breaks) : " ";
        p = chunk = f.next;
        continue;
      }
      p++;
    }
  }

  /** The escape sequence at `p` (a backslash): its text and length. */
  private escape(p: number): [string, number] {
    const s = this.s;
    const e = s[p + 1];
    switch (e) {
      case "0":
        return ["\0", 2];
      case "a":
        return ["\x07", 2];
      case "b":
        return ["\b", 2];
      case "t":
      case "\t":
        return ["\t", 2];
      case "n":
        return ["\n", 2];
      case "v":
        return ["\v", 2];
      case "f":
        return ["\f", 2];
      case "r":
        return ["\r", 2];
      case "e":
        return ["\x1b", 2];
      case " ":
        return [" ", 2];
      case '"':
        return ['"', 2];
      case "/":
        return ["/", 2];
      case "\\":
        return ["\\", 2];
      case "N":
        return ["\x85", 2];
      case "_":
        return ["\xa0", 2];
      case "L":
        return [" ", 2];
      case "P":
        return [" ", 2];
      case "x":
      case "u":
      case "U": {
        const digits = e === "x" ? 2 : e === "u" ? 4 : 8;
        const hex = s.slice(p + 2, p + 2 + digits);
        if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) this.fail(`"\\${e}" needs ${digits} hexadecimal digits`, p);
        const code = Number.parseInt(hex, 16);
        if (code > 0x10ffff) this.fail(`"\\${e}${hex}" is not a Unicode character`, p);
        return [code >= 0xd800 && code <= 0xdfff ? String.fromCharCode(code) : String.fromCodePoint(code), 2 + digits];
      }
      default:
        if (e === undefined) this.fail("Unclosed double-quoted string", p);
        return this.fail(`Unknown escape sequence "\\${e}"`, p);
    }
  }

  /** `|` or `>` block scalar; content must be indented more than `parentIndent`. */
  private blockScalar(parentIndent: number): string {
    const s = this.s;
    const n = s.length;
    const literal = s[this.pos] === "|";
    this.pos++;
    let chomp = 0; // -1 strip, 0 clip, 1 keep
    let explicit = 0;
    for (let k = 0; k < 2; k++) {
      const c = s[this.pos];
      if ((c === "-" || c === "+") && chomp === 0) {
        chomp = c === "-" ? -1 : 1;
        this.pos++;
      } else if (c !== undefined && c >= "1" && c <= "9" && explicit === 0) {
        explicit = c.charCodeAt(0) - 48;
        this.pos++;
      } else if (c === "0") {
        this.fail("A block scalar's indentation indicator must be 1 to 9");
      }
    }
    const afterHeader = this.pos;
    this.skipInlineSpace();
    if (s[this.pos] === "#") {
      if (this.pos === afterHeader) this.fail("Put a space before '#' to start a comment");
      this.pos = this.lineEnd(this.pos);
    }
    if (this.pos < n && s[this.pos] !== "\n") this.fail(`Unexpected text after the block scalar indicator '${literal ? "|" : ">"}'`);
    if (this.pos < n) this.pos++;

    let contentIndent = explicit ? parentIndent + explicit : -1;
    let out = "";
    let pending = 0; // blank lines since the last content line (or the header)
    let sawContent = false;
    let lastMoreIndented = false;
    let lastHadBreak = false;
    let leadingMax = 0;
    let p = this.pos;
    while (p < n) {
      const lineStart = p;
      while (s[p] === " " && (contentIndent < 0 || p - lineStart < contentIndent)) p++;
      const spaces = p - lineStart;
      if (p >= n) break;
      if (s[p] === "\n") {
        if (contentIndent < 0 && spaces > leadingMax) leadingMax = spaces;
        pending++;
        p++;
        continue;
      }
      if (contentIndent < 0) {
        if (spaces <= parentIndent) {
          p = lineStart;
          break;
        }
        if (leadingMax > spaces) this.fail("A blank line at the start of this block scalar is indented more than its first line", lineStart);
        contentIndent = spaces;
      } else if (spaces < contentIndent) {
        p = lineStart;
        break;
      }
      if (spaces === 0 && this.isMarkerAt(lineStart)) {
        p = lineStart;
        break;
      }
      const eol = this.lineEnd(p);
      const text = s.slice(p, eol);
      const moreIndented = text[0] === " " || text[0] === "\t";
      if (!sawContent) out += "\n".repeat(pending);
      else if (literal || moreIndented || lastMoreIndented) out += "\n".repeat(pending + 1);
      else out += pending ? "\n".repeat(pending) : " ";
      out += text;
      sawContent = true;
      lastMoreIndented = moreIndented;
      pending = 0;
      lastHadBreak = eol < n;
      p = lastHadBreak ? eol + 1 : eol;
    }
    this.pos = p;
    const trailing = (sawContent && lastHadBreak ? 1 : 0) + pending;
    if (chomp === 1) out += "\n".repeat(trailing);
    else if (chomp === 0 && sawContent && lastHadBreak) out += "\n";
    this.skipToContent();
    return out;
  }

  // ------------------------------------------------------------ flow collections

  private flowCollection(): unknown {
    return this.s[this.pos] === "[" ? this.flowSequence() : this.flowMapping();
  }

  /** Skip spaces, line breaks and comments inside [ ] or { }. */
  private skipFlowSpace(open: number): void {
    const s = this.s;
    const n = s.length;
    let p = this.pos;
    for (;;) {
      const c = s[p];
      if (c === " " || c === "\t") {
        p++;
        continue;
      }
      if (c === "\n") {
        p++;
        if (this.isMarkerAt(p)) this.fail(`A document marker can't appear inside '${s[open]}'`, p);
        continue;
      }
      if (c === "#") {
        const prev = s[p - 1];
        if (prev !== " " && prev !== "\t" && prev !== "\n") this.fail("Put a space before '#' to start a comment", p);
        p = this.lineEnd(p);
        continue;
      }
      break;
    }
    this.pos = p;
    if (p >= n) this.fail(`Unclosed '${s[open]}'`, open);
  }

  private flowSequence(): unknown[] {
    const s = this.s;
    const open = this.pos;
    this.enter(open);
    this.pos++;
    const list: unknown[] = [];
    for (;;) {
      this.skipFlowSpace(open);
      if (s[this.pos] === "]") {
        this.pos++;
        break;
      }
      if (s[this.pos] === ",") this.fail("Missing value before ','");
      const entryAt = this.pos;
      const node = this.flowNode(open);
      this.skipFlowSpace(open);
      if (s[this.pos] === ":") {
        // A single-pair mapping: [key: value]
        if (node.kind === "collection") this.fail("Collections can't be used as mapping keys", entryAt);
        if (node.kind === "plain" && node.text === "<<") this.fail("Merge keys (<<) are not supported; write the keys out", entryAt);
        this.pos++;
        this.skipFlowSpace(open);
        const value = s[this.pos] === "," || s[this.pos] === "]" ? null : this.flowNode(open).value;
        const pair: Record<string, unknown> = {};
        define(pair, node.text, value);
        list.push(pair);
        this.skipFlowSpace(open);
      } else {
        list.push(node.value);
      }
      if (s[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (s[this.pos] === "]") {
        this.pos++;
        break;
      }
      this.fail("Expected ',' or ']'");
    }
    this.depth--;
    return list;
  }

  private flowMapping(): Record<string, unknown> {
    const s = this.s;
    const open = this.pos;
    this.enter(open);
    this.pos++;
    const map: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (;;) {
      this.skipFlowSpace(open);
      const c = s[this.pos];
      if (c === "}") {
        this.pos++;
        break;
      }
      if (c === ",") this.fail("Missing key before ','");
      if (c === ":" && (this.wsOrEnd(this.pos + 1) || isFlowIndicator(s[this.pos + 1]))) this.fail("Missing key before ':'");
      const keyAt = this.pos;
      const key = this.flowNode(open);
      if (key.kind === "collection") this.fail("Collections can't be used as mapping keys", keyAt);
      if (key.kind === "plain" && key.text === "<<") this.fail("Merge keys (<<) are not supported; write the keys out", keyAt);
      if (seen.has(key.text)) this.fail(`Duplicate key "${key.text}"`, keyAt);
      seen.add(key.text);
      this.skipFlowSpace(open);
      let value: unknown = null;
      if (s[this.pos] === ":") {
        this.pos++;
        this.skipFlowSpace(open);
        if (s[this.pos] !== "," && s[this.pos] !== "}") value = this.flowNode(open).value;
        this.skipFlowSpace(open);
      }
      define(map, key.text, value);
      if (s[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (s[this.pos] === "}") {
        this.pos++;
        break;
      }
      this.fail("Expected ',' or '}'");
    }
    this.depth--;
    return map;
  }

  private flowNode(open: number): FlowNode {
    const s = this.s;
    this.rejectUnsupported();
    const c = s[this.pos];
    if (c === "[" || c === "{") return { value: this.flowCollection(), kind: "collection", text: "" };
    if (c === '"' || c === "'") {
      const text = c === '"' ? this.doubleQuoted() : this.singleQuoted();
      return { value: text, kind: "quoted", text };
    }
    if (c === "|" || c === ">") this.fail(`Block scalars (| and >) can't be used inside '${s[open]}'`);
    if (!this.startsPlain(this.pos, true)) this.fail(`Unexpected '${c}'; quote the value if it is text`);
    let text = this.plainLine(true);
    let multiline = false;
    // Plain scalars in flow context may continue on the next lines.
    for (;;) {
      let p = this.pos;
      while (s[p] === " " || s[p] === "\t") p++;
      if (s[p] !== "\n") break;
      let breaks = 0;
      let next = -1;
      while (p < s.length) {
        p++;
        const lineStart = p;
        while (s[p] === " " || s[p] === "\t") p++;
        if (p >= s.length) break;
        if (s[p] === "\n") {
          breaks++;
          continue;
        }
        if (s[p] === "#" || (p === lineStart && this.isMarkerAt(lineStart))) break;
        if (isFlowIndicator(s[p]) || (s[p] === ":" && (this.wsOrEnd(p + 1) || isFlowIndicator(s[p + 1])))) break;
        next = p;
        break;
      }
      if (next < 0) break;
      text += breaks ? "\n".repeat(breaks) : " ";
      this.pos = next;
      text += this.plainLine(true);
      multiline = true;
    }
    return { value: multiline ? text : resolvePlainScalar(text), kind: "plain", text };
  }
}

function trimEndSpace(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === " " || text[end - 1] === "\t")) end--;
  return end === text.length ? text : text.slice(0, end);
}
