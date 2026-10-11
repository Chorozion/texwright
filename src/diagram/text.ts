/**
 * Text for diagrams: labels parsed into lines of styled pieces, measured with
 * the very fonts the SVG renderer will draw them in, so a box always fits its
 * words in the PDF. Labels are set in the bundled Computer Modern Sans
 * (KaTeX_SansSerif), the sans face that matches the document's text; a
 * character it lacks falls back exactly as SVG text does.
 *
 * Label syntax follows what Mermaid accepts: <br> for a line break, <b> <i>
 * <strong> <em> for emphasis, entities (&amp;, #quot;, #9829;), and Markdown
 * strings in backticks with **bold**, *italic* and automatic wrapping
 * (underscores are left alone, so identifiers like snake_case survive).
 */

import type { Font } from "../font/index.js";
import { glyphFor, resolveFace, shapeRun } from "../svg/fonts.js";

/** The family diagrams name in their SVG. The SVG renderer maps it to the bundled face; HTML output embeds it. */
export const DIAGRAM_FONT = "KaTeX_SansSerif";

export interface Piece {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type Line = Piece[];

export interface Label {
  lines: Line[];
  /** Size of the block of lines, in px. */
  width: number;
  height: number;
  size: number;
  lineHeight: number;
  /** Baseline of the first line below the block's top. */
  ascent: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", deg: "°", times: "×", hearts: "♥" };

/** Mermaid's entity forms: &name; &#nn; &#xhh; and its own #name; #nn; */
function decodeEntities(s: string): string {
  return s.replace(/&#x([0-9a-f]+);|&#(\d+);|&([a-z]+);|#(\d+);|#([a-z]+);/gi, (m, hex, dec, name, mdec, mname) => {
    const cp = hex ? parseInt(hex, 16) : dec ? Number(dec) : mdec ? Number(mdec) : undefined;
    if (cp !== undefined) return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    const n = (name ?? mname).toLowerCase();
    return Object.hasOwn(ENTITIES, n) ? ENTITIES[n] : m;
  });
}

/**
 * A label's text as lines of styled pieces. `markdown` is Mermaid's
 * backtick string: **bold** and *italic* (underscores are left alone, so
 * snake_case survives), newlines as breaks.
 */
export function parseLabel(raw: string): { lines: Line[]; markdown: boolean } {
  let text = raw;
  let markdown = false;
  const md = /^\s*`([^]*)`\s*$/.exec(text);
  if (md) {
    text = md[1];
    markdown = true;
  }
  text = text.replace(/\r\n?/g, "\n");
  if (!markdown) text = text.replace(/\\n/g, "\n");
  const lines: Line[] = [[]];
  let bold = 0;
  let italic = 0;
  const push = (s: string) => {
    if (!s) return;
    const line = lines[lines.length - 1];
    const prev = line[line.length - 1];
    const b = bold > 0;
    const i = italic > 0;
    if (prev && !!prev.bold === b && !!prev.italic === i) prev.text += s;
    else line.push({ text: s, ...(b ? { bold: true } : {}), ...(i ? { italic: true } : {}) });
  };
  const re = markdown ? /(<br\s*\/?>|\n|\*\*|\*|<\/?(?:b|strong|i|em)>|<[^>]*>)/gi : /(<br\s*\/?>|\n|<\/?(?:b|strong|i|em)>|<[^>]*>)/gi;
  let at = 0;
  for (const m of text.matchAll(re)) {
    push(decodeEntities(text.slice(at, m.index)));
    at = m.index! + m[0].length;
    const tok = m[0].toLowerCase();
    if (tok === "\n" || tok.startsWith("<br")) lines.push([]);
    else if (tok === "**") bold = bold ? 0 : 1;
    else if (tok === "*") italic = italic ? 0 : 1;
    else if (tok === "<b>" || tok === "<strong>") bold++;
    else if (tok === "</b>" || tok === "</strong>") bold = Math.max(0, bold - 1);
    else if (tok === "<i>" || tok === "<em>") italic++;
    else if (tok === "</i>" || tok === "</em>") italic = Math.max(0, italic - 1);
    // Other tags are dropped; their text stays.
  }
  push(decodeEntities(text.slice(at)));
  // Collapse runs of spaces within a line, trim its ends.
  for (const line of lines) {
    for (const p of line) p.text = p.text.replace(/[ \t]+/g, " ");
    if (line.length) {
      line[0].text = line[0].text.replace(/^ +/, "");
      line[line.length - 1].text = line[line.length - 1].text.replace(/ +$/, "");
    }
  }
  return { lines: lines.map((l) => l.filter((p) => p.text.length)), markdown };
}

// ---------------------------------------------------------------- measuring

const widthCache = new Map<string, number>();

function fontFor(bold: boolean, italic: boolean) {
  return resolveFace(DIAGRAM_FONT, bold, italic);
}

/** Width of a piece of text in px at `size`, as the SVG renderer will shape it. */
export function textWidth(text: string, size: number, bold = false, italic = false): number {
  const key = `${bold ? 1 : 0}${italic ? 1 : 0}${size}\u0000${text}`;
  const hit = widthCache.get(key);
  if (hit !== undefined) return hit;
  const face = fontFor(bold, italic);
  const chars = [...text];
  const choice = chars.map((c) => glyphFor(face, c.codePointAt(0) as number));
  let w = 0;
  let i = 0;
  while (i < chars.length) {
    const font = choice[i].font;
    let j = i + 1;
    while (j < chars.length && choice[j].font === font) j++;
    w += shapeRun(
      font,
      size,
      choice.slice(i, j).map((g) => g.gid),
      chars.slice(i, j),
      0,
      0,
    ).width;
    i = j;
  }
  if (widthCache.size > 20000) widthCache.clear();
  // Bounded, for a long-running server that measures the labels of many diagrams.
  if (widthCache.size >= 20000) widthCache.clear();
  widthCache.set(key, w);
  return w;
}

export function lineWidth(line: Line, size: number): number {
  let w = 0;
  for (const p of line) w += textWidth(p.text, size, p.bold, p.italic);
  return w;
}

/** Splits lines longer than `max` px at spaces (a single long word stays whole). */
export function wrap(lines: Line[], size: number, max: number): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    if (lineWidth(line, size) <= max) {
      out.push(line);
      continue;
    }
    // Words keep their styles; a word may span pieces.
    const words: Line[] = [[]];
    for (const p of line) {
      const parts = p.text.split(/( )/);
      for (const part of parts) {
        if (part === " ") words.push([]);
        else if (part) words[words.length - 1].push({ ...p, text: part });
      }
    }
    let cur: Line = [];
    for (const w of words.filter((x) => x.length)) {
      const trial: Line = cur.length ? [...cur, { ...w[0], text: " " + w[0].text }, ...w.slice(1)] : w;
      if (cur.length && lineWidth(trial, size) > max) {
        out.push(merge(cur));
        cur = w;
      } else cur = trial;
    }
    if (cur.length) out.push(merge(cur));
  }
  return out;
}

