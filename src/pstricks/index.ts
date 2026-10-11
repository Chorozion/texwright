/**
 * PSTricks pictures, drawn by texwright's own interpreter into the same
 * kind of SVG as TikZ pictures: pstricks.tex's objects and parameters,
 * pst-plot, pst-node, pst-tree, pst-grad, and basic pst-eucl, pst-3dplot
 * and pst-coil.
 *
 *   renderPstricks(source, options) -> { svg, messages, drawn }
 *
 * `source` is a whole \begin{pspicture}...\end{pspicture}, or a single
 * command that draws (\pstree{...}{...}, \psframebox{...}), or a bare
 * picture body. Messages carry an offset into `source`; PST001 warnings say
 * what was drawn approximately or left out. When nothing at all could be
 * drawn, `svg` is undefined.
 */

import { type Box, boxOK, emptyBox, growBox } from "../tikz/scene.js";
import { Scanner, stripComments } from "../tikz/scan.js";
import { type Message, type PstOptions, PstInterp, Stop } from "./interp.js";
import { initialState } from "./state.js";
import { Lru, memoRender } from "../typeset/cache.js";
import "./plot.js";
import "./nodes.js";
import "./tree.js";
import "./extras.js";
import { polySegs } from "./interp.js";

export type { Message } from "./interp.js";

export interface PstricksOptions extends PstOptions {
  /** \psset, \newpsstyle, colour and data commands that come before the picture in the document. */
  preamble?: string;
}

export interface PstricksResult {
  svg?: string;
  messages: Message[];
  drawn: number;
  width: number;
  height: number;
  ms: number;
}

function prefixFor(source: string): string {
  let h = 2166136261;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `ps${(h >>> 0).toString(36)}`;
}

/** Index just past the \end{pspicture} matching the \begin at `from` (nesting counted), or the end. */
function envEnd(s: string, from: number): { bodyEnd: number; next: number } {
  // \begin{pspicture} ... \end{pspicture}, or plain TeX's \pspicture ... \endpspicture.
  const re = /\\(begin|end)\s*\{pspicture\*?\}|\\(end)?pspicture\*?(?![A-Za-z])/g;
  re.lastIndex = from;
  let depth = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[1] === "begin" || (m[1] === undefined && m[2] === undefined)) depth++;
    else if (depth === 0) return { bodyEnd: m.index, next: m.index + m[0].length };
    else depth--;
  }
  return { bodyEnd: s.length, next: s.length };
}

interface Parts {
  opts: string;
  coords: string[];
  body: string;
  bodyOff: number;
  star: boolean;
  env: boolean;
}

function pictureParts(src: string): Parts {
  const m = /\\begin\s*\{pspicture(\*?)\}|^\s*\\pspicture(\*?)(?![A-Za-z])/.exec(src);
  if (!m) return { opts: "", coords: [], body: src, bodyOff: 0, star: false, env: false };
  const sc = new Scanner(src);
  sc.i = m.index + m[0].length;
  let opts = "";
  while (sc.peek() === "[") opts += `,${sc.options() ?? ""}`;
  const coords: string[] = [];
  while (coords.length < 2 && sc.peek() === "(") coords.push(sc.group("(") ?? "");
  const bodyOff = sc.i;
  const star = (m[1] ?? m[2]) === "*";
  const end = envEnd(src, sc.i);
  return { opts, coords, body: src.slice(bodyOff, end.bodyEnd), bodyOff, star, env: true };
}

const pstricksCache = new Lru<{ calls: [string, string, string][]; result: PstricksResult }>("pstricks", 256, 300_000);

/** Runs a picture and returns its SVG. Never throws. A picture drawn before with the same inputs comes from a cache. */
export function renderPstricks(source: string, options: PstricksOptions = {}): PstricksResult {
  return memoRender(pstricksCache, source, options, renderPstricksFresh);
}

