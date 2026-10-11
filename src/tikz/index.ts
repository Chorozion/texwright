/**
 * TikZ and pgfplots pictures, drawn by texwright's own interpreter. The
 * subset is what people (and language models) write: \draw, \fill, \node,
 * \coordinate, \foreach, scopes and styles, the positioning, calc, arrows,
 * shapes, automata, angles, fit and decorations libraries in their common
 * forms, and pgfplots axes with line, scatter and bar plots.
 *
 *   renderTikz(source, options) -> { svg, messages, drawn }
 *
 * `source` is a whole \begin{tikzpicture}...\end{tikzpicture}, a \tikz
 * command, or a bare picture body. The SVG has no fonts to load: node text
 * is drawn as glyph outlines from the bundled fonts. Messages carry an
 * offset into `source`; TIKZ001 warnings say what was drawn approximately
 * or left out. When nothing at all could be drawn, `svg` is undefined.
 */

import { findEnd, Interp, type InterpOptions, type Message, Stop } from "./interp.js";
import { applyOptions } from "./options.js";
import { renderAxis } from "./pgfplots.js";
import { Scanner, stripComments } from "./scan.js";
import { Lru, memoRender } from "../typeset/cache.js";
import { cloneGS, initialState } from "./state.js";
import { drawTree, treeKey } from "./trees.js";
import { drawForest } from "./forest.js";
import { drawGraph } from "./graphs.js";
import { CIRCUIT, CIRCUIT_DEFAULTS, circuitKey } from "./circuit.js";

export type { Message } from "./interp.js";

export interface TikzOptions extends InterpOptions {
  /** Preamble text with \tikzset, \tikzstyle, \pgfplotsset, \definecolor that apply to the picture. */
  preamble?: string;
}

export interface TikzResult {
  svg?: string;
  messages: Message[];
  /** Number of things drawn (paths, nodes, plots). */
  drawn: number;
  /** Size in TeX points. */
  width: number;
  height: number;
  /** Milliseconds spent. */
  ms: number;
}

/** A short stable id prefix, so glyph and gradient ids of different pictures in one HTML page do not clash. */
function prefixFor(source: string): string {
  let h = 2166136261;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `tz${(h >>> 0).toString(36)}`;
}

/** Splits a picture into its options and body. */
function pictureParts(src: string): { opts: string; body: string; bodyOff: number; circuit?: boolean } {
  const s = src;
  const m = /\\begin\s*\{(tikzpicture|circuitikz)\}/.exec(s);
  if (m) {
    const sc = new Scanner(s);
    sc.i = m.index + m[0].length;
    const opts = sc.options() ?? "";
    const bodyOff = sc.i;
    const end = findEnd(s, sc.i, m[1]);
    return { opts, body: s.slice(bodyOff, end.bodyEnd), bodyOff, ...(m[1] === "circuitikz" ? { circuit: true } : {}) };
  }
  const t = /^\s*\\tikz(?![A-Za-z])/.exec(s);
  if (t) {
    const sc = new Scanner(s);
    sc.i = t[0].length;
    const opts = sc.options() ?? "";
    sc.ws();
    if (sc.s[sc.i] === "{") {
      const start = sc.i + 1;
      const inner = sc.group("{") ?? "";
      return { opts, body: inner, bodyOff: start };
    }
    // \tikz \draw ...; : one statement.
    return { opts, body: s.slice(sc.i), bodyOff: sc.i };
  }
  return { opts: "", body: s, bodyOff: 0 };
}

const tikzCache = new Lru<{ calls: [string, string, string][]; result: TikzResult }>("tikz", 256, 300_000);

/** Runs a picture and returns its SVG. Never throws. A picture drawn before with the same inputs comes from a cache. */
export function renderTikz(source: string, options: TikzOptions = {}): TikzResult {
  return memoRender(tikzCache, source, options, renderTikzFresh);
}

