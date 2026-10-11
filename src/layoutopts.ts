/**
 * Page layout chosen by the document itself, so one file carries everything
 * an agent needs to change: front matter keys in pandoc's spelling, or the
 * LaTeX reader's \documentclass and geometry options (kept in meta.extra).
 * Options given to convert() (the CLI's flags, the MCP tool's arguments) win.
 *
 *   theme: modern            papersize: a4        fontsize: 12pt
 *   geometry: margin=2cm     margin: 1in          landscape: true
 *   page-numbers: right      header: Draft        footer: Internal
 *   max-pages: 1             (the layout is tightened to fit; see src/fit.ts)
 */

import type { Meta, Pos } from "./ast.js";
import type { Diagnostics } from "./diagnostics.js";
import { closestFix } from "./fixes.js";
import { listThemes } from "./write/assets.js";
import { PAPER } from "./typeset/style.js";
import { parseMicrotype } from "./layout/microtype.js";

export type PaperName = "letter" | "a4" | "a5" | "legal" | "b5";
export type PageNumbers = "center" | "right" | "none";

export interface LayoutOptions {
  theme?: string;
  paper?: PaperName;
  landscape?: boolean;
  margin?: string;
  pageNumbers?: PageNumbers;
  header?: string;
  footer?: string;
  /** Body size in points (10, 11, 12 ...). */
  fontSize?: number;
  /** Page limit the PDF is fitted to (src/fit.ts). */
  maxPages?: number;
}

const LENGTH = /^\s*\d+(?:\.\d+)?\s*(?:in|cm|mm|pt|px|pc)\s*$/i;

function text(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

function flag(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  const s = text(v)?.toLowerCase();
  if (s === "true" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "no" || s === "off") return false;
  return undefined;
}

/** "a4", "a4paper", "A4", "letterpaper", "US Letter" -> a paper name. */
export function paperName(v: string): PaperName | undefined {
  const s = v.toLowerCase().replace(/paper$/, "").replace(/^us\s*/, "").trim();
  return s in PAPER ? (s as PaperName) : undefined;
}

/**
 * LaTeX geometry options ("margin=1in", "top=2cm,bottom=2cm,hmargin=1.5in", "a4paper, landscape") as a
 * margin string (top,right,bottom,left), a paper and an orientation. Unknown keys are ignored.
 */
export function parseGeometry(spec: string): { margin?: string; paper?: PaperName; landscape?: boolean; bad?: string } {
  const sides: Record<"top" | "right" | "bottom" | "left", string | undefined> = { top: undefined, right: undefined, bottom: undefined, left: undefined };
  let paper: PaperName | undefined;
  let landscape: boolean | undefined;
  let bad: string | undefined;
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [rawKey, rawValue] = part.split("=").map((s) => s.trim()) as [string, string | undefined];
    const key = rawKey.toLowerCase();
    if (rawValue === undefined) {
      const p = paperName(key);
      if (p) paper = p;
      else if (key === "landscape") landscape = true;
      else if (key === "portrait") landscape = false;
      continue;
    }
    if (key === "paper" || key === "papername") {
      paper = paperName(rawValue) ?? paper;
      continue;
    }
    const set = (names: (keyof typeof sides)[]) => {
      if (!LENGTH.test(rawValue)) {
        bad ??= `${rawKey}=${rawValue}`;
        return;
      }
      for (const n of names) sides[n] = rawValue;
    };
    if (key === "margin") set(["top", "right", "bottom", "left"]);
    else if (key === "hmargin" || key === "lrmargin") set(["left", "right"]);
    else if (key === "vmargin" || key === "tbmargin") set(["top", "bottom"]);
    else if (key === "top" || key === "tmargin") set(["top"]);
    else if (key === "bottom" || key === "bmargin") set(["bottom"]);
    else if (key === "left" || key === "lmargin" || key === "inner") set(["left"]);
    else if (key === "right" || key === "rmargin" || key === "outer") set(["right"]);
  }
  const any = Object.values(sides).some(Boolean);
  const margin = any ? [sides.top, sides.right, sides.bottom, sides.left].map((v) => v ?? "1in").join(",") : undefined;
  return { margin, paper, landscape, bad };
}

