/**
 * Node text, set by texwright's own math engine: each line goes in as
 * \text{...}, so plain words come out in the document's serif (KaTeX_Main,
 * Computer Modern), $math$ inside is real math, and \textbf, \emph and
 * friends work as they do in the document. The typeset boxes become SVG:
 * every glyph is its outline from the bundled font, defined once per
 * picture in <defs> and placed with <use>, so the picture looks the same in
 * the PDF and in a browser without any font to load.
 */

import { Diagnostics } from "../diagnostics.js";
import type { Font } from "../font/index.js";
import type { HBox, HNode, VBox, VNode } from "../layout/types.js";
import { typesetMath } from "../math/index.js";
import { matchClose } from "./scan.js";

export interface TextStyle {
  size: number;
  bold: boolean;
  italic: boolean;
  family: "serif" | "sans" | "mono";
  /** Ragged width for wrapping (text width=...), in pt. */
  width?: number;
  align: "left" | "center" | "right";
}

interface GlyphPlace {
  key: string;
  font: Font;
  gid: number;
  size: number;
  x: number;
  /** Down from the baseline. */
  y: number;
  color?: [number, number, number];
}

interface RulePlace {
  x: number;
  /** Top edge, down from the baseline. */
  y: number;
  w: number;
  h: number;
  color?: [number, number, number];
}

/** A laid-out block of text: (0,0) is the first line's baseline at the left of the block. */
export interface TextBlock {
  width: number;
  /** Above the first baseline. */
  height: number;
  /** Below the first baseline (all further lines included). */
  depth: number;
  glyphs: GlyphPlace[];
  rules: RulePlace[];
  ok: boolean;
  /** Where node parts meet (\nodepart), down from the first baseline: rectangle split draws a line there. */
  parts: number[];
  errors: string[];
}

const SIZES: Record<string, number> = {
  tiny: 5,
  scriptsize: 7,
  footnotesize: 8,
  small: 9,
  normalsize: 10,
  large: 12,
  Large: 14.4,
  LARGE: 17.28,
  huge: 20.74,
  Huge: 24.88,
};

/** Reads a font= value (\small\bfseries, \sffamily ...) into a style. */
export function applyFont(spec: string, style: TextStyle): void {
  for (const m of spec.matchAll(/\\([A-Za-z]+)/g)) {
    const c = m[1];
    if (Object.hasOwn(SIZES, c)) style.size = SIZES[c];
    else if (c === "bfseries" || c === "bf" || c === "boldmath") style.bold = true;
    else if (c === "itshape" || c === "it" || c === "slshape" || c === "em") style.italic = true;
    else if (c === "mdseries") style.bold = false;
    else if (c === "upshape") style.italic = false;
    else if (c === "sffamily" || c === "sf") style.family = "sans";
    else if (c === "ttfamily" || c === "tt") style.family = "mono";
    else if (c === "rmfamily" || c === "rm") style.family = "serif";
  }
}

/** Splits at `\\` (and \newline) outside braces and math. */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let math = false;
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      if (s[k + 1] === "\\" && depth === 0 && !math) {
        out.push(cur);
        cur = "";
        k++;
        // \\[4pt]
        const rest = s.slice(k + 1);
        const opt = /^\s*\[[^\]]*\]/.exec(rest);
        if (opt) k += opt[0].length;
        continue;
      }
      if (s.startsWith("\\newline", k) && !/[A-Za-z]/.test(s[k + 8] ?? "") && depth === 0 && !math) {
        out.push(cur);
        cur = "";
        k += 7;
        continue;
      }
      cur += c + (s[k + 1] ?? "");
      k++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "$") math = !math;
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Words of a line, split at spaces outside braces and math. */
function words(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let math = false;
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      cur += c + (s[k + 1] ?? "");
      k++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "$") math = !math;
    if (/\s/.test(c) && depth === 0 && !math) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Strips size switches from text (\small Hello, {\Large x}) and reads them into the style. */
function takeSizes(text: string, style: TextStyle): string {
  return text.replace(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)(?![A-Za-z])\s*/g, (_m, c: string) => {
    style.size = SIZES[c];
    return "";
  });
}

