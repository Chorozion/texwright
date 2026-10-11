/**
 * Mermaid user journeys: sections of tasks, each task scored 1 to 5 by how
 * it feels, with the actors who take part.
 *
 * Drawn as a row of task cards under coloured section bands, the actors as
 * coloured dots on each card (named in a legend under the title), and below
 * the cards the journey's mood: a face per task, higher for better scores,
 * its mouth and colour following the score (red for 1 and 2, amber for 3,
 * green for 4 and 5), joined by one smooth line around a dashed neutral
 * baseline, so the low points of the journey show at a glance.
 */

import { luminance, mix, pageColor } from "./mindmap.js";
import { labelSvg, n, type Pt, pathData, shadowSvg, shapeSvg, smoothPath, svgDocument } from "./svg.js";
import { type Label, layoutLabel } from "./text.js";
import { type DiagramContext, type DiagramError, type Rendered, stripComment, unquote } from "./types.js";

export interface JourneyTask {
  name: string;
  /** 1..5, or undefined when the score could not be read. */
  score?: number;
  actors: string[];
  section: number;
  line: number;
}

export interface Journey {
  title?: string;
  /** Section names; tasks before the first section belong to an unnamed one (""). */
  sections: string[];
  tasks: JourneyTask[];
  /** Actors in order of first appearance. */
  actors: string[];
}

export function parseJourney(src: string, errors: DiagramError[]): Journey {
  const j: Journey = { sections: [], tasks: [], actors: [] };
  const err = (line: number, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line, col, message, hint, fix });
  const lines = src.split(/\r?\n/);
  let headerSeen = false;
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = stripComment(lines[ln]);
    if (!raw.trim()) continue;
    const col = raw.length - raw.trimStart().length;
    let text = raw.trim();
    if (!headerSeen) {
      headerSeen = true;
      const h = /^journey\b\s*(.*)$/.exec(text);
      if (h) {
        if (!h[1].trim()) continue;
        text = h[1].trim();
      }
    }
    const kw = /^(title|section|accTitle|accDescr)\b\s*:?\s*(.*)$/.exec(text);
    if (kw) {
      const rest = kw[2].trim();
      if (kw[1] === "title") {
        if (rest) j.title = unquote(rest);
        else err(ln, col, "The title is empty", "Write: title My working day");
      } else if (kw[1] === "section") {
        j.sections.push(unquote(rest));
      }
      continue;
    }
    // Task: name: score[: actors]. The name may itself contain colons, so read from the right.
    const parts = text.split(":");
    if (parts.length < 2) {
      err(ln, col, "This line is neither a section nor a task", "A task is written Name: score: Actor, Actor, with a score from 1 to 5");
      continue;
    }
    let name: string;
    let scoreText: string;
    let actorText = "";
    if (parts.length === 2) {
      [name, scoreText] = parts;
    } else if (/^\s*-?\d+(\.\d+)?\s*$/.test(parts[parts.length - 2]) || !/^\s*-?\d+(\.\d+)?\s*$/.test(parts[parts.length - 1])) {
      actorText = parts[parts.length - 1];
      scoreText = parts[parts.length - 2];
      name = parts.slice(0, -2).join(":");
    } else {
      // "Name: with colon: 4": no actors.
      scoreText = parts[parts.length - 1];
      name = parts.slice(0, -1).join(":");
    }
    name = unquote(name);
    const scoreCol = col + text.indexOf(scoreText, name.length) + (scoreText.length - scoreText.trimStart().length);
    const st = scoreText.trim();
    let score: number | undefined;
    const num = Number(st);
    if (!st || !/^-?\d+(\.\d+)?$/.test(st)) {
      err(ln, scoreCol, st ? `"${st}" is not a score` : "The task has no score", "Scores are whole numbers from 1 (bad) to 5 (good): Name: 3: Actor");
    } else if (!Number.isInteger(num) || num < 1 || num > 5) {
      const fixed = Math.min(5, Math.max(1, Math.round(num)));
      err(ln, scoreCol, `The score ${st} is outside 1 to 5`, "Scores run from 1 (bad) to 5 (good)", { old: st, new: String(fixed) });
      score = fixed;
    } else score = num;
    if (!j.sections.length) j.sections.push("");
    const actors = actorText
      .split(",")
      .map((a) => unquote(a))
      .filter(Boolean);
    for (const a of actors) if (!j.actors.includes(a)) j.actors.push(a);
    j.tasks.push({ name: name || "(unnamed)", score, actors, section: j.sections.length - 1, line: ln });
  }
  return j;
}