function renderTikzFresh(source: string, options: TikzOptions): TikzResult {
  const t0 = Date.now();
  const src = stripComments(source);
  const it = new Interp(options, prefixFor(source));
  it.axisHandler = renderAxis;
  it.treeHandler = drawTree;
  it.graphHandler = drawGraph;
  it.extra = (key, value, g) => treeKey(it, key, value, g) || circuitKey(key, value, g);
  it.circuit = CIRCUIT;
  const root = initialState(options.fontSize ?? 10);
  const { opts, body, bodyOff, circuit } = pictureParts(src);
  try {
    if (options.preamble) {
      // Styles and colours from the document's preamble; nothing there is drawn.
      const pre = stripComments(options.preamble);
      const before = it.messages.length;
      it.run(pre, 0, false, root);
      it.messages.length = before;
    }
    const g = cloneGS(root);
    if (circuit && !g.circuit) g.circuit = CIRCUIT_DEFAULTS;
    it.off = 0;
    if (opts) applyOptions(g, it.expand(opts), "scope", it);
    const every = g.styles.get("every picture");
    if (every?.body) applyOptions(g, every.body, "scope", it);
    const forest = /^\s*\\begin\s*\{forest\}/.exec(src);
    if (forest) {
      // A forest environment: the bracket tree, then any TikZ code after it.
      const end = findEnd(src, forest[0].length, "forest");
      it.off = forest[0].length;
      drawForest(it, src.slice(forest[0].length, end.bodyEnd), g, options.preamble ?? "");
    }
    // A bare \begin{axis} without tikzpicture is a pgfplots picture too.
    else it.run(body, bodyOff, true, g);
  } catch (e) {
    if (e instanceof Stop) it.warn(`${e.message}; the rest was not drawn`, it.off, "Simplify the picture: fewer loop iterations or plot samples");
    else it.warn(`internal error while drawing the picture: ${(e as Error).message}`, it.off);
  }
  const box = it.scene.box();
  const svg = it.drawn > 0 || it.scene.count > 0 ? it.scene.svg() : undefined;
  return {
    ...(svg ? { svg } : {}),
    messages: it.messages,
    drawn: it.drawn,
    width: svg ? box[2] - box[0] : 0,
    height: svg ? box[3] - box[1] : 0,
    ms: Date.now() - t0,
  };
}

/** Line and column (1-based) of an offset in `text`. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let last = -1;
  const end = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: end - last };
}

/** Commands that configure pictures (\tikzset, \tikzstyle, \pgfplotsset, \pgfplotstableread), with where each starts. */
export function preambleCommands(text: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  const re = /\\(tikzset|pgfplotsset|tikzstyle|pgfplotstableread|ctikzset|forestset|usepackage|tdplotsetmaincoords)(?![A-Za-z])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const sc = new Scanner(text);
    sc.i = m.index + m[0].length;
    if (m[1] === "usepackage") {
      // \usepackage[american]{circuitikz}: its options are circuitikz settings.
      const o = sc.options();
      const pk = sc.group("{");
      if (pk !== undefined && /(^|,)\s*circuitikz\s*(,|$)/.test(pk)) out.push({ at: m.index, text: `\\ctikzset{${o ?? ""}}` });
      re.lastIndex = Math.max(sc.i, m.index + 1);
      continue;
    }
    if (m[1] === "tikzstyle") {
      sc.group("{");
      sc.ws();
      if (sc.s.startsWith("+=", sc.i)) sc.i += 2;
      else if (sc.s[sc.i] === "=") sc.i++;
      sc.options();
    } else {
      sc.group("{");
      if (m[1] === "pgfplotstableread" || m[1] === "tdplotsetmaincoords") sc.group("{");
    }
    out.push({ at: m.index, text: text.slice(m.index, sc.i) });
    re.lastIndex = Math.max(sc.i, m.index + 1);
    if (out.length > 200) break;
  }
  return out;
}

/** The picture-configuring commands of `text` before offset `before`, as one string. */
export function picturePreamble(text: string, before = text.length): string {
  return preambleCommands(text)
    .filter((c) => c.at < before)
    .map((c) => c.text)
    .join("\n");
}