function wrapStyle(tex: string, style: TextStyle): string {
  let t = tex;
  if (style.family === "sans") t = `\\textsf{${t}}`;
  else if (style.family === "mono") t = `\\texttt{${t}}`;
  if (style.bold) t = `\\textbf{${t}}`;
  if (style.italic) t = `\\textit{${t}}`;
  return t;
}

/** siunitx and mhchem commands with their number of brace arguments; the math engine sets them. */
const UNIT_COMMANDS: Record<string, number> = { SI: 2, si: 1, num: 1, qty: 2, unit: 1, ang: 1, SIrange: 3, numrange: 2, qtyrange: 3, SIlist: 2, numlist: 1, qtylist: 2, ce: 1, pu: 1 };

/**
 * Puts siunitx and mhchem commands written in running text ("Temperature (\si{\celsius})")
 * into math, where the math engine knows them; in text they expand to math-only pieces.
 */
function mathUnits(src: string): string {
  if (!/\\(SI|si|num|qty|unit|ang|ce|pu)/.test(src)) return src;
  let out = "";
  let inMath = false;
  let k = 0;
  while (k < src.length) {
    const c = src[k]!;
    if (c === "\\" && src[k + 1] === "$") {
      out += "\\$";
      k += 2;
      continue;
    }
    if (c === "$") {
      inMath = !inMath;
      out += c;
      k++;
      continue;
    }
    const m = !inMath && c === "\\" ? /^\\([A-Za-z]+)/.exec(src.slice(k)) : null;
    const need = m ? UNIT_COMMANDS[m[1]!] : undefined;
    if (m && need !== undefined) {
      // The command, its optional [..] arguments and its brace arguments.
      let j = k + m[0].length;
      let groups = 0;
      while (j < src.length && groups < need) {
        while (src[j] === " ") j++;
        const open = src[j];
        if (open !== "[" && open !== "{") break;
        const close = open === "[" ? "]" : "}";
        let depth = 0;
        let e = j;
        for (; e < src.length; e++) {
          if (src[e] === "\\") e++;
          else if (src[e] === open) depth++;
          else if (src[e] === close && --depth === 0) break;
        }
        if (e >= src.length) break;
        if (open === "{") groups++;
        j = e + 1;
      }
      out += `$${src.slice(k, j)}$`;
      k = j;
      continue;
    }
    out += c;
    k++;
  }
  return out;
}

function typesetLine(tex: string, style: TextStyle, macros: Record<string, string>): { box: HBox; ok: boolean; errors: string[] } {
  const d = new Diagnostics();
  // An unbalanced brace would swallow the \text group; balance it rather than fail.
  let src = tex;
  let depth = 0;
  for (let k = 0; k < src.length; k++) {
    if (src[k] === "\\") k++;
    else if (src[k] === "{") depth++;
    else if (src[k] === "}") depth--;
  }
  if (depth < 0) src = "{".repeat(-depth) + src;
  else if (depth > 0) src += "}".repeat(depth);
  // An odd number of $ leaves math open.
  if ((src.replace(/\\\$/g, "").match(/\$/g)?.length ?? 0) % 2) src += "$";
  src = mathUnits(src);
  const r = typesetMath(`\\text{${wrapStyle(src, style)}}`, { display: false, fontSize: style.size, macros, diagnostics: d });
  return { box: r.box, ok: r.ok, errors: d.items.filter((x) => x.severity === "error").map((x) => x.message) };
}

const MAX_TEXT = 4000;

