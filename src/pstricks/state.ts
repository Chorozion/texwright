/**
 * The graphics parameters of PSTricks (what \psset sets) with their
 * defaults, how values are read (a bare number as a length is in units of
 * the current `unit`, as \pssetlength does), and the arrow specs (`->`,
 * `|<->|`, `*-o`) mapped onto the TikZ interpreter's tips.
 */

import type { ArrowSpec, Tip } from "../tikz/arrows.js";
import { type RGB, parseColor } from "../tikz/color.js";
import { evaluate } from "../tikz/expr.js";
import { ID, type Mat, mul } from "../tikz/geom.js";
import { parseOptions } from "../tikz/scan.js";

export const CM = 72.27 / 2.54;

export interface PState {
  /** Current transformation (pt to pt), applied after the units. */
  T: Mat;
  xunit: number;
  yunit: number;
  runit: number;
  lw: number;
  lc: string;
  fillstyle: string;
  fc: string;
  arrows: string;
  linestyle: string;
  dash: [number, number];
  dotsep: number;
  dotstyle: string;
  /** dotsize = dim + factor * linewidth. */
  dotsize: [number, number];
  dotscale: [number, number];
  dotangle: number;
  arrowsize: [number, number];
  arrowlength: number;
  arrowinset: number;
  arrowscale: number;
  tbarsize: [number, number];
  framearc: number;
  linearc: number;
  framesep: number;
  labelsep: number;
  hatchwidth: number;
  hatchsep: number;
  hatchangle: number;
  hatchcolor: string;
  gradbegin: string;
  gradend: string;
  gradangle: number;
  gradmidpoint: number;
  shadow: boolean;
  shadowsize: number;
  shadowangle: number;
  shadowcolor: string;
  doubleline: boolean;
  doublesep?: number;
  doublecolor: string;
  border: number;
  bordercolor: string;
  opacity?: number;
  strokeopacity?: number;
  fillopacity?: number;
  plotpoints: number;
  plotstyle: string;
  algebraic: boolean;
  showpoints: boolean;
  liftpen: number;
  /** Text colour (from \color and friends inside the picture). */
  textColor: string;
  fontSize: number;
  /** Clip regions in force. */
  clips: string[];
  /** origin={x,y}: where (0,0) of later objects lies, in pt (already part of T). */
  origin: [number, number];
  /** Everything else, raw, for the commands that read it (psaxes, nodes, trees, pst-eucl, pst-3dplot). */
  kv: Map<string, string>;
}

export function initialState(fontSize = 10): PState {
  return {
    T: ID,
    xunit: CM,
    yunit: CM,
    runit: CM,
    lw: 0.8,
    lc: "#000000",
    fillstyle: "none",
    fc: "#ffffff",
    arrows: "-",
    linestyle: "solid",
    dash: [5, 3],
    dotsep: 3,
    dotstyle: "*",
    dotsize: [2, 2],
    dotscale: [1, 1],
    dotangle: 0,
    arrowsize: [2, 3],
    arrowlength: 1.4,
    arrowinset: 0.4,
    arrowscale: 1,
    tbarsize: [2, 5],
    framearc: 0,
    linearc: 0,
    framesep: 3,
    labelsep: 5,
    hatchwidth: 0.8,
    hatchsep: 4,
    hatchangle: 45,
    hatchcolor: "#000000",
    gradbegin: "#001af2",
    gradend: "#00ffff",
    gradangle: 0,
    gradmidpoint: 0.9,
    shadow: false,
    shadowsize: 3,
    shadowangle: -45,
    shadowcolor: "#404040",
    doubleline: false,
    doublecolor: "#ffffff",
    border: 0,
    bordercolor: "#ffffff",
    plotpoints: 50,
    plotstyle: "line",
    algebraic: false,
    showpoints: false,
    liftpen: 0,
    textColor: "#000000",
    fontSize,
    clips: [],
    origin: [0, 0],
    kv: new Map(),
  };
}

export function cloneState(s: PState): PState {
  return { ...s, clips: [...s.clips], origin: [...s.origin], kv: new Map(s.kv) };
}

