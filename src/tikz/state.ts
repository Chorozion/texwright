/** The graphic state of a TikZ scope, path or node, and how it is copied. */

import type { ArrowSpec, Tip } from "./arrows.js";
import type { CircuitSettings } from "./circuit.js";
import { ID, type Mat, type Pt } from "./geom.js";
import type { Shade } from "./scene.js";
import type { TextStyle } from "./text.js";
import { UNITS } from "./expr.js";

export const CM = UNITS.cm;

export interface StyleDef {
  body: string;
  default?: string;
}

export interface Place {
  /** above, below left, ... */
  dir: string;
  /** Vertical and horizontal distance, pt; undefined = node distance. */
  dy?: number;
  dx?: number;
  /** The node (and anchor) it is placed relative to: right=of a. */
  of?: string;
  /** right of=a: centre to centre. */
  old?: boolean;
}

export interface LabelSpec {
  pin: boolean;
  opts: string;
  angle: string;
  text: string;
}

export interface AxisMap {
  /** Data to the picture's (untransformed) points. */
  map(x: number, y: number): Pt;
  /** Fractions of the axis box (rel axis cs). */
  rel(x: number, y: number): Pt;
  /** Symbolic x coordinates, by name. */
  xsym?: Map<string, number>;
  ysym?: Map<string, number>;
}

export interface Decoration {
  kind: string;
  amplitude: number;
  segmentLength: number;
  mirror: boolean;
  raise: number;
  /** Marks along the path: position (fraction or pt from start) and the arrow tip spec. */
  marks: { at: number; abs: boolean; tip: string; reversed: boolean }[];
}

export interface GS {
  T: Mat;
  xv: Pt;
  yv: Pt;
  zv: Pt;
  color: string;
  drawColor: string | null | undefined;
  fillColor: string | null | undefined;
  textColor?: string;
  lw: number;
  dash?: string;
  dashPattern?: number[];
  dashOffset: number;
  arrows?: ArrowSpec;
  defTip: Tip;
  opacity?: number;
  drawOpacity?: number;
  fillOpacity?: number;
  textOpacity?: number;
  rounded: number;
  cap: "butt" | "round" | "square";
  join: "miter" | "round" | "bevel";
  doDraw: boolean;
  doFill: boolean;
  shade?: Shade;
  evenOdd: boolean;
  double?: string;
  doubleDist: number;
  // nodes
  shape: string;
  anchor?: string;
  ix: number;
  iy: number;
  outer?: number;
  minW: number;
  minH: number;
  textWidth?: number;
  align?: "left" | "center" | "right";
  font: TextStyle;
  nscale: number;
  nrot: number;
  nshift: Pt;
  place?: Place;
  labels: LabelSpec[];
  nodeDist: [number, number];
  labelDist: number;
  pinDist: number;
  pos?: number;
  auto?: "left" | "right";
  swap: boolean;
  sloped: boolean;
  initial?: string;
  initialText: string;
  accepting: boolean;
  fit?: string;
  sides: number;
  aspect: number;
  points: number;
  alias?: string;
  // to paths
  out?: number;
  in?: number;
  bend?: number;
  looseness: number;
  minDist?: number;
  loop: boolean;
  shortenS: number;
  shortenE: number;
  // plots
  domain: [number, number];
  samples: number;
  samplesAt?: number[];
  variable: string;
  smooth: boolean;
  smoothCycle: boolean;
  tension: number;
  mark?: string;
  markSize: number;
  markOpts: string[];
  onlyMarks: boolean;
  plotKind?: "ycomb" | "xcomb" | "const" | "jump";
  // grids, circles, arcs
  step: [number, number];
  radius?: [number, boolean];
  xradius?: [number, boolean];
  yradius?: [number, boolean];
  startAngle?: number;
  endAngle?: number;
  deltaAngle?: number;
  styles: Map<string, StyleDef>;
  nodesOpts: string[];
  clips: string[];
  layer: number;
  axis?: AxisMap;
  /** circuitikz settings (src/tikz/circuit.ts); replaced, never changed in place. */
  circuit?: CircuitSettings;
  decorate: boolean;
  decoration?: Decoration;
  postDecorate: boolean;
  transformShape: boolean;
  useAsBox: boolean;
  doClip: boolean;
  /** Keys of trees, mind maps and graphs (level distance, grow, concept color, ...), read by trees.ts and graphs.ts. Replaced, never changed in place. */
  tkeys?: Readonly<Record<string, string>>;
}