/** Lays out node text: lines at \\, wrapped to style.width when given. */
export function layoutText(raw: string, style0: TextStyle, macros: Record<string, string>): TextBlock {
  const style = { ...style0 };
  const text = takeSizes(raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw, style).trim();
  // \nodepart{two} starts a new line that also starts a new part.
  const PART = "\u0001";
  let lines = splitLines(text.replace(/\\nodepart\s*\{[^}]*\}/g, `\\\\${PART}`)).map((l) => l.trim());
  const partStart = new Set<number>();
  lines = lines.map((l, i) => {
    if (!l.startsWith(PART)) return l;
    partStart.add(i);
    return l.slice(1).trim();
  });
  const errors: string[] = [];
  let ok = true;
  const boxes: HBox[] = [];
  const set = (t: string): HBox => {
    const r = typesetLine(t, style, macros);
    if (!r.ok) ok = false;
    errors.push(...r.errors);
    return r.box;
  };
  if (style.width !== undefined && style.width > 0) {
    // Greedy line filling, measured word by word.
    const wrapped: string[] = [];
    const space = set(" a").width - set("a").width || style.size / 3;
    for (const line of lines) {
      const ws = words(line);
      let cur = "";
      let curW = 0;
      for (const w of ws) {
        const ww = set(w).width;
        if (cur && curW + space + ww > style.width + 0.01) {
          wrapped.push(cur);
          cur = w;
          curW = ww;
        } else {
          cur = cur ? `${cur} ${w}` : w;
          curW = cur === w ? ww : curW + space + ww;
        }
      }
      wrapped.push(cur);
    }
    lines = wrapped;
  }
  for (const l of lines.slice(0, 200)) boxes.push(l ? set(l) : { t: "hbox", width: 0, height: 0, depth: 0, children: [] });
  const width = style.width !== undefined && style.width > 0 ? style.width : boxes.reduce((w, b) => Math.max(w, b.width), 0);
  const skip = style.size * 1.2;
  const glyphs: GlyphPlace[] = [];
  const rules: RulePlace[] = [];
  let y = 0;
  let prevDepth = 0;
  let height = 0;
  const parts: number[] = [];
  boxes.forEach((b, i) => {
    if (i > 0) {
      // TeX's baselineskip, with lineskip when lines would touch; a new part gets room for its rule.
      const gap = Math.max(skip, prevDepth + b.height + 1) + (partStart.has(i) ? style.size * 0.6 : 0);
      if (partStart.has(i)) parts.push(y + prevDepth + (gap - prevDepth - b.height) / 2);
      y += gap;
    } else height = Math.max(b.height, style.size * 0.7);
    const x = style.align === "center" ? (width - b.width) / 2 : style.align === "right" ? width - b.width : 0;
    walkH(b, x, y, glyphs, rules);
    prevDepth = b.depth;
  });
  const depth = y + Math.max(prevDepth, style.size * 0.2);
  return { width, height, depth, glyphs, rules, ok, errors, parts };
}

function glueWidth(n: Extract<HNode, { t: "glue" }>, set: HBox["glueSet"]): number {
  if (!set || set.sign === "none") return n.width;
  if (set.sign === "stretch" && n.stretchOrder === set.order) return n.width + n.stretch * set.ratio;
  if (set.sign === "shrink" && n.shrinkOrder === set.order) return n.width - n.shrink * set.ratio;
  return n.width;
}

/** Places the contents of an hbox whose baseline starts at (x, y), y down. */
function walkH(box: HBox, x0: number, y0: number, glyphs: GlyphPlace[], rules: RulePlace[]): void {
  let x = x0;
  for (const n of box.children) {
    switch (n.t) {
      case "glyphs": {
        let gx = x;
        n.gids.forEach((gid, k) => {
          glyphs.push({ key: `${n.font.postscriptName}:${gid}`, font: n.font, gid, size: n.size, x: gx, y: y0 - (n.yOffsets?.[k] ?? 0), ...(n.color ? { color: n.color } : {}) });
          gx += n.advances[k] ?? 0;
        });
        x += n.width;
        break;
      }
      case "glue":
        x += glueWidth(n, box.glueSet);
        break;
      case "kern":
        x += n.width;
        break;
      case "rule": {
        const h = n.height ?? box.height;
        const d = n.depth ?? box.depth;
        const w = n.width ?? 0;
        rules.push({ x, y: y0 - h, w, h: h + d, ...(n.color ? { color: n.color } : {}) });
        x += w;
        break;
      }
      case "hbox":
        walkH(n, x, y0 + (n.shift ?? 0), glyphs, rules);
        x += n.width;
        break;
      case "vbox":
        walkV(n, x, y0 + (n.shift ?? 0), glyphs, rules);
        x += n.width;
        break;
      case "image":
      case "drawing":
        x += n.width;
        break;
      default:
        break;
    }
  }
}

