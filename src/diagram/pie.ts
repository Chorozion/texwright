/**
 * Mermaid pie charts. Slices run clockwise from twelve o'clock in source
 * order, coloured from the theme's palette and parted by thin lines in the
 * paper colour. Each slice is labelled directly, outside the pie, with a
 * leader line: the name, then its share to one decimal (and the raw value
 * with showData). Labels on each side are spread apart so they never touch.
 * With many slices a legend at the right reads better, and is used instead.
 *
 *   pie showData title Browser share
 *     "Chrome" : 64.2
 *     "Safari" : 18.6
 */

import { escLabel, formatNumber, MARGIN, measure, paper, parseNumber, plainText, type Stmt, statementsOf, textAt, titleBlock, unknownStatement, baselineFor } from "./chartkit.js";
import { n, svgDocument } from "./svg.js";
import type { DiagramContext, Rendered } from "./types.js";

export interface PieSlice {
  label: string;
  value: number;
  line: number;
}

export interface PieChart {
  title?: string;
  showData: boolean;
  slices: PieSlice[];
}

export function parsePie(src: string, ctx: DiagramContext): PieChart {
  const stmts = statementsOf(src);
  const pie: PieChart = { showData: false, slices: [] };
  const err = ctx.errors;
  const head = (s: Stmt) => {
    let rest = s.text.replace(/^pie\b/, "").trim();
    if (/^showData\b/i.test(rest)) {
      pie.showData = true;
      rest = rest.replace(/^showData\b/i, "").trim();
    }
    const t = /^title\s+(.*)$/i.exec(rest);
    if (t) pie.title = t[1].trim();
  };
  stmts.forEach((s, i) => {
    if (i === 0) return head(s);
    const text = s.text;
    if (/^showData\s*$/i.test(text)) {
      pie.showData = true;
      return;
    }
    const t = /^title\b\s*(.*)$/i.exec(text);
    if (t) {
      pie.title = t[1].trim();
      return;
    }
    if (/^acc(Title|Descr)\b/.test(text) || text === "}" ) return;
    const m = /^("(?:[^"]*)"|'(?:[^']*)')\s*:\s*(.*)$/.exec(text);
    if (m) {
      const label = m[1].slice(1, -1);
      const vtext = m[2].trim();
      const v = parseNumber(vtext);
      const vcol = s.col + text.indexOf(vtext, m[1].length);
      if (v === undefined) {
        const cleaned = vtext.replace(/[,_\s%]/g, "");
        const fixable = parseNumber(cleaned);
        err.push({ line: s.line, col: vcol, message: `The value of "${label}" is not a number: "${vtext}"`, hint: 'A slice is "Label" : 42.5 with a plain number (no units, no thousands separators)', ...(fixable !== undefined ? { fix: { old: vtext, new: cleaned } } : {}) });
        return;
      }
      if (v < 0) {
        err.push({ line: s.line, col: vcol, message: `The value of "${label}" is negative`, hint: "A pie shows parts of a whole; every value must be zero or more" });
        return;
      }
      pie.slices.push({ label, value: v, line: s.line });
      return;
    }
    const bare = /^([^:"]+?)\s*:\s*(\S.*)$/.exec(text);
    if (bare && parseNumber(bare[2]) !== undefined) {
      err.push({ line: s.line, col: s.col, message: `The slice label "${bare[1]}" needs double quotes`, hint: 'Write slices as "Label" : value', fix: { old: bare[1], new: `"${bare[1]}"` } });
      pie.slices.push({ label: bare[1], value: Math.max(0, parseNumber(bare[2])!), line: s.line });
      return;
    }
    err.push(unknownStatement(s, ["title", "showData"], "pie chart", 'Write slices as "Label" : value, one per line'));
  });
  return pie;
}

/** Percent of a slice to one decimal, written the way people read it. */
export function percentText(v: number, total: number): string {
  if (total <= 0) return "0%";
  const p = (v / total) * 100;
  return `${p.toFixed(1)}%`;
}

export function renderPie(src: string, ctx: DiagramContext): Rendered {
  const t = ctx.theme;
  const pie = parsePie(src, ctx);
  if (pie.title && !ctx.title) ctx.title = pie.title;
  const title = pie.title ?? ctx.title;
  const total = pie.slices.reduce((s, x) => s + x.value, 0);
  const slices = pie.slices.filter((s) => s.value > 0);
  const fs = t.fontSize;
  const small = Math.round(fs * 0.9 * 10) / 10;
  const bg = paper(t);
  const out: string[] = [];

  const r = slices.length > 6 ? 120 : 110;
  const rows = slices.map((s, i) => {
    const pct = percentText(s.value, total);
    const val = pie.showData ? formatNumber(s.value, decimalsOf(s.value)) : "";
    return { ...s, color: t.palette[i % t.palette.length], pct, val };
  });

  // Angles: clockwise from twelve o'clock.
  let acc = 0;
  const geo = rows.map((s) => {
    const a0 = (acc / total) * Math.PI * 2;
    acc += s.value;
    const a1 = (acc / total) * Math.PI * 2;
    return { a0, a1, mid: (a0 + a1) / 2 };
  });

  // Labels: the name, then the share (and the value) in muted ink.
  const lineH = fs * 1.35;
  const labelText = (s: (typeof rows)[number]) => s.label;
  const detail = (s: (typeof rows)[number]) => (s.val ? `${s.pct}  (${s.val})` : s.pct);
  const useLegend = rows.length > 9;

  const head = titleBlock(title, t, 640);
  const top = MARGIN + head.height + (head.height ? 6 : 0);

  if (!rows.length) {
    const msg = "No slices to draw";
    const w = Math.max(240, head.width + 2 * MARGIN);
    const h = top + 40;
    out.push(head.svg, textAt(msg, MARGIN, top + 14, small, t.mutedText));
    return { svg: svgDocument(w, h, out.join(""), t, title), width: w, height: h };
  }

  if (!useLegend) {
    // Direct labels on both sides; each side's labels are spread vertically.
    const elbow = r + 12;
    const textGap = r + 30;
    type Lab = { i: number; side: 1 | -1; want: number; y: number; h: number; w: number };
    const labs: Lab[] = rows.map((s, i) => {
      const m = geo[i].mid;
      const side: 1 | -1 = Math.sin(m) >= 0 ? 1 : -1;
      const want = -Math.cos(m) * elbow;
      const w = Math.max(measure(escLabel(labelText(s)), fs), measure(detail(s), small));
      return { i, side, want, y: want, h: lineH + small * 1.25, w };
    });
    // Spread each side: overlapping labels form groups centred on their wanted positions.
    const spread = (list: Lab[]) => {
      list.sort((a, b) => a.want - b.want);
      type Group = { items: Lab[]; top: number; h: number };
      const groups: Group[] = [];
      const gap = 4;
      for (const l of list) {
        groups.push({ items: [l], top: l.want - l.h / 2, h: l.h });
        // Merge while the last group overlaps the one before it.
        while (groups.length > 1) {
          const g = groups[groups.length - 1];
          const p = groups[groups.length - 2];
          if (p.top + p.h + gap <= g.top) break;
          groups.pop();
          const items = [...p.items, ...g.items];
          const h = items.reduce((s, x) => s + x.h, 0) + gap * (items.length - 1);
          const centre = items.reduce((s, x) => s + x.want, 0) / items.length;
          p.items = items;
          p.h = h;
          p.top = centre - h / 2;
        }
      }
      for (const g of groups) {
        let y = g.top;
        for (const l of g.items) {
          l.y = y + l.h / 2;
          y += l.h + gap;
        }
      }
    };
    const right = labs.filter((l) => l.side === 1);
    const left = labs.filter((l) => l.side === -1);
    spread(right);
    spread(left);
    const reachL = Math.max(0, ...left.map((l) => l.w));
    const reachR = Math.max(0, ...right.map((l) => l.w));
    const minY = Math.min(-r, ...labs.map((l) => l.y - l.h / 2));
    const maxY = Math.max(r, ...labs.map((l) => l.y + l.h / 2));
    const cx = MARGIN + (left.length ? textGap + reachL + 4 : r + 4);
    const cy = top + 4 - minY;
    const width = Math.max(cx + (right.length ? textGap + reachR + 4 : r + 4) + MARGIN, head.width + 2 * MARGIN);
    const height = cy + maxY + MARGIN + 4;

    out.push(head.svg);
    out.push(slicesSvg(geo, rows, cx, cy, r, bg));
    for (const l of labs) {
      const s = rows[l.i];
      const m = geo[l.i].mid;
      const px = cx + Math.sin(m) * (r - 2);
      const py = cy - Math.cos(m) * (r - 2);
      const ex = cx + Math.sin(m) * elbow;
      const ey = cy - Math.cos(m) * elbow;
      const ly = cy + l.y;
      const tx = cx + l.side * textGap;
      // Leader: out from the slice, across to the label.
      const lead = `M${n(px)} ${n(py)}L${n(ex)} ${n(ey)}L${n(tx - l.side * 6)} ${n(ly)}`;
      out.push(`<path d="${lead}" fill="none" stroke="${t.mutedText}" stroke-width="0.75" stroke-opacity="0.7" stroke-linejoin="round"/>`);
      out.push(`<circle cx="${n(px)}" cy="${n(py)}" r="1.6" fill="${t.text}"/>`);
      const align = l.side === 1 ? "start" : "end";
      const nameY = ly - l.h / 2 + lineH / 2;
      out.push(textAt(escLabel(labelText(s)), tx, nameY, fs, t.text, { align }));
      out.push(plainText(detail(s), tx, baselineFor(nameY + lineH / 2 + small * 0.62, small), small, t.mutedText, align));
    }
    return { svg: svgDocument(width, height, out.join(""), t, title), width, height };
  }

  // Legend at the right: swatch, name, share right-aligned, value.
  const sw = 10;
  const rowH = Math.max(fs * 1.5, 20);
  const nameW = Math.max(...rows.map((s) => measure(escLabel(s.label), fs)));
  const pctW = Math.max(...rows.map((s) => measure(s.pct, small)));
  const valW = pie.showData ? Math.max(...rows.map((s) => measure(s.val, small))) : 0;
  const legendH = rows.length * rowH;
  const plotH = Math.max(2 * r, legendH);
  const cx = MARGIN + r + 2;
  const cy = top + plotH / 2;
  const lx = cx + r + 32;
  const width = Math.max(lx + sw + 8 + nameW + 18 + pctW + (valW ? 14 + valW : 0) + MARGIN, head.width + 2 * MARGIN);
  const height = top + plotH + MARGIN + 4;
  out.push(head.svg);
  out.push(slicesSvg(geo, rows, cx, cy, r, bg));
  const ly0 = cy - legendH / 2;
  rows.forEach((s, i) => {
    const y = ly0 + i * rowH + rowH / 2;
    out.push(`<rect x="${n(lx)}" y="${n(y - sw / 2)}" width="${sw}" height="${sw}" rx="2" fill="${s.color}"/>`);
    out.push(textAt(escLabel(s.label), lx + sw + 8, y, fs, t.text));
    const px = lx + sw + 8 + nameW + 18 + pctW;
    out.push(plainText(s.pct, px, baselineFor(y, small), small, t.mutedText, "end"));
    if (valW) out.push(plainText(s.val, px + 14 + valW, baselineFor(y, small), small, t.mutedText, "end"));
  });
  return { svg: svgDocument(width, height, out.join(""), t, title), width, height };
}

function decimalsOf(v: number): number {
  const s = String(v);
  const i = s.indexOf(".");
  return i < 0 ? 0 : Math.min(4, s.length - i - 1);
}

function slicesSvg(geo: { a0: number; a1: number }[], rows: { color: string }[], cx: number, cy: number, r: number, bg: string): string {
  const out: string[] = [];
  const pt = (a: number): string => `${n(cx + Math.sin(a) * r)} ${n(cy - Math.cos(a) * r)}`;
  geo.forEach((g, i) => {
    const sweep = g.a1 - g.a0;
    if (sweep >= Math.PI * 2 - 1e-9) {
      out.push(`<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${rows[i].color}"/>`);
      return;
    }
    const large = sweep > Math.PI ? 1 : 0;
    out.push(`<path d="M${n(cx)} ${n(cy)}L${pt(g.a0)}A${n(r)} ${n(r)} 0 ${large} 1 ${pt(g.a1)}Z" fill="${rows[i].color}"/>`);
  });
  // Separators in the paper colour, drawn over the slices so every edge is the same weight.
  if (geo.length > 1)
    for (const g of geo) out.push(`<path d="M${n(cx)} ${n(cy)}L${pt(g.a0)}" stroke="${bg}" stroke-width="1.5" stroke-linecap="round"/>`);
  return out.join("");
}
