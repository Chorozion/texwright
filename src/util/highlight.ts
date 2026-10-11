/**
 * Syntax highlighting for code blocks, without any third-party code.
 *
 * `tokenize` splits source into `{text, kind}` tokens (the PDF renderer can
 * color those directly); `highlight` turns them into HTML spans named the way
 * highlight.js names them (`hljs-keyword`, `hljs-string`, `hljs-title
 * function_`...), so existing themes keep working. All text is HTML-escaped.
 *
 * Each language is a small table (keywords, literals, built-ins, types,
 * comment and string delimiters, a few switches) driving one scanner, plus
 * dedicated scanners for markup-like languages (HTML/XML, CSS, YAML,
 * Markdown, LaTeX, diff). Every scanner moves forward through the text and
 * searches for closing delimiters at most once per line, so highlighting runs
 * in linear time whatever the input; there are no backtracking regexes.
 */

export type TokenKind =
  | ""
  | "keyword"
  | "built_in"
  | "type"
  | "literal"
  | "number"
  | "string"
  | "regexp"
  | "comment"
  | "meta"
  | "title"
  | "title.function"
  | "title.class"
  | "variable"
  | "variable.language"
  | "attr"
  | "attribute"
  | "symbol"
  | "bullet"
  | "section"
  | "emphasis"
  | "strong"
  | "code"
  | "quote"
  | "link"
  | "addition"
  | "deletion"
  | "tag"
  | "name"
  | "selector-tag"
  | "selector-class"
  | "selector-id"
  | "selector-pseudo"
  | "selector-attr";

export interface Token {
  text: string;
  /** "" for plain text. */
  kind: TokenKind;
}

/** The highlight.js class attribute value for a token kind ("" for plain text). */
export function tokenClass(kind: TokenKind): string {
  if (!kind) return "";
  const dot = kind.indexOf(".");
  return dot < 0 ? `hljs-${kind}` : `hljs-${kind.slice(0, dot)} ${kind.slice(dot + 1)}_`;
}

/** Canonical name of a supported language, or undefined. */
export function languageName(lang: string): string | undefined {
  const key = lang.trim().toLowerCase();
  return Object.hasOwn(ALIASES, key) ? ALIASES[key] : undefined;
}

/** Supported languages by canonical name. */
export function supportedLanguages(): string[] {
  return [...new Set(Object.values(ALIASES))].sort();
}

/** Split `code` into tokens. An unsupported language gives one plain token. */
export function tokenize(code: string, lang: string): Token[] {
  const name = languageName(lang);
  const out = new Emitter();
  if (!name) out.push(code, "");
  else scan(name, code, 0, code.length, out);
  return out.tokens;
}

/** Highlighted HTML for `code`, or undefined when the language is not supported. */
export function highlight(code: string, lang: string): string | undefined {
  if (!languageName(lang)) return undefined;
  let html = "";
  for (const t of tokenize(code, lang)) {
    const text = escapeHtml(t.text);
    html += t.kind ? `<span class="${tokenClass(t.kind)}">${text}</span>` : text;
  }
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#x27;"));
}

// ------------------------------------------------------------------ plumbing