/** Lengths a value may name. */
function lengthMacros(s: string, st: PState): string {
  // 2\pslinewidth is twice the line width.
  return s
    .replace(/(\d|\.)\s*(?=\\ps(?:linewidth|unit|xunit|yunit|runit)(?![A-Za-z]))/g, "$1*")
    .replace(/\\pslinewidth(?![A-Za-z])/g, `${st.lw}pt`)
    .replace(/\\psunit(?![A-Za-z])/g, `${st.xunit}pt`)
    .replace(/\\psxunit(?![A-Za-z])/g, `${st.xunit}pt`)
    .replace(/\\psyunit(?![A-Za-z])/g, `${st.yunit}pt`)
    .replace(/\\psrunit(?![A-Za-z])/g, `${st.runit}pt`)
    .replace(/\\(?:textwidth|linewidth|columnwidth|hsize)(?![A-Za-z])/g, "345pt")
    .replace(/\\(?:textheight|vsize)(?![A-Za-z])/g, "550pt")
    .replace(/\\(?:p@|z@)(?![A-Za-z])/g, "1pt");
}

/** A length in pt: a bare number is in units of `unit` pt. Undefined when it is not one. */
export function dimen(src: string | undefined, unit: number, st: PState): number | undefined {
  if (src === undefined) return undefined;
  const t = lengthMacros(src.trim(), st);
  if (!t) return undefined;
  try {
    const r = evaluate(t);
    return r.dim ? r.v : r.v * unit;
  } catch {
    return undefined;
  }
}

/** A plain number. */
export function numVal(src: string | undefined): number | undefined {
  if (src === undefined) return undefined;
  const t = src.trim();
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
  try {
    const r = evaluate(t);
    return r.v;
  } catch {
    return undefined;
  }
}

/** `2pt 3` (a length plus a multiple of the line width). */
function dimNum(src: string, st: PState): [number, number] | undefined {
  const parts = src.trim().split(/\s+/);
  const d = dimen(parts[0], st.xunit, st);
  if (d === undefined) return undefined;
  const k = parts[1] !== undefined ? numVal(parts[1]) : 0;
  return [d, k ?? 0];
}

/** Where the colour reader looks: colours defined in the picture, then the document's. */
export interface ColorEnv {
  local: Map<string, RGB>;
  lookup?: (name: string) => string | undefined;
}

export function color(expr: string, env: ColorEnv, current = "#000000"): string | undefined {
  let s = expr.trim();
  // PSTricks also accepts {[rgb]{1 0 0}}-like specs rarely; and gray levels as `0.5` mean nothing here.
  const m = /^\[(rgb|gray|cmyk|RGB|HTML)\]\s*\{([^}]*)\}$/.exec(s);
  if (m) {
    const v = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (m[1] === "rgb" && v.length === 3) return toHex(v.map((x) => x * 255) as RGB);
    if (m[1] === "RGB" && v.length === 3) return toHex(v as RGB);
    if (m[1] === "gray" && v.length === 1) return toHex([v[0] * 255, v[0] * 255, v[0] * 255]);
    if (m[1] === "HTML") return `#${m[2].trim().toLowerCase()}`;
    if (m[1] === "cmyk" && v.length === 4) return toHex([v[0], v[1], v[2]].map((x) => 255 * (1 - Math.min(1, x + v[3]))) as RGB);
    return undefined;
  }
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1).trim();
  return parseColor(s, env.local, env.lookup, current);
}

function toHex(c: RGB): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

const truthy = (v: string | undefined) => v === undefined || /^(true|1|)$/.test(v.trim());

