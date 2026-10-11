/**
 * HTML blocks: the seven kinds of start and how each ends (CommonMark spec
 * section 4.6). Raw HTML inside text is in inlinehtml.ts.
 */

const ATTR_NAME = "[A-Za-z_:][A-Za-z0-9_.:-]*";
const UNQUOTED = "[^\"'=<>`\\x00-\\x20]+";
const ATTR_VALUE = `(?:${UNQUOTED}|'[^']*'|"[^"]*")`;
const OPEN_TAG = `<[A-Za-z][A-Za-z0-9-]*(?:\\s+${ATTR_NAME}(?:\\s*=\\s*${ATTR_VALUE})?)*\\s*\\/?>`;
const CLOSE_TAG = "<\\/[A-Za-z][A-Za-z0-9-]*\\s*>";

const OPEN_TAG_RE = new RegExp(`^${OPEN_TAG}`);
const CLOSE_TAG_RE = new RegExp(`^${CLOSE_TAG}`);

const BLOCK_TAGS = new Set(
  (
    "address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset " +
    "figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem " +
    "nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul"
  ).split(" "),
);

/**
 * The kind (1-7) of HTML block that `line` (from its first non-blank
 * character) opens, or 0. Kind 7, a lone complete tag, cannot interrupt a
 * paragraph; the caller checks that. (Unlike the spec, a lone closing
 * `</pre>` or `</script>` is kind 7 too, as it was in the old reader.)
 */
export function htmlBlockStart(line: string): number {
  if (line.charCodeAt(0) !== 60) return 0;
  if (/^<(?:script|pre|style|textarea)(?:[ \t>]|$)/i.test(line)) return 1;
  if (line.startsWith("<!--")) return 2;
  if (line.startsWith("<?")) return 3;
  if (/^<![A-Za-z]/.test(line)) return 4;
  if (line.startsWith("<![CDATA[")) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>]|\/>|$)/.exec(line);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  const tag = OPEN_TAG_RE.exec(line) ?? CLOSE_TAG_RE.exec(line);
  return tag && /^\s*$/.test(line.slice(tag[0].length)) ? 7 : 0;
}

/** True when `line` ends an HTML block of kind 1-5. Kinds 6 and 7 end at a blank line instead. */
export function htmlBlockEnds(kind: number, line: string): boolean {
  switch (kind) {
    case 1:
      return /<\/(?:script|pre|style|textarea)>/i.test(line);
    case 2:
      return line.includes("-->");
    case 3:
      return line.includes("?>");
    case 4:
      return line.includes(">");
    case 5:
      return line.includes("]]>");
    default:
      return false;
  }
}
