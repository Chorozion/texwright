/**
 * The parsed math list. It follows TeX's noads closely: atoms of the eight
 * classes with nucleus and scripts, generalized fractions, radicals,
 * accents, \left...\right groups, style changes and glue, plus nodes for the
 * LaTeX constructs that TeX builds from boxes (arrays, extensible arrows,
 * braces, phantoms). Both the box builder and the MathML writer read it.
 */

import type { Color } from "../layout/types.js";
import type { AccentDef, ArrowDef, Cls, SymDef } from "./symbols.js";

/** Math alphabets: \mathrm \mathit \mathbf \mathsf \mathtt \mathcal \mathbb \mathfrak \mathscr \boldsymbol. */
export type MathFont = "rm" | "it" | "bf" | "sf" | "tt" | "cal" | "bb" | "frak" | "scr" | "bsym";

export type StyleName = "display" | "text" | "script" | "scriptscript";

/** A length. Absolute units are converted to pt when parsed; em, ex and mu depend on the style. */
export interface Dim {
  v: number;
  u: "pt" | "em" | "ex" | "mu";
}

export interface TextFont {
  family: "rm" | "sf" | "tt";
  bold: boolean;
  italic: boolean;
}

export type TextItem =
  | { k: "chars"; s: string; font: TextFont; color?: Color }
  | { k: "space"; dim?: Dim; color?: Color } // dim undefined: an interword space
  | { k: "math"; body: MathList; color?: Color }
  | { k: "accent"; cp: number; mark: string; below: boolean; base: string; font: TextFont; color?: Color };

interface Base {
  /** Offset of the construct in the formula source. */
  pos: number;
  color?: Color;
}

export interface SymNode extends Base {
  type: "sym";
  sym: SymDef;
  cls: Cls;
  font?: MathFont;
}

export interface GroupNode extends Base {
  type: "group";
  body: MathList;
  /** \mathbin{...} and friends; a plain {...} is an Ord. */
  cls?: Cls;
}

export interface SupSubNode extends Base {
  type: "supsub";
  base: MathNode | null;
  sup: MathList | null;
  sub: MathList | null;
}

export interface OpNode extends Base {
  type: "op";
  limits: "display" | "limits" | "nolimits";
  /** A large operator character. */
  sym?: SymDef;
  font?: MathFont;
  /** A named operator (\sin, \operatorname{...}) set in roman. */
  name?: string;
  /** \mathop{...} contents. */
  body?: MathList;
}

export interface FracNode extends Base {
  type: "frac";
  num: MathList;
  den: MathList;
  /** Bar thickness; null for the default rule thickness, 0 for \atop-style fractions. */
  thickness: Dim | null;
  left: SymDef | null;
  right: SymDef | null;
  /** \dfrac / \tfrac / \genfrac style; undefined keeps the surrounding style. */
  style?: StyleName;
  /** \cfrac numerator alignment. */
  cfrac?: "l" | "c" | "r";
  /** The command that made it, for MathML (\binom gets linethickness 0). */
  cmd: string;
}

export interface SqrtNode extends Base {
  type: "sqrt";
  body: MathList;
  index: MathList | null;
}

export interface AccentNode extends Base {
  type: "accent";
  accent: AccentDef;
  name: string;
  body: MathList;
}

export interface LineNode extends Base {
  type: "overline" | "underline";
  body: MathList;
}

/** \overbrace / \underbrace: an operator with limits whose nucleus is the braced box. */
export interface BraceNode extends Base {
  type: "brace";
  over: boolean;
  body: MathList;
}

/** \overrightarrow and friends. */
export interface ArrowAccentNode extends Base {
  type: "arrowacc";
  arrow: ArrowDef;
  over: boolean;
  body: MathList;
}

export interface LeftRightNode extends Base {
  type: "leftright";
  left: SymDef | null;
  right: SymDef | null;
  body: MathList;
}

export interface MiddleNode extends Base {
  type: "middle";
  delim: SymDef | null;
}

/** \big( and friends. */
export interface BigNode extends Base {
  type: "big";
  delim: SymDef | null;
  size: 1 | 2 | 3 | 4;
  cls: Cls;
}

export interface TextNode extends Base {
  type: "text";
  body: TextItem[];
  /** \mbox and \hbox keep the body size; \text scales with the style. */
  fixedSize?: boolean;
}

export interface SpaceNode extends Base {
  type: "space";
  dim: Dim;
  stretch?: Dim;
  shrink?: Dim;
  /** A kern (\kern, \mkern) rather than glue. */
  kern: boolean;
  /** Infinite stretch order of the stretch component (\hfill: 2). */
  fil?: 1 | 2 | 3;
}