/** Keys \psset understands that are kept raw for the commands reading them. Others are reported. */
const RAW_KEYS = new Set([
  // psaxes
  "Ox", "Oy", "Dx", "Dy", "dx", "dy", "labels", "ticks", "tickstyle", "ticksize", "xticksize", "yticksize", "axesstyle", "labelFontSize", "showorigin", "subticks", "xsubticks", "ysubticks", "subticksize", "comma", "xlabelFactor", "ylabelFactor", "ticklinestyle", "tickcolor", "xAxis", "yAxis", "xAxisLabel", "yAxisLabel", "xAxisLabelPos", "yAxisLabelPos", "llx", "lly", "urx", "ury", "logLines", "xLabels", "yLabels", "trigLabels", "trigLabelBase", "mathLabel", "decimalSeparator", "Ox", "xDecimals", "yDecimals", "tickwidth", "subtickwidth", "subtickcolor", "labelsep",
  // grids
  "gridwidth", "gridcolor", "griddots", "gridlabels", "gridlabelcolor", "subgriddiv", "subgridwidth", "subgridcolor", "subgriddots", "showgrid",
  // nodes
  "nodesep", "nodesepA", "nodesepB", "offset", "offsetA", "offsetB", "arm", "armA", "armB", "angle", "angleA", "angleB", "arcangle", "arcangleA", "arcangleB", "ncurv", "ncurvA", "ncurvB", "loopsize", "npos", "nrot", "tpos", "radius", "boxsize", "href", "vref", "framesize", "name", "Xnodesep", "Ynodesep", "XnodesepA", "XnodesepB", "YnodesepA", "YnodesepB", "rot", "shortput", "ref", "nodealign", "nodesepAB",
  // trees
  "treemode", "levelsep", "treesep", "treefit", "treeflip", "treenodesize", "thislevelsep", "thistreesep", "edge", "showbbox", "Tcradius", "Tdotsize", "bbl", "bbr", "bbh", "bbd", "fansize", "tnpos", "tnsep", "tndepth", "tnheight", "tnyref", "Tnsize", "levelsepA",
  // pst-eucl
  "PointSymbol", "PointSymbolA", "PointSymbolB", "PointSymbolC", "PointName", "PointNameA", "PointNameB", "PointNameC", "PosAngle", "PosAngleA", "PosAngleB", "PosAngleC", "PointNameSep", "LabelSep", "MarkAngleRadius", "RightAngleSize", "RightAngleType", "SegmentSymbol", "SegmentSymbolA", "SegmentSymbolB", "CodeFig", "CodeFigColor", "CodeFigStyle", "DistCoef", "DotScale", "Mark", "MarkAngle", "LabelAngleOffset", "LabelRefPt", "Radius", "nodesepA", "linetype", "CurveType", "Ux", "Uy", "OriginName", "DrawCirABC", "AngleValue", "AngleArc", "DiameterA", "DiameterB",
  // pst-3dplot
  "Alpha", "Beta", "xMin", "xMax", "yMin", "yMax", "zMin", "zMax", "nameX", "nameY", "nameZ", "spotX", "spotY", "spotZ", "drawCoor", "xPlotpoints", "yPlotpoints", "drawStyle", "hiddenLine", "IIIDticks", "IIIDlabels", "Dz", "IIIDxTicksPlane", "IIIDticksize", "IIIDxticksep", "IIIDyticksep", "IIIDzticksep", "IIIDOffset", "visibleLineStyle", "invisibleLineStyle", "coorType", "zlabelFactor", "planecorr", "xThreeDunit", "yThreeDunit", "zThreeDunit", "plotpoints3d", "RotX", "RotY", "RotZ", "RotSequence", "RotSet", "SphericalCoor", "linejoin", "zPlotpoints", "mathLabel",
  // pst-coil
  "coilwidth", "coilheight", "coilarm", "coilarmA", "coilarmB", "coilaspect", "coilinc",
  // boxes
  "boxsep", "cornersize", "shadowstyle", "shift",
  // misc accepted and ignored
  "dimen", "linejoin", "linecap", "curvature", "swapaxes", "strokeopacity", "fillopacity", "transpalpha", "framearcA", "dotstyleA", "gradlines", "gradientHSB", "GradientCircle", "GradientPos", "GradientScale", "gradangleA", "ArrowInside", "ArrowInsidePos", "ArrowInsideNo", "ArrowFill", "ArrowInsideOffset", "bracketlength", "rbracketlength", "arrowlengthA", "stepFactor", "VarStep", "VarStepEpsilon", "ChangeOrder", "polarplot", "xStep", "yStep", "nStep", "nStart", "nEnd", "barwidth", "fillcolorA", "baseline", "shadowcolorA", "framesepA", "plotpointsA", "yMaxValue", "yMinValue", "stroke", "gangle", "isolines", "IIIDOffset",
]);

export interface PssetHost {
  /** Reports an unknown key. */
  unknown(key: string): void;
  colors: ColorEnv;
  /** Named styles (\newpsstyle). */
  styles: Map<string, string>;
}

