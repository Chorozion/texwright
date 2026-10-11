/**
 * Microtypography the pdfTeX way (microtype's protrusion and expansion).
 *
 * Character protrusion (margin kerning): a character at the start or end of
 * a justified line hangs into the margin by a fraction of its width, so
 * the margins look straight even though hyphens, periods and quotes are
 * light. The fractions, in thousandths of the character's width, are
 * microtype's default protrusion set (microtype.cfg, used for Computer and
 * Latin Modern), extended to the Unicode quotes and dashes. The line
 * breaker counts the protrusion as extra room on the line (pdfTeX's
 * \pdfprotrudechars=2) and the line gets margin kerns at its ends.
 *
 * Font expansion: the glyphs of a line may be widened or narrowed by up to
 * `stretch` or `shrink` thousandths (microtype's defaults: 20, so 2%) in
 * steps of `step`, which pdfTeX uses before the interword glue
 * (\pdfadjustspacing=2): a line whose shortfall the glyphs can absorb
 * counts as nearly perfect, and only what they cannot absorb stretches the
 * spaces. Every expandable glyph of a line gets the same factor, so a line
 * is drawn with one horizontal scale (PDF's Tz). Like microtype's
 * "basictext" set, only medium-weight, proportional faces take part: bold
 * and monospaced text is left alone.
 */

import type { Font } from "../font/index.js";
import type { Glyphs, HNode } from "./types.js";

export interface MicrotypeOptions {
  /** Hang characters into the margins. Default true. */
  protrusion?: boolean;
  /** Widen or narrow glyphs to even out interword spaces. Default true. */
  expansion?: boolean;
  /** Largest widening, in thousandths of the glyph width. Default 20. */
  stretch?: number;
  /** Largest narrowing, in thousandths. Default 20. */
  shrink?: number;
  /** Expansion is a multiple of this many thousandths. Default 1. */
  step?: number;
}

/** Options with every default filled in; protrusion and expansion off when `o` is false or undefined. */
export interface Microtype {
  protrusion: boolean;
  expansion: boolean;
  stretch: number;
  shrink: number;
  step: number;
}

export function microtypeSettings(o: MicrotypeOptions | false | undefined): Microtype | undefined {
  if (!o) return undefined;
  const lim = (v: number | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : d);
  const m: Microtype = {
    protrusion: o.protrusion !== false,
    expansion: o.expansion !== false,
    stretch: lim(o.stretch, 20),
    shrink: lim(o.shrink, 20),
    step: Math.max(1, lim(o.step, 1)),
  };
  if (m.stretch === 0 && m.shrink === 0) m.expansion = false;
  return m.protrusion || m.expansion ? m : undefined;
}

/**
 * Reads a document's microtype request: true or false, a map
 * ({protrusion: false}), or microtype's key=value options as LaTeX writes
 * them ("protrusion=true,expansion=false", "disable", "draft").
 * Returns undefined for a value it cannot use.
 */
const MICROTYPE_WORDS = new Set(["protrusion", "expansion", "disable", "draft", "final", "enable", "tracking", "kerning", "spacing", "auto", "babel", "verbose", "nopatch", "selected", "config", "defersetup", "letterspace", "factor", "stretch", "shrink", "step", "unit", "activate", "deactivate"]);

export function parseMicrotype(v: unknown, base: MicrotypeOptions | false | undefined): MicrotypeOptions | false | undefined {
  const on = (x: unknown): boolean | undefined => {
    if (typeof x === "boolean") return x;
    const s = String(x).trim().toLowerCase();
    if (s === "" || s === "true" || s === "yes" || s === "on" || s === "compatibility" || s === "alltext" || s === "basictext" || s === "smallcaps" || s === "allmath" || s === "all") return true;
    if (s === "false" || s === "no" || s === "off" || s === "nonfonts" || s === "none") return false;
    return undefined;
  };
  const start: MicrotypeOptions = base ? { ...base } : { protrusion: true, expansion: true };
  if (typeof v === "boolean") return v ? start : false;
  let entries: [string, unknown][];
  if (typeof v === "string") {
    const s = v.trim();
    const whole = on(s);
    if (whole !== undefined && !s.includes("=")) return whole ? start : false;
    // A single word must be one of microtype's options; in a list, unknown options are ignored.
    if (!/[=,]/.test(s) && !MICROTYPE_WORDS.has(s.toLowerCase())) return undefined;
    entries = s
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf("=");
        return i < 0 ? [p, true] : [p.slice(0, i).trim(), p.slice(i + 1).trim().replace(/^\{|\}$/g, "")];
      });
  } else if (v && typeof v === "object" && !Array.isArray(v)) entries = Object.entries(v as Record<string, unknown>);
  else return undefined;
  const out: MicrotypeOptions = { ...start };
  for (const [rawKey, value] of entries) {
    const key = rawKey.toLowerCase();
    if (key === "disable" || key === "draft") {
      if (on(value) !== false) return false;
    } else if (key === "protrusion" || key === "expansion") {
      const b = on(value);
      if (b === undefined) return undefined;
      out[key] = b;
    } else if (key === "stretch" || key === "shrink" || key === "step") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) return undefined;
      out[key] = n;
    } else if (key === "enable" || key === "final") {
      if (on(value) === false) return false;
    }
    // Other microtype options (tracking, kerning, spacing, factor, letterspace, auto, ...) are accepted and ignored.
  }
  return out;
}

// ----------------------------------------------------------------- protrusion

