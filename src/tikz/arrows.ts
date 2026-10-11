/**
 * Arrow tips: the classic ones (to, stealth, latex, |, o, *) and the
 * arrows.meta ones (Stealth, Latex, Triangle, To, Bar, Circle, Square,
 * Diamond, Kite) with their length=, width=, scale= and open options. Sizes
 * follow arrows.meta's defaults: a Stealth tip on a 0.4pt line is
 * 3pt + 4.5 * 0.4pt = 4.8pt long and three quarters as wide.
 */

import type { Pt, Seg } from "./geom.js";
import { matchClose, parseOptions } from "./scan.js";
import { UNITS, length as evalLength, num } from "./expr.js";

export interface Tip {
  kind: "to" | "stealth" | "latex" | "triangle" | "bar" | "circle" | "square" | "diamond" | "kite" | "bracket" | "paren" | "hooks" | "none" | "default";
  length?: number;
  width?: number;
  scale?: number;
  open?: boolean;
  reversed?: boolean;
  round?: boolean;
  color?: string;
  fill?: string;
}

export interface ArrowSpec {
  start: Tip[];
  end: Tip[];
}

const NAMES: Record<string, Tip["kind"]> = {
  to: "to",
  ">": "to",
  "<": "to",
  "To": "to",
  "Classical TikZ Rightarrow": "to",
  "Computer Modern Rightarrow": "to",
  "Straight Barb": "to",
  "Arc Barb": "to",
  "angle 45": "to",
  "angle 60": "to",
  "angle 90": "to",
  "Implies": "to",
  "implies": "to",
  "stealth": "stealth",
  "stealth'": "stealth",
  "Stealth": "stealth",
  "latex": "latex",
  "latex'": "latex",
  "Latex": "latex",
  "triangle 45": "triangle",
  "triangle 60": "triangle",
  "triangle 90": "triangle",
  "open triangle 45": "triangle",
  "open triangle 60": "triangle",
  "open triangle 90": "triangle",
  "Triangle": "triangle",
  "|": "bar",
  "Bar": "bar",
  "o": "circle",
  "*": "circle",
  "Circle": "circle",
  "square": "square",
  "Square": "square",
  "diamond": "diamond",
  "Diamond": "diamond",
  "Kite": "kite",
  "[": "bracket",
  "]": "bracket",
  "Bracket": "bracket",
  "(": "paren",
  ")": "paren",
  "Parenthesis": "paren",
  "Hooks": "hooks",
  "hooks": "hooks",
  "right hook": "hooks",
  "left hook": "hooks",
  "Rays": "to",
};

/** Parses one side of an arrow spec (`>>`, `{Stealth[length=3mm]}`, `latex`) into tips, or undefined when it is not one. */
function parseSide(s: string, side: "start" | "end"): Tip[] | undefined {
  const tips: Tip[] = [];
  let i = 0;
  const t = s.trim();
  while (i < t.length) {
    const c = t[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "{") {
      const e = matchClose(t, i);
      if (e < 0) return undefined;
      const inner = parseSide(t.slice(i + 1, e), side);
      if (!inner) return undefined;
      tips.push(...inner);
      i = e + 1;
      continue;
    }
    if (c === "[" && tips.length) {
      const e = matchClose(t, i);
      if (e < 0) return undefined;
      tipOptions(tips[tips.length - 1], t.slice(i + 1, e));
      i = e + 1;
      continue;
    }
    // Longest name first.
    let name = "";
    for (const k of Object.keys(NAMES)) if (t.startsWith(k, i) && k.length > name.length && (!/[A-Za-z']$/.test(k) || !/[A-Za-z']/.test(t[i + k.length] ?? ""))) name = k;
    if (!name) return undefined;
    let tip: Tip = { kind: NAMES[name] };
    if ((name === ">" && side === "end") || (name === "<" && side === "start")) tip = { kind: "default" };
    else if ((name === "<" && side === "end") || (name === ">" && side === "start")) tip = { kind: "default", reversed: true };
    if (name === "o" || name.startsWith("open ")) tip.open = true;
    if (name === "Circle" || name === "*") tip.open = false;
    tips.push(tip);
    i += name.length;
  }
  return tips;
}