const MOOD = { sad: "#d4635e", meh: "#e0a238", happy: "#59a14f" };

/** A face for a score: tinted disc, two eyes, a mouth that curves with the score. */
function face(x: number, y: number, r: number, score: number, page: string, ink: string): string {
  const c = score <= 2 ? MOOD.sad : score === 3 ? MOOD.meh : MOOD.happy;
  const fill = mix(c, page, 0.72);
  const feature = luminance(page) > 0.5 ? mix(c, "#000000", 0.45) : mix(c, ink, 0.35);
  const ex = r * 0.36;
  const ey = y - r * 0.2;
  const er = Math.max(1.1, r * 0.11);
  const curve = (score - 3) * r * 0.25;
  const my = y + r * 0.34 - curve * 0.35;
  const mw = r * 0.48;
  return (
    `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${fill}" stroke="${c}" stroke-width="1.3"/>` +
    `<circle cx="${n(x - ex)}" cy="${n(ey)}" r="${n(er)}" fill="${feature}"/><circle cx="${n(x + ex)}" cy="${n(ey)}" r="${n(er)}" fill="${feature}"/>` +
    `<path d="M${n(x - mw)} ${n(my)}Q${n(x)} ${n(my + curve * 2)} ${n(x + mw)} ${n(my)}" fill="none" stroke="${feature}" stroke-width="1.4" stroke-linecap="round"/>`
  );
}

