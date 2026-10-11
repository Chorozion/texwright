/**
 * Mermaid quadrant charts: a square plot split in four, each quadrant
 * faintly tinted and named, with points placed by [x, y] in 0..1 and
 * labelled beside them. Quadrant 1 is top right, 2 top left, 3 bottom left,
 * 4 bottom right, as in Mermaid. Axis ends are named along the outside
 * (Low on the left or bottom, High on the right or top), with a thin arrow
 * between them so the direction reads at a glance. Point labels try the
 * right, left, above and below of their point and take the first place that
 * collides with nothing.
 *
 *   quadrantChart
 *     title Reach and engagement
 *     x-axis Low Reach --> High Reach
 *     y-axis Low Engagement --> High Engagement
 *     quadrant-1 Expand
 *     Campaign A: [0.3, 0.6]
 *     Campaign B:::hot: [0.7, 0.8] radius: 8, color: #d4635e
 */

import { escLabel, isDark, MARGIN, measure, mix, parseNumber, type Stmt, statementsOf, textAt, tint, titleBlock, unknownStatement } from "./chartkit.js";
import { labelSvg, n, svgDocument } from "./svg.js";
import { layoutLabel } from "./text.js";
import { safeColor } from "./theme.js";
import type { DiagramContext, DiagramError, Rendered } from "./types.js";

export interface QuadrantPoint {
  name: string;
  x: number;
  y: number;
  style: Record<string, string>;
  line: number;
}

export interface Quadrant {
  title?: string;
  xLow?: string;
  xHigh?: string;
  yLow?: string;
  yHigh?: string;
  quadrants: (string | undefined)[];
  points: QuadrantPoint[];
}

function parseStyles(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const m = /^\s*([a-z-]+)\s*:\s*(.+?)\s*$/i.exec(part);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

export function parseQuadrant(src: string, errors: DiagramError[]): Quadrant {
  const q: Quadrant = { quadrants: [undefined, undefined, undefined, undefined], points: [] };
  const classes = new Map<string, Record<string, string>>();
  const pending: { name: string; cls?: string; x: number; y: number; style: Record<string, string>; s: Stmt }[] = [];
  const stmts = statementsOf(src);
  const err = (s: Stmt, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line: s.line, col: s.col + Math.max(0, col), message, ...(hint ? { hint } : {}), ...(fix ? { fix } : {}) });
  stmts.forEach((s, i) => {
    if (i === 0) return;
    const t = s.text;
    let m: RegExpExecArray | null;
    if ((m = /^title\s+(.*)$/.exec(t))) {
      q.title = m[1].trim();
      return;
    }
    if ((m = /^(x|y)-axis\s+(.*)$/.exec(t))) {
      const [lo, hi] = m[2].split(/\s*-->\s*/);
      const low = lo?.trim().replace(/^"(.*)"$/, "$1");
      const high = hi?.trim().replace(/^"(.*)"$/, "$1");
      if (m[1] === "x") {
        q.xLow = low || undefined;
        q.xHigh = high || undefined;
      } else {
        q.yLow = low || undefined;
        q.yHigh = high || undefined;
      }
      return;
    }
    if ((m = /^quadrant-([1-4])\s+(.*)$/.exec(t))) {
      q.quadrants[Number(m[1]) - 1] = m[2].trim().replace(/^"(.*)"$/, "$1");
      return;
    }
    if ((m = /^quadrant-(\S*)/.exec(t))) {
      err(s, 0, `There is no ${m[0]}`, "Quadrants are quadrant-1 (top right), quadrant-2 (top left), quadrant-3 (bottom left) and quadrant-4 (bottom right)");
      return;
    }
    if ((m = /^classDef\s+(\S+)\s+(.*)$/.exec(t))) {
      classes.set(m[1], parseStyles(m[2]));
      return;
    }
    if (/^acc(Title|Descr)\b/.test(t)) return;
    // A point: Name(:::class)?: [x, y] styles
    m = /^("[^"]*"|[^:[\]]+?)(?::::([\w-]+))?\s*:\s*\[([^\]]*)\]\s*(.*)$/.exec(t);
    if (m) {
      const name = m[1].trim().replace(/^"(.*)"$/, "$1");
      const nums = m[3].split(",").map((x) => x.trim());
      const at = t.indexOf("[") + 1;
      if (nums.length !== 2) {
        err(s, at, `The point "${name}" needs two coordinates`, "Write  Name: [x, y]  with x and y from 0 to 1");
        return;
      }
      const vals = nums.map((v) => parseNumber(v));
      if (vals.some((v) => v === undefined)) {
        err(s, at, `The coordinates of "${name}" are not numbers`, "Write  Name: [0.3, 0.6]");
        return;
      }
      let [x, y] = vals as number[];
      if (x < 0 || x > 1 || y < 0 || y > 1) {
        const pct = x <= 100 && y <= 100 && x >= 0 && y >= 0 && (x > 1 || y > 1);
        err(s, at, `The point "${name}" lies outside the chart: [${x}, ${y}]`, pct ? "Coordinates run from 0 to 1; divide percentages by 100" : "Coordinates run from 0 to 1", pct ? { old: m[3], new: `${x / 100}, ${y / 100}` } : undefined);
        x = Math.max(0, Math.min(1, pct ? x / 100 : x));
        y = Math.max(0, Math.min(1, pct ? y / 100 : y));
      }
      pending.push({ name, cls: m[2], x, y, style: parseStyles(m[4]), s });
      return;
    }
    if (/:\s*[\d.]+\s*,\s*[\d.]+\s*$/.test(t)) {
      const c = t.indexOf(":");
      const coords = t.slice(c + 1).trim();
      err(s, c + 1, "Point coordinates go in square brackets", "Write  Name: [x, y]", { old: coords, new: `[${coords}]` });
      return;
    }
    errors.push(unknownStatement(s, ["title", "x-axis", "y-axis", "quadrant-1", "quadrant-2", "quadrant-3", "quadrant-4", "classDef"], "quadrant chart", "A point is  Name: [x, y]  with x and y from 0 to 1"));
  });
  for (const p of pending) {
    if (p.cls && !classes.has(p.cls)) err(p.s, p.s.text.indexOf(":::") + 3, `No classDef named "${p.cls}"`, "Define it: classDef name color: #d4635e, radius: 8");
    q.points.push({ name: p.name, x: p.x, y: p.y, style: { ...(p.cls ? (classes.get(p.cls) ?? {}) : {}), ...p.style }, line: p.s.line });
  }
  return q;
}