/** The layout for a document: options first, then what the document asks for. Bad values are OPT001. */
export function documentLayout(opts: LayoutOptions, meta: Meta, diagnostics: Diagnostics, locate?: (key: string) => Pos | undefined): LayoutOptions {
  const x = meta.extra ?? {};
  // With the key's line known, a near miss of an accepted value comes with a fix ("modren" to "modern").
  const bad = (key: string, value: unknown, hint: string, accepted?: readonly string[]) => {
    const at = locate?.(key);
    const near = at && typeof value === "string" && accepted ? closestFix(value.trim(), accepted) : undefined;
    diagnostics.add("OPT001", `Front matter "${key}" has an unusable value ${JSON.stringify(value)}`, at, {
      hint: near ? `Did you mean "${near.replacement}"? ${hint}` : hint,
      fix: near && { old: (value as string).trim(), new: near.replacement, safe: near.safe },
    });
  };
  const out: LayoutOptions = { ...opts };

  const theme = text(x.theme);
  if (out.theme === undefined && theme) {
    if (listThemes().includes(theme)) out.theme = theme;
    else bad("theme", theme, `Themes: ${listThemes().join(", ")}; article is used`, listThemes());
  }

  if (out.paper === undefined) {
    for (const key of ["papersize", "paper"]) {
      const v = text(x[key]);
      if (!v) continue;
      const p = paperName(v);
      if (p) out.paper = p;
      else bad(key, v, `Use one of ${Object.keys(PAPER).join(", ")}`, Object.keys(PAPER));
      break;
    }
  }

  const geometry = Array.isArray(x.geometry) ? x.geometry.map((g) => text(g) ?? "").join(",") : text(x.geometry);
  const g = geometry ? parseGeometry(geometry) : undefined;
  if (g?.bad) bad("geometry", g.bad, 'Lengths need a unit, e.g. "margin=1in" or "top=2cm,left=1.5cm"');
  if (out.margin === undefined) {
    const m = text(x.margin);
    if (m) {
      if (m.split(/[,\s]+/).filter(Boolean).every((p) => LENGTH.test(p))) out.margin = m;
      else bad("margin", m, 'Give one length ("1in") or two to four, e.g. "1in, 0.8in"');
    } else if (g?.margin) out.margin = g.margin;
  }
  if (out.paper === undefined && g?.paper) out.paper = g.paper;

  if (out.landscape === undefined) {
    const l = x.landscape !== undefined ? flag(x.landscape) : undefined;
    if (x.landscape !== undefined && l === undefined) bad("landscape", x.landscape, "Use true or false");
    const classLandscape = text(x.classoption)?.split(",").some((o) => o.trim() === "landscape");
    out.landscape = l ?? g?.landscape ?? (classLandscape || undefined);
  }

  if (out.pageNumbers === undefined) {
    const raw = x["page-numbers"] ?? x.pageNumbers;
    if (raw !== undefined) {
      const v = raw === false ? "none" : text(raw)?.toLowerCase();
      if (v === "center" || v === "right" || v === "none") out.pageNumbers = v;
      else bad("page-numbers", raw, 'Use "center", "right" or "none"', ["center", "right", "none"]);
    }
  }
  for (const key of ["header", "footer"] as const) {
    const v = text(x[key]);
    if (out[key] === undefined && v) out[key] = v;
  }

  if (out.maxPages === undefined) {
    const raw = x["max-pages"] ?? x.maxPages;
    if (raw !== undefined) {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= 10000) out.maxPages = n;
      else bad("max-pages", raw, "Use a whole number of pages, e.g. 1");
    }
  }

  // Read by the typesetter (src/typeset/index.ts); only checked here.
  if (x.microtype !== undefined && parseMicrotype(x.microtype, undefined) === undefined) {
    bad("microtype", x.microtype, 'Use true or false, or options such as "protrusion=true, expansion=false"');
  }

  if (out.fontSize === undefined) {
    const raw = x.fontsize ?? x["font-size"];
    if (raw !== undefined) {
      const m = /^\s*(\d+(?:\.\d+)?)\s*(pt)?\s*$/i.exec(String(raw));
      const size = m ? Number(m[1]) : NaN;
      if (size >= 6 && size <= 24) out.fontSize = size;
      else bad("fontsize", raw, 'Use a size in points from 6 to 24, e.g. "12pt"');
    }
  }
  return out;
}


/** The position of a top-level front-matter key in a Markdown file's source, for fixes to its value. */
export function frontMatterLocator(diagnostics: Diagnostics, file: string | undefined): (key: string) => Pos | undefined {
  return (key) => {
    const lines = file ? diagnostics.sourceLines(file) : undefined;
    if (!lines || lines[0]?.trim() !== "---") return undefined;
    for (let i = 1; i < lines.length && i < 1000; i++) {
      const l = lines[i]!;
      if (/^(---|\.\.\.)\s*$/.test(l)) return undefined;
      if (l.startsWith(key) && /^\s*:/.test(l.slice(key.length))) return { file, line: i + 1, col: 1 };
    }
    return undefined;
  };
}
