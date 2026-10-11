/**
 * Raw HTML inside text (CommonMark spec section 6.6): open and closing
 * tags, comments, processing instructions, declarations and CDATA.
 *
 * The forms that run until a closing marker (`-->`, `?>`, `>`, `]]>`) look
 * the marker up in a table of its occurrences, built once per text, so a
 * paragraph of many unclosed `<!--` stays linear.
 */

const ATTR_NAME = "[A-Za-z_:][A-Za-z0-9_.:-]*";
const ATTR_VALUE = "(?:[^\"'=<>`\\x00-\\x20]+|'[^']*'|\"[^\"]*\")";
const OPEN_TAG = new RegExp(`<[A-Za-z][A-Za-z0-9-]*(?:\\s+${ATTR_NAME}(?:\\s*=\\s*${ATTR_VALUE})?)*\\s*\\/?>`, "y");
const CLOSE_TAG = /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y;

/** Where the closing markers of one text are; filled as markers are first asked for. */
export class MarkerTable {
  private readonly lists = new Map<string, number[]>();
  /** Results of comment scans by every position a scan went through. */
  private readonly comments = new Map<number, number>();

  constructor(private readonly s: string) {}

  /**
   * End of a comment whose text starts at `from`: the text may hold `--`
   * but no `-->`, and cannot end with `-` (so `<!-- a --->` is not one,
   * unless a later `-->` closes it). The scan is deterministic, so every
   * position it passes is remembered with the outcome. -1 when unclosed.
   */
  commentEnd(from: number): number {
    const s = this.s;
    const path: number[] = [];
    let result = -1;
    let i = from;
    while (i < s.length) {
      const known = this.comments.get(i);
      if (known !== undefined) {
        result = known;
        break;
      }
      path.push(i);
      if (s.charCodeAt(i) !== 45) {
        i++;
        continue;
      }
      if (s.charCodeAt(i + 1) !== 45) {
        if (i + 1 >= s.length) break;
        i += 2;
        continue;
      }
      if (s.charCodeAt(i + 2) === 62) {
        result = i + 3;
        break;
      }
      if (i + 2 >= s.length) break;
      i += 3;
    }
    for (const p of path) this.comments.set(p, result);
    return result;
  }

  /** The first occurrence of `marker` at or after `from`, or -1. */
  next(marker: string, from: number): number {
    let list = this.lists.get(marker);
    if (!list) {
      list = [];
      for (let i = this.s.indexOf(marker); i >= 0; i = this.s.indexOf(marker, i + 1)) list.push(i);
      this.lists.set(marker, list);
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] < from) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length ? list[lo] : -1;
  }
}

/** Length of the raw HTML starting at `pos` (a `<`) and ending by `to`, or 0. */
export function htmlLengthAt(s: string, pos: number, to: number, markers: MarkerTable): number {
  const c = s[pos + 1];
  if (c === undefined) return 0;
  const within = (end: number, length: number): number => (end >= 0 && end + length <= to ? end + length - pos : 0);
  if (/[A-Za-z]/.test(c)) {
    OPEN_TAG.lastIndex = pos;
    const m = OPEN_TAG.exec(s);
    return m && pos + m[0].length <= to ? m[0].length : 0;
  }
  if (c === "/") {
    CLOSE_TAG.lastIndex = pos;
    const m = CLOSE_TAG.exec(s);
    return m && pos + m[0].length <= to ? m[0].length : 0;
  }
  if (c === "!") {
    if (s.startsWith("<!--", pos)) {
      if (s.startsWith("<!-->", pos)) return within(pos + 4, 1);
      if (s.startsWith("<!--->", pos)) return within(pos + 5, 1);
      const end = markers.commentEnd(pos + 4);
      return end >= 0 && end <= to ? end - pos : 0;
    }
    if (s.startsWith("<![CDATA[", pos)) return within(markers.next("]]>", pos + 9), 3);
    if (/[A-Za-z]/.test(s[pos + 2] ?? "")) return within(markers.next(">", pos + 2), 1);
    return 0;
  }
  if (c === "?") return within(markers.next("?>", pos + 2), 2);
  return 0;
}
