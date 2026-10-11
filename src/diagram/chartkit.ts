/**
 * Pieces the chart types share (gantt, pie, xychart, timeline, quadrant):
 * nice axis ticks, number formatting, colour mixing, single-line and wrapped
 * text placed by its centre, the chart title, and the small parser helpers
 * every chart needs. Dates for gantt live in gantt.ts.
 */

import { esc, labelSvg, n } from "./svg.js";
import { DIAGRAM_FONT, type Label, layoutLabel, textWidth } from "./text.js";
import type { Theme } from "./theme.js";
import type { DiagramError } from "./types.js";

/** Outer margin of every chart, px. */
export const MARGIN = 8;

// ---------------------------------------------------------------- numbers

/** A step of 1, 2, 2.5 or 5 times a power of ten close to range / target. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const raw = range / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const m = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  return m * p;
}

export interface Scale {
  lo: number;
  hi: number;
  step: number;
  ticks: number[];
}

/**
 * Ticks over [min, max]: steps of 1, 2, 2.5 or 5 times a power of ten, about
 * `target` of them. With `fixed` the ends stay where they are (the author
 * gave them) and only the ticks inside are nice; otherwise the ends are
 * rounded out to ticks.
 */
export function niceScale(min: number, max: number, target = 5, fixed = false): Scale {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = 0;
    max = 1;
  }
  if (min > max) [min, max] = [max, min];
  if (min === max) {
    const d = min === 0 ? 1 : Math.abs(min) * 0.1;
    if (!fixed) {
      min -= d;
      max += d;
    } else {
      max = min + d;
    }
  }
  let step = niceStep(max - min, target);
  if (fixed) {
    // Ends the author chose: prefer a nice step that lands on both of them.
    const p = Math.pow(10, Math.floor(Math.log10(max - min)) - 1);
    let best: number | undefined;
    for (const k of [1, 2, 2.5, 5, 10, 20, 25, 50, 100]) {
      const st = k * p;
      const count = (max - min) / st;
      const lands = Math.abs(count - Math.round(count)) < 1e-6 && Math.abs(min / st - Math.round(min / st)) < 1e-6;
      if (lands && count >= Math.max(3, target - 2) && count <= target + 3) {
        if (best === undefined || Math.abs(count - target) < Math.abs((max - min) / best - target)) best = st;
      }
    }
    if (best !== undefined) step = best;
  }
  const eps = step * 1e-9;
  const lo = fixed ? min : Math.floor(min / step + 1e-9) * step;
  const hi = fixed ? max : Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + eps && ticks.length < 200; v += step) ticks.push(clean(v, step));
  return { lo: clean(lo, step), hi: clean(hi, step), step, ticks };
}

function clean(v: number, step: number): number {
  const d = Math.max(0, -Math.floor(Math.log10(step)) + 2);
  const r = Number(v.toFixed(Math.min(12, d)));
  return Object.is(r, -0) ? 0 : r;
}

/** Decimals needed to tell ticks `step` apart. */
export function decimalsFor(step: number): number {
  if (!(step > 0)) return 0;
  for (let d = 0; d < 10; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-6 * 10 ** d) return d;
  return 10;
}