export const BUILTIN_STYLES: [string, string][] = [
  ["help lines", "color=gray, very thin"],
  ["state", "shape=circle, draw, minimum size=2.5em, every state"],
  ["every state", ""],
  ["every node", ""],
  ["every path", ""],
  ["every edge", ""],
  ["every label", ""],
  ["every pin", ""],
  ["every pin edge", ""],
  ["every loop", ""],
  ["every matrix", ""],
  ["every scope", ""],
  ["every picture", ""],
  ["every to", ""],
  ["every initial by arrow", ""],
  ["every circle node", ""],
  ["every rectangle node", ""],
  ["every axis", ""],
  ["every axis plot", ""],
  ["every axis plot post", ""],
  ["every axis label", ""],
  ["every axis legend", ""],
  ["every tick label", ""],
  ["every node near coord", ""],
  ["small dot", "circle, fill, inner sep=0.8pt"],
  ["dot", "circle, fill, inner sep=1.2pt"],
];

export function initialState(fontSize = 10): GS {
  return {
    T: ID,
    xv: [CM, 0],
    yv: [0, CM],
    zv: [-0.385 * CM, -0.385 * CM],
    color: "#000000",
    drawColor: undefined,
    fillColor: undefined,
    lw: 0.4,
    dashOffset: 0,
    defTip: { kind: "to" },
    rounded: 0,
    cap: "butt",
    join: "miter",
    doDraw: false,
    doFill: false,
    evenOdd: false,
    doubleDist: 0.6,
    shape: "rectangle",
    ix: 3.333,
    iy: 3.333,
    minW: 1,
    minH: 1,
    font: { size: fontSize, bold: false, italic: false, family: "serif", align: "center" },
    nscale: 1,
    nrot: 0,
    nshift: [0, 0],
    labels: [],
    nodeDist: [CM, CM],
    labelDist: 0,
    pinDist: 3 * 4.305,
    swap: false,
    sloped: false,
    initialText: "start",
    accepting: false,
    sides: 5,
    aspect: 1,
    points: 5,
    looseness: 1,
    loop: false,
    shortenS: 0,
    shortenE: 0,
    domain: [-5, 5],
    samples: 25,
    variable: "x",
    smooth: false,
    smoothCycle: false,
    tension: 0.55,
    markSize: 2,
    markOpts: [],
    onlyMarks: false,
    step: [CM, CM],
    styles: new Map(BUILTIN_STYLES.map(([k, v]) => [k, { body: v }])),
    nodesOpts: [],
    clips: [],
    layer: 0,
    decorate: false,
    postDecorate: false,
    transformShape: false,
    useAsBox: false,
    doClip: false,
  };
}

/** A copy for a nested scope or path: values are shared until changed (changes replace them). */
export function cloneGS(g: GS): GS {
  return { ...g, font: { ...g.font }, labels: [...g.labels], nodesOpts: [...g.nodesOpts], markOpts: [...g.markOpts], nshift: [...g.nshift] as Pt };
}

/** The state a node starts from inside a path: colours and line style carry over, actions and tips do not. */
export function nodeGS(g: GS): GS {
  const n = cloneGS(g);
  n.doDraw = false;
  n.doFill = false;
  n.shade = undefined;
  n.arrows = undefined;
  n.decorate = false;
  n.decoration = undefined;
  n.postDecorate = false;
  n.labels = [];
  n.nscale = 1;
  n.nrot = 0;
  n.nshift = [0, 0];
  n.double = undefined;
  n.doClip = false;
  n.useAsBox = false;
  n.shortenS = 0;
  n.shortenE = 0;
  n.mark = undefined;
  n.fit = undefined;
  n.alias = undefined;
  n.initial = undefined;
  n.accepting = false;
  return n;
}
