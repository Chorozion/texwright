/**
 * Mermaid timelines. Periods sit as markers on one horizontal axis, read
 * left to right; each period's events hang below it as small cards, stacked
 * in source order. Sections become coloured bands above the periods they
 * group, and colour their markers and cards; without sections every period
 * takes the next palette colour, as in Mermaid.
 *
 *   timeline
 *     title History of the web
 *     section Early days
 *       1991 : First website
 *       1993 : Mosaic : CGI
 *            : HTML 2 drafts
 */

import { escLabel, isDark, MARGIN, mix, type Stmt, statementsOf, textAt, tint, titleBlock, unknownStatement } from "./chartkit.js";
import { labelSvg, n, shadowSvg, svgDocument } from "./svg.js";
import { type Label, layoutLabel } from "./text.js";
import type { DiagramContext, DiagramError, Rendered } from "./types.js";

export interface TimelinePeriod {
  label: string;
  events: string[];
  section: number;
  line: number;
}

export interface Timeline {
  title?: string;
  sections: string[];
  periods: TimelinePeriod[];
}

/** Splits at colons followed by a space or the end (a colon inside 10:30 stays text). */
function splitEvents(s: string): string[] {
  return s.split(/:(?=\s|$)/).map((x) => x.trim());
}

export function parseTimeline(src: string, errors: DiagramError[]): Timeline {
  const tl: Timeline = { sections: [], periods: [] };
  const stmts = statementsOf(src);
  let section = -1;
  stmts.forEach((s: Stmt, i) => {
    if (i === 0) {
      const rest = s.text.replace(/^timeline\b/, "").trim();
      if (rest && !/^(LR|TD|TB)$/.test(rest)) errors.push({ line: s.line, col: s.col + s.text.indexOf(rest), message: `Unexpected "${rest}" after timeline`, hint: "Put the title on its own line: title My timeline" });
      return;
    }
    const kw = /^(title|section|accTitle|accDescr)\b\s*:?\s*(.*)$/.exec(s.text);
    if (kw) {
      if (kw[1] === "title") tl.title = kw[2].trim();
      else if (kw[1] === "section") {
        tl.sections.push(kw[2].trim());
        section = tl.sections.length - 1;
      }
      return;
    }
    if (s.text.startsWith(":")) {
      const prev = tl.periods[tl.periods.length - 1];
      const evs = splitEvents(s.text.slice(1)).filter(Boolean);
      if (!prev) {
        errors.push({ line: s.line, col: s.col, message: "An event line with no period before it", hint: "Start with a period: 2021 : First event" });
        return;
      }
      prev.events.push(...evs);
      return;
    }
    const parts = splitEvents(s.text);
    if (parts.length === 1 && /^[A-Za-z]+$/.test(parts[0]) && !/^\d/.test(parts[0])) {
      // A lone word: probably a misspelt keyword (tilte, sectoin), or a period with no events.
      const err = unknownStatement(s, ["title", "section"], "timeline", "A period is  2021 : event : event; sections start with  section Name");
      if (err.fix) {
        errors.push(err);
        return;
      }
    }
    const label = parts[0];
    if (!label) {
      errors.push({ line: s.line, col: s.col, message: "A period needs a name before its events", hint: "Write  2021 : First event" });
      return;
    }
    tl.periods.push({ label, events: parts.slice(1).filter(Boolean), section, line: s.line });
  });
  return tl;
}

