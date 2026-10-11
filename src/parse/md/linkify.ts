/**
 * Bare URLs and e-mail addresses in running text: `http://`, `https://`,
 * `ftp://`, protocol-relative `//host`, `mailto:` and plain `name@host.tld`.
 * Host names without a protocol (`example.com`) are left alone.
 *
 * Recognition follows the rules of the common linkify implementations: a
 * protocol must not be glued to a preceding word, the host must look like a
 * domain or an IP literal, and the path stops before trailing punctuation
 * while keeping balanced brackets and quotes.
 */

export interface LinkMatch {
  /** "http:", "https:", "ftp:", "//", "mailto:"; e-mail addresses get "mailto:". */
  schema: string;
  index: number;
  lastIndex: number;
  /** The matched text. */
  text: string;
  /** The URL it stands for (`mailto:` added to bare addresses). */
  url: string;
}

const MAX_LENGTH = 10_000;

const SEP = "[><\\uff5c]";
const ZPCC = "[\\p{Z}\\p{P}\\p{Cc}]";
const ZCC = "[\\p{Z}\\p{Cc}]";
/** A character that may be part of a host name label. */
const LETTER = "[^><\\uff5c\\p{Z}\\p{P}\\p{Cc}]";

const IPV4 = "(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])[.]){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9][0-9]|[0-9])";
const H16 = "[0-9A-Fa-f]{1,4}";
const LS32 = `(?:(?:${H16}:${H16})|${IPV4})`;
const IPV6 =
  `(?:(?:${H16}:){6}${LS32}|::(?:${H16}:){5}${LS32}|(?:${H16})?::(?:${H16}:){4}${LS32}|(?:(?:${H16}:){0,1}${H16})?::(?:${H16}:){3}${LS32}` +
  `|(?:(?:${H16}:){0,2}${H16})?::(?:${H16}:){2}${LS32}|(?:(?:${H16}:){0,3}${H16})?::${H16}:${LS32}|(?:(?:${H16}:){0,4}${H16})?::${LS32}` +
  `|(?:(?:${H16}:){0,5}${H16})?::${H16}|(?:(?:${H16}:){0,6}${H16})?::)`;
const IPV6_URL_HOST = `\\[${IPV6}\\]`;
const IPV6_MAIL_HOST = `\\[[iI][pP][vV]6:${IPV6}\\]`;

const PORT = "(?::(?:6(?:[0-4]\\d{3}|5(?:[0-4]\\d{2}|5(?:[0-2]\\d|3[0-5])))|[1-5]?\\d{1,4}))?";
const HOST_TERMINATOR = `(?=$|${SEP}|${ZPCC})(?!-|_|:\\d|\\.-|\\.(?!$|${ZPCC}))`;
const PATH_TERMINATOR = `${ZPCC}|${SEP}`;

/** Balanced `open ... close`, nested up to four levels. */
function nestedPair(open: string, close: string): string {
  const atom = `(?:(?!${ZCC}|${open}|${close}).)`;
  let pair = `${open}${atom}{0,1000}${close}`;
  for (let level = 2; level <= 4; level++) pair = `${open}(?:${atom}|${pair}){0,1000}${close}`;
  return pair;
}

const PATH =
  `(?:[/?#](?:${nestedPair("\\[", "\\]")}|${nestedPair("\\(", "\\)")}|${nestedPair("\\{", "\\}")}` +
  `|"(?:(?!${ZCC}|["]).){1,100}"|'(?:(?!${ZCC}|[']).){1,100}'|'(?=${LETTER}|[-])` +
  `|\\.{2,20}[:]?[a-zA-Z0-9%/&]|\\.(?!${ZCC}|[.]|$)|-{1,20}|,(?!${ZCC}|$)|;(?!${ZCC}|$)` +
  `|!{1,20}(?!${ZCC}|[!]|$)|\\?(?!${ZCC}|[?]|$)|[\\\\/:%@#&=_~*]|(?!${PATH_TERMINATOR}).){1,${MAX_LENGTH}}|\\/)?`;

const MAIL_CHAR = "[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9]";
const MAIL_NAME = `${MAIL_CHAR}(?:${MAIL_CHAR}|[.](?=${MAIL_CHAR})){0,63}`;
const XN = "[xX][nN]--[a-zA-Z0-9\\-]{1,59}";
const DOMAIN_ROOT = `(?:${XN}|${LETTER}{1,63})`;
const DOMAIN = `(?:${XN}|(?:${LETTER})|(?:${LETTER}(?:-|${LETTER}){0,61}${LETTER}))`;
const URL_HOST_PORT = `(?:${IPV6_URL_HOST}|(?:(?:(?:${DOMAIN})\\.){0,10}${DOMAIN}))${PORT}${HOST_TERMINATOR}`;
const MAIL_HOST = `(?:${IPV6_MAIL_HOST}|(?:(?:(?:${DOMAIN})\\.){0,4}${DOMAIN}))${HOST_TERMINATOR}`;
const FUZZY_MAIL_HOST = `(?:${IPV6_MAIL_HOST}|(?:(?:(?:${DOMAIN})[.]){1,4}${DOMAIN_ROOT}))${HOST_TERMINATOR}`;

