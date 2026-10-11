/**
 * Mermaid xy charts (`xychart-beta`): bars and lines over categories or a
 * numeric x range, vertical or `horizontal`. Several bar series stand side by
 * side in each category; lines are 2px with a marker at every value. The
 * value axis gets nice ticks (steps of 1, 2, 2.5 or 5) with hairline
 * gridlines; its title sits above the tick labels, where it can be read
 * without turning the head. A legend appears when series have names.
 *
 *   xychart-beta
 *     title "Revenue"
 *     x-axis [Q1, Q2, Q3, Q4]
 *     y-axis "EUR thousands" 0 --> 500
 *     bar "2025" [120, 180, 260, 310]
 *     line "Target" [150, 200, 250, 300]
 */

import { decimalsFor, escLabel, formatNumber, MARGIN, measure, niceScale, paper, parseNumber, plainText, type Stmt, statementsOf, splitList, textAt, titleBlock, unknownStatement, baselineFor } from "./chartkit.js";
import { labelSvg, n, svgDocument } from "./svg.js";
import { layoutLabel } from "./text.js";
import type { DiagramContext, DiagramError, Rendered } from "./types.js";

export interface XySeries {
  kind: "bar" | "line";
  name?: string;
  values: number[];
  line: number;
}

export interface XyChart {
  horizontal: boolean;
  title?: string;
  xTitle?: string;
  categories?: string[];
  xRange?: [number, number];
  yTitle?: string;
  yRange?: [number, number];
  series: XySeries[];
}

/** `"quoted"` or bare text at the start of s: the text and what is left. */
function leadingTitle(s: string): { title?: string; rest: string } {
  const t = s.trim();
  if (t.startsWith('"')) {
    const end = t.indexOf('"', 1);
    if (end > 0) return { title: t.slice(1, end), rest: t.slice(end + 1).trim() };
  }
  if (!t || t.startsWith("[") || /^[+-]?(\d|\.\d)/.test(t)) return { rest: t };
  // A bare title runs up to a list or a range.
  const m = /^(.*?)\s*(\[.*|[+-]?(?:\d+\.?\d*|\.\d+)\s*-->.*)?$/.exec(t)!;
  return { title: m[1].trim() || undefined, rest: (m[2] ?? "").trim() };
}

export function parseXyChart(src: string, errors: DiagramError[]): XyChart {
  const stmts = statementsOf(src);
  const c: XyChart = { horizontal: false, series: [] };
  const err = (s: Stmt, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line: s.line, col: s.col + Math.max(0, col), message, ...(hint ? { hint } : {}), ...(fix ? { fix } : {}) });

  const range = (s: Stmt, text: string, at: number, axis: string): [number, number] | undefined => {
    const m = /^(\S+)\s*-->\s*(\S+)$/.exec(text);
    if (!m) {
      err(s, at, `Cannot read the ${axis} range "${text}"`, `Write  ${axis} "Title" min --> max  (for example 0 --> 100)`);
      return undefined;
    }
    const a = parseNumber(m[1]);
    const b = parseNumber(m[2]);
    if (a === undefined || b === undefined) {
      err(s, at + (a === undefined ? 0 : text.indexOf(m[2], m[1].length)), `The ${axis} range needs two numbers`, `Write min --> max, for example 0 --> 100`);
      return undefined;
    }
    if (a === b) {
      err(s, at, `The ${axis} range is empty (${a} --> ${b})`, "Give two different numbers");
      return undefined;
    }
    return [a, b];
  };

  const list = (s: Stmt, text: string, at: number): { items: { text: string; col: number }[] } | undefined => {
    const open = text.indexOf("[");
    const close = text.lastIndexOf("]");
    if (open < 0 || close < open) {
      err(s, at + Math.max(0, open), "A list needs square brackets", "Write values as [1, 2, 3]", open >= 0 && close < 0 ? { old: text.slice(open), new: text.slice(open) + "]" } : undefined);
      return undefined;
    }
    const inner = text.slice(open + 1, close);
    if (!inner.trim()) return { items: [] };
    return { items: splitList(inner).map((x) => ({ text: x.text, col: at + open + 1 + x.col })) };
  };

  stmts.forEach((s, i) => {
    if (i === 0) {
      const rest = s.text.replace(/^xychart(-beta)?\b/, "").trim();
      if (/^horizontal$/i.test(rest)) c.horizontal = true;
      else if (rest && !/^vertical$/i.test(rest)) err(s, s.text.indexOf(rest), `Unknown orientation "${rest}"`, "Write xychart-beta or xychart-beta horizontal");
      return;
    }
    const m = /^(title|x-axis|y-axis|bar|line|accTitle|accDescr)\b\s*:?\s*(.*)$/.exec(s.text);
    if (!m) {
      errors.push(unknownStatement(s, ["title", "x-axis", "y-axis", "bar", "line"], "xy chart", "Statements are title, x-axis, y-axis, bar [..] and line [..]"));
      return;
    }
    const [, kw, body] = m;
    const at = s.text.length - body.length;
    switch (kw) {
      case "title":
        c.title = body.trim().replace(/^"(.*)"$/, "$1");
        return;
      case "accTitle":
      case "accDescr":
        return;
      case "x-axis":
      case "y-axis": {
        const { title, rest } = leadingTitle(body);
        const restAt = at + body.length - rest.length;
        if (kw === "x-axis") {
          if (title !== undefined) c.xTitle = title;
          if (rest.startsWith("[")) {
            const l = list(s, rest, restAt);
            if (l) c.categories = l.items.map((x) => x.text.replace(/^"(.*)"$/, "$1"));
          } else if (rest) c.xRange = range(s, rest, restAt, "x-axis");
        } else {
          if (title !== undefined) c.yTitle = title;
          if (rest.startsWith("[")) err(s, restAt, "The y-axis takes a range, not categories", "Write  y-axis \"Title\" min --> max; categories go on the x-axis");
          else if (rest) c.yRange = range(s, rest, restAt, "y-axis");
        }
        return;
      }
      case "bar":
      case "line": {
        const { title, rest } = leadingTitle(body);
        const restAt = at + body.length - rest.length;
        const l = list(s, rest, restAt);
        if (!l) return;
        const values: number[] = [];
        for (const it of l.items) {
          const v = parseNumber(it.text);
          if (v === undefined) {
            const cleaned = it.text.replace(/[,_\s$%€£]/g, "");
            const ok = parseNumber(cleaned);
            err(s, it.col, `"${it.text}" is not a number`, "Series values are plain numbers: [12, 18.5, -3]", ok !== undefined && it.text ? { old: it.text, new: cleaned } : undefined);
            values.push(ok ?? NaN);
          } else values.push(v);
        }
        c.series.push({ kind: kw, name: title, values, line: s.line });
        return;
      }
    }
  });
  const nCat = c.categories?.length;
  if (nCat !== undefined)
    for (const se of c.series)
      if (se.values.length !== nCat) errors.push({ line: se.line, col: 0, message: `This ${se.kind} has ${se.values.length} values but the x-axis has ${nCat} categories`, hint: "Give one value per category; extra values are left out" });
  return c;
}