/** Places the contents of a vbox whose baseline (its last box's) is at y0. */
function walkV(box: VBox, x0: number, y0: number, glyphs: GlyphPlace[], rules: RulePlace[]): void {
  let y = y0 - box.height;
  for (const n of box.children as VNode[]) {
    switch (n.t) {
      case "hbox":
        y += n.height;
        walkH(n, x0 + (n.shift ?? 0), y, glyphs, rules);
        y += n.depth;
        break;
      case "vbox":
        y += n.height;
        walkV(n, x0 + (n.shift ?? 0), y, glyphs, rules);
        y += n.depth;
        break;
      case "glue":
        y += glueWidth(n as never, box.glueSet as never);
        break;
      case "kern":
        y += n.width;
        break;
      case "rule": {
        const h = (n.height ?? 0) + (n.depth ?? 0);
        rules.push({ x: x0, y, w: n.width ?? box.width, h, ...(n.color ? { color: n.color } : {}) });
        y += h;
        break;
      }
      case "image":
      case "drawing":
        y += n.height + n.depth;
        break;
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------- SVG

const outlineCache = new Map<string, string>();

function outlineData(font: Font, gid: number, key: string): string {
  const hit = outlineCache.get(key);
  if (hit !== undefined) return hit;
  let d = "";
  try {
    for (const c of font.outline(gid)) {
      if (c[0] === "Z") d += "Z";
      else if (c[0] === "C") d += `C${r(c[1])} ${r(c[2])} ${r(c[3])} ${r(c[4])} ${r(c[5])} ${r(c[6])}`;
      else d += `${c[0]}${r(c[1])} ${r(c[2])}`;
    }
  } catch {
    d = "";
  }
  if (outlineCache.size > 50000) outlineCache.clear();
  outlineCache.set(key, d);
  return d;
}

const r = (v: number): string => {
  const x = Math.round(v * 10) / 10;
  return Object.is(x, -0) ? "0" : String(x);
};

export const n2 = (v: number): string => {
  const x = Math.round(v * 100) / 100;
  return Object.is(x, -0) ? "0" : String(x);
};

/** Glyph outlines a picture uses, written once into <defs>. */
export class GlyphDefs {
  private ids = new Map<string, string>();
  private defs: string[] = [];
  constructor(private readonly prefix: string) {}

  id(g: GlyphPlace): string | undefined {
    let id = this.ids.get(g.key);
    if (id === undefined) {
      const d = outlineData(g.font, g.gid, g.key);
      id = d ? `${this.prefix}${this.ids.size}` : "";
      this.ids.set(g.key, id);
      if (d) this.defs.push(`<path id="${id}" d="${d}"/>`);
    }
    return id || undefined;
  }

  markup(): string {
    return this.defs.join("");
  }
}

function rgbAttr(c: [number, number, number]): string {
  return `#${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * SVG for a text block with its first baseline's left end at (x, y) in SVG
 * coordinates (y down), turned by `rotate` degrees counterclockwise about
 * that point and scaled by `scale`.
 */
export function textSvg(block: TextBlock, x: number, y: number, fill: string, defs: GlyphDefs, opts: { rotate?: number; scale?: number; opacity?: number } = {}): string {
  const parts: string[] = [];
  for (const g of block.glyphs) {
    const id = defs.id(g);
    if (!id) continue;
    const s = g.size / g.font.unitsPerEm;
    parts.push(`<use href="#${id}" transform="translate(${n2(g.x)} ${n2(g.y)}) scale(${+s.toFixed(6)} ${+(-s).toFixed(6)})"${g.color ? ` fill="${rgbAttr(g.color)}"` : ""}/>`);
  }
  for (const ru of block.rules) {
    parts.push(`<rect x="${n2(ru.x)}" y="${n2(ru.y)}" width="${n2(Math.max(ru.w, 0))}" height="${n2(Math.max(ru.h, 0))}"${ru.color ? ` fill="${rgbAttr(ru.color)}"` : ""}/>`);
  }
  if (!parts.length) return "";
  let t = `translate(${n2(x)} ${n2(y)})`;
  if (opts.rotate) t += ` rotate(${n2(-opts.rotate)})`;
  if (opts.scale !== undefined && opts.scale !== 1) t += ` scale(${+opts.scale.toFixed(4)})`;
  return `<g transform="${t}" fill="${fill}"${opts.opacity !== undefined && opts.opacity < 1 ? ` opacity="${n2(opts.opacity)}"` : ""}>${parts.join("")}</g>`;
}

/** True when the node text has nothing to draw. */
export function blankText(s: string): boolean {
  return !s.replace(/\\(strut|phantom\{[^}]*\}|,|;|quad|qquad)|[{}~\s]/g, "").length;
}

export { matchClose };