/** Applies a \psset option list (or the [...] of a command) to `st`. */
export function psset(st: PState, opts: string, host: PssetHost, depth = 0): void {
  if (depth > 20) return;
  for (const { key: k0, value } of parseOptions(opts)) {
    const key = k0.trim();
    if (!key) continue;
    const v = value ?? "";
    const col = (cur: string) => color(v, host.colors, cur);
    switch (key) {
      case "unit": {
        const u = dimen(v, st.xunit, st);
        if (u !== undefined && u > 0) st.xunit = st.yunit = st.runit = u;
        break;
      }
      case "xunit":
      case "yunit":
      case "runit": {
        const u = dimen(v, st[key], st);
        if (u !== undefined && u > 0) st[key] = u;
        break;
      }
      case "linewidth": {
        const d = dimen(v, st.xunit, st);
        if (d !== undefined && d >= 0) st.lw = Math.min(d, 200);
        break;
      }
      case "linecolor": {
        const c = col(st.lc);
        if (c) st.lc = c;
        else host.unknown(`color ${v}`);
        break;
      }
      case "fillcolor": {
        const c = col(st.fc);
        if (c) st.fc = c;
        else host.unknown(`color ${v}`);
        break;
      }
      case "hatchcolor":
      case "shadowcolor":
      case "doublecolor":
      case "bordercolor":
      case "gradbegin":
      case "gradend": {
        const c = col(st[key]);
        if (c) st[key] = c;
        else host.unknown(`color ${v}`);
        break;
      }
      case "fillstyle":
        st.fillstyle = v.trim() || "none";
        break;
      case "arrows":
        st.arrows = v.trim() || "-";
        break;
      case "linestyle":
        st.linestyle = v.trim() || "solid";
        break;
      case "dash": {
        const parts = v.trim().split(/\s+/);
        const a = dimen(parts[0], st.xunit, st);
        const b = dimen(parts[1] ?? parts[0], st.xunit, st);
        if (a !== undefined && b !== undefined && a >= 0 && b >= 0 && a + b > 0.05) st.dash = [a, b];
        break;
      }
      case "dotsep":
      case "framesep":
      case "labelsep":
      case "hatchwidth":
      case "hatchsep":
      case "shadowsize":
      case "border":
      case "linearc": {
        const d = dimen(v, st.xunit, st);
        if (d !== undefined && Number.isFinite(d)) st[key] = Math.max(0, Math.min(d, 1000));
        // Keep the raw value too: commands such as \uput read labelsep themselves.
        if (key === "labelsep") st.kv.set(key, v);
        break;
      }
      case "doublesep": {
        const d = dimen(v, st.xunit, st);
        if (d !== undefined && d >= 0) st.doublesep = d;
        break;
      }
      case "framearc":
      case "arrowlength":
      case "arrowinset":
      case "arrowscale":
      case "gradmidpoint":
      case "hatchangle":
      case "gradangle":
      case "shadowangle":
      case "dotangle": {
        const n = numVal(v.trim().split(/\s+/)[0]);
        if (n !== undefined) st[key] = key === "arrowscale" ? Math.max(0.05, Math.min(n, 50)) : n;
        break;
      }
      case "dotsize":
      case "arrowsize":
      case "tbarsize": {
        const d = dimNum(v, st);
        if (d) st[key] = d;
        break;
      }
      case "dotscale": {
        const parts = v.trim().split(/\s+/).map((x) => numVal(x));
        if (parts[0] !== undefined) st.dotscale = [parts[0], parts[1] ?? parts[0]];
        break;
      }
      case "dotstyle":
        st.dotstyle = v.trim() || "*";
        break;
      case "shadow":
        st.shadow = truthy(value);
        break;
      case "doubleline":
        st.doubleline = truthy(value);
        break;
      case "algebraic":
        st.algebraic = truthy(value);
        break;
      case "showpoints":
        st.showpoints = truthy(value);
        break;
      case "opacity":
      case "strokeopacity":
      case "fillopacity":
      case "transpalpha": {
        const n = numVal(v);
        if (n !== undefined) {
          const k = Math.max(0, Math.min(1, n));
          if (key === "opacity" || key === "transpalpha") st.opacity = k;
          else st[key] = k;
        }
        break;
      }
      case "plotpoints": {
        const n = numVal(v);
        if (n !== undefined) st.plotpoints = Math.max(2, Math.min(5000, Math.round(n)));
        break;
      }
      case "plotstyle":
        st.plotstyle = v.trim() || "line";
        break;
      case "liftpen": {
        const n = numVal(v);
        if (n !== undefined) st.liftpen = n;
        break;
      }
      case "style":
      case "linestyleA": {
        const s = host.styles.get(v.trim());
        if (s !== undefined) psset(st, s, host, depth + 1);
        else host.unknown(`style ${v.trim()}`);
        break;
      }
      case "origin": {
        const parts = v.replace(/^\{|\}$/g, "").split(",");
        const x = dimen(parts[0], st.xunit, st);
        const y = dimen(parts[1], st.yunit, st);
        if (parts.length === 2 && x !== undefined && y !== undefined) {
          st.T = mul(st.T, [1, 0, 0, 1, x - st.origin[0], y - st.origin[1]]);
          st.origin = [x, y];
        }
        break;
      }
      case "fontsize":
        break;
      default: {
        // A key that names a style (\newpsstyle{dashedblue}{...} then [dashedblue]).
        if (value === undefined && host.styles.has(key)) {
          psset(st, host.styles.get(key)!, host, depth + 1);
          break;
        }
        // An arrow spec on its own: [->].
        if (value === undefined && parseArrows(key, st)) {
          st.arrows = key;
          break;
        }
        if (RAW_KEYS.has(key)) st.kv.set(key, value ?? "true");
        else {
          st.kv.set(key, value ?? "true");
          host.unknown(key);
        }
      }
    }
  }
}

