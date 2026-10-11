/**
 * One source line seen through the eyes of the block parser: a cursor that
 * moves over the container markers at the start of the line ("> ", list
 * indentation) and knows the column it is at.
 *
 * CommonMark measures indentation in columns with tab stops of four
 * (spec section 2.2, "Tabs"). A tab can be consumed partly, for example by
 * the optional space after a block quote marker; the columns left over then
 * count as spaces in front of the content. The cursor keeps both the
 * character index and the column so it can report either.
 */

/** A run of block content: text from one line, with where it starts in the source. */
export interface Seg {
  text: string;
  /** 0-based line index within the text being parsed. */
  line: number;
  /** 0-based character offset of `text` within that line (virtual spaces from a split tab included). */
  col: number;
}

export const isBlankText = (s: string): boolean => /^[ \t]*$/.test(s);

/**
 * `s` without the spaces and tabs at its end. (A regular expression such as
 * /[ \t]+$/ takes quadratic time on a long run of blanks that is not at
 * the end, so the reader trims with loops.)
 */
export function trimEndBlank(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  return end === s.length ? s : s.slice(0, end);
}

export class LineCursor {
  /** Character index of the next unread character. */
  i = 0;
  /** Column of position `i`, plus any part of a tab already consumed. */
  col = 0;
  /** Columns of the tab at `i` that were consumed already (0 when not inside a tab). */
  private taken = 0;
  /** The tab at `i` was split by the blank after a block quote marker (see rawSeg). */
  private quoteTab = false;
  /** Blank space skipped that still counts as indentation (see skipBlankKeepingIndent). */
  private kept = 0;
  /**
   * Where the run of blank space at the cursor ends, and the column there,
   * as last measured. Moving through the run keeps both right, so deeply
   * nested containers, which each read the indentation of the same run, do
   * not measure it again each time.
   */
  private run: { end: number; col: number } | null = null;

  constructor(
    readonly text: string,
    readonly line: number,
  ) {}

  /** Width in columns of the tab at index `i` when it starts at column `col`. */
  private static tabWidth(col: number): number {
    return 4 - (col % 4);
  }

  /** The end of the run of blank space from the cursor on, and its column (see `run`). */
  private measure(): { end: number; col: number } {
    if (this.run && this.i <= this.run.end) return this.run;
    let col = this.col;
    let i = this.i;
    if (this.taken) {
      col += LineCursor.tabWidth(col - this.taken) - this.taken;
      i++;
    }
    for (; i < this.text.length; i++) {
      const c = this.text.charCodeAt(i);
      if (c === 32) col++;
      else if (c === 9) col += LineCursor.tabWidth(col);
      else break;
    }
    return (this.run = { end: i, col });
  }

  /** Columns of blank space from the cursor on, without moving. */
  indent(): number {
    return this.kept + this.measure().col - this.col;
  }

  /** Index of the first character that is not a space or tab, from the cursor. */
  firstNonBlank(): number {
    return this.measure().end;
  }

  /** True when nothing but spaces and tabs is left. */
  blank(): boolean {
    return this.firstNonBlank() >= this.text.length;
  }

  /** Character at the first non-blank position. */
  peek(): string {
    return this.text[this.firstNonBlank()] ?? "";
  }

  /** Consume up to `n` columns of blank space (fewer when the blank space ends first). */
  advanceCols(n: number): void {
    if (n <= 0) return;
    this.quoteTab = false;
    this.kept = 0;
    while (n > 0 && this.i < this.text.length) {
      const c = this.text.charCodeAt(this.i);
      if (c === 32) {
        this.i++;
        this.col++;
        n--;
      } else if (c === 9) {
        const start = this.col - this.taken;
        const w = LineCursor.tabWidth(start);
        const left = w - this.taken;
        if (n >= left) {
          this.i++;
          this.col += left;
          this.taken = 0;
          n -= left;
        } else {
          this.taken += n;
          this.col += n;
          n = 0;
        }
      } else break;
    }
  }

  /** Consume all blank space. */
  skipBlank(): void {
    this.advanceCols(Number.MAX_SAFE_INTEGER);
  }

  /**
   * Consume all blank space, but go on counting it as indentation: the text
   * starts at the first character that is not blank, while a list marker
   * there keeps its offset. Tab stops from there on are counted as if the
   * text started at `column` (a footnote's first line, as the old reader
   * read it).
   */
  skipBlankKeepingIndent(column: number): void {
    const cols = this.indent();
    this.skipBlank();
    this.kept = cols;
    this.col = column;
    this.run = null;
  }

  /** Consume `n` characters that are not tabs (markers such as `>` or `- `). */
  advanceChars(n: number): void {
    this.quoteTab = false;
    this.kept = 0;
    for (let k = 0; k < n && this.i < this.text.length; k++) {
      if (this.text.charCodeAt(this.i) === 9) {
        this.advanceCols(LineCursor.tabWidth(this.col - this.taken) - this.taken);
      } else {
        this.i++;
        this.col++;
      }
    }
  }

  /** The rest of the line; the unconsumed part of a split tab becomes spaces. */
  rest(): string {
    if (!this.taken) return this.text.slice(this.i);
    const left = LineCursor.tabWidth(this.col - this.taken) - this.taken;
    return " ".repeat(left) + this.text.slice(this.i + 1);
  }

  /** The rest of the line as a content segment. */
  seg(): Seg {
    if (!this.taken) return { text: this.text.slice(this.i), line: this.line, col: this.i };
    const left = LineCursor.tabWidth(this.col - this.taken) - this.taken;
    return { text: " ".repeat(left) + this.text.slice(this.i + 1), line: this.line, col: this.i + 1 - left };
  }

  /** The optional blank after a block quote marker: one column, of a space or a tab. */
  quoteSpace(): void {
    const c = this.text.charCodeAt(this.i);
    if (c !== 32 && c !== 9) return;
    this.advanceCols(1);
    this.quoteTab = this.taken > 0;
  }

  /**
   * The rest of the line for HTML blocks, display math and raw LaTeX, as
   * the old reader cut it: a tab split by a block quote marker's blank
   * stays a tab; one split by indentation is spaces, as in seg().
   */
  rawSeg(): Seg {
    return this.quoteTab ? { text: this.text.slice(this.i), line: this.line, col: this.i } : this.seg();
  }

  /** The rest of the line after skipping blank space, as a segment. */
  segAfterBlank(): Seg {
    const at = this.firstNonBlank();
    return { text: this.text.slice(at), line: this.line, col: at };
  }

  /** A copy, for looking ahead without moving this cursor. */
  clone(): LineCursor {
    const c = new LineCursor(this.text, this.line);
    c.i = this.i;
    c.col = this.col;
    c.taken = this.taken;
    c.quoteTab = this.quoteTab;
    c.kept = this.kept;
    c.run = this.run;
    return c;
  }

  /** Move this cursor to where `other` (a clone of it) is. */
  sync(other: LineCursor): void {
    this.i = other.i;
    this.col = other.col;
    this.taken = other.taken;
    this.quoteTab = other.quoteTab;
    this.kept = other.kept;
    this.run = other.run;
  }
}