function merge(line: Line): Line {
  const out: Line = [];
  for (const p of line) {
    const prev = out[out.length - 1];
    if (prev && !!prev.bold === !!p.bold && !!prev.italic === !!p.italic) prev.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

function metrics(): { ascent: number; descent: number } {
  const f: Font = fontFor(false, false).font;
  return { ascent: f.ascent / f.unitsPerEm, descent: -f.descent / f.unitsPerEm };
}

/** A label laid out: wrapped (Markdown strings and anything wider than `maxWidth`), measured. */
export function layoutLabel(raw: string, size: number, maxWidth = Infinity, lineHeightFactor = 1.3): Label {
  const parsed = parseLabel(raw);
  const lines = wrap(parsed.lines, size, maxWidth);
  const nonEmpty = lines.length && lines.some((l) => l.length) ? lines : [];
  const lh = size * lineHeightFactor;
  const m = metrics();
  const width = nonEmpty.reduce((w, l) => Math.max(w, lineWidth(l, size)), 0);
  // The block is as tall as its lines; the first baseline sits so the text is centred in the line.
  const ascent = (lh - (m.ascent + m.descent) * size) / 2 + m.ascent * size;
  return { lines: nonEmpty, width, height: nonEmpty.length ? nonEmpty.length * lh : 0, size, lineHeight: lh, ascent };
}