// ------------------------------------------------------------ arrows

/** One end of a PSTricks arrow spec as TikZ tips, and how far the line is pushed past the end (negative: shortened). */
interface End {
  tips: Tip[];
  /** Shortening passed to applyTips (negative lengthens: dots are centred on the end). */
  shorten: number;
  cap?: "round" | "square";
}

const ARROW_RE = /^([<>|*o()[\]cC]*|<<|>>|\|<|>\||\|\*|\*\*|oo|cc|CC|\|>|<\||[hHvV])$/;

function endOf(code: string, side: "start" | "end", st: PState): End | undefined {
  const lw = st.lw;
  const sc = st.arrowscale;
  const width = (st.arrowsize[0] + st.arrowsize[1] * lw) * sc;
  const len = width * st.arrowlength;
  const dot = (st.dotsize[0] + st.dotsize[1] * lw) * sc;
  const tbar = (st.tbarsize[0] + st.tbarsize[1] * lw) * sc;
  // `>` at the end points out; at the start, `<` points out.
  const out = side === "end" ? ">" : "<";
  const inn = side === "end" ? "<" : ">";
  const stealth = (reversed: boolean): Tip => ({ kind: "stealth", length: len, width, ...(reversed ? { reversed: true } : {}) });
  switch (code) {
    case "":
      return { tips: [], shorten: 0 };
    case ">":
    case "<":
      return { tips: [stealth(code !== out)], shorten: 0 };
    case ">>":
    case "<<":
      return { tips: [stealth(code[0] !== out), stealth(code[0] !== out)], shorten: 0 };
    case "|":
    case "|*":
      return { tips: [{ kind: "bar", width: tbar }], shorten: 0 };
    case "|<":
    case ">|":
    case "<|":
    case "|>": {
      if (code === "|>" || code === "<|") return { tips: [{ kind: "triangle", length: len, width, ...((code === "|>") !== (side === "end") ? { reversed: true } : {}) }], shorten: 0 };
      // A tip with a bar at the very end.
      const tipOut = (code === "|<" && side === "start") || (code === ">|" && side === "end");
      return { tips: [{ kind: "bar", width: tbar }, stealth(!tipOut)], shorten: 0 };
    }
    case "*":
      return { tips: [{ kind: "circle", length: dot }], shorten: -dot / 2 };
    case "**":
      return { tips: [{ kind: "circle", length: dot }], shorten: 0 };
    case "o":
      return { tips: [{ kind: "circle", length: dot, open: true }], shorten: -dot / 2 };
    case "oo":
      return { tips: [{ kind: "circle", length: dot, open: true }], shorten: 0 };
    case "[":
    case "]":
      return { tips: [{ kind: "bracket", length: tbar * 0.3, width: tbar }], shorten: 0 };
    case "(":
    case ")":
      return { tips: [{ kind: "paren", length: tbar * 0.3, width: tbar }], shorten: 0 };
    case "c":
    case "cc":
      return { tips: [], shorten: 0, cap: "round" };
    case "C":
    case "CC":
      return { tips: [], shorten: 0, cap: "square" };
    case "h":
    case "H":
    case "v":
    case "V":
      return { tips: [stealth(false)], shorten: 0 };
  }
  if (code === inn + inn) return { tips: [stealth(true), stealth(true)], shorten: 0 };
  return undefined;
}

export interface Arrows {
  spec?: ArrowSpec;
  shortenS: number;
  shortenE: number;
  cap?: "round" | "square";
}

/** Reads an arrow spec such as `->`, `<->`, `|-|`, `*-o`, `<<->>`; undefined when it is not one. */
export function parseArrows(spec: string, st: PState): Arrows | undefined {
  const t = spec.trim();
  if (!t || t === "-") return { shortenS: 0, shortenE: 0 };
  const dash = t.indexOf("-");
  if (dash < 0) return undefined;
  const a = t.slice(0, dash);
  const b = t.slice(dash + 1);
  if (!ARROW_RE.test(a) || !ARROW_RE.test(b)) return undefined;
  const s = endOf(a, "start", st);
  const e = endOf(b, "end", st);
  if (!s || !e) return undefined;
  const r: Arrows = { shortenS: s.shorten, shortenE: e.shorten };
  if (s.tips.length || e.tips.length) r.spec = { start: s.tips, end: e.tips };
  const cap = s.cap ?? e.cap;
  if (cap) r.cap = cap;
  return r;
}