export interface StyleNode extends Base {
  type: "style";
  style: StyleName;
}

export interface PhantomNode extends Base {
  type: "phantom";
  body: MathList;
  /** Keep the width (\phantom, \hphantom). */
  h: boolean;
  /** Keep the height and depth (\phantom, \vphantom). */
  v: boolean;
}

export interface SmashNode extends Base {
  type: "smash";
  body: MathList;
  top: boolean;
  bottom: boolean;
}

export interface LapNode extends Base {
  type: "lap";
  body: MathList;
  align: "l" | "r" | "c";
}

/** cancel's \cancel, \bcancel and \xcancel: the body struck through diagonally. */
export interface CancelNode extends Base {
  type: "cancel";
  body: MathList;
  /** "/" up to the right, "\\" down to the right, "x" both. */
  strike: "/" | "\\" | "x";
}

export interface BoxedNode extends Base {
  type: "boxed";
  body: MathList;
  /** \colorbox background. */
  fill?: Color;
  /** No frame (\colorbox). */
  frameless?: boolean;
}

export interface ColSpec {
  align: "l" | "c" | "r";
  /** Vertical rules before this column. */
  lines: number;
  /** @{...} material replacing the inter-column space before / after this column. */
  pre?: MathList;
  post?: MathList;
}

export interface TagSpec {
  body: TextItem[];
  star: boolean;
}

export interface ArrayRow {
  cells: MathList[];
  /** Extra space after the row (\\[2pt]). */
  gap?: Dim;
  /** Horizontal rules above the row. */
  hlines: number;
  /** Source offset of the row start (for diagnostics and tags). */
  pos: number;
  tag?: TagSpec;
  notag?: boolean;
  /** \intertext before this row. */
  intertext?: TextItem[];
}

export type ArrayKind = "matrix" | "array" | "cases" | "aligned" | "gathered" | "smallmatrix" | "subarray" | "eqnarray" | "multline";

export interface ArrayNode extends Base {
  type: "array";
  env: string;
  kind: ArrayKind;
  rows: ArrayRow[];
  /** Column specs (array, subarray); other kinds derive their columns. */
  cols?: ColSpec[];
  /** Vertical rules after the last column (array). */
  trailingLines?: number;
  /** Horizontal rules below the last row. */
  hlinesBelow: number;
  style: StyleName;
  /** Number of column pairs for alignat. */
  pairs?: number;
  /** Vertical placement: centred on the axis, or aligned at the first / last row. */
  vpos: "c" | "t" | "b";
  /** Top-level display environment (align, gather, ...) rather than an inner one. */
  display?: boolean;
  /** cases-style: rcases puts the brace on the right; dcases sets cells in display style. */
  arrayStretch: number;
  /** Gap around columns for matrices (\arraycolsep each side) and whether the outer edges keep it. */
  outerSep: boolean;
}

export interface NotNode extends Base {
  type: "not";
  body: MathNode | null;
}

export interface XArrowNode extends Base {
  type: "xarrow";
  arrow: ArrowDef;
  name: string;
  above: MathList | null;
  below: MathList | null;
}

export interface StackNode extends Base {
  type: "stack";
  base: MathList;
  over: MathList | null;
  under: MathList | null;
  cls: Cls;
}

export interface RuleNode extends Base {
  type: "rule";
  width: Dim;
  height: Dim;
  raise: Dim | null;
}

export interface RaiseNode extends Base {
  type: "raise";
  dim: Dim;
  body: MathList;
}

export interface PenaltyNode extends Base {
  type: "penalty";
  value: number;
}

export type MathNode =
  | SymNode
  | GroupNode
  | SupSubNode
  | OpNode
  | FracNode
  | SqrtNode
  | AccentNode
  | LineNode
  | BraceNode
  | ArrowAccentNode
  | LeftRightNode
  | MiddleNode
  | BigNode
  | TextNode
  | SpaceNode
  | StyleNode
  | PhantomNode
  | SmashNode
  | LapNode
  | BoxedNode
  | CancelNode
  | ArrayNode
  | NotNode
  | XArrowNode
  | StackNode
  | RuleNode
  | RaiseNode
  | PenaltyNode;

export type MathList = MathNode[];

/** What the parser returns for a whole formula. */
export interface Formula {
  body: MathList;
  /** \tag on a formula that is not a row environment. */
  tag?: TagSpec;
  notag?: boolean;
  /** Top-level rows split by \\ in display math outside any environment. */
  rows?: { body: MathList; tag?: TagSpec; notag?: boolean; pos: number }[];
}