/** A number with thousands separators and the given decimals; huge values as 1.2M or 3B when `short`. */
export function formatNumber(v: number, decimals = 0, short = false): string {
  if (!Number.isFinite(v)) return String(v);
  if (short) {
    const a = Math.abs(v);
    for (const [k, s] of [[1e12, "T"], [1e9, "B"], [1e6, "M"]] as const) {
      if (a >= k) return trimZeros((v / k).toFixed(Math.max(0, Math.min(2, decimals + (Math.log10(k) | 0) - 0)))).replace(/\.?0+$/, "") + s;
    }
  }
  const s = Math.abs(v).toFixed(Math.min(10, decimals));
  const [int, frac] = s.split(".");
  const grouped = int.length > 3 ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : int;
  return `${v < 0 && Number(s) !== 0 ? "−" : ""}${grouped}${frac ? "." + frac : ""}`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** A plain number written in a source (1, -2.5, 1e3, 1_000 is not one). */
export function parseNumber(s: string): number | undefined {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------- colour

function hexRgb(c: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c.trim());
  if (!m) {
    const named: Record<string, string> = { white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff", gray: "#808080", grey: "#808080", orange: "#ffa500", purple: "#800080", yellow: "#ffff00", teal: "#008080", navy: "#000080" };
    const hex = named[c.trim().toLowerCase()];
    return hex ? hexRgb(hex) : undefined;
  }
  let h = m[1];
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** `a` moved toward `b` by t (0 keeps a, 1 gives b); colours we cannot read give `a`. */
export function mix(a: string, b: string, t: number): string {
  const x = hexRgb(a);
  const y = hexRgb(b);
  if (!x || !y) return a;
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Relative luminance (0 black .. 1 white), 0.5 for colours we cannot read. */
export function luminance(c: string): number {
  const x = hexRgb(c);
  if (!x) return 0.5;
  const [r, g, b] = x.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The page colour under the chart: the theme's background, or white. */
export function paper(t: Theme): string {
  return t.background === "transparent" ? "#ffffff" : t.background;
}

export function isDark(t: Theme): boolean {
  return luminance(paper(t)) < 0.3;
}

/** Text colour that reads on a fill: the paper colour on dark fills, the ink on light ones. */
export function textOn(fill: string, t: Theme): string {
  const l = luminance(fill);
  const dark = isDark(t) ? "#111827" : t.text;
  const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  // White wins ties slightly: it reads as the quieter choice on saturated bars.
  return ratio(1, l) * 1.15 >= ratio(luminance(dark), l) ? "#ffffff" : dark;
}

/** A tint of a colour toward the paper: subtle fills behind things. */
export function tint(c: string, t: Theme, amount: number): string {
  return mix(c, paper(t), amount);
}

/** The warm accent for critical items, readable on the theme's paper. */
export function warmAccent(t: Theme): string {
  return isDark(t) ? "#ec8b6f" : "#cf4f3b";
}

// ---------------------------------------------------------------- text

/** A single label's SVG centred vertically on cy, anchored at x. */
export function textAt(raw: string, x: number, cy: number, size: number, fill: string, opts: { align?: "start" | "middle" | "end"; bold?: boolean; maxWidth?: number } = {}): string {
  const lab = layoutLabel(raw, size, opts.maxWidth ?? Infinity);
  return labelSvg(lab, x, cy, fill, { align: opts.align ?? "start", ...(opts.bold ? { weight: "bold" as const } : {}) });
}

/** Plain text (no label markup) at a baseline: for numbers and short fixed strings. */
export function plainText(s: string, x: number, baseline: number, size: number, fill: string, align: "start" | "middle" | "end" = "start", extra = ""): string {
  return `<text x="${n(x)}" y="${n(baseline)}" font-family="${DIAGRAM_FONT}" font-size="${n(size)}" fill="${fill}" text-anchor="${align}"${extra}>${esc(s)}</text>`;
}

/** Where the baseline sits for text of `size` centred on cy. */
export function baselineFor(cy: number, size: number): number {
  const lab = layoutLabel("Hg", size);
  return cy - lab.height / 2 + lab.ascent;
}

export function measure(raw: string, size: number, bold = false): number {
  if (!bold) return layoutLabel(raw, size).width;
  return textWidth(raw, size, true);
}

/** The chart's title, bold and left-aligned at the margin; returns its SVG and the height it takes. */
export function titleBlock(title: string | undefined, t: Theme, maxWidth: number): { svg: string; height: number; width: number; label?: Label } {
  if (!title || !title.trim()) return { svg: "", height: 0, width: 0 };
  const size = Math.round(t.fontSize * 1.15 * 10) / 10;
  const lab = layoutLabel(`<b>${escLabel(title)}</b>`, size, Math.max(160, maxWidth));
  const svg = labelSvg(lab, MARGIN, MARGIN + lab.height / 2, t.text, { align: "start" });
  return { svg, height: lab.height + 12, width: lab.width, label: lab };
}

/** Text from a source meant to be shown as is: angle brackets that are not tags survive. */
export function escLabel(s: string): string {
  return s.replace(/<(?!\/?(br|b|i|strong|em)\b)/gi, "&lt;");
}

// ---------------------------------------------------------------- parsing

/** A statement with its 0-based line and the column where its text starts. */
export interface Stmt {
  text: string;
  line: number;
  col: number;
}

/** Non-empty lines without comments, trimmed, with positions. */
export function statementsOf(src: string): Stmt[] {
  const out: Stmt[] = [];
  src.split("\n").forEach((raw, line) => {
    let s = raw;
    // %% comments, unless inside quotes.
    let q = false;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === '"') q = !q;
      else if (!q && s[i] === "%" && s[i + 1] === "%") {
        s = s.slice(0, i);
        break;
      }
    }
    const text = s.trim();
    if (text) out.push({ text, line, col: s.length - s.trimStart().length });
  });
  return out;
}

/** The first statement is the diagram keyword; returns its index in the list. */
export function headerIndex(stmts: Stmt[]): number {
  return stmts.length ? 0 : -1;
}

/** Edit distance, for "did you mean" fixes. */
export function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const k = b.length;
  if (Math.abs(m - k) > 3) return 99;
  let prev = Array.from({ length: k + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= k; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[k];
}

/** The closest of `options` to `word` within two edits, if any. */
export function closest(word: string, options: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bd = 3;
  for (const o of options) {
    const d = distance(word.toLowerCase(), o.toLowerCase());
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

/** An error for a statement keyword nobody knows, with a fix when it is a near miss. */
export function unknownStatement(s: Stmt, keywords: string[], what: string, hint: string): DiagramError {
  const word = s.text.split(/[\s:]/)[0];
  const near = word.length > 2 ? closest(word, keywords) : undefined;
  return {
    line: s.line,
    col: s.col,
    message: `Cannot read "${s.text.length > 40 ? s.text.slice(0, 40) + "..." : s.text}" in a ${what}`,
    hint: near ? `Did you mean "${near}"? ${hint}` : hint,
    ...(near && near !== word ? { fix: { old: word, new: near } } : {}),
  };
}

/** Splits at commas outside double quotes and brackets. */
export function splitList(s: string): { text: string; col: number }[] {
  const out: { text: string; col: number }[] = [];
  let q = false;
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (i === s.length || (c === "," && !q && depth === 0)) {
      const raw = s.slice(start, i);
      out.push({ text: raw.trim(), col: start + (raw.length - raw.trimStart().length) });
      start = i + 1;
    } else if (c === '"') q = !q;
    else if (!q && c === "[") depth++;
    else if (!q && c === "]") depth--;
  }
  return out;
}