const SCHEMAS = "[hH][tT][tT][pP]:|[hH][tT][tT][pP][sS]:|[fF][tT][pP]:|\\/\\/|[mM][aA][iI][lL][tT][oO]:";

interface Patterns {
  HTTP_TAIL: RegExp;
  RELATIVE_TAIL: RegExp;
  MAILTO_TAIL: RegExp;
  MAIL_HOST_SEARCH: RegExp;
  MAIL_NAME_BEFORE: RegExp;
  SCHEMA_SEARCH: RegExp;
  SCHEMA_AT_START: RegExp;
}
let compiled: Patterns | undefined;

/**
 * The patterns, compiled on first use: with their Unicode property classes
 * they take tens of milliseconds to build, which text without links (most
 * text) need not pay.
 */
function patterns(): Patterns {
  compiled ??= {
    HTTP_TAIL: new RegExp(`\\/\\/${URL_HOST_PORT}${PATH}`, "yu"),
    RELATIVE_TAIL: new RegExp(`(?:[lL][oO][cC][aA][lL][hH][oO][sS][tT]|${IPV6_URL_HOST}|(?:(?:${DOMAIN})[.]){1,10}${DOMAIN_ROOT})${PORT}${HOST_TERMINATOR}${PATH}`, "yu"),
    MAILTO_TAIL: new RegExp(`${MAIL_NAME}@${MAIL_HOST}`, "yu"),
    MAIL_HOST_SEARCH: new RegExp(`@${FUZZY_MAIL_HOST}`, "gu"),
    MAIL_NAME_BEFORE: new RegExp(`(?:^|${SEP}|"|\\(|${ZCC})(${MAIL_NAME})$`, "u"),
    SCHEMA_SEARCH: new RegExp(`(^|(?!_)(?:${SEP}|${ZPCC}))(${SCHEMAS})`, "gu"),
    SCHEMA_AT_START: new RegExp(`^(^|(?!_)(?:${SEP}|${ZPCC}))(${SCHEMAS})`, "u"),
  };
  return compiled;
}