function tipOptions(tip: Tip, opts: string): void {
  for (const { key, value } of parseOptions(opts)) {
    if (key === "open") tip.open = true;
    else if (key === "fill" && value === "none") tip.open = true;
    else if (key === "round") tip.round = true;
    else if (key === "reversed") tip.reversed = true;
    else if (key === "scale" && value) tip.scale = num(value) ?? 1;
    else if ((key === "length" || key === "width") && value) {
      // "3pt 2" is 3pt plus twice the line width; keep the length part.
      const v = evalLength(value.split(/\s+/)[0], UNITS.pt);
      if (v !== undefined) tip[key] = v;
    } else if (key === "color" && value) tip.color = value;
    else if (key === "fill" && value) tip.fill = value;
  }
}

/**
 * Whether an option key is an arrow spec (->, <->, -stealth, |<->|,
 * -{Stealth[length=2mm]}), and which tips it asks for.
 */
export function parseArrowSpec(key: string): ArrowSpec | undefined {
  const k = key.trim();
  // The separating dash: at depth 0, the last one not inside a name.
  let depth = 0;
  let dash = -1;
  for (let i = 0; i < k.length; i++) {
    const c = k[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "[" && depth === 0 && i > 0) {
      const e = matchClose(k, i);
      if (e > 0) i = e;
    } else if (c === "-" && depth === 0) dash = i;
  }
  if (dash < 0) return undefined;
  const start = parseSide(k.slice(0, dash), "start");
  const end = parseSide(k.slice(dash + 1), "end");
  if (!start || !end) return undefined;
  return { start, end };
}

/** A tip spec on its own (the value of >=...). */
export function parseTip(s: string): Tip | undefined {
  const tips = parseSide(s, "end");
  return tips?.[0];
}

export interface TipShape {
  /** Outline in the tip's frame: x back along the line (tip at 0), y across. */
  segs: Seg[];
  filled: boolean;
  /** How much of the line the tip covers: the line is shortened by this. */
  back: number;
  /** Total length, so a following tip starts behind this one. */
  extent: number;
  lineWidth: number;
}