/** [left, right] protrusion in thousandths of the character's width. */
const PROTRUSION = new Map<string, readonly [number, number]>();
const set = (chars: string, left: number, right: number) => {
  for (const c of chars) PROTRUSION.set(c, [left, right]);
};
// microtype.cfg, "default" protrusion set (OT1/T1 encodings, Computer Modern and Latin Modern).
set("A", 50, 50);
set("Æ", 50, 0);
set("F", 0, 50);
set("J", 50, 0);
set("K", 0, 50);
set("L", 0, 50);
set("TVWXY", 50, 50);
set("k", 0, 50);
set("r", 0, 50);
set("t", 0, 70);
set("vwx", 50, 50);
set("y", 0, 50);
set("1", 150, 150);
set("23", 50, 50);
set("4", 100, 50);
set("6", 50, 0);
set("7", 50, 80);
set("9", 50, 50);
set(".", 0, 700);
set(",", 0, 500);
set(":", 0, 500);
set(";", 0, 300);
set("!", 0, 100);
set("?", 0, 200);
set("@", 50, 50);
set("~", 200, 250);
set("%", 0, 50);
set("*", 300, 300);
set("+", 250, 250);
set("-‐‑", 400, 500);
set("=", 100, 100);
set("/", 100, 200);
set("_", 100, 100);
set("(", 100, 0);
set(")", 0, 200);
set("[", 100, 0);
set("]", 0, 100);
set("–", 200, 200); // en dash
set("—", 150, 150); // em dash
set("‘`", 700, 0); // opening single quote
set("’'", 0, 700); // closing single quote, apostrophe
set("“", 500, 0); // opening double quote
set("”", 0, 500); // closing double quote
set('"', 300, 300);
set("‚„", 400, 400); // low quotes
set("«", 400, 300);
set("»", 300, 400);
set("‹", 400, 400);
set("›", 300, 400);
set("…", 0, 500); // ellipsis

/** Protrusion factors (thousandths) of a character, [left, right]; [0, 0] when it does not protrude. */
export function protrusionFactors(ch: string): readonly [number, number] {
  return PROTRUSION.get(ch) ?? [0, 0];
}

const eligibleCache = new WeakMap<Font, boolean>();

/** Medium-weight proportional faces take part (microtype's basictext); bold and monospaced ones do not. */
export function microtypeFont(font: Font): boolean {
  let v = eligibleCache.get(font);
  if (v === undefined) {
    v = !font.bold && !font.isFixedPitch;
    eligibleCache.set(font, v);
  }
  return v;
}

function charWidth(g: Glyphs, i: number): number {
  return (g.font.advance(g.gids[i]) * g.size) / g.font.unitsPerEm;
}

/** Items a protrusion search passes over: marks, penalties and things with no width. */
function passable(n: HNode): boolean {
  switch (n.t) {
    case "penalty":
    case "anchor":
    case "link-start":
    case "link-end":
    case "outline":
    case "footnote":
    case "float":
    case "struct":
      return true;
    case "kern":
      return n.width === 0;
    case "glue":
      return n.width === 0 && n.stretch === 0 && n.shrink === 0;
    case "hbox":
      return n.width === 0 && n.children.length === 0;
    case "glyphs":
      return n.gids.length === 0;
    default:
      return false;
  }
}

/** How far the first character at or after list[from] (up to `end`) hangs into the left margin, in points. */
export function leftProtrusion(list: readonly HNode[], from: number, end = list.length): number {
  for (let i = from; i < end; i++) {
    const n = list[i];
    if (passable(n)) continue;
    if (n.t !== "glyphs" || !microtypeFont(n.font)) return 0;
    const ch = n.text[0];
    if (!ch) return 0;
    const f = protrusionFactors(ch.length > 1 ? String.fromCodePoint(ch.codePointAt(0)!) : ch)[0];
    return f ? (f / 1000) * charWidth(n, 0) : 0;
  }
  return 0;
}

/** How far the last character before list[to] (back to `start`) hangs into the right margin, in points. */
export function rightProtrusion(list: readonly HNode[], to: number, start = 0): number {
  for (let i = to - 1; i >= start; i--) {
    const n = list[i];
    if (passable(n)) continue;
    if (n.t !== "glyphs" || !microtypeFont(n.font)) return 0;
    const k = n.gids.length - 1;
    const t = n.text[k];
    if (!t) return 0;
    const ch = [...t].pop()!;
    const f = protrusionFactors(ch)[1];
    return f ? (f / 1000) * charWidth(n, k) : 0;
  }
  return 0;
}

// ------------------------------------------------------------------ expansion

/** Total width of the glyphs in a list that may expand (each glyph's share of a line's font stretch is its width times the limit). */
export function expandableWidth(n: HNode): number {
  return n.t === "glyphs" && n.gids.length && microtypeFont(n.font) ? n.width : 0;
}

/**
 * The expansion (thousandths, negative to narrow) that absorbs as much of
 * `excess` as the glyphs allow: excess > 0 means the line is short. Rounded
 * to whole steps, within the limits (pdfTeX's font_expand_ratio and fix_expand_value).
 */
export function lineExpansion(excess: number, expandable: number, m: Microtype): number {
  if (!m.expansion || expandable <= 0 || Math.abs(excess) < 1e-9) return 0;
  const limit = excess > 0 ? m.stretch : m.shrink;
  if (limit <= 0) return 0;
  const ratio = Math.min(1, Math.abs(excess) / ((expandable * limit) / 1000));
  let e = Math.round((ratio * limit) / m.step) * m.step;
  if (e > limit) e -= m.step;
  return excess > 0 ? e : -e;
}

/** A copy of a glyph run widened by `e` thousandths: advances and width scale, outlines are drawn with horizontal scale. */
export function expandGlyphs(g: Glyphs, e: number): Glyphs {
  const k = 1 + e / 1000;
  const out: Glyphs = { ...g, advances: g.advances.map((a) => a * k), width: g.width * k, hscale: (g.hscale ?? 1) * k };
  return out;
}