/** Any schema, in plain ASCII (as SCHEMAS): text without one holds no link with a schema. */
const ANY_SCHEMA = /https?:|ftp:|mailto:|\/\//i;
const MAIL_CHAR_TEST = /[-!#$%&'*+/=?^_`{|}~a-zA-Z0-9]/;

/**
 * Whether text may hold an e-mail address, by plain character tests: an
 * address has a name character right before its "@", and after it "[" (an
 * IPv6 host) or a "." further on. Citations such as [@doe2020] and
 * "see @doe2020" have neither.
 */
function mayHoldMail(text: string): boolean {
  const lastDot = text.lastIndexOf(".");
  for (let at = text.indexOf("@", 1); at >= 0; at = text.indexOf("@", at + 1)) {
    if (MAIL_CHAR_TEST.test(text[at - 1]) && (text[at + 1] === "[" || lastDot > at)) return true;
  }
  return false;
}

function sticky(re: RegExp, text: string, pos: number): number {
  re.lastIndex = pos;
  const m = re.exec(text);
  return m ? m[0].length : 0;
}

/** Length of the link tail after the schema `schema` ending at `pos`, or 0. */
function tailAt(text: string, schema: string, pos: number): number {
  const s = text.slice(0, pos + MAX_LENGTH);
  switch (schema.toLowerCase()) {
    case "http:":
    case "https:":
    case "ftp:":
      return sticky(patterns().HTTP_TAIL, s, pos);
    case "//": {
      const len = sticky(patterns().RELATIVE_TAIL, s, pos);
      // Not after a protocol ("x://") or a third slash.
      if (len && pos >= 3 && (s[pos - 3] === ":" || s[pos - 3] === "/")) return 0;
      return len;
    }
    case "mailto:":
      return sticky(patterns().MAILTO_TAIL, s, pos);
    default:
      return 0;
  }
}

function makeMatch(text: string, schema: string, index: number, lastIndex: number): LinkMatch {
  const raw = text.slice(index, lastIndex);
  const lower = schema.toLowerCase();
  const url = lower === "mailto:" && !/^mailto:/i.test(raw) ? `mailto:${raw}` : raw;
  return { schema: lower, index, lastIndex, text: raw, url };
}

/** True when `text` holds a link or an e-mail address. */
export function hasLink(text: string): boolean {
  if (!text.length) return false;
  // Plain character tests first: the full searches are slow on long text, and slow to compile.
  if (ANY_SCHEMA.test(text)) {
    const { SCHEMA_SEARCH } = patterns();
    SCHEMA_SEARCH.lastIndex = 0;
    for (let m = SCHEMA_SEARCH.exec(text); m; m = SCHEMA_SEARCH.exec(text)) {
      if (tailAt(text, m[2], SCHEMA_SEARCH.lastIndex)) return true;
    }
  }
  if (mayHoldMail(text)) {
    const { MAIL_HOST_SEARCH, MAIL_NAME_BEFORE } = patterns();
    MAIL_HOST_SEARCH.lastIndex = 0;
    for (let m = MAIL_HOST_SEARCH.exec(text); m; m = MAIL_HOST_SEARCH.exec(text)) {
      if (MAIL_NAME_BEFORE.test(text.slice(Math.max(0, m.index - 65), m.index))) return true;
    }
  }
  return false;
}

interface Candidate {
  schema: string;
  index: number;
  lastIndex: number;
}

/** Every link and e-mail address in `text`, left to right without overlaps. */
export function findLinks(text: string): LinkMatch[] {
  const result: LinkMatch[] = [];
  if (!text.length) return result;
  const { SCHEMA_SEARCH, MAIL_HOST_SEARCH, MAIL_NAME_BEFORE } = patterns();
  SCHEMA_SEARCH.lastIndex = 0;
  MAIL_HOST_SEARCH.lastIndex = 0;
  let mail: Candidate | undefined;
  let prefix: Candidate | undefined;
  // The searches that the plain character tests rule out are done before they start.
  let mailDone = !mayHoldMail(text);
  let schemaDone = !ANY_SCHEMA.test(text);
  let pos = 0;
  for (;;) {
    const scanFrom = Math.max(pos - 1, 0);
    // The next e-mail address at or after pos.
    if (!mailDone && (!mail || mail.index < pos)) {
      if (MAIL_HOST_SEARCH.lastIndex < scanFrom) MAIL_HOST_SEARCH.lastIndex = scanFrom;
      for (;;) {
        const m = MAIL_HOST_SEARCH.exec(text);
        if (!m) {
          mailDone = true;
          mail = undefined;
          break;
        }
        const name = MAIL_NAME_BEFORE.exec(text.slice(Math.max(0, m.index - 65), m.index));
        if (!name) continue;
        mail = { schema: "mailto:", index: m.index - name[1].length, lastIndex: m.index + m[0].length };
        if (mail.index >= pos) break;
        if (MAIL_HOST_SEARCH.lastIndex < scanFrom) MAIL_HOST_SEARCH.lastIndex = scanFrom;
      }
    }
    // The next link with a schema, unless it would start after the address.
    let linked: Candidate | undefined;
    if (!schemaDone) {
      for (;;) {
        if (!prefix) {
          if (SCHEMA_SEARCH.lastIndex < scanFrom) SCHEMA_SEARCH.lastIndex = scanFrom;
          const m = SCHEMA_SEARCH.exec(text);
          if (!m) {
            schemaDone = true;
            break;
          }
          prefix = { schema: m[2], index: m.index + m[1].length, lastIndex: m.index + m[0].length };
        }
        if (prefix.index < pos) {
          prefix = undefined;
          continue;
        }
        if (mail && prefix.index > mail.index) break;
        const found = prefix;
        prefix = undefined;
        const len = tailAt(text, found.schema, found.lastIndex);
        if (len) {
          linked = { schema: found.schema, index: found.index, lastIndex: found.lastIndex + len };
          break;
        }
      }
    }
    let pick = linked;
    if (!pick || (mail && (mail.index < pick.index || (mail.index === pick.index && mail.lastIndex > pick.lastIndex)))) pick = mail;
    if (!pick) break;
    if (pick === mail) mail = undefined;
    result.push(makeMatch(text, pick.schema, pick.index, pick.lastIndex));
    pos = pick.lastIndex;
  }
  return result;
}

/** A link with a schema starting right at the beginning of `text`, or null. */
export function linkAtStart(text: string): LinkMatch | null {
  if (!text.length) return null;
  const m = patterns().SCHEMA_AT_START.exec(text);
  if (!m) return null;
  const len = tailAt(text, m[2], m[0].length);
  if (!len) return null;
  return makeMatch(text, m[2], m.index + m[1].length, m.index + m[0].length + len);
}