export function renderJourney(src: string, ctx: DiagramContext): Rendered {
  const t = ctx.theme;
  const j = parseJourney(src, ctx.errors);
  if (!ctx.title && j.title) ctx.title = j.title;
  if (!j.tasks.length) {
    ctx.errors.push({ line: 0, col: 0, message: "The journey has no tasks", hint: "Add tasks under a section: Make tea: 5: Me" });
    return { svg: "", width: 0, height: 0 };
  }
  const page = pageColor(t);
  const fs = t.fontSize;
  const M = 8;
  const out: string[] = [];

  const sectionColor = (i: number) => t.palette[i % t.palette.length];
  // Actors avoid the palette's red, amber and green (slots 1 to 3), which the faces use for mood.
  const actorSlots = [0, ...t.palette.keys()].filter((i, k) => k === 0 || i > 3);
  const actorColor = (a: number) => t.palette[actorSlots[a % actorSlots.length]];

  // Cards share one width, so the mood line's steps are even.
  const rawLabels = j.tasks.map((k) => layoutLabel(k.name, fs - 0.5, 136, 1.25));
  const cw = Math.max(108, Math.min(156, Math.max(...rawLabels.map((l) => l.width)) + 24));
  const labels = j.tasks.map((k) => layoutLabel(k.name, fs - 0.5, cw - 20, 1.25));
  const hasActors = j.tasks.some((k) => k.actors.length);
  const ch = Math.max(...labels.map((l) => l.height)) + 18 + (hasActors ? 14 : 0);
  const GAP = 10;
  const SGAP = 20;

  // Columns: x of each card, a wider gap between sections.
  const xs: number[] = [];
  let x = M;
  j.tasks.forEach((k, i) => {
    if (i > 0) x += k.section !== j.tasks[i - 1].section ? SGAP : GAP;
    xs.push(x);
    x += cw;
  });
  let width = x + M;

  // Title and the legend of actors.
  let y = M;
  if (ctx.title) {
    const tl = layoutLabel(`<b>${ctx.title}</b>`, fs + 3, Math.max(width - 2 * M, 300));
    out.push(labelSvg(tl, M, y + tl.height / 2, t.text, { align: "start" }));
    width = Math.max(width, tl.width + 2 * M);
    y += tl.height + 6;
  }
  if (j.actors.length) {
    let lx = M;
    const lh = fs + 6;
    for (const [i, a] of j.actors.entries()) {
      const lab = layoutLabel(a, fs - 1);
      const w = 14 + lab.width + 16;
      if (lx > M && lx + w > Math.max(width, 560) - M) {
        lx = M;
        y += lh;
      }
      out.push(`<circle cx="${n(lx + 5)}" cy="${n(y + lh / 2)}" r="4.5" fill="${actorColor(i)}"/>`);
      out.push(labelSvg(lab, lx + 14, y + lh / 2, t.mutedText, { align: "start" }));
      lx += w;
      width = Math.max(width, lx + M);
    }
    y += lh + 8;
  } else if (ctx.title) y += 4;

  // Section bands.
  const bandLabels = j.sections.map((s, si) => {
    const idx = j.tasks.map((k, i) => (k.section === si ? i : -1)).filter((i) => i >= 0);
    if (!idx.length || !s) return undefined;
    const x0 = xs[idx[0]];
    const x1 = xs[idx[idx.length - 1]] + cw;
    return { si, x0, x1, label: layoutLabel(`<b>${s}</b>`, fs - 0.5, x1 - x0 - 16, 1.2) };
  });
  const bh = Math.max(0, ...bandLabels.map((b) => (b ? b.label.height + 12 : 0)));
  if (bh) {
    for (const b of bandLabels) {
      if (!b) continue;
      const c = sectionColor(b.si);
      out.push(`<rect x="${n(b.x0)}" y="${n(y)}" width="${n(b.x1 - b.x0)}" height="${n(bh)}" rx="4" fill="${mix(c, page, 0.72)}"/>`);
      out.push(`<rect x="${n(b.x0)}" y="${n(y)}" width="4" height="${n(bh)}" rx="1.5" fill="${c}"/>`);
      out.push(labelSvg(b.label, b.x0 + 12, y + bh / 2, t.text, { align: "start" }));
    }
    y += bh + 8;
  }

  // Cards.
  const cardTop = y;
  j.tasks.forEach((k, i) => {
    const c = sectionColor(k.section);
    const cx = xs[i] + cw / 2;
    const cy = cardTop + ch / 2;
    out.push(shadowSvg("rect", cx, cy, cw, ch, 5, t.shadow));
    out.push(shapeSvg("rect", cx, cy, cw, ch, { fill: mix(c, page, 0.92), stroke: mix(c, page, 0.25), strokeWidth: 1, radius: 5 }));
    const lab: Label = labels[i];
    const textH = ch - (hasActors ? 14 : 0);
    out.push(labelSvg(lab, cx, cardTop + textH / 2 + 1, t.text));
    k.actors.forEach((a, ai) => {
      const per = Math.min(11, (cw - 20) / Math.max(1, k.actors.length));
      out.push(`<circle cx="${n(xs[i] + 12 + ai * per)}" cy="${n(cardTop + ch - 11)}" r="3.6" fill="${actorColor(j.actors.indexOf(a))}" stroke="${page}" stroke-width="0.8"/>`);
    });
  });
  y = cardTop + ch;

  // The mood: faces at the height of their scores, a dashed neutral line, one curve through them.
  const R = 12;
  const STEP = 21;
  const moodTop = y + 18 + R;
  const yOf = (s: number) => moodTop + (5 - s) * STEP;
  const mid = yOf(3);
  const lineColor = mix(t.line, page, 0.55);
  out.push(`<path d="M${n(xs[0])} ${n(mid)}H${n(xs[xs.length - 1] + cw)}" stroke="${lineColor}" stroke-width="1" stroke-dasharray="4 4" fill="none"/>`);
  const pts: Pt[] = [];
  const faces: string[] = [];
  j.tasks.forEach((k, i) => {
    const cx = xs[i] + cw / 2;
    const c = sectionColor(k.section);
    if (k.score === undefined) {
      out.push(`<path d="M${n(cx)} ${n(y + 3)}V${n(mid)}" stroke="${mix(c, page, 0.5)}" stroke-width="1" stroke-dasharray="1.5 3" fill="none"/>`);
      return;
    }
    const fy = yOf(k.score);
    out.push(`<path d="M${n(cx)} ${n(y + 3)}V${n(fy - R - 2)}" stroke="${mix(c, page, 0.5)}" stroke-width="1" stroke-dasharray="1.5 3" stroke-linecap="round" fill="none"/>`);
    pts.push([cx, fy]);
    faces.push(face(cx, fy, R, k.score, page, t.text));
  });
  if (pts.length > 1) out.push(`<path d="${pathData(smoothPath(pts, false))}" fill="none" stroke="${mix(t.line, page, 0.25)}" stroke-width="1.5" stroke-linecap="round"/>`);
  out.push(...faces);
  const height = yOf(1) + R + 2 + M;
  return { svg: svgDocument(width, height, out.join(""), t, ctx.title), width, height };
}