class Emitter {
  readonly tokens: Token[] = [];
  push(text: string, kind: TokenKind): void {
    if (!text) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.tokens.push({ text, kind });
  }
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isIdentStart = (c: number): boolean => isLetter(c) || c === 95 || c > 127;
const isIdentPart = (c: number): boolean => isIdentStart(c) || isDigit(c);
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
const isHex = (c: number): boolean => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

function lineEnd(code: string, i: number, end: number): number {
  const j = code.indexOf("\n", i);
  return j < 0 || j > end ? end : j;
}

function identEnd(code: string, i: number, end: number, extra = ""): number {
  while (i < end) {
    const c = code.charCodeAt(i);
    if (isIdentPart(c) || (extra && extra.includes(code[i]!))) i++;
    else break;
  }
  return i;
}

/**
 * Searches for a closer that must sit on the same line, remembering failures:
 * once `needle` is missing from the rest of a line, later searches from the
 * same line return -1 at once, so a line full of openers costs linear time.
 */
class LineSearch {
  /** Per needle: where the last search started and the first occurrence at or after it (-1: none). */
  private memo = new Map<string, { from: number; found: number }>();
  /** The last line end computed, and the position it was computed from. */
  private eolFrom = -1;
  private eolAt = -1;
  constructor(
    private readonly code: string,
    private readonly end: number,
  ) {}
  find(needle: string, from: number): number {
    let m = this.memo.get(needle);
    // Nothing occurs in [m.from, m.found), so from anywhere inside that range the first occurrence is the same.
    if (!m || from < m.from || (m.found >= 0 && from > m.found)) {
      m = { from, found: this.code.indexOf(needle, from) };
      this.memo.set(needle, m);
    }
    const eol = this.lineEndOf(from);
    return m.found >= 0 && m.found + needle.length <= eol ? m.found : -1;
  }
  private lineEndOf(from: number): number {
    if (from < this.eolFrom || from > this.eolAt) {
      this.eolFrom = from;
      this.eolAt = lineEnd(this.code, from, this.end);
    }
    return this.eolAt;
  }
}

/** Scan a number starting at `i` (a digit, or '.' before a digit); returns its end. */
function numberEnd(code: string, i: number, end: number): number {
  let j = i;
  const c0 = code[j];
  const c1 = code[j + 1]?.toLowerCase();
  if (c0 === "0" && (c1 === "x" || c1 === "b" || c1 === "o")) {
    j += 2;
    while (j < end && (isHex(code.charCodeAt(j)) || code[j] === "_")) j++;
  } else {
    while (j < end && (isDigit(code.charCodeAt(j)) || code[j] === "_")) j++;
    if (code[j] === "." && isDigit(code.charCodeAt(j + 1) || 0)) {
      j++;
      while (j < end && (isDigit(code.charCodeAt(j)) || code[j] === "_")) j++;
    } else if (code[j] === "." && j > i && !isIdentStart(code.charCodeAt(j + 1) || 0) && code[j + 1] !== ".") {
      j++; // "5." is a float
    }
    if ((code[j] === "e" || code[j] === "E") && (isDigit(code.charCodeAt(j + 1) || 0) || ((code[j + 1] === "+" || code[j + 1] === "-") && isDigit(code.charCodeAt(j + 2) || 0)))) {
      j += 2;
      while (j < end && isDigit(code.charCodeAt(j))) j++;
    }
  }
  // Suffixes such as 10u, 1.5f, 2L, 1n, 3i, 1im, 1_000usize.
  while (j < end && isIdentPart(code.charCodeAt(j))) j++;
  return Math.min(j, end);
}

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

// ------------------------------------------------------------------ code languages

interface StringRule {
  open: string;
  close: string;
  /** Backslash escapes the next character. */
  escape: boolean;
  /** May span lines; otherwise an unclosed string ends at the line end. */
  multiline: boolean;
  /** `$name` and `${...}` inside are variables (shell, PHP). */
  vars?: boolean;
}

interface CodeLang {
  keywords: Set<string>;
  literals?: Set<string>;
  builtins?: Set<string>;
  types?: Set<string>;
  /** `this`, `self`: highlighted as `variable language_`. */
  language?: Set<string>;
  caseInsensitive?: boolean;
  lineComments?: string[];
  blockComment?: [string, string];
  nestedComments?: boolean;
  /** `#` starts a comment only at the start of a word (shell). */
  hashNeedsBoundary?: boolean;
  strings: StringRule[];
  /** Identifiers that turn a directly following quote into a prefixed string (r"", b'', f""). */
  stringPrefixes?: Set<string>;
  /** `$name` is a variable (shell, PHP). */
  dollarVars?: boolean;
  /** `@x`, `@@x` and `$x` are variables (Ruby). */
  rubyVars?: boolean;
  /** `@name` decorators / annotations / macros and their class. */
  decorators?: TokenKind;
  /** `#` at the start of a line is a preprocessor directive (C family). */
  preprocessor?: boolean;
  /** `#[...]` attributes, `name!` macros, `'a` lifetimes, raw strings (Rust). */
  rust?: boolean;
  /** `:name` symbols (Ruby). */
  rubySymbols?: boolean;
  /** `/regex/` literals (JavaScript). */
  regex?: boolean;
  /** A quote right after a value is the transpose operator (MATLAB, Julia). */
  transpose?: boolean;
  /** `'x'` is a character literal (C family, Rust, Julia...). */
  charLiterals?: boolean;
  /** Keyword -> kind of the identifier that follows (def f, class C). */
  titles?: Record<string, TokenKind>;
  /** `name(` is a function title (JavaScript calls). */
  callTitles?: boolean;
  /** `type name(` declares a function (C family). */
  declTitles?: boolean;
  /** `<?php` and `?>` are meta. */
  phpTags?: boolean;
  /** Extra identifier characters. */
  identExtra?: string;
  /** Shell: numbers aren't highlighted (they are usually parts of words). */
  noNumbers?: boolean;
}

const DQ: StringRule = { open: '"', close: '"', escape: true, multiline: false };
const SQ: StringRule = { open: "'", close: "'", escape: true, multiline: false };
const C_STRINGS = [DQ];

const JS_KEYWORDS =
  "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch throw try typeof var void while with yield";
const JS_BUILTINS =
  "Array ArrayBuffer BigInt Boolean DataView Date Error EvalError Float32Array Float64Array Function Int8Array Int16Array Int32Array Intl JSON Map Math Number Object Promise Proxy RangeError ReferenceError Reflect RegExp Set String Symbol SyntaxError TypeError URIError Uint8Array Uint16Array Uint32Array WeakMap WeakSet decodeURI decodeURIComponent encodeURI encodeURIComponent eval globalThis isFinite isNaN parseFloat parseInt require module exports process setTimeout setInterval clearTimeout clearInterval structuredClone fetch";
const JS: CodeLang = {
  keywords: words(JS_KEYWORDS),
  literals: words("true false null undefined NaN Infinity"),
  builtins: words(JS_BUILTINS),
  language: words("this console window document"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: [DQ, SQ, { open: "`", close: "`", escape: true, multiline: true }],
  regex: true,
  titles: { function: "title.function", class: "title.class", extends: "title.class", new: "title.class" },
  callTitles: true,
  identExtra: "$",
};
const TS: CodeLang = {
  ...JS,
  keywords: words(`${JS_KEYWORDS} abstract declare enum implements infer interface is keyof module namespace override private protected public readonly satisfies type unique asserts`),
  builtins: words(`${JS_BUILTINS} string number boolean any unknown never void object symbol bigint Record Partial Required Readonly Pick Omit Exclude Extract ReturnType Awaited`),
  titles: { ...JS.titles, interface: "title.class", enum: "title.class", type: "title.class", implements: "title.class" },
};

const PYTHON: CodeLang = {
  keywords: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"),
  literals: words("True False None Ellipsis NotImplemented"),
  builtins: words(
    "abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __import__ Exception BaseException ValueError TypeError KeyError IndexError AttributeError RuntimeError StopIteration NotImplementedError OSError IOError ZeroDivisionError ImportError NameError AssertionError",
  ),
  language: words("self cls"),
  lineComments: ["#"],
  strings: [
    { open: '"""', close: '"""', escape: true, multiline: true },
    { open: "'''", close: "'''", escape: true, multiline: true },
    DQ,
    SQ,
  ],
  stringPrefixes: words("r u b f br rb fr rf"),
  decorators: "meta",
  titles: { def: "title.function", class: "title.class" },
};

const C_KEYWORDS =
  "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local";
const C_TYPES =
  "char double float int long short signed unsigned void bool _Bool _Complex size_t ssize_t ptrdiff_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t wchar_t FILE";
const C_BUILTINS =
  "printf fprintf sprintf snprintf scanf sscanf malloc calloc realloc free memcpy memset memmove memcmp strlen strcpy strncpy strcmp strncmp strcat strchr strstr fopen fclose fread fwrite fgets fputs puts putchar getchar exit abort assert abs atoi atof qsort";
const C: CodeLang = {
  keywords: words(C_KEYWORDS),
  types: words(C_TYPES),
  builtins: words(C_BUILTINS),
  literals: words("true false NULL"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: C_STRINGS,
  charLiterals: true,
  preprocessor: true,
  titles: { struct: "title.class", union: "title.class", enum: "title.class" },
  declTitles: true,
};
const CPP: CodeLang = {
  ...C,
  keywords: words(
    `${C_KEYWORDS} alignas alignof and asm catch class concept consteval constexpr constinit co_await co_return co_yield decltype delete explicit export friend mutable namespace new noexcept not operator or private protected public requires static_assert static_cast dynamic_cast reinterpret_cast const_cast template this thread_local throw try typeid typename using virtual xor override final`,
  ),
  types: words(`${C_TYPES} auto char8_t char16_t char32_t string wstring vector map set unordered_map unordered_set pair tuple shared_ptr unique_ptr array optional variant`),
  builtins: words(`${C_BUILTINS} std cout cin cerr endl make_shared make_unique move forward`),
  literals: words("true false NULL nullptr"),
  language: words("this"),
  titles: { ...C.titles, class: "title.class", namespace: "title.class" },
};

const CSHARP: CodeLang = {
  keywords: words(
    "abstract as async await base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach get goto if implicit in init interface internal is lock namespace new operator out override params partial private protected public readonly record ref required return sealed set sizeof stackalloc static struct switch throw try typeof unchecked unsafe using value var virtual volatile when where while yield nameof",
  ),
  builtins: words("bool byte char decimal double dynamic float int long nint nuint object sbyte short string uint ulong ushort void Console Math List Dictionary Task String Int32 Exception"),
  literals: words("true false null"),
  language: words("this base"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: [
    { open: '$@"', close: '"', escape: false, multiline: true },
    { open: '@$"', close: '"', escape: false, multiline: true },
    { open: '@"', close: '"', escape: false, multiline: true },
    { open: '"""', close: '"""', escape: false, multiline: true },
    { open: '$"', close: '"', escape: true, multiline: false },
    DQ,
  ],
  charLiterals: true,
  preprocessor: true,
  titles: { class: "title.class", interface: "title.class", struct: "title.class", enum: "title.class", record: "title.class", namespace: "title.class" },
  declTitles: true,
};

const JAVA: CodeLang = {
  keywords: words(
    "abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new non-sealed package permits private protected public record return sealed static strictfp super switch synchronized throw throws transient try var volatile while yield",
  ),
  types: words("boolean byte char double float int long short void"),
  builtins: words("String Object Integer Long Double Float Boolean Character Math System List ArrayList Map HashMap Set HashSet Optional Exception RuntimeException Thread StringBuilder"),
  literals: words("true false null"),
  language: words("this super"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, DQ],
  charLiterals: true,
  decorators: "meta",
  titles: { class: "title.class", interface: "title.class", enum: "title.class", record: "title.class", extends: "title.class", implements: "title.class", new: "title.class" },
  declTitles: true,
};

const GO: CodeLang = {
  keywords: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
  types: words("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable"),
  builtins: words("append cap clear close complex copy delete imag len make max min new panic print println real recover"),
  literals: words("true false nil iota"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  strings: [DQ, { open: "`", close: "`", escape: false, multiline: true }],
  charLiterals: true,
  titles: { func: "title.function", type: "title.class" },
};

const RUST: CodeLang = {
  keywords: words(
    "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type union unsafe use where while yield",
  ),
  types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc RefCell Cell HashMap HashSet BTreeMap BTreeSet"),
  builtins: words("Some None Ok Err drop"),
  literals: words("true false"),
  language: words("self Self"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  nestedComments: true,
  strings: [DQ],
  stringPrefixes: words("b c"),
  rust: true,
  titles: { fn: "title.function", struct: "title.class", enum: "title.class", trait: "title.class", type: "title.class", union: "title.class" },
};

const SQL: CodeLang = {
  keywords: words(
    "add all alter and any as asc begin between by cascade case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references replace returning right rollback select set table then transaction truncate union unique update using values view when where with",
  ),
  types: words("int integer smallint bigint tinyint decimal numeric real float double precision char varchar nvarchar text blob clob date time timestamp datetime interval boolean bool serial uuid json jsonb bytea"),
  builtins: words("count sum avg min max coalesce nullif cast convert upper lower length substr substring trim round abs now current_date current_timestamp row_number rank dense_rank over partition"),
  literals: words("true false"),
  caseInsensitive: true,
  lineComments: ["--"],
  blockComment: ["/*", "*/"],
  strings: [{ open: "'", close: "'", escape: false, multiline: true }],
};

const SHELL: CodeLang = {
  keywords: words("if then else elif fi for while until do done case esac in function select time coproc"),
  builtins: words(
    "alias bg bind break builtin cd command compgen complete continue declare dirs disown echo enable eval exec exit export false fc fg getopts hash help history jobs kill let local logout popd printf pushd pwd read readonly return set shift shopt source suspend test times trap true type typeset ulimit umask unalias unset wait cat ls grep sed awk mkdir rm cp mv chmod chown find xargs curl git npm node sudo",
  ),
  lineComments: ["#"],
  hashNeedsBoundary: true,
  strings: [
    { open: '"', close: '"', escape: true, multiline: true, vars: true },
    { open: "'", close: "'", escape: false, multiline: true },
  ],
  dollarVars: true,
  titles: { function: "title.function" },
  identExtra: "-",
  noNumbers: true,
};

const R: CodeLang = {
  keywords: words("function if else repeat while for in next break return switch"),
  literals: words("TRUE FALSE NULL NA NA_integer_ NA_real_ NA_character_ Inf NaN T F"),
  builtins: words(
    "c list vector matrix array data.frame factor print cat paste paste0 length sum mean median sd var min max range seq rep apply lapply sapply vapply mapply library require source names nrow ncol head tail str summary plot lm glm is.na which unique sort order table round",
  ),
  lineComments: ["#"],
  strings: [
    { open: '"', close: '"', escape: true, multiline: true },
    { open: "'", close: "'", escape: true, multiline: true },
  ],
  identExtra: ".",
};

const JULIA: CodeLang = {
  keywords: words("abstract baremodule begin break catch const continue do else elseif end export finally for function global if import in isa let local macro module mutable primitive quote return struct try type using where while"),
  literals: words("true false nothing missing NaN Inf"),
  builtins: words(
    "Int Int8 Int16 Int32 Int64 Int128 UInt UInt8 UInt16 UInt32 UInt64 Float16 Float32 Float64 Bool Char String Symbol Vector Matrix Array Dict Set Tuple Any Nothing Missing Complex Rational println print length size push! pop! map filter reduce sum zeros ones collect typeof",
  ),
  lineComments: ["#"],
  blockComment: ["#=", "=#"],
  nestedComments: true,
  strings: [
    { open: '"""', close: '"""', escape: true, multiline: true },
    { open: '"', close: '"', escape: true, multiline: false },
  ],
  charLiterals: true,
  transpose: true,
  decorators: "meta",
  titles: { function: "title.function", struct: "title.class", macro: "title.function" },
  identExtra: "!",
};

const MATLAB: CodeLang = {
  keywords: words("break case catch classdef continue else elseif end for function global if otherwise parfor persistent return spmd switch try while methods properties events enumeration"),
  literals: words("true false pi Inf NaN eps"),
  builtins: words("disp fprintf sprintf zeros ones eye rand randn size length numel plot figure hold xlabel ylabel title legend abs sqrt exp log sin cos tan max min sum mean sort find any all isempty num2str str2num"),
  lineComments: ["%"],
  blockComment: ["%{", "%}"],
  strings: [
    { open: '"', close: '"', escape: false, multiline: false },
    { open: "'", close: "'", escape: false, multiline: false },
  ],
  transpose: true,
  titles: { function: "title.function", classdef: "title.class" },
};

const RUBY: CodeLang = {
  keywords: words("alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return super then undef unless until when while yield __FILE__ __LINE__ __method__"),
  literals: words("true false nil"),
  builtins: words("puts print p require require_relative attr_accessor attr_reader attr_writer include extend raise lambda proc loop private protected public"),
  language: words("self"),
  lineComments: ["#"],
  strings: [
    { open: '"', close: '"', escape: true, multiline: true },
    { open: "'", close: "'", escape: true, multiline: true },
  ],
  rubyVars: true,
  rubySymbols: true,
  titles: { def: "title.function", class: "title.class", module: "title.class" },
  identExtra: "?!",
};

const PHP: CodeLang = {
  keywords: words(
    "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield",
  ),
  literals: words("true false null"),
  builtins: words("strlen count array_map array_filter array_merge in_array explode implode json_encode json_decode var_dump print_r isset sprintf str_replace"),
  caseInsensitive: true,
  lineComments: ["//", "#"],
  blockComment: ["/*", "*/"],
  strings: [
    { open: '"', close: '"', escape: true, multiline: true, vars: true },
    { open: "'", close: "'", escape: true, multiline: true },
  ],
  dollarVars: true,
  phpTags: true,
  titles: { function: "title.function", class: "title.class", interface: "title.class", trait: "title.class", extends: "title.class", new: "title.class" },
};

const KOTLIN: CodeLang = {
  keywords: words(
    "abstract actual annotation as break by catch class companion const constructor continue crossinline data do dynamic else enum expect external final finally for fun get if import in infix init inline inner interface internal is lateinit noinline object open operator out override package private protected public reified return sealed set super suspend tailrec throw try typealias val var vararg when where while",
  ),
  types: words("Int Long Short Byte Double Float Boolean Char String Unit Any Nothing Array List MutableList Map MutableMap Set MutableSet Pair"),
  builtins: words("println print listOf mutableListOf mapOf mutableMapOf setOf arrayOf lazy require check error repeat"),
  literals: words("true false null"),
  language: words("this super"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  nestedComments: true,
  strings: [{ open: '"""', close: '"""', escape: false, multiline: true }, DQ],
  charLiterals: true,
  decorators: "meta",
  titles: { fun: "title.function", class: "title.class", interface: "title.class", object: "title.class" },
};

const SWIFT: CodeLang = {
  keywords: words(
    "actor any as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nonmutating open operator override private protocol public repeat rethrows return some static struct subscript switch throw throws try typealias var weak where while",
  ),
  types: words("Int Int8 Int16 Int32 Int64 UInt Double Float Bool String Character Array Dictionary Set Optional Void Any AnyObject Error"),
  builtins: words("print debugPrint min max abs zip stride fatalError precondition assert"),
  literals: words("true false nil"),
  language: words("self Self super"),
  lineComments: ["//"],
  blockComment: ["/*", "*/"],
  nestedComments: true,
  strings: [{ open: '"""', close: '"""', escape: true, multiline: true }, DQ],
  decorators: "keyword",
  titles: { func: "title.function", class: "title.class", struct: "title.class", enum: "title.class", protocol: "title.class", extension: "title.class", actor: "title.class" },
};

const JSON_LANG = "json";

const CODE_LANGS: Record<string, CodeLang> = {
  javascript: JS,
  typescript: TS,
  python: PYTHON,
  c: C,
  cpp: CPP,
  csharp: CSHARP,
  java: JAVA,
  go: GO,
  rust: RUST,
  sql: SQL,
  bash: SHELL,
  r: R,
  julia: JULIA,
  matlab: MATLAB,
  ruby: RUBY,
  php: PHP,
  kotlin: KOTLIN,
  swift: SWIFT,
};

const ALIASES: Record<string, string> = {
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  python: "python",
  py: "python",
  python3: "python",
  gyp: "python",
  json: JSON_LANG,
  jsonc: JSON_LANG,
  json5: JSON_LANG,
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  ksh: "bash",
  console: "bash",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  csharp: "csharp",
  cs: "csharp",
  "c#": "csharp",
  java: "java",
  jsp: "java",
  go: "go",
  golang: "go",
  rust: "rust",
  rs: "rust",
  sql: "sql",
  html: "html",
  xhtml: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  rss: "xml",
  atom: "xml",
  xsl: "xml",
  plist: "xml",
  css: "css",
  yaml: "yaml",
  yml: "yaml",
  latex: "latex",
  tex: "latex",
  markdown: "markdown",
  md: "markdown",
  mkd: "markdown",
  mkdown: "markdown",
  r: "r",
  julia: "julia",
  jl: "julia",
  matlab: "matlab",
  ruby: "ruby",
  rb: "ruby",
  gemspec: "ruby",
  podspec: "ruby",
  thor: "ruby",
  irb: "ruby",
  php: "php",
  php3: "php",
  php4: "php",
  php5: "php",
  php7: "php",
  php8: "php",
  kotlin: "kotlin",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  diff: "diff",
  patch: "diff",
};

function scan(name: string, code: string, start: number, end: number, out: Emitter): void {
  switch (name) {
    case "json":
      return scanJson(code, start, end, out);
    case "html":
      return scanXml(code, start, end, out, true);
    case "xml":
      return scanXml(code, start, end, out, false);
    case "css":
      return scanCss(code, start, end, out);
    case "yaml":
      return scanYaml(code, start, end, out);
    case "markdown":
      return scanMarkdown(code, start, end, out);
    case "latex":
      return scanLatex(code, start, end, out);
    case "diff":
      return scanDiff(code, start, end, out);
    default:
      return scanCode(code, start, end, CODE_LANGS[name]!, out);
  }
}

/** Scan a string starting at `i` with `rule`; returns its end (exclusive). */
function stringEnd(code: string, i: number, end: number, rule: StringRule): number {
  let j = i + rule.open.length;
  const close = rule.close;
  const c0 = close.charCodeAt(0);
  while (j < end) {
    const c = code.charCodeAt(j);
    if (c === 92 /* \ */ && rule.escape) {
      j += 2;
      continue;
    }
    if (c === c0 && code.startsWith(close, j)) {
      // A doubled single-character closer escapes itself where there is no backslash (SQL '', C# @"").
      if (!rule.escape && close.length === 1 && code.charCodeAt(j + 1) === c0 && rule.open.endsWith(close)) {
        j += 2;
        continue;
      }
      return j + close.length;
    }
    if (c === 10 && !rule.multiline) return j;
    j++;
  }
  return end;
}

/** Push a string, splitting out `$name` / `${...}` variables when the rule asks for it. */
function pushString(code: string, i: number, j: number, rule: StringRule, out: Emitter): void {
  if (!rule.vars) {
    out.push(code.slice(i, j), "string");
    return;
  }
  let k = i;
  let chunk = i;
  let brace = -2; // next "}" at or after the current position (-1: none before j)
  while (k < j) {
    const c = code.charCodeAt(k);
    if (c === 92 && rule.escape) {
      k += 2;
      continue;
    }
    if (c === 36 /* $ */ && k + 1 < j) {
      let v = -1;
      if (code[k + 1] === "{") {
        if (brace !== -1 && brace < k + 2) {
          brace = code.indexOf("}", k + 2);
          if (brace >= j) brace = -1;
        }
        if (brace >= 0) v = brace + 1;
      } else if (isIdentStart(code.charCodeAt(k + 1))) v = identEnd(code, k + 1, j);
      if (v > 0) {
        out.push(code.slice(chunk, k), "string");
        out.push(code.slice(k, v), "variable");
        k = chunk = v;
        continue;
      }
    }
    k++;
  }
  out.push(code.slice(chunk, j), "string");
}

/** The end of a block comment opened at `i` (nested when asked); `end` when unclosed. */
function blockCommentEnd(code: string, i: number, end: number, open: string, close: string, nested: boolean): number {
  let j = i + open.length;
  if (!nested) {
    const at = code.indexOf(close, j);
    return at < 0 || at + close.length > end ? end : at + close.length;
  }
  let depth = 1;
  let nextOpen = code.indexOf(open, j);
  let nextClose = code.indexOf(close, j);
  while (depth > 0) {
    if (nextClose < 0 || nextClose >= end) return end;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      j = nextOpen + open.length;
      nextOpen = code.indexOf(open, j);
    } else {
      depth--;
      j = nextClose + close.length;
      nextClose = code.indexOf(close, j);
      if (nextOpen >= 0 && nextOpen < j) nextOpen = code.indexOf(open, j);
    }
  }
  return j;
}

function scanCode(code: string, start: number, end: number, L: CodeLang, out: Emitter): void {
  const lines = new LineSearch(code, end);
  // The previous significant token, for regex, transpose and title decisions.
  let prevKind: TokenKind | "word" | "punct" | "none" = "none";
  let prevText = "";
  let pendingTitle: TokenKind | null = null;
  // After a /regex/ attempt runs into the line end, no regex is tried again on that line.
  let regexBlockedUntil = -1;
  let i = start;
  const emit = (text: string, kind: TokenKind, sig: TokenKind | "word" | "punct" = kind || "punct") => {
    out.push(text, kind);
    prevKind = sig;
    prevText = text;
    if (sig !== "word") pendingTitle = null;
  };
  const atLineStart = (k: number): boolean => {
    for (let p = k - 1; p >= start; p--) {
      const c = code[p];
      if (c === "\n") return true;
      if (c !== " " && c !== "\t") return false;
    }
    return true;
  };

  if (L.phpTags) {
    // Text before <?php is HTML; keep it plain.
    const open = code.indexOf("<?", start);
    if (open > start && open < end) {
      out.push(code.slice(start, open), "");
      i = open;
    }
  }

  while (i < end) {
    const c = code.charCodeAt(i);
    const ch = code[i]!;

    if (isSpace(c)) {
      let j = i + 1;
      while (j < end && isSpace(code.charCodeAt(j))) j++;
      out.push(code.slice(i, j), "");
      i = j;
      continue;
    }

    if (L.phpTags && (code.startsWith("<?php", i) || code.startsWith("<?=", i) || code.startsWith("?>", i))) {
      const len = code.startsWith("<?php", i) ? 5 : code.startsWith("<?=", i) ? 3 : 2;
      emit(code.slice(i, i + len), "meta");
      i += len;
      continue;
    }

    // Shebang.
    if (i === 0 && code.startsWith("#!", 0) && L.lineComments?.includes("#")) {
      const j = lineEnd(code, i, end);
      emit(code.slice(i, j), "meta");
      i = j;
      continue;
    }

    // Comments.
    if (L.blockComment && code.startsWith(L.blockComment[0], i)) {
      const [open, close] = L.blockComment;
      // MATLAB block comments sit on lines of their own.
      if (open !== "%{" || (atLineStart(i) && lineEnd(code, i, end) === i + 2)) {
        const j = blockCommentEnd(code, i, end, open, close, !!L.nestedComments);
        out.push(code.slice(i, j), "comment");
        i = j;
        continue;
      }
    }
    if (L.lineComments) {
      let matched = false;
      for (const lc of L.lineComments) {
        if (!code.startsWith(lc, i)) continue;
        if (lc === "#" && L.hashNeedsBoundary && i > start && !/[\s;&|(){}]/.test(code[i - 1]!)) continue;
        if (lc === "#" && L.phpTags && code[i + 1] === "[") continue;
        matched = true;
        break;
      }
      if (matched) {
        const j = lineEnd(code, i, end);
        out.push(code.slice(i, j), "comment");
        i = j;
        continue;
      }
    }
    if (L === RUBY && code.startsWith("=begin", i) && atLineStart(i)) {
      const close = code.indexOf("\n=end", i);
      const j = close < 0 || close >= end ? end : lineEnd(code, close + 1, end);
      out.push(code.slice(i, j), "comment");
      i = j;
      continue;
    }

    // Preprocessor directives.
    if (L.preprocessor && ch === "#" && atLineStart(i)) {
      let j = i + 1;
      while (j < end && (code[j] === " " || code[j] === "\t")) j++;
      const w = identEnd(code, j, end);
      out.push(code.slice(i, j), "meta");
      out.push(code.slice(j, w), "keyword");
      const directive = code.slice(j, w);
      let k = w;
      if (directive === "include" || directive === "import") {
        while (k < end && (code[k] === " " || code[k] === "\t")) k++;
        out.push(code.slice(w, k), "meta");
        const q = code[k];
        if (q === "<" || q === '"') {
          const close = lines.find(q === "<" ? ">" : '"', k + 1);
          if (close >= 0) {
            out.push(code.slice(k, close + 1), "string");
            k = close + 1;
          }
        }
      }
      // The rest of the directive, with backslash line continuations.
      let e = lineEnd(code, k, end);
      while (e < end && code[e - 1] === "\\") e = lineEnd(code, e + 1, end);
      out.push(code.slice(k, e), "meta");
      prevKind = "punct";
      pendingTitle = null;
      i = e;
      continue;
    }

    // Rust attributes: #[...] and #![...].
    if (L.rust && ch === "#" && (code[i + 1] === "[" || (code[i + 1] === "!" && code[i + 2] === "["))) {
      let j = i + (code[i + 1] === "!" ? 3 : 2);
      let depth = 1;
      while (j < end && depth > 0) {
        if (code[j] === "[") depth++;
        else if (code[j] === "]") depth--;
        j++;
      }
      emit(code.slice(i, j), "meta");
      i = j;
      continue;
    }

    // Decorators, annotations, macros: @name(.name)*
    if (L.decorators && ch === "@" && isIdentStart(code.charCodeAt(i + 1) || 0) && (L !== PYTHON || atLineStart(i))) {
      let j = identEnd(code, i + 1, end);
      while (code[j] === "." && isIdentStart(code.charCodeAt(j + 1) || 0)) j = identEnd(code, j + 1, end);
      emit(code.slice(i, j), L.decorators);
      i = j;
      continue;
    }

    // Variables.
    if (L.dollarVars && ch === "$") {
      const n1 = code[i + 1];
      let j = -1;
      if (n1 === "{") {
        const close = lines.find("}", i + 2);
        if (close >= 0) j = close + 1;
      } else if (n1 !== undefined && isIdentStart(code.charCodeAt(i + 1))) {
        j = identEnd(code, i + 1, end);
      } else if (n1 !== undefined && L === SHELL && /[0-9@#?$!*-]/.test(n1)) {
        j = i + 2;
      }
      if (j > 0) {
        emit(code.slice(i, j), "variable");
        i = j;
        continue;
      }
    }
    if (L.rubyVars && (ch === "@" || ch === "$")) {
      let j = i + 1;
      if (ch === "@" && code[j] === "@") j++;
      if (isIdentStart(code.charCodeAt(j) || 0)) {
        j = identEnd(code, j, end);
        emit(code.slice(i, j), "variable");
        i = j;
        continue;
      }
    }
    if (L.rubySymbols && ch === ":" && code[i + 1] !== ":" && code[i - 1] !== ":" && isIdentStart(code.charCodeAt(i + 1) || 0)) {
      let j = identEnd(code, i + 1, end);
      if (code[j] === "?" || code[j] === "!") j++;
      emit(code.slice(i, j), "symbol");
      i = j;
      continue;
    }

    // Quotes: transpose, characters, lifetimes, strings.
    if (ch === "'" && L.transpose && i > start && /[\w)\]}'.]/.test(code[i - 1]!)) {
      emit("'", "", "punct");
      i++;
      continue;
    }
    if (ch === "'" && L.rust) {
      const j = rustQuoteEnd(code, i, end);
      if (j > 0) {
        emit(code.slice(i, j), "string");
        i = j;
        continue;
      }
      if (isIdentStart(code.charCodeAt(i + 1) || 0)) {
        const k = identEnd(code, i + 1, end);
        emit(code.slice(i, k), "symbol");
        i = k;
        continue;
      }
    }
    if (ch === "'" && L.charLiterals && !L.rust) {
      const j = charLiteralEnd(code, i, end);
      if (j > 0) {
        emit(code.slice(i, j), "string");
        i = j;
        continue;
      }
    }
    let rule: StringRule | undefined;
    for (const r of L.strings) {
      if (code.startsWith(r.open, i)) {
        rule = r;
        break;
      }
    }
    if (rule) {
      const j = stringEnd(code, i, end, rule);
      pushString(code, i, j, rule, out);
      prevKind = "string";
      pendingTitle = null;
      i = j;
      continue;
    }

    // Regular expression literals.
    if (L.regex && ch === "/" && i >= regexBlockedUntil && regexAllowed(prevKind, prevText)) {
      const j = regexEnd(code, i, end, lines);
      if (j > 0) {
        emit(code.slice(i, j), "regexp");
        i = j;
        continue;
      }
      regexBlockedUntil = lineEnd(code, i, end);
    }

    // Numbers.
    if (!L.noNumbers && (isDigit(c) || (ch === "." && isDigit(code.charCodeAt(i + 1) || 0))) && !(i > start && isIdentPart(code.charCodeAt(i - 1)))) {
      const j = numberEnd(code, i, end);
      emit(code.slice(i, j), "number");
      i = j;
      continue;
    }

    // Identifiers and keywords.
    if (isIdentStart(c) || (L.identExtra?.includes("$") && ch === "$")) {
      const j = identEnd(code, i, end, L.identExtra);
      const word = code.slice(i, j);
      const key = L.caseInsensitive ? word.toLowerCase() : word;
      const next = code[j];

      // Prefixed strings: r"...", b'...', f"""...""", rust r#"..."#.
      if (L.rust && (word === "r" || word === "br" || word === "cr") && (next === '"' || next === "#")) {
        const k = rustRawStringEnd(code, j, end);
        if (k > 0) {
          emit(code.slice(i, k), "string");
          i = k;
          continue;
        }
      }
      if (L.stringPrefixes?.has(word.toLowerCase()) && (next === '"' || next === "'")) {
        const r = L.strings.find((s) => code.startsWith(s.open, j)) ?? (next === '"' ? DQ : SQ);
        const k = L.rust && next === "'" ? rustQuoteEnd(code, j, end) : stringEnd(code, j, end, r);
        if (k > 0) {
          emit(code.slice(i, k), "string");
          i = k;
          continue;
        }
      }
      // Rust macros: name!(...)
      if (L.rust && next === "!" && code[j + 1] !== "=") {
        emit(code.slice(i, j + 1), "built_in");
        i = j + 1;
        continue;
      }

      let kind: TokenKind = "";
      if (L.keywords.has(key)) kind = "keyword";
      else if (L.literals?.has(key)) kind = "literal";
      else if (L.language?.has(key)) kind = "variable.language";
      else if (L.types?.has(key)) kind = "type";
      else if (L.builtins?.has(key)) kind = "built_in";

      if (pendingTitle && (kind === "" || kind === "built_in" || kind === "type")) {
        const t = pendingTitle;
        emit(word, t);
        i = j;
        continue;
      }
      if (kind === "") {
        let k = j;
        while (k < end && (code[k] === " " || code[k] === "\t")) k++;
        if (code[k] === "(") {
          if (L.callTitles) kind = "title.function";
          else if (L.declTitles && (prevKind === "type" || prevKind === "word" || prevKind === "built_in") && prevText !== "return") kind = "title.function";
        }
      }
      const title = kind === "keyword" ? L.titles?.[key] : undefined;
      out.push(word, kind);
      prevKind = kind === "" ? "word" : kind;
      prevText = word;
      pendingTitle = title ?? null;
      i = j;
      continue;
    }

    emit(ch, "", "punct");
    i++;
  }
}

const REGEX_AFTER_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

function regexAllowed(prevKind: string, prevText: string): boolean {
  if (prevKind === "none") return true;
  if (prevKind === "keyword") return REGEX_AFTER_WORDS.has(prevText);
  if (prevKind !== "punct") return false;
  return /[(,=:[!&|?{};+\-*%<>~^]$/.test(prevText);
}

/** End of a /regex/flags literal at `i`, or -1. Regexes never span lines. */
function regexEnd(code: string, i: number, end: number, lines: LineSearch): number {
  if (code[i + 1] === "/" || code[i + 1] === "*") return -1;
  // Cheap rejection: no second slash on the line at all.
  if (lines.find("/", i + 1) < 0) return -1;
  let j = i + 1;
  let inClass = false;
  while (j < end) {
    const c = code[j];
    if (c === "\n") return -1;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      j++;
      while (j < end && isLetter(code.charCodeAt(j))) j++;
      return j;
    }
    j++;
  }
  return -1;
}

/** End of a 'c' / '\n' / '\x41' character literal at `i`, or -1. */
function charLiteralEnd(code: string, i: number, end: number): number {
  if (code[i + 1] === "\\") {
    for (let j = i + 2; j < end && j < i + 12; j++) {
      if (code[j] === "'") return j + 1;
      if (code[j] === "\n") return -1;
    }
    return -1;
  }
  const cp = code.codePointAt(i + 1);
  if (cp === undefined || cp === 10 || cp === 39) return -1;
  const w = cp > 0xffff ? 2 : 1;
  return code[i + 1 + w] === "'" && i + 2 + w <= end ? i + 2 + w : -1;
}

/** Rust: a char or byte literal ('a', '\n', '\u{1F600}'); -1 when the quote starts a lifetime. */
function rustQuoteEnd(code: string, i: number, end: number): number {
  if (code[i + 1] === "\\") {
    for (let j = i + 2; j < end && j < i + 14; j++) {
      if (code[j] === "'") return j + 1;
      if (code[j] === "\n") return -1;
    }
    return -1;
  }
  return charLiteralEnd(code, i, end);
}

/** Rust raw strings: at `j` is either `"` or a run of `#` then `"`; returns the end after the matching `"#...#`, or -1. */
function rustRawStringEnd(code: string, j: number, end: number): number {
  let hashes = 0;
  while (code[j + hashes] === "#") hashes++;
  if (code[j + hashes] !== '"') return -1;
  const close = `"${"#".repeat(hashes)}`;
  const at = code.indexOf(close, j + hashes + 1);
  return at < 0 || at + close.length > end ? end : at + close.length;
}

// ------------------------------------------------------------------ JSON

function scanJson(code: string, start: number, end: number, out: Emitter): void {
  let i = start;
  while (i < end) {
    const ch = code[i]!;
    const c = code.charCodeAt(i);
    if (isSpace(c)) {
      let j = i + 1;
      while (j < end && isSpace(code.charCodeAt(j))) j++;
      out.push(code.slice(i, j), "");
      i = j;
      continue;
    }
    if (code.startsWith("//", i)) {
      const j = lineEnd(code, i, end);
      out.push(code.slice(i, j), "comment");
      i = j;
      continue;
    }
    if (code.startsWith("/*", i)) {
      const j = blockCommentEnd(code, i, end, "/*", "*/", false);
      out.push(code.slice(i, j), "comment");
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const j = stringEnd(code, i, end, ch === '"' ? DQ : SQ);
      let k = j;
      while (k < end && isSpace(code.charCodeAt(k))) k++;
      out.push(code.slice(i, j), code[k] === ":" ? "attr" : "string");
      i = j;
      continue;
    }
    if (isDigit(c) || (ch === "-" && isDigit(code.charCodeAt(i + 1) || 0))) {
      const j = numberEnd(code, ch === "-" ? i + 1 : i, end);
      out.push(code.slice(i, j), "number");
      i = j;
      continue;
    }
    if (isIdentStart(c)) {
      const j = identEnd(code, i, end);
      const w = code.slice(i, j);
      out.push(w, w === "true" || w === "false" || w === "null" ? "literal" : "");
      i = j;
      continue;
    }
    out.push(ch, "");
    i++;
  }
}

// ------------------------------------------------------------------ HTML / XML

function scanXml(code: string, start: number, end: number, out: Emitter, html: boolean): void {
  // ASCII-only lowercasing keeps every index where it was (toLowerCase can change lengths).
  const lower = html ? code.replace(/[A-Z]+/g, (m) => m.toLowerCase()) : code;
  let i = start;
  let nextLt = -2;
  let nextAmp = -2;
  while (i < end) {
    if (nextLt !== -1 && nextLt < i) nextLt = code.indexOf("<", i);
    if (nextAmp !== -1 && nextAmp < i) nextAmp = code.indexOf("&", i);
    const lt = nextLt < 0 || nextLt >= end ? end : nextLt;
    const amp = nextAmp < 0 || nextAmp >= end ? end : nextAmp;
    const stop = Math.min(lt, amp);
    if (stop > i) {
      out.push(code.slice(i, stop), "");
      i = stop;
      continue;
    }
    if (i === amp) {
      const m = /&(?:#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,8}|[A-Za-z][A-Za-z0-9]{0,31});/y;
      m.lastIndex = i;
      const hit = m.exec(code);
      if (hit && i + hit[0].length <= end) {
        out.push(hit[0], "symbol");
        i += hit[0].length;
      } else {
        out.push("&", "");
        i++;
      }
      continue;
    }
    // At '<'.
    if (code.startsWith("<!--", i)) {
      const close = code.indexOf("-->", i + 4);
      const j = close < 0 || close + 3 > end ? end : close + 3;
      out.push(code.slice(i, j), "comment");
      i = j;
      continue;
    }
    if (code.startsWith("<![CDATA[", i)) {
      const close = code.indexOf("]]>", i + 9);
      const j = close < 0 || close + 3 > end ? end : close + 3;
      out.push(code.slice(i, j), "meta");
      i = j;
      continue;
    }
    if (code.startsWith("<!", i) || code.startsWith("<?", i)) {
      const close = code.indexOf(">", i + 2);
      const j = close < 0 || close + 1 > end ? end : close + 1;
      out.push(code.slice(i, j), "meta");
      i = j;
      continue;
    }
    const closing = code[i + 1] === "/";
    const nameStart = i + (closing ? 2 : 1);
    if (!isLetter(code.charCodeAt(nameStart) || 0)) {
      out.push("<", "");
      i++;
      continue;
    }
    const nameEnd = identEnd(code, nameStart, end, "-:.");
    const name = lower.slice(nameStart, nameEnd);
    out.push(code.slice(i, nameStart), "tag");
    out.push(code.slice(nameStart, nameEnd), "name");
    i = nameEnd;
    // Attributes, up to '>' or '/>'.
    while (i < end) {
      const ch = code[i]!;
      if (ch === ">") {
        out.push(">", "tag");
        i++;
        break;
      }
      if (ch === "/" && code[i + 1] === ">") {
        out.push("/>", "tag");
        i += 2;
        break;
      }
      if (isSpace(code.charCodeAt(i))) {
        let j = i + 1;
        while (j < end && isSpace(code.charCodeAt(j))) j++;
        out.push(code.slice(i, j), "");
        i = j;
        continue;
      }
      if (ch === "=") {
        out.push("=", "");
        i++;
        let j = i;
        while (j < end && isSpace(code.charCodeAt(j))) j++;
        out.push(code.slice(i, j), "");
        i = j;
        const q = code[i];
        if (q === '"' || q === "'") {
          const close = code.indexOf(q, i + 1);
          const k = close < 0 || close + 1 > end ? end : close + 1;
          out.push(code.slice(i, k), "string");
          i = k;
        } else {
          let k = i;
          while (k < end && !isSpace(code.charCodeAt(k)) && code[k] !== ">") k++;
          out.push(code.slice(i, k), "string");
          i = k;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        const close = code.indexOf(ch, i + 1);
        const k = close < 0 || close + 1 > end ? end : close + 1;
        out.push(code.slice(i, k), "string");
        i = k;
        continue;
      }
      let j = i;
      while (j < end && !isSpace(code.charCodeAt(j)) && code[j] !== "=" && code[j] !== ">" && code[j] !== '"' && code[j] !== "'" && !(code[j] === "/" && code[j + 1] === ">")) j++;
      if (j === i) j = i + 1;
      out.push(code.slice(i, j), "attr");
      i = j;
    }
    // Script and style bodies are highlighted as JavaScript and CSS.
    if (html && !closing && (name === "script" || name === "style")) {
      const close = lower.indexOf(`</${name}`, i);
      const bodyEnd = close < 0 || close > end ? end : close;
      if (bodyEnd > i) scan(name === "script" ? "javascript" : "css", code, i, bodyEnd, out);
      i = bodyEnd;
    }
  }
}

// ------------------------------------------------------------------ CSS

const CSS_GROUP_RULES = new Set(["media", "supports", "document", "layer", "container", "scope", "starting-style", "keyframes", "-webkit-keyframes"]);

function scanCss(code: string, start: number, end: number, out: Emitter): void {
  const lines = new LineSearch(code, end);
  // Stack of block kinds: "rules" hold selectors, "decls" hold declarations.
  const stack: ("rules" | "decls")[] = [];
  let atRule: string | null = null;
  let declStart = true;
  let i = start;
  const context = (): "rules" | "decls" => stack[stack.length - 1] ?? "rules";
  while (i < end) {
    const ch = code[i]!;
    const c = code.charCodeAt(i);
    if (isSpace(c)) {
      let j = i + 1;
      while (j < end && isSpace(code.charCodeAt(j))) j++;
      out.push(code.slice(i, j), "");
      i = j;
      continue;
    }
    if (code.startsWith("/*", i)) {
      const j = blockCommentEnd(code, i, end, "/*", "*/", false);
      out.push(code.slice(i, j), "comment");
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const j = stringEnd(code, i, end, ch === '"' ? DQ : SQ);
      out.push(code.slice(i, j), "string");
      i = j;
      declStart = false;
      continue;
    }
    if (ch === "@" && isIdentStart(code.charCodeAt(i + 1) || 0)) {
      const j = identEnd(code, i + 1, end, "-");
      atRule = code.slice(i + 1, j).toLowerCase();
      out.push(code.slice(i, j), "keyword");
      i = j;
      declStart = false;
      continue;
    }
    if (ch === "{") {
      // Selectors inside @media and friends; declarations inside everything else.
      const inner = context() === "rules" && atRule !== null && CSS_GROUP_RULES.has(atRule) ? "rules" : "decls";
      stack.push(inner);
      atRule = null;
      declStart = true;
      out.push("{", "");
      i++;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      atRule = null;
      declStart = true;
      out.push("}", "");
      i++;
      continue;
    }
    if (ch === ";") {
      atRule = null;
      declStart = true;
      out.push(";", "");
      i++;
      continue;
    }
    const inDecls = context() === "decls" && atRule === null;
    if (isDigit(c) || (ch === "." && isDigit(code.charCodeAt(i + 1) || 0)) || ((ch === "-" || ch === "+") && (isDigit(code.charCodeAt(i + 1) || 0) || code[i + 1] === "."))) {
      if (inDecls || atRule !== null || context() === "rules") {
        let j = ch === "-" || ch === "+" ? i + 1 : i;
        while (j < end && (isDigit(code.charCodeAt(j)) || code[j] === ".")) j++;
        while (j < end && (isLetter(code.charCodeAt(j)) || code[j] === "%")) j++;
        out.push(code.slice(i, j), "number");
        i = j;
        declStart = false;
        continue;
      }
    }
    if (inDecls) {
      if (ch === "!" && /^!\s*important/i.test(code.slice(i, i + 16))) {
        const j = i + code.slice(i, i + 16).search(/important/i) + 9;
        out.push(code.slice(i, j), "meta");
        i = j;
        continue;
      }
      if (ch === "#" && isHex(code.charCodeAt(i + 1) || 0)) {
        let j = i + 1;
        while (j < end && isIdentPart(code.charCodeAt(j))) j++;
        out.push(code.slice(i, j), "number");
        i = j;
        continue;
      }
      if (isIdentStart(c) || ch === "-") {
        const j = identEnd(code, i + 1, end, "-");
        let k = j;
        while (k < end && (code[k] === " " || code[k] === "\t")) k++;
        if (declStart && code[k] === ":") {
          out.push(code.slice(i, j), "attribute");
          i = j;
          declStart = false;
          continue;
        }
        if (code[j] === "(") {
          const fn = code.slice(i, j);
          out.push(fn, "built_in");
          i = j;
          if (fn.toLowerCase() === "url") {
            const close = lines.find(")", j + 1);
            if (close >= 0) {
              out.push("(", "");
              out.push(code.slice(j + 1, close), "string");
              i = close;
            }
          }
          continue;
        }
        out.push(code.slice(i, j), "");
        i = j;
        declStart = false;
        continue;
      }
      out.push(ch, "");
      i++;
      if (ch !== ":") declStart = false;
      continue;
    }
    if (atRule !== null) {
      // An at-rule prelude: @media screen and (max-width: 600px)
      if (isIdentStart(c) || ch === "-") {
        const j = identEnd(code, i + 1, end, "-");
        out.push(code.slice(i, j), "");
        i = j;
        continue;
      }
      out.push(ch, "");
      i++;
      continue;
    }
    // Selectors.
    if ((ch === "." || ch === "#") && (isIdentStart(code.charCodeAt(i + 1) || 0) || code[i + 1] === "-")) {
      const j = identEnd(code, i + 1, end, "-");
      out.push(code.slice(i, j), ch === "." ? "selector-class" : "selector-id");
      i = j;
      continue;
    }
    if (ch === ":") {
      let j = i + 1;
      if (code[j] === ":") j++;
      const k = identEnd(code, j, end, "-");
      out.push(code.slice(i, k), k > j ? "selector-pseudo" : "");
      i = Math.max(k, i + 1);
      continue;
    }
    if (ch === "[") {
      const close = lines.find("]", i + 1);
      if (close >= 0) {
        out.push(code.slice(i, close + 1), "selector-attr");
        i = close + 1;
        continue;
      }
    }
    if (isIdentStart(c)) {
      const j = identEnd(code, i, end, "-");
      out.push(code.slice(i, j), "selector-tag");
      i = j;
      continue;
    }
    out.push(ch, "");
    i++;
  }
}

// ------------------------------------------------------------------ YAML

function yamlScalarKind(text: string): TokenKind {
  const t = text.trim();
  if (/^(?:true|false|yes|no|on|off|null|~)$/i.test(t)) return "literal";
  if (/^[-+]?(?:\.inf|\.nan)$/i.test(t)) return "number";
  if (/^[-+]?(?:0x[0-9a-fA-F]+|0o[0-7]+|[0-9][0-9_]*(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9]+(?:[eE][-+]?[0-9]+)?)$/.test(t)) return "number";
  if (/^\d{4}-\d\d-\d\d(?:[Tt ][0-9:.]+(?:Z|[-+][0-9:]+)?)?$/.test(t)) return "number";
  return "string";
}

function scanYaml(code: string, start: number, end: number, out: Emitter): void {
  let i = start;
  let blockOwner = -1; // indentation of the line that opened a | or > block scalar
  let flowDepth = 0;
  while (i < end) {
    const eol = lineEnd(code, i, end);
    const next = eol < end ? eol + 1 : end;
    let p = i;
    while (p < eol && code[p] === " ") p++;
    const indent = p - i;
    if (blockOwner >= 0) {
      if (p === eol || indent > blockOwner) {
        out.push(code.slice(i, next), "string");
        i = next;
        continue;
      }
      blockOwner = -1;
    }
    out.push(code.slice(i, p), "");
    if (flowDepth === 0 && p === i && (code.startsWith("---", p) || code.startsWith("...", p)) && (p + 3 === eol || isSpace(code.charCodeAt(p + 3)))) {
      out.push(code.slice(p, p + 3), "meta");
      p += 3;
    }
    if (flowDepth === 0) {
      // Sequence bullets.
      while (code[p] === "-" && (p + 1 === eol || code[p + 1] === " ")) {
        out.push("-", "bullet");
        let q = p + 1;
        while (q < eol && code[q] === " ") q++;
        out.push(code.slice(p + 1, q), "");
        p = q;
      }
      // A key.
      const keyEnd = yamlKeyEnd(code, p, eol);
      if (keyEnd > 0) {
        out.push(code.slice(p, keyEnd), "attr");
        p = keyEnd;
      }
    }
    p = scanYamlValue(code, p, eol, out, (d) => (flowDepth += d), () => flowDepth, (owner) => (blockOwner = owner), indent);
    out.push(code.slice(p, next), "");
    i = next;
  }
}

/** If a `key:` starts at `p`, the index after its colon. */
function yamlKeyEnd(code: string, p: number, eol: number): number {
  const q = code[p];
  if (q === "#" || p >= eol) return -1;
  let k = p;
  if (q === '"' || q === "'") {
    const close = code.indexOf(q, p + 1);
    if (close < 0 || close >= eol) return -1;
    k = close + 1;
    while (k < eol && code[k] === " ") k++;
    return code[k] === ":" && (k + 1 === eol || code[k + 1] === " ") ? k + 1 : -1;
  }
  if ("[{&*!|>%@`".includes(q!)) return -1;
  for (; k < eol; k++) {
    if (code[k] === "#" && code[k - 1] === " ") return -1;
    if (code[k] === ":" && (k + 1 === eol || code[k + 1] === " " || code[k + 1] === "\t")) return k + 1;
  }
  return -1;
}

function scanYamlValue(
  code: string,
  p: number,
  eol: number,
  out: Emitter,
  flow: (delta: number) => void,
  depth: () => number,
  block: (owner: number) => void,
  indent: number,
): number {
  while (p < eol) {
    const ch = code[p]!;
    if (ch === " " || ch === "\t") {
      out.push(ch, "");
      p++;
      continue;
    }
    if (ch === "#" && (p === 0 || code[p - 1] === " " || code[p - 1] === "\t" || code[p - 1] === "\n")) {
      out.push(code.slice(p, eol), "comment");
      return eol;
    }
    if ((ch === "|" || ch === ">") && depth() === 0) {
      let q = p + 1;
      while (q < eol && /[-+0-9]/.test(code[q]!)) q++;
      out.push(code.slice(p, q), "string");
      block(indent);
      p = q;
      continue;
    }
    if (ch === "&" || ch === "*") {
      let q = p + 1;
      while (q < eol && !/[\s,\]}]/.test(code[q]!)) q++;
      out.push(code.slice(p, q), "meta");
      p = q;
      continue;
    }
    if (ch === "!") {
      let q = p + 1;
      while (q < eol && !/[\s,\]}]/.test(code[q]!)) q++;
      out.push(code.slice(p, q), "type");
      p = q;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const j = stringEnd(code, p, eol, ch === '"' ? DQ : { open: "'", close: "'", escape: false, multiline: false });
      out.push(code.slice(p, j), "string");
      p = j;
      continue;
    }
    if (ch === "[" || ch === "{") {
      flow(1);
      out.push(ch, "");
      p++;
      continue;
    }
    if (ch === "]" || ch === "}") {
      if (depth() > 0) flow(-1);
      out.push(ch, "");
      p++;
      continue;
    }
    if (ch === "," && depth() > 0) {
      out.push(ch, "");
      p++;
      continue;
    }
    if (depth() > 0) {
      const keyEnd = flowKeyEnd(code, p, eol);
      if (keyEnd > 0) {
        out.push(code.slice(p, keyEnd), "attr");
        p = keyEnd;
        continue;
      }
    }
    // A plain scalar up to ' #', the line end, or (in flow) an indicator.
    let q = p;
    while (q < eol) {
      const c = code[q]!;
      if ((c === " " || c === "\t") && code[q + 1] === "#") break;
      if (depth() > 0 && (c === "," || c === "]" || c === "}")) break;
      q++;
    }
    let e = q;
    while (e > p && (code[e - 1] === " " || code[e - 1] === "\t")) e--;
    out.push(code.slice(p, e), yamlScalarKind(code.slice(p, e)));
    out.push(code.slice(e, q), "");
    p = Math.max(q, p + 1);
  }
  return p;
}

function flowKeyEnd(code: string, p: number, eol: number): number {
  for (let k = p; k < eol; k++) {
    const c = code[k];
    if (c === "," || c === "]" || c === "}" || c === "[" || c === "{") return -1;
    if (c === ":" && (code[k + 1] === " " || k + 1 === eol)) return k + 1;
  }
  return -1;
}

// ------------------------------------------------------------------ Markdown

function scanMarkdown(code: string, start: number, end: number, out: Emitter): void {
  let i = start;
  let fence: string | null = null;
  let prevBlank = true;
  while (i < end) {
    const eol = lineEnd(code, i, end);
    const next = eol < end ? eol + 1 : end;
    const line = code.slice(i, eol);
    if (fence) {
      out.push(code.slice(i, next), "code");
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
      i = next;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = open[1]!;
      out.push(code.slice(i, next), "code");
      i = next;
      prevBlank = false;
      continue;
    }
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) {
      out.push(line, "section");
    } else if (/^ {0,3}(?:=+|-+)\s*$/.test(line) && !prevBlank && line.trim().length >= 2) {
      out.push(line, "section");
    } else if (/^ {0,3}>/.test(line)) {
      out.push(line, "quote");
    } else {
      const bullet = /^([ \t]*)([-*+]|\d{1,9}[.)])(?=[ \t]|$)/.exec(line);
      let p = i;
      if (bullet && !/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        out.push(bullet[1]!, "");
        out.push(bullet[2]!, "bullet");
        p = i + bullet[0].length;
      }
      scanMarkdownInline(code, p, eol, out);
    }
    out.push(code.slice(eol, next), "");
    prevBlank = line.trim() === "";
    i = next;
  }
}

/** End of an autolink `<scheme:...>` at `i`, or -1. Stops at the next '<', so repeated tries stay linear. */
function autolinkEnd(code: string, i: number, end: number): number {
  let j = i + 1;
  while (j < end && (isLetter(code.charCodeAt(j)) || isDigit(code.charCodeAt(j)) || code[j] === "+" || code[j] === "." || code[j] === "-")) j++;
  if (code[j] !== ":" || j === i + 1) return -1;
  for (j++; j < end; j++) {
    const c = code[j]!;
    if (c === ">") return j + 1;
    if (c === "<" || isSpace(code.charCodeAt(j))) return -1;
  }
  return -1;
}

function scanMarkdownInline(code: string, start: number, end: number, out: Emitter): void {
  const lines = new LineSearch(code, end);
  let i = start;
  let plain = start;
  const flush = (to: number) => {
    out.push(code.slice(plain, to), "");
  };
  while (i < end) {
    const ch = code[i]!;
    if (ch === "\\" && i + 1 < end) {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = i;
      while (run < end && code[run] === "`") run++;
      const ticks = code.slice(i, run);
      const close = lines.find(ticks, run);
      if (close >= 0) {
        flush(i);
        out.push(code.slice(i, close + ticks.length), "code");
        i = plain = close + ticks.length;
        continue;
      }
      i = run;
      continue;
    }
    if ((ch === "*" || ch === "_") && code[i + 1] === ch) {
      const delim = ch + ch;
      const close = code[i + 2] !== " " ? lines.find(delim, i + 2) : -1;
      if (close > i + 2) {
        flush(i);
        out.push(code.slice(i, close + 2), "strong");
        i = plain = close + 2;
        continue;
      }
      i += 2;
      continue;
    }
    if ((ch === "*" || ch === "_") && code[i + 1] !== " " && !(ch === "_" && i > start && isIdentPart(code.charCodeAt(i - 1)))) {
      const close = lines.find(ch, i + 1);
      if (close > i + 1 && !(ch === "_" && isIdentPart(code.charCodeAt(close + 1) || 0))) {
        flush(i);
        out.push(code.slice(i, close + 1), "emphasis");
        i = plain = close + 1;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "[") {
      const mid = lines.find("](", i + 1);
      const close = mid >= 0 ? lines.find(")", mid + 2) : -1;
      if (mid >= 0 && close >= 0) {
        flush(i);
        out.push("[", "");
        out.push(code.slice(i + 1, mid), "string");
        out.push("](", "");
        out.push(code.slice(mid + 2, close), "link");
        out.push(")", "");
        i = plain = close + 1;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "<" && isLetter(code.charCodeAt(i + 1) || 0)) {
      const close = autolinkEnd(code, i, end);
      if (close > 0) {
        flush(i);
        out.push(code.slice(i, close), "link");
        i = plain = close;
        continue;
      }
    }
    i++;
  }
  flush(end);
}

// ------------------------------------------------------------------ LaTeX

function scanLatex(code: string, start: number, end: number, out: Emitter): void {
  const lines = new LineSearch(code, end);
  let i = start;
  let plain = start;
  const flush = (to: number) => out.push(code.slice(plain, to), "");
  while (i < end) {
    const ch = code[i]!;
    if (ch === "%") {
      flush(i);
      const j = lineEnd(code, i, end);
      out.push(code.slice(i, j), "comment");
      i = plain = j;
      continue;
    }
    if (ch === "\\" && i + 1 < end) {
      flush(i);
      let j = i + 1;
      if (isLetter(code.charCodeAt(j))) {
        while (j < end && (isLetter(code.charCodeAt(j)) || code[j] === "@")) j++;
        if (code[j] === "*") j++;
      } else {
        j++;
      }
      const word = code.slice(i + 1, j);
      out.push(code.slice(i, j), "keyword");
      i = plain = j;
      if ((word === "begin" || word === "end") && code[i] === "{") {
        const close = lines.find("}", i + 1);
        if (close >= 0) {
          out.push("{", "");
          out.push(code.slice(i + 1, close), "title.class");
          out.push("}", "");
          i = plain = close + 1;
        }
      }
      continue;
    }
    if (ch === "$") {
      flush(i);
      const j = code[i + 1] === "$" ? i + 2 : i + 1;
      out.push(code.slice(i, j), "built_in");
      i = plain = j;
      continue;
    }
    i++;
  }
  flush(end);
}

// ------------------------------------------------------------------ diff

function scanDiff(code: string, start: number, end: number, out: Emitter): void {
  let i = start;
  while (i < end) {
    const eol = lineEnd(code, i, end);
    const next = eol < end ? eol + 1 : end;
    const line = code.slice(i, eol);
    let kind: TokenKind = "";
    if (/^(?:\+\+\+|---|\*\*\*)(?: |$)/.test(line) || /^(?:diff|index|new file mode|deleted file mode|similarity index|rename from|rename to|Index:|=+$|Only in)/.test(line)) kind = "comment";
    else if (line.startsWith("@@") || /^\*+$/.test(line)) kind = "meta";
    else if (line.startsWith("+") || line.startsWith(">") || line.startsWith("!")) kind = "addition";
    else if (line.startsWith("-") || line.startsWith("<")) kind = "deletion";
    out.push(line, kind);
    out.push(code.slice(eol, next), "");
    i = next;
  }
}
