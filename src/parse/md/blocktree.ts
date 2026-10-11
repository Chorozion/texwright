/**
 * The intermediate block tree that the block phase builds and the assembly
 * phase turns into texwright blocks. Leaves keep their raw text as segments
 * (one per source line) so the inline phase can map every offset back to a
 * line and column.
 */
import type { Seg } from "./lines.js";
import type { AttrSpec } from "./scan.js";

export type BlockKind =
  // containers
  | "doc"
  | "quote"
  | "list"
  | "item"
  | "div"
  | "note"
  | "deflist"
  | "defitem"
  // leaves
  | "para"
  | "heading"
  | "fence"
  | "code"
  | "html"
  | "hr"
  | "math"
  | "rawtex"
  | "mark"
  | "table"
  | "caption"
  /** Where a paragraph of only link reference definitions was: no output, but it separates blocks. */
  | "linkdefs";

export type Mark = "PageBreak" | "TOC" | "Bibliography";

/**
 * How far a block may run past where it opens (see BlockParser.rangeLimit):
 * over the lines its containers hold up to a blank line (display math), over
 * all the lines they hold (environments), or also over lines that continue
 * them lazily (the extent of a container).
 */
export type RangeMode = "math" | "held" | "lazy";

/** One block of the tree. The fields after the first few belong to some kinds only. */
export class BNode {
  readonly children: BNode[] = [];
  parent: BNode | null = null;
  open = true;
  /** Content lines of a leaf. */
  segs: Seg[] = [];
  /** The last line added to this block was blank (for list tightness). */
  lastLineBlank = false;
  /** Containers: nesting depth of their content (see MAX_DEPTH in blocks.ts). */
  depth = 0;
  /** Containers: the last line whose markers matched this block, and the cursor column after them. */
  matchLine = -1;
  matchCol = 0;
  /** Containers: the extent of lines they hold, by kind, as last computed from line `from` (see BlockParser.rangeLimit). */
  ranges?: Partial<Record<RangeMode, { from: number; last: number }>>;

  /** Headings. */
  level = 0;
  /** Fenced code: the info string, the fence and its indentation. */
  info = "";
  fenceChar = "";
  fenceLength = 0;
  fenceIndent = 0;
  /** HTML blocks: which of the seven kinds (spec 4.6). */
  htmlType = 0;
  /** Lists. */
  ordered = false;
  bullet = "";
  start = 1;
  tight = true;
  /** A list with a blank line right before one of its items (so it is loose). */
  gapLoose = false;
  /** List items and definitions: columns from the containers' content to the marker, and from the marker to the content. */
  markerOffset = 0;
  padding = 0;
  /** List items and definitions that started with nothing after the marker. */
  emptyStart = false;
  /** Divs, display math and raw LaTeX: the line that closes the block (-1 when it is never closed). */
  endLine = -1;
  /** Divs and display math: the attribute list. */
  attr: AttrSpec | null = null;
  /**
   * Display math: the line of the closing delimiter (an attribute list after
   * it may run on to endLine), and the character index in it where the
   * delimiter starts.
   */
  closeLine = -1;
  closeAt = 0;
  /** Math environments: the name, and the `\begin{name}` their first line starts with. */
  env: string | undefined;
  envHead = "";
  /** Special lines. */
  mark: Mark = "PageBreak";
  /** Footnote definitions. */
  label = "";
  /** Tables: the alignments, the body rows, and the line of the delimiter row (which the table takes without a row). */
  aligns: ("left" | "center" | "right" | null)[] = [];
  rows: Seg[] = [];
  delimiter = -1;
  /** Definitions: the term paragraph's segments, and whether a blank line separates them from it. */
  term: Seg[] = [];
  looseTerm = false;
  /** Paragraphs: the last line of the link reference definition the paragraph starts with, or -1. */
  defsEnd = -1;
  /** Paragraphs: a definition list term, whatever it looks like; it holds no link reference definitions. */
  literal = false;

  constructor(
    readonly kind: BlockKind,
    /** 0-based start line. */
    public line: number,
  ) {}

  get last(): BNode | undefined {
    return this.children[this.children.length - 1];
  }

  add(child: BNode): BNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  isContainer(): boolean {
    switch (this.kind) {
      case "doc":
      case "quote":
      case "list":
      case "item":
      case "div":
      case "note":
      case "deflist":
      case "defitem":
        return true;
      default:
        return false;
    }
  }
}

/** A link reference definition (spec section 4.7). */
export interface LinkDef {
  url: string;
  title?: string;
}