/** The outline of a tip for a line of width lw. Coordinates: tip at (0,0), pointing to +x. */
export function tipShape(tip: Tip, lw: number): TipShape {
  const sc = tip.scale ?? 1;
  const meta = (len: number, w: number): [number, number] => [(tip.length ?? len) * sc, (tip.width ?? w) * sc];
  const M = (x: number, y: number): Seg => ({ t: "M", p: [x, y] });
  const L = (x: number, y: number): Seg => ({ t: "L", p: [x, y] });
  const C = (a: number, b: number, c: number, d: number, x: number, y: number): Seg => ({ t: "C", c1: [a, b], c2: [c, d], p: [x, y] });
  switch (tip.kind) {
    case "stealth": {
      const [len, w] = meta(3 + 4.5 * lw, 0.75 * (3 + 4.5 * lw));
      const inset = 0.325 * len;
      return { segs: [M(0, 0), L(-len, w / 2), L(-len + inset, 0), L(-len, -w / 2), { t: "Z" }], filled: !tip.open, back: len - inset, extent: len, lineWidth: tip.open ? lw : lw * 0.6 };
    }
    case "latex": {
      const [len, w] = meta(3 + 4.5 * lw, 0.75 * (3 + 4.5 * lw));
      const h = w / 2;
      return {
        segs: [M(0, 0), C(-len * 0.32, h * 0.12, -len * 0.82, h * 0.55, -len, h), L(-len, -h), C(-len * 0.82, -h * 0.55, -len * 0.32, -h * 0.12, 0, 0), { t: "Z" }],
        filled: !tip.open,
        back: len * 0.85,
        extent: len,
        lineWidth: tip.open ? lw : lw * 0.6,
      };
    }
    case "triangle":
    case "kite": {
      const [len, w] = meta(3 + 4.5 * lw, 0.75 * (3 + 4.5 * lw));
      if (tip.kind === "kite") return { segs: [M(0, 0), L(-len * 0.25, w / 2), L(-len, 0), L(-len * 0.25, -w / 2), { t: "Z" }], filled: !tip.open, back: len * 0.9, extent: len, lineWidth: lw };
      return { segs: [M(0, 0), L(-len, w / 2), L(-len, -w / 2), { t: "Z" }], filled: !tip.open, back: len * 0.9, extent: len, lineWidth: lw };
    }
    case "bar": {
      const [, w] = meta(lw, 2 * (2 + 1.5 * lw));
      return { segs: [M(-lw / 2, w / 2), L(-lw / 2, -w / 2)], filled: false, back: 0, extent: lw, lineWidth: lw };
    }
    case "bracket":
    case "paren": {
      const [len, w] = meta(1 + lw, 2 * (2 + 1.5 * lw));
      if (tip.kind === "paren") return { segs: [M(-len, w / 2), C(0, w / 4, 0, -w / 4, -len, -w / 2)], filled: false, back: 0, extent: len, lineWidth: lw };
      return { segs: [M(-len, w / 2), L(0, w / 2), L(0, -w / 2), L(-len, -w / 2)], filled: false, back: 0, extent: len, lineWidth: lw };
    }
    case "circle": {
      const [len] = meta(2.39 + 3.19 * lw, 0);
      const r = len / 2;
      const k = 0.5523 * r;
      return {
        segs: [M(0, 0), C(0, k, -r + k, r, -r, r), C(-r - k, r, -2 * r, k, -2 * r, 0), C(-2 * r, -k, -r - k, -r, -r, -r), C(-r + k, -r, 0, -k, 0, 0), { t: "Z" }],
        filled: !tip.open,
        back: tip.open ? 2 * r : r,
        extent: 2 * r,
        lineWidth: lw,
      };
    }
    case "square":
    case "diamond": {
      const [len] = meta(2.39 + 3.19 * lw, 0);
      if (tip.kind === "diamond") {
        const l2 = len * 1.4;
        return { segs: [M(0, 0), L(-l2 / 2, len / 2), L(-l2, 0), L(-l2 / 2, -len / 2), { t: "Z" }], filled: !tip.open, back: l2 / 2, extent: l2, lineWidth: lw };
      }
      return { segs: [M(0, len / 2), L(-len, len / 2), L(-len, -len / 2), L(0, -len / 2), { t: "Z" }], filled: !tip.open, back: len / 2, extent: len, lineWidth: lw };
    }
    case "hooks": {
      const w = 2 * (1.5 + lw) * sc;
      return { segs: [M(0, w), C(-w * 0.75, w, -w * 0.75, 0, 0, 0), M(0, -w), C(-w * 0.75, -w, -w * 0.75, 0, 0, 0)], filled: false, back: 0, extent: w * 0.6, lineWidth: lw };
    }
    case "none":
      return { segs: [], filled: false, back: 0, extent: 0, lineWidth: lw };
    default: {
      // TikZ's `to`: two curved barbs, stroked with round ends.
      const a = (0.28 + 0.3 * lw) * sc * (tip.length ? tip.length / (4 * (0.28 + 0.3 * lw)) : 1);
      return {
        segs: [M(-3 * a, 4 * a), C(-2.75 * a, 2.5 * a, 0, 0.25 * a, 0.75 * a, 0), C(0, -0.25 * a, -2.75 * a, -2.5 * a, -3 * a, -4 * a)],
        filled: false,
        back: lw * 0.6,
        extent: 3 * a,
        lineWidth: lw,
      };
    }
  }
}

/** Maps a tip outline to the canvas: the tip's point at `at`, pointing along unit `u`. */
export function placeTip(segs: Seg[], at: Pt, u: Pt): Seg[] {
  const map = (p: Pt): Pt => [at[0] + u[0] * p[0] - u[1] * p[1], at[1] + u[1] * p[0] + u[0] * p[1]];
  return segs.map((s) => {
    if (s.t === "M") return { t: "M", p: map(s.p) };
    if (s.t === "L") return { t: "L", p: map(s.p) };
    if (s.t === "C") return { t: "C", c1: map(s.c1), c2: map(s.c2), p: map(s.p) };
    return s;
  });
}