function renderPstricksFresh(source: string, options: PstricksOptions): PstricksResult {
  const t0 = Date.now();
  const src = stripComments(source);
  const it = new PstInterp(options, prefixFor(source));
  const st = initialState(options.fontSize ?? 10);
  const parts = pictureParts(src);
  let declared: Box | undefined;
  try {
    if (options.preamble) {
      // Settings from before the picture; nothing there is drawn.
      const before = it.messages.length;
      it.run(stripComments(options.preamble), 0, st, false);
      it.messages.length = before;
      it.scene.items.length = 0;
      it.drawn = 0;
    }
    // pspicture's own options ([showgrid], [shift=...]): only showgrid draws anything.
    let showgrid = false;
    if (parts.opts) {
      for (const o of parts.opts.split(",")) {
        const [k, v] = o.split("=").map((x) => x.trim());
        if (k === "showgrid") showgrid = v === undefined || v === "true" || v === "top";
        else if (k) it.set(st, o);
      }
    }
    if (parts.env) {
      const cs = parts.coords;
      const a = cs.length === 2 ? it.coord(cs[0], st) : [0, 0];
      const b = cs.length ? it.coord(cs[cs.length - 1], st) : undefined;
      if (a && b) {
        declared = emptyBox();
        growBox(declared, a as [number, number]);
        growBox(declared, b);
        it.frame = [[declared[0], declared[1]], [declared[2], declared[3]]];
        if (parts.star) st.clips = [it.scene.clipPath(polySegs([[declared[0], declared[1]], [declared[2], declared[1]], [declared[2], declared[3]], [declared[0], declared[3]]], true))];
      }
    }
    if (showgrid) it.run("\\psgrid", 0, st, false);
    it.run(parts.body, parts.bodyOff, st);
  } catch (e) {
    if (e instanceof Stop) it.warn(`${e.message}; the rest was not drawn`, it.off, "Simplify the picture: fewer loop iterations or plot points");
    else it.warn(`internal error while drawing the picture: ${(e as Error).message}`, it.off);
  }
  const drawn = it.drawn > 0 || it.scene.count > 0;
  let box = it.scene.box();
  if (declared && drawn) {
    // The picture keeps the room it asked for; what spills over is kept too (pspicture* clips it).
    if (parts.star) box = declared;
    else if (boxOK(box)) box = [Math.min(box[0], declared[0]), Math.min(box[1], declared[1]), Math.max(box[2], declared[2]), Math.max(box[3], declared[3])];
    else box = declared;
    if (box[2] - box[0] < 1e5 && box[3] - box[1] < 1e5) it.scene.fixedBox = box;
  }
  const svg = drawn ? it.scene.svg() : undefined;
  return {
    ...(svg ? { svg } : {}),
    messages: it.messages,
    drawn: it.drawn,
    width: svg ? box[2] - box[0] : 0,
    height: svg ? box[3] - box[1] : 0,
    ms: Date.now() - t0,
  };
}

/** Ranges of the pspicture environments in `text`, so settings inside one do not leak into the next. */
function pictureRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /\\begin\s*\{pspicture\*?\}|\\pspicture\*?(?![A-Za-z])/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const e = envEnd(text, m.index + m[0].length);
    out.push([m.index, e.next]);
    re.lastIndex = e.next;
    if (out.length > 5000) break;
  }
  return out;
}

const SETTERS = /\\(psset|newpsstyle|addtopsstyle|newrgbcolor|newgray|newcmykcolor|newhsbcolor|definecolor|colorlet|savedata|readdata|newpsobject|SpecialCoor)(?![A-Za-z])/g;

/** Commands that configure PSTricks pictures, with where each starts (outside any pspicture). */
export function pstricksPreambleCommands(text: string): { at: number; text: string }[] {
  const ranges = pictureRanges(text);
  const inside = (i: number) => ranges.some(([a, b]) => i > a && i < b);
  const out: { at: number; text: string }[] = [];
  SETTERS.lastIndex = 0;
  for (let m = SETTERS.exec(text); m; m = SETTERS.exec(text)) {
    if (inside(m.index)) continue;
    const sc = new Scanner(text);
    sc.i = m.index + m[0].length;
    const name = m[1];
    const take = (k: string) => {
      for (const c of k) {
        if (c === "o") sc.options();
        else if (c === "m") {
          sc.ws();
          if (sc.s[sc.i] === "{") sc.group("{");
          else {
            const w = /^\\[A-Za-z@]+/.exec(sc.s.slice(sc.i, sc.i + 60));
            if (w) sc.i += w[0].length;
          }
        }
      }
    };
    const spec: Record<string, string> = { psset: "m", newpsstyle: "mm", addtopsstyle: "mm", newrgbcolor: "mm", newgray: "mm", newcmykcolor: "mm", newhsbcolor: "mm", definecolor: "ommm", colorlet: "omm", savedata: "mo", readdata: "omm", newpsobject: "mmm", SpecialCoor: "" };
    take(spec[name] ?? "");
    out.push({ at: m.index, text: text.slice(m.index, sc.i) });
    SETTERS.lastIndex = Math.max(sc.i, m.index + 1);
    if (out.length > 500) break;
  }
  return out;
}

export { lineCol } from "../tikz/index.js";