export function renderXyChart(src: string, ctx: DiagramContext): Rendered {
  const th = ctx.theme;
  const c = parseXyChart(src, ctx.errors);
  if (c.title && !ctx.title) ctx.title = c.title;
  const title = c.title ?? ctx.title;
  const fs = th.fontSize;
  const small = Math.round(fs * 0.86 * 10) / 10;
  const bg = paper(th);
  const out: string[] = [];

  const nCat = c.categories?.length ?? Math.max(0, ...c.series.map((s) => s.values.length));
  const cats: string[] = c.categories ?? (c.xRange ? [] : Array.from({ length: nCat }, (_, i) => String(i + 1)));
  const head = titleBlock(title, th, 720);
  if (!nCat || !c.series.length) {
    const w = Math.max(260, head.width + 2 * MARGIN);
    const h = MARGIN + head.height + 36;
    out.push(head.svg, textAt(c.series.length ? "No categories to draw" : "No bar or line series to draw", MARGIN, MARGIN + head.height + 12, small, th.mutedText));
    return { svg: svgDocument(w, h, out.join(""), th, title), width: w, height: h };
  }

  // Value scale.
  const vals = c.series.flatMap((s) => s.values.slice(0, nCat)).filter((v) => Number.isFinite(v));
  const hasBars = c.series.some((s) => s.kind === "bar");
  let vmin = vals.length ? Math.min(...vals) : 0;
  let vmax = vals.length ? Math.max(...vals) : 1;
  if (hasBars || vmin > 0 && vmin < vmax * 0.35) vmin = Math.min(0, vmin);
  if (hasBars) vmax = Math.max(0, vmax);
  const sc = c.yRange ? niceScale(Math.min(...c.yRange), Math.max(...c.yRange), 5, true) : niceScale(vmin, vmax, 5);
  const dec = decimalsFor(sc.step);
  const big = Math.max(Math.abs(sc.lo), Math.abs(sc.hi)) >= 1e6;
  const fmt = (v: number) => formatNumber(v, big ? 1 : dec, big);
  const tickTexts = sc.ticks.map(fmt);

  // Series colours and the legend.
  const colorOf = (i: number) => th.palette[i % th.palette.length];
  const named = c.series.some((s) => s.name);
  const legend = named
    ? c.series.map((s, i) => ({ text: s.name ?? `${s.kind === "bar" ? "Bar" : "Line"} ${i + 1}`, color: colorOf(i), kind: s.kind }))
    : [];

  const H = c.horizontal;
  // Category labels and the numeric x range.
  const xr = c.xRange;
  const xs = xr ? niceScale(Math.min(...xr), Math.max(...xr), 6, true) : undefined;
  const catText = (i: number) => (cats[i] !== undefined ? escLabel(cats[i]) : "");

  // Lengths: category axis grows with the categories, value axis is fixed.
  const bars = c.series.filter((s) => s.kind === "bar");
  const perCat = Math.max(1, bars.length);
  const bandIdeal = H ? Math.max(26, 14 + perCat * 14) : Math.max(44, 22 + perCat * 18);
  const Lc = Math.round(Math.max(H ? 160 : 380, Math.min(H ? 620 : 760, nCat * bandIdeal)));
  const Lv = H ? 460 : 290;
  const band = Lc / nCat;

  // Gutters.
  const valueLabelW = Math.max(...tickTexts.map((t) => measure(t, small)));
  let catLabels = cats.map((_, i) => layoutLabel(catText(i), small, H ? 150 : Math.max(band - 6, 40)));
  // Thin out category labels that would collide.
  let every = 1;
  if (!H && !xr) {
    const widest = Math.max(0, ...catLabels.map((l) => l.width));
    while (every < nCat && widest > band * every - 6 && catLabels.some((l) => l.lines.length > 2)) every++;
    if (catLabels.some((l) => l.lines.length > 3)) catLabels = cats.map((_, i) => layoutLabel(catText(i), small, Math.max(band * every - 6, 40)));
  }
  if (H && !xr) {
    const tall = Math.max(...catLabels.map((l) => l.height));
    while (every < nCat && tall > band * every) every++;
  }
  const catLabH = Math.max(0, ...catLabels.map((l) => l.height));
  const catLabW = Math.max(0, ...catLabels.map((l) => l.width));
  const xTicksN = xs ? xs.ticks.map((v) => formatNumber(v, decimalsFor(xs.step))) : [];

  const legendH = legend.length ? small * 1.6 + 6 : 0;
  const axisTitleH = small * 1.5;
  const top = MARGIN + head.height + (head.height ? 4 : 0) + legendH;

  // Positions of the plot.
  let px0: number, py0: number, width: number, height: number;
  const catTitle = c.xTitle;
  const valTitle = c.yTitle;
  if (!H) {
    const left = MARGIN + Math.max(valueLabelW + 8, valTitle ? 0 : 0);
    px0 = left;
    py0 = top + (valTitle ? axisTitleH + 9 : 6);
    const below = (xr ? small * 1.4 : catLabH) + 10 + (catTitle ? axisTitleH + 4 : 0);
    width = Math.max(px0 + Lc + MARGIN + 6, head.width + 2 * MARGIN, valTitle ? MARGIN + measure(escLabel(valTitle), small) + MARGIN : 0);
    height = py0 + Lv + below + MARGIN;
  } else {
    const left = MARGIN + (xr ? Math.max(...xTicksN.map((t) => measure(t, small))) : catLabW) + 10;
    px0 = left;
    py0 = top + (catTitle ? axisTitleH + 4 : 6);
    width = Math.max(px0 + Lv + MARGIN + valueLabelW / 2 + 4, head.width + 2 * MARGIN);
    height = py0 + Lc + small * 1.4 + 10 + (valTitle ? axisTitleH + 4 : 0) + MARGIN;
  }

  // Coordinates: c along the category axis (0..Lc), v a value.
  const vpos = (v: number) => ((v - sc.lo) / (sc.hi - sc.lo)) * Lv;
  const P = (cc: number, v: number): [number, number] => (H ? [px0 + vpos(v), py0 + cc] : [px0 + cc, py0 + Lv - vpos(v)]);
  const catCentre = (i: number) => (i + 0.5) * band;

  out.push(head.svg);
  // Legend: swatches in a row under the title.
  if (legend.length) {
    let x = MARGIN;
    const cy = MARGIN + head.height + (head.height ? 4 : 0) + small * 0.8;
    for (const l of legend) {
      if (l.kind === "bar") out.push(`<rect x="${n(x)}" y="${n(cy - 5)}" width="10" height="10" rx="2" fill="${l.color}"/>`);
      else out.push(`<path d="M${n(x - 1)} ${n(cy)}H${n(x + 13)}" stroke="${l.color}" stroke-width="2" stroke-linecap="round"/><circle cx="${n(x + 6)}" cy="${n(cy)}" r="3" fill="${l.color}" stroke="${bg}" stroke-width="1"/>`);
      const sw = l.kind === "bar" ? 10 : 12;
      out.push(textAt(escLabel(l.text), x + sw + 6, cy, small, th.text));
      x += sw + 6 + measure(escLabel(l.text), small) + 18;
    }
    width = Math.max(width, x + MARGIN);
  }

  // Gridlines at the value ticks, and their labels.
  const grid = th.clusterStroke;
  sc.ticks.forEach((v, k) => {
    const [ax, ay] = P(0, v);
    const [bx, by] = P(Lc, v);
    const isZero = v === 0 && sc.lo < 0;
    out.push(`<path d="M${n(ax)} ${n(ay)}L${n(bx)} ${n(by)}" stroke="${isZero ? th.line : grid}" stroke-width="${isZero ? 1 : 0.75}"/>`);
    if (!H) out.push(plainText(tickTexts[k], px0 - 8, baselineFor(ay, small), small, th.mutedText, "end"));
    else out.push(plainText(tickTexts[k], ax, baselineFor(py0 + Lc + 6 + small * 0.6, small), small, th.mutedText, "middle"));
  });
  // Value axis title.
  if (valTitle) {
    if (!H) out.push(textAt(escLabel(valTitle), MARGIN, py0 - axisTitleH / 2 - 9, small, th.mutedText));
    else out.push(textAt(escLabel(valTitle), px0 + Lv / 2, py0 + Lc + small * 1.4 + 10 + axisTitleH / 2, small, th.mutedText, { align: "middle" }));
  }

  // Bars.
  const base = Math.min(Math.max(0, sc.lo), sc.hi);
  const groupW = band * (bars.length > 1 ? 0.78 : 0.62);
  const gap = bars.length > 1 ? Math.min(3, groupW / bars.length / 6) : 0;
  const barW = (groupW - gap * (bars.length - 1)) / Math.max(1, bars.length);
  const clampV = (v: number) => Math.max(sc.lo, Math.min(sc.hi, v));
  c.series.forEach((s, si) => {
    if (s.kind !== "bar") return;
    const bi = bars.indexOf(s);
    const color = colorOf(si);
    for (let i = 0; i < nCat && i < s.values.length; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) continue;
      const c0 = catCentre(i) - groupW / 2 + bi * (barW + gap);
      const v0 = clampV(base);
      const v1 = clampV(v);
      if (v0 === v1) continue;
      out.push(barPath(P, c0, barW, v0, v1, H, color));
    }
  });
  // The baseline, over the bars.
  if (sc.lo >= 0 || sc.hi <= 0) {
    const [ax, ay] = P(0, base);
    const [bx, by] = P(Lc, base);
    out.push(`<path d="M${n(ax)} ${n(ay)}L${n(bx)} ${n(by)}" stroke="${th.line}" stroke-width="1"/>`);
  }

  // Lines.
  c.series.forEach((s, si) => {
    if (s.kind !== "line") return;
    const color = colorOf(si);
    const pts: [number, number][] = [];
    let d = "";
    for (let i = 0; i < nCat && i < s.values.length; i++) {
      const v = s.values[i];
      if (!Number.isFinite(v)) {
        d += " ";
        continue;
      }
      const p = P(catCentre(i), clampV(v));
      d += `${d && !d.endsWith(" ") ? "L" : "M"}${n(p[0])} ${n(p[1])}`;
      pts.push(p);
    }
    out.push(`<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    const r = nCat > 40 ? 0 : nCat > 20 ? 2.2 : 3.2;
    if (r) for (const p of pts) out.push(`<circle cx="${n(p[0])}" cy="${n(p[1])}" r="${r}" fill="${color}" stroke="${bg}" stroke-width="1.2"/>`);
  });

  // Category axis: labels, or numeric ticks across the bands.
  if (xs) {
    const span = xs.hi - xs.lo;
    const at = (v: number) => catCentre(0) + ((v - xs.lo) / span) * (catCentre(nCat - 1) - catCentre(0) || Lc / 2);
    xs.ticks.forEach((v, k) => {
      const cc = nCat > 1 ? at(v) : Lc / 2;
      if (!H) {
        const x = px0 + cc;
        out.push(`<path d="M${n(x)} ${n(py0 + Lv)}V${n(py0 + Lv + 4)}" stroke="${th.line}" stroke-width="0.9"/>`);
        out.push(plainText(xTicksN[k], x, baselineFor(py0 + Lv + 6 + small * 0.6, small), small, th.mutedText, "middle"));
      } else {
        const y = py0 + cc;
        out.push(`<path d="M${n(px0 - 4)} ${n(y)}H${n(px0)}" stroke="${th.line}" stroke-width="0.9"/>`);
        out.push(plainText(xTicksN[k], px0 - 8, baselineFor(y, small), small, th.mutedText, "end"));
      }
    });
  } else {
    catLabels.forEach((lab, i) => {
      if (i % every) return;
      if (!H) labelSvgTop(out, lab, px0 + catCentre(i), py0 + Lv + 7, th.mutedText);
      else out.push(labelSvg(lab, px0 - 10, py0 + catCentre(i), th.text, { align: "end" }));
    });
  }
  if (catTitle) {
    if (!H) out.push(textAt(escLabel(catTitle), px0 + Lc / 2, height - MARGIN - axisTitleH / 2, small, th.mutedText, { align: "middle" }));
    else out.push(textAt(escLabel(catTitle), MARGIN, py0 - axisTitleH / 2 - 6, small, th.mutedText));
  }

  return { svg: svgDocument(width, height, out.join(""), th, title), width, height };
}

function labelSvgTop(out: string[], lab: ReturnType<typeof layoutLabel>, cx: number, top: number, fill: string): void {
  out.push(labelSvg(lab, cx, top + lab.height / 2, fill, { align: "middle" }));
}

/** A bar from v0 to v1 with its far end's corners rounded a little. */
function barPath(P: (c: number, v: number) => [number, number], c0: number, w: number, v0: number, v1: number, H: boolean, color: string): string {
  const [ax, ay] = P(c0, v0);
  const [bx, by] = P(c0 + w, v1);
  const x = Math.min(ax, bx);
  const y = Math.min(ay, by);
  const bw = Math.abs(bx - ax);
  const bh = Math.abs(by - ay);
  const r = Math.min(2, bw / 2, bh / 2);
  if (r <= 0.2) return `<rect x="${n(x)}" y="${n(y)}" width="${n(bw)}" height="${n(bh)}" fill="${color}"/>`;
  // Which side is the far end: up (vertical, positive), down, right or left.
  const far = H ? (v1 >= v0 ? "right" : "left") : v1 >= v0 ? "top" : "bottom";
  const X1 = x + bw;
  const Y1 = y + bh;
  let d: string;
  switch (far) {
    case "top":
      d = `M${n(x)} ${n(Y1)}V${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}H${n(X1 - r)}Q${n(X1)} ${n(y)} ${n(X1)} ${n(y + r)}V${n(Y1)}Z`;
      break;
    case "bottom":
      d = `M${n(x)} ${n(y)}V${n(Y1 - r)}Q${n(x)} ${n(Y1)} ${n(x + r)} ${n(Y1)}H${n(X1 - r)}Q${n(X1)} ${n(Y1)} ${n(X1)} ${n(Y1 - r)}V${n(y)}Z`;
      break;
    case "right":
      d = `M${n(x)} ${n(y)}H${n(X1 - r)}Q${n(X1)} ${n(y)} ${n(X1)} ${n(y + r)}V${n(Y1 - r)}Q${n(X1)} ${n(Y1)} ${n(X1 - r)} ${n(Y1)}H${n(x)}Z`;
      break;
    default:
      d = `M${n(X1)} ${n(y)}H${n(x + r)}Q${n(x)} ${n(y)} ${n(x)} ${n(y + r)}V${n(Y1 - r)}Q${n(x)} ${n(Y1)} ${n(x + r)} ${n(Y1)}H${n(X1)}Z`;
  }
  return `<path d="${d}" fill="${color}"/>`;
}