export function renderQuadrant(src: string, ctx: DiagramContext): Rendered {
  const th = ctx.theme;
  const q = parseQuadrant(src, ctx.errors);
  if (q.title && !ctx.title) ctx.title = q.title;
  const title = q.title ?? ctx.title;
  const fs = th.fontSize;
  const small = Math.round(fs * 0.86 * 10) / 10;
  const dark = isDark(th);
  const out: string[] = [];
  const head = titleBlock(title, th, 560);

  const S = 420;
  const axisLabH = small * 1.4 + 10;
  const yAxisW = q.yLow || q.yHigh ? small * 1.4 + 12 : 0;
  const x0 = MARGIN + yAxisW;
  const y0 = MARGIN + head.height + (head.height ? 6 : 0);

  // Quadrant tints: the top right warmest, the rest quieter.
  const quad = [
    { x: S / 2, y: 0, c: th.palette[0] },
    { x: 0, y: 0, c: th.palette[2 % th.palette.length] },
    { x: 0, y: S / 2, c: th.mutedText },
    { x: S / 2, y: S / 2, c: th.palette[1 % th.palette.length] },
  ];
  out.push(head.svg);
  quad.forEach((g) => out.push(`<rect x="${n(x0 + g.x)}" y="${n(y0 + g.y)}" width="${n(S / 2)}" height="${n(S / 2)}" fill="${tint(g.c, th, dark ? 0.8 : 0.9)}"/>`));
  // Dividers and the frame.
  out.push(`<path d="M${n(x0 + S / 2)} ${n(y0)}V${n(y0 + S)}M${n(x0)} ${n(y0 + S / 2)}H${n(x0 + S)}" stroke="${dark ? th.clusterStroke : "#ffffff"}" stroke-width="2"/>`);
  out.push(`<rect x="${n(x0)}" y="${n(y0)}" width="${S}" height="${S}" fill="none" stroke="${th.clusterStroke}" stroke-width="0.75"/>`);

  // Quadrant names, at the top of each quadrant.
  const qBoxes: [number, number, number, number][] = [];
  quad.forEach((g, i) => {
    const name = q.quadrants[i];
    if (!name) return;
    const lab = layoutLabel(`<b>${escLabel(name)}</b>`, small, S / 2 - 24);
    const cx = x0 + g.x + S / 4;
    const cy = y0 + g.y + 12 + lab.height / 2;
    out.push(labelSvg(lab, cx, cy, dark ? mix(g.c, "#ffffff", 0.45) : mix(g.c, th.text, 0.5), { align: "middle" }));
    qBoxes.push([cx - lab.width / 2 - 2, cy - lab.height / 2 - 2, lab.width + 4, lab.height + 4]);
  });

  // Axis names, outside the plot, with an arrow toward High.
  const arrow = (x1: number, y1: number, x2: number, y2: number) => {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const a = (k: number) => `${n(x2 - 6 * Math.cos(ang + k))} ${n(y2 - 6 * Math.sin(ang + k))}`;
    return `<path d="M${n(x1)} ${n(y1)}L${n(x2)} ${n(y2)}M${a(0.45)}L${n(x2)} ${n(y2)}L${a(-0.45)}" fill="none" stroke="${th.mutedText}" stroke-opacity="0.6" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round"/>`;
  };
  const by = y0 + S + 6 + small * 0.7;
  if (q.xLow && q.xHigh) {
    const wl = measure(escLabel(q.xLow), small);
    const wh = measure(escLabel(q.xHigh), small);
    out.push(textAt(escLabel(q.xLow), x0, by, small, th.mutedText));
    out.push(textAt(escLabel(q.xHigh), x0 + S, by, small, th.mutedText, { align: "end" }));
    if (S - wl - wh > 60) out.push(arrow(x0 + wl + 10, by, x0 + S - wh - 10, by));
  } else if (q.xLow) out.push(textAt(escLabel(q.xLow), x0 + S / 2, by, small, th.mutedText, { align: "middle" }));
  // The y names run up the left side, turned.
  const lx = MARGIN + small * 0.7;
  const rot = (s: string, y: number, anchor: "start" | "end" | "middle") => `<g transform="rotate(-90 ${n(lx)} ${n(y)})">${textAt(escLabel(s), lx, y, small, th.mutedText, { align: anchor })}</g>`;
  if (q.yLow && q.yHigh) {
    const wl = measure(escLabel(q.yLow), small);
    const wh = measure(escLabel(q.yHigh), small);
    out.push(rot(q.yLow, y0 + S, "start"));
    out.push(rot(q.yHigh, y0, "end"));
    if (S - wl - wh > 60) out.push(arrow(lx, y0 + S - wl - 10, lx, y0 + wh + 10));
  } else if (q.yLow) out.push(rot(q.yLow, y0 + S / 2, "middle"));

  // Points, then their labels where they collide with nothing.
  const defaultColor = dark ? "#e5e7eb" : th.text;
  const pts = q.points.map((p) => {
    const r = Math.max(2, Math.min(20, parseFloat(p.style.radius ?? "") || 5));
    return { p, r, cx: x0 + p.x * S, cy: y0 + (1 - p.y) * S, color: safeColor(p.style.color) ?? defaultColor };
  });
  const taken: [number, number, number, number][] = [...qBoxes, ...pts.map((d) => [d.cx - d.r - 1, d.cy - d.r - 1, 2 * d.r + 2, 2 * d.r + 2] as [number, number, number, number])];
  const hit = (b: [number, number, number, number]) => taken.some((o) => b[0] < o[0] + o[2] && b[0] + b[2] > o[0] && b[1] < o[1] + o[3] && b[1] + b[3] > o[1]);
  const inside = (b: [number, number, number, number]) => b[0] >= x0 + 2 && b[0] + b[2] <= x0 + S - 2 && b[1] >= y0 + 2 && b[1] + b[3] <= y0 + S - 2;
  for (const d of pts) {
    const stroke = safeColor(d.p.style["stroke-color"]) ?? (dark ? th.background : "#ffffff");
    const sw = Math.max(0, Math.min(6, parseFloat(d.p.style["stroke-width"] ?? "") || 1.5));
    out.push(`<circle cx="${n(d.cx)}" cy="${n(d.cy)}" r="${n(d.r)}" fill="${d.color}" stroke="${stroke}" stroke-width="${n(sw)}"/>`);
  }
  for (const d of pts) {
    const lab = layoutLabel(escLabel(d.p.name), small, 150);
    const w = lab.width;
    const h = lab.height;
    const g = d.r + 5;
    const cands: { box: [number, number, number, number]; x: number; y: number; align: "start" | "end" | "middle" }[] = [
      { box: [d.cx + g, d.cy - h / 2, w, h], x: d.cx + g, y: d.cy, align: "start" },
      { box: [d.cx - g - w, d.cy - h / 2, w, h], x: d.cx - g, y: d.cy, align: "end" },
      { box: [d.cx - w / 2, d.cy - g - h, w, h], x: d.cx, y: d.cy - g - h / 2, align: "middle" },
      { box: [d.cx - w / 2, d.cy + g, w, h], x: d.cx, y: d.cy + g + h / 2, align: "middle" },
      { box: [d.cx + g * 0.7, d.cy - g * 0.7 - h, w, h], x: d.cx + g * 0.7, y: d.cy - g * 0.7 - h / 2, align: "start" },
      { box: [d.cx + g * 0.7, d.cy + g * 0.7, w, h], x: d.cx + g * 0.7, y: d.cy + g * 0.7 + h / 2, align: "start" },
      { box: [d.cx - g * 0.7 - w, d.cy - g * 0.7 - h, w, h], x: d.cx - g * 0.7, y: d.cy - g * 0.7 - h / 2, align: "end" },
      { box: [d.cx - g * 0.7 - w, d.cy + g * 0.7, w, h], x: d.cx - g * 0.7, y: d.cy + g * 0.7 + h / 2, align: "end" },
    ];
    const pick = cands.find((c) => inside(c.box) && !hit(c.box)) ?? cands.find((c) => inside(c.box)) ?? cands[0];
    taken.push(pick.box);
    out.push(labelSvg(lab, pick.x, pick.y, th.text, { align: pick.align }));
  }

  const width = Math.max(x0 + S + MARGIN, head.width + 2 * MARGIN);
  const height = y0 + S + axisLabH + MARGIN;
  return { svg: svgDocument(width, height, out.join(""), th, title), width, height };
}