export function renderTimeline(src: string, ctx: DiagramContext): Rendered {
  const th = ctx.theme;
  const tl = parseTimeline(src, ctx.errors);
  if (tl.title && !ctx.title) ctx.title = tl.title;
  const title = tl.title ?? ctx.title;
  const fs = th.fontSize;
  const small = Math.round(fs * 0.9 * 10) / 10;
  const out: string[] = [];
  const head = titleBlock(title, th, 900);
  const P = tl.periods;
  if (!P.length) {
    const w = Math.max(260, head.width + 2 * MARGIN);
    const h = MARGIN + head.height + 36;
    out.push(head.svg, textAt("No periods to draw", MARGIN, MARGIN + head.height + 12, small, th.mutedText));
    return { svg: svgDocument(w, h, out.join(""), th, title), width: w, height: h };
  }

  const hasSections = P.some((p) => p.section >= 0);
  const colorOf = (p: TimelinePeriod, i: number) => th.palette[(hasSections ? Math.max(0, p.section) : i) % th.palette.length];
  const dark = isDark(th);
  const deep = (c: string) => (dark ? mix(c, "#ffffff", 0.35) : mix(c, th.text, 0.4));

  // Column width: what the widest card wants, within bounds, the same for every period.
  const cardPadX = 10;
  const cardPadY = 7;
  const natural = Math.max(...P.flatMap((p) => [layoutLabel(`<b>${escLabel(p.label)}</b>`, fs).width, ...p.events.map((e) => layoutLabel(escLabel(e), small).width + 2 * cardPadX)]));
  const colW = Math.round(Math.max(118, Math.min(184, natural)));
  const gapX = 14;

  const periodLabels: Label[] = P.map((p) => layoutLabel(`<b>${escLabel(p.label)}</b>`, fs, colW));
  const cards: Label[][] = P.map((p) => p.events.map((e) => layoutLabel(escLabel(e), small, colW - 2 * cardPadX)));

  out.push(head.svg);
  // Long timelines wrap into rows, so the chart stays readable on a page.
  const maxW = 940;
  const perRow = Math.max(2, Math.floor((maxW - 2 * MARGIN + gapX) / (colW + gapX)));
  const rows = Math.ceil(P.length / perRow);
  const per = Math.ceil(P.length / rows);
  const sectionLabels = tl.sections.map((s) => layoutLabel(`<b>${escLabel(s)}</b>`, small, 10_000));
  const bandH = hasSections ? Math.max(26, ...sectionLabels.map((l) => l.height + 10)) : 0;
  const cardShadow = th.shadow;
  let top = MARGIN + head.height + (head.height ? 6 : 0);
  let widest = 0;
  for (let r = 0; r < rows; r++) {
    const first = r * per;
    const idx = P.map((_, i) => i).slice(first, first + per);
    const colX = (i: number) => MARGIN + (i - first) * (colW + gapX);
    const bandY = top;
    const labelTop = top + (hasSections ? bandH + 12 : 0);
    const labelH = Math.max(...idx.map((i) => periodLabels[i].height));
    const axisY = labelTop + labelH + 12;
    const cardsTop = axisY + 18;
    const lastI = idx[idx.length - 1];
    const rowRight = colX(lastI) + colW;
    widest = Math.max(widest, rowRight + MARGIN);

    // Section bands span their columns.
    if (hasSections) {
      let k = 0;
      while (k < idx.length) {
        const s = P[idx[k]].section;
        let j = k;
        while (j + 1 < idx.length && P[idx[j + 1]].section === s) j++;
        const x = colX(idx[k]);
        const w = colX(idx[j]) + colW - x;
        if (s >= 0) {
          const c = colorOf(P[idx[k]], idx[k]);
          out.push(`<rect x="${n(x)}" y="${n(bandY)}" width="${n(w)}" height="${n(bandH)}" rx="2" fill="${tint(c, th, dark ? 0.7 : 0.8)}"/>`);
          out.push(`<rect x="${n(x)}" y="${n(bandY)}" width="3" height="${n(bandH)}" fill="${c}"/>`);
          const lab = layoutLabel(`<b>${escLabel(tl.sections[s])}</b>`, small, w - 20);
          out.push(labelSvg(lab, x + 12, bandY + bandH / 2, deep(c), { align: "start" }));
        }
        k = j + 1;
      }
    }

    // The axis (continuing past the row's end when more rows follow), then each period.
    const more = r < rows - 1;
    out.push(`<path d="M${n(MARGIN)} ${n(axisY)}H${n(rowRight + (more ? gapX / 2 : 0))}" stroke="${th.clusterStroke}" stroke-width="1.5" stroke-linecap="round"/>`);
    if (more) out.push(`<path d="M${n(rowRight + gapX / 2 - 5)} ${n(axisY - 4)}L${n(rowRight + gapX / 2)} ${n(axisY)}L${n(rowRight + gapX / 2 - 5)} ${n(axisY + 4)}" fill="none" stroke="${th.clusterStroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`);
    let bottom = axisY + 10;
    const body: string[] = [];
    for (const i of idx) {
      const p = P[i];
      const c = colorOf(p, i);
      const cx = colX(i) + colW / 2;
      out.push(labelSvg(periodLabels[i], cx, labelTop + labelH - periodLabels[i].height / 2, th.text, { align: "middle" }));
      let y = cardsTop;
      const heights = cards[i].map((l) => l.height + 2 * cardPadY);
      const last = cards[i].length ? cardsTop + heights.reduce((a, b) => a + b, 0) + 8 * (heights.length - 1) - heights[heights.length - 1] / 2 : axisY;
      if (cards[i].length) out.push(`<path d="M${n(cx)} ${n(axisY)}V${n(last)}" stroke="${tint(c, th, 0.45)}" stroke-width="1.25"/>`);
      out.push(`<circle cx="${n(cx)}" cy="${n(axisY)}" r="5.5" fill="${c}" stroke="${dark ? th.background : "#ffffff"}" stroke-width="2"/>`);
      cards[i].forEach((lab, k) => {
        const h = heights[k];
        const x = colX(i);
        body.push(shadowSvg("rect", x + colW / 2, y + h / 2, colW, h, 5, cardShadow));
        body.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(colW)}" height="${n(h)}" rx="5" fill="${tint(c, th, dark ? 0.78 : 0.88)}" stroke="${tint(c, th, dark ? 0.4 : 0.55)}" stroke-width="0.8"/>`);
        body.push(labelSvg(lab, x + colW / 2, y + h / 2, th.text, { align: "middle" }));
        y += h + 8;
      });
      bottom = Math.max(bottom, y);
    }
    out.push(...body);
    top = bottom + (more ? 22 : 0);
  }
  const width = Math.max(widest, head.width + 2 * MARGIN);
  const height = top + MARGIN;
  return { svg: svgDocument(width, height, out.join(""), th, title), width, height };
}
