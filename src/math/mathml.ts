/**
 * MathML Core output. Letters keep TeX's conventions (italic single-letter
 * identifiers, upright capital Greek, upright operator names); math
 * alphabets (\mathbf, \mathbb, ...) become characters from the Unicode
 * Mathematical Alphanumeric Symbols block, since MathML Core only supports
 * mathvariant="normal". Equation tags become a right-aligned last column of
 * a table (MathML Core has no mlabeledtr). Everything is escaped, so the
 * output is well-formed XML.
 */

import type { Color } from "../layout/types.js";
import type { ArrayNode, Dim, Formula, MathFont, MathList, MathNode, SymNode, TagSpec, TextItem } from "./ast.js";
import type { DisplayOptions } from "./display.js";
import type { SymDef } from "./symbols.js";
import { type MathVariant, styledChar } from "./unicode.js";

export function escapeXml(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&apos;";
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) out += " ";
    else if ((c >= 0xfffe && c <= 0xffff) || (c >= 0xd800 && c <= 0xdfff)) out += "�";
    else out += ch;
  }
  return out;
}

const attr = (name: string, value: string) => ` ${name}="${escapeXml(value)}"`;

/** Equation-tag cells: right-aligned and classed "tw-tag" so HTML styling can place them at the right margin. */
const TAG_CELL = ` class="tw-tag" columnalign="right" style="text-align:right"`;

/** Cell alignment: the columnalign attribute (MathML 3) plus the CSS that MathML Core renderers follow. */
function cellAttrs(align: string, extra?: string): string {
  const css: string[] = [];
  if (align === "left" || align === "right") css.push(`text-align:${align}`);
  if (extra) css.push(extra);
  return attr("columnalign", align) + (css.length ? attr("style", css.join(";")) : "");
}

function hex(c: Color): string {
  const h = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

function sameColor(a: Color | undefined, b: Color | undefined): boolean {
  if (!a || !b) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function dimStr(d: Dim): string {
  const v = Math.round(d.v * 10000) / 10000;
  switch (d.u) {
    case "mu":
      return `${Math.round((v / 18) * 10000) / 10000}em`;
    case "em":
      return `${v}em`;
    case "ex":
      return `${v}ex`;
    case "pt":
      return `${v}pt`;
  }
}

/** Precomposed negations for \not. */
const NEGATED: Record<string, string> = {
  "=": "≠",
  "∈": "∉",
  "≡": "≢",
  "∼": "≁",
  "≃": "≄",
  "≈": "≉",
  "≅": "≇",
  "<": "≮",
  ">": "≯",
  "≤": "≰",
  "≥": "≱",
  "⊂": "⊄",
  "⊃": "⊅",
  "⊆": "⊈",
  "⊇": "⊉",
  "∋": "∌",
  "∣": "∤",
  "∥": "∦",
  "≺": "⊀",
  "≻": "⊁",
  "⊢": "⊬",
  "⊨": "⊭",
  "∃": "∄",
  "≍": "≭",
  "→": "↛",
  "←": "↚",
  "↔": "↮",
  "⇒": "⇏",
  "⇐": "⇍",
  "⇔": "⇎",
  "⊑": "⋢",
  "⊒": "⋣",
  "⪯": "⋠",
  "⪰": "⋡",
};

function variantFor(font: MathFont, sym: SymDef): MathVariant | "normal" | null {
  const latin = /^[A-Za-z]$/.test(sym.text);
  const digit = /^[0-9]$/.test(sym.text);
  const greek = /^[Α-Ωα-ωϑϕϖϰϱϵ]$/.test(sym.text);
  switch (font) {
    case "rm":
      return sym.variable ? "normal" : null;
    case "it":
      return sym.variable ? (latin ? null : greek ? "italic" : null) : null;
    case "bf":
      return sym.variable ? "bold" : null;
    case "sf":
      return sym.variable ? "sans-serif" : null;
    case "tt":
      return sym.variable ? "monospace" : null;
    case "cal":
    case "scr":
      return latin ? "script" : null;
    case "frak":
      return latin || digit ? "fraktur" : null;
    case "bb":
      return latin || digit ? "double-struck" : null;
    case "bsym":
      if (latin || (greek && sym.fam === "mathI")) return "bold-italic";
      return digit || greek ? "bold" : null;
  }
}

class Writer {
  constructor(private readonly display: boolean) {}

  // ------------------------------------------------------------ lists

  /** A list as a single element (an mrow when it has several children). */
  row(list: MathList, color?: Color): string {
    const parts = this.items(list, color);
    if (parts.length === 1) return parts[0]!;
    return `<mrow>${parts.join("")}</mrow>`;
  }

  items(list: MathList, color?: Color): string[] {
    const out: string[] = [];
    // A style change applies to the rest of the list: open an mstyle now, close it at the end.
    let opened = 0;
    for (let i = 0; i < list.length; i++) {
      const n = list[i]!;
      if (n.type === "style") {
        const lvl = n.style === "display" || n.style === "text" ? 0 : n.style === "script" ? 1 : 2;
        if (i === list.length - 1) continue;
        out.push(`<mstyle${attr("displaystyle", n.style === "display" ? "true" : "false")}${attr("scriptlevel", String(lvl))}>`);
        opened++;
        continue;
      }
      // numbers: digits with decimal points
      if (n.type === "sym" && n.sym.mml === "mn" && !n.font) {
        let s = n.sym.text;
        let j = i + 1;
        while (j < list.length) {
          const m = list[j]!;
          if (m.type === "sym" && !m.font && sameColor(m.color, n.color) && (m.sym.mml === "mn" || (m.sym.text === "." && list[j + 1]?.type === "sym" && (list[j + 1] as SymNode).sym.mml === "mn"))) {
            s += m.sym.text;
            j++;
          } else break;
        }
        out.push(this.colored(`<mn>${escapeXml(s)}</mn>`, n.color, color));
        i = j - 1;
        continue;
      }
      // runs of letters in an upright alphabet become one identifier
      if (n.type === "sym" && n.font && n.font !== "bsym" && n.sym.variable && /^[A-Za-z]$/.test(n.sym.text)) {
        const v = variantFor(n.font, n.sym);
        let s = v && v !== "normal" ? styledChar(n.sym.text, v) : n.sym.text;
        let j = i + 1;
        while (j < list.length) {
          const m = list[j]!;
          if (m.type === "sym" && m.font === n.font && sameColor(m.color, n.color) && m.sym.variable && /^[A-Za-z]$/.test(m.sym.text)) {
            s += v && v !== "normal" ? styledChar(m.sym.text, v) : m.sym.text;
            j++;
          } else break;
        }
        const count = j - i;
        const normal = v === "normal" && count === 1 ? attr("mathvariant", "normal") : "";
        out.push(this.colored(`<mi${normal}>${escapeXml(s)}</mi>`, n.color, color));
        i = j - 1;
        continue;
      }
      out.push(this.node(n, color));
      if (n.type === "op" && (n.name !== undefined || n.body) && !n.sym) {
        const next = list[i + 1];
        if (next && next.type !== "supsub") out.push("<mo>⁡</mo>");
      }
    }
    if (opened) {
      // fold everything after the first mstyle into it so the result stays a list of whole elements
      const first = out.findIndex((s) => s.startsWith("<mstyle") && !s.endsWith("</mstyle>"));
      const head = out.slice(0, first);
      head.push(out.slice(first).join("") + "</mstyle>".repeat(opened));
      return head;
    }
    return out;
  }

  private colored(s: string, c: Color | undefined, inherited: Color | undefined): string {
    if (!c || sameColor(c, inherited)) return s;
    return `<mstyle${attr("mathcolor", hex(c))}>${s}</mstyle>`;
  }

  // ------------------------------------------------------------ nodes

  node(n: MathNode, color?: Color): string {
    const inner = this.bare(n, n.color ?? color);
    return this.colored(inner, n.color, color);
  }

  private sym(n: SymNode): string {
    const s = n.sym;
    const v = n.font ? variantFor(n.font, s) : null;
    let text = v && v !== "normal" ? styledChar(s.text, v) : s.text;
    if (s.mml === "mn") return `<mn>${escapeXml(text)}</mn>`;
    if (s.mml === "mi") {
      const upright = (!n.font && s.fam === "main" && /^[Α-Ω]$/.test(s.text)) || v === "normal" || (!n.font && s.fam === "main" && s.text.length === 1 && /\p{L}/u.test(s.text) && !/^[A-Za-z]$/.test(s.text) && false);
      if (s.text === "′") return `<mo${attr("lspace", "0")}${attr("rspace", "0")}>′</mo>`;
      if (v === "normal" && /^[A-Za-z]$/.test(text)) return `<mi mathvariant="normal">${escapeXml(text)}</mi>`;
      return `<mi${upright ? attr("mathvariant", "normal") : ""}>${escapeXml(text)}</mi>`;
    }
    // operators
    let a = "";
    if (n.cls === "open" || n.cls === "close") a += attr("stretchy", "false");
    if (n.cls === "ord") a += attr("lspace", "0") + attr("rspace", "0");
    if (n.cls === "bin" && s.text === "−") text = "−";
    return `<mo${a}>${escapeXml(text)}</mo>`;
  }

  private opBase(n: Extract<MathNode, { type: "op" }>, limitsOn: boolean, color?: Color): string {
    const movable = n.limits === "display" ? "true" : "false";
    if (n.sym) {
      const big = n.sym.big ? attr("largeop", "true") : "";
      return `<mo${big}${attr("movablelimits", limitsOn ? movable : "false")}>${escapeXml(n.sym.text)}</mo>`;
    }
    if (n.name !== undefined) {
      const name = n.name.replace(/ /g, " ");
      if (limitsOn) return `<mo${attr("form", "prefix")}${attr("movablelimits", movable)}>${escapeXml(name)}</mo>`;
      return `<mi>${escapeXml(name)}</mi>`;
    }
    const body = n.body ?? [];
    // \operatorname{...}: letters become one identifier
    if (body.length && body.every((b) => b.type === "sym" && /^[A-Za-z\-*]$/.test(b.sym.text))) {
      const s = body.map((b) => (b as SymNode).sym.text).join("");
      if (limitsOn) return `<mo${attr("form", "prefix")}${attr("movablelimits", movable)}>${escapeXml(s)}</mo>`;
      return s.length === 1 ? `<mi mathvariant="normal">${escapeXml(s)}</mi>` : `<mi>${escapeXml(s)}</mi>`;
    }
    return this.row(body, color);
  }

  private bare(n: MathNode, color?: Color): string {
    switch (n.type) {
      case "sym":
        return this.sym(n);
      case "group": {
        const s = this.row(n.body, color);
        return n.body.length === 0 ? "<mrow></mrow>" : s;
      }
      case "op":
        return this.opBase(n, false, color);
      case "supsub":
        return this.scripts(n, color);
      case "frac":
        return this.frac(n, color);
      case "sqrt":
        if (n.index && n.index.length) return `<mroot>${this.row(n.body, color)}${this.row(n.index, color)}</mroot>`;
        return `<msqrt>${this.items(n.body, color).join("")}</msqrt>`;
      case "accent": {
        const stretchy = n.accent.wide ? "true" : "false";
        return `<mover${attr("accent", "true")}>${this.row(n.body, color)}<mo${attr("stretchy", stretchy)}>${escapeXml(n.accent.mml)}</mo></mover>`;
      }
      case "overline":
        return `<mover${attr("accent", "true")}>${this.row(n.body, color)}<mo${attr("stretchy", "true")}>‾</mo></mover>`;
      case "underline":
        return `<munder${attr("accentunder", "true")}>${this.row(n.body, color)}<mo${attr("stretchy", "true")}>_</mo></munder>`;
      case "brace":
        return n.over
          ? `<mover>${this.row(n.body, color)}<mo${attr("stretchy", "true")}>⏞</mo></mover>`
          : `<munder>${this.row(n.body, color)}<mo${attr("stretchy", "true")}>⏟</mo></munder>`;
      case "arrowacc":
        return n.over
          ? `<mover${attr("accent", "true")}>${this.row(n.body, color)}<mo${attr("stretchy", "true")}>${escapeXml(n.arrow.text)}</mo></mover>`
          : `<munder${attr("accentunder", "true")}>${this.row(n.body, color)}<mo${attr("stretchy", "true")}>${escapeXml(n.arrow.text)}</mo></munder>`;
      case "leftright": {
        const l = n.left ? `<mo${attr("fence", "true")}${attr("form", "prefix")}${attr("stretchy", "true")}>${escapeXml(n.left.text)}</mo>` : "";
        const r = n.right ? `<mo${attr("fence", "true")}${attr("form", "postfix")}${attr("stretchy", "true")}>${escapeXml(n.right.text)}</mo>` : "";
        return `<mrow>${l}${this.items(n.body, color).join("")}${r}</mrow>`;
      }
      case "middle":
        return n.delim ? `<mo${attr("fence", "true")}${attr("stretchy", "true")}${attr("lspace", "0.05em")}${attr("rspace", "0.05em")}>${escapeXml(n.delim.text)}</mo>` : "";
      case "big": {
        if (!n.delim) return `<mspace${attr("width", "0.12em")}/>`;
        const size = ["1.2em", "1.8em", "2.4em", "3em"][n.size - 1]!;
        const form = n.cls === "open" ? attr("form", "prefix") : n.cls === "close" ? attr("form", "postfix") : "";
        return `<mo${form}${attr("minsize", size)}${attr("maxsize", size)}${attr("stretchy", "true")}${n.cls === "ord" ? attr("lspace", "0") + attr("rspace", "0") : ""}>${escapeXml(n.delim.text)}</mo>`;
      }
      case "text":
        return this.text(n.body, color);
      case "space":
        return `<mspace${attr("width", dimStr(n.dim))}/>`;
      case "style":
        return "";
      case "phantom": {
        const inner = `<mphantom>${this.row(n.body, color)}</mphantom>`;
        if (n.h && n.v) return inner;
        if (n.h) return `<mpadded${attr("height", "0")}${attr("depth", "0")}>${inner}</mpadded>`;
        return `<mpadded${attr("width", "0")}>${inner}</mpadded>`;
      }
      case "smash": {
        const a = (n.top ? attr("height", "0") : "") + (n.bottom ? attr("depth", "0") : "");
        return `<mpadded${a}>${this.row(n.body, color)}</mpadded>`;
      }
      case "lap":
        return `<mpadded${attr("width", "0")}>${this.row(n.body, color)}</mpadded>`;
      case "cancel": {
        const notation = n.strike === "/" ? "updiagonalstrike" : n.strike === "x" ? "updiagonalstrike downdiagonalstrike" : "downdiagonalstrike";
        return `<menclose${attr("notation", notation)}>${this.row(n.body, color)}</menclose>`;
      }
      case "boxed": {
        const parts: string[] = [];
        if (!n.frameless) parts.push(`border:0.04em solid${n.color ? ` ${hex(n.color)}` : ""}`);
        if (n.fill) parts.push(`background-color:${hex(n.fill)}`);
        parts.push("padding:0.3em");
        return `<mrow${attr("style", parts.join(";"))}>${this.items(n.body, color).join("")}</mrow>`;
      }
      case "array":
        return this.table(n, color, null);
      case "not": {
        if (!n.body) return "<mo>⧸</mo>";
        if (n.body.type === "sym") {
          const t = n.body.sym.text;
          const neg = NEGATED[t] ?? `${t}̸`;
          return `<mo>${escapeXml(neg)}</mo>`;
        }
        return `<mrow>${this.node(n.body, color)}<mo≯</mo></mrow>`;
      }
      case "xarrow": {
        const arrow = `<mo${attr("stretchy", "true")}${attr("minsize", "1.5em")}>${escapeXml(n.arrow.text)}</mo>`;
        const above = n.above ? `<mpadded${attr("lspace", "0.3em")}${attr("width", "+0.6em")}>${this.row(n.above, color)}</mpadded>` : null;
        const below = n.below ? `<mpadded${attr("lspace", "0.3em")}${attr("width", "+0.6em")}>${this.row(n.below, color)}</mpadded>` : null;
        if (above && below) return `<munderover>${arrow}${below}${above}</munderover>`;
        if (above) return `<mover>${arrow}${above}</mover>`;
        if (below) return `<munder>${arrow}${below}</munder>`;
        return arrow;
      }
      case "stack": {
        const base = this.row(n.base, color);
        if (n.over && n.under) return `<munderover>${base}${this.row(n.under, color)}${this.row(n.over, color)}</munderover>`;
        if (n.over) return `<mover>${base}${this.row(n.over, color)}</mover>`;
        if (n.under) return `<munder>${base}${this.row(n.under, color)}</munder>`;
        return base;
      }
      case "rule":
        return `<mspace${attr("width", dimStr(n.width))}${attr("height", dimStr(n.height))}${attr("style", "background:currentColor")}/>`;
      case "raise":
        return `<mpadded${attr("voffset", dimStr(n.dim))}>${this.row(n.body, color)}</mpadded>`;
      case "penalty":
        return "";
    }
  }

  private scripts(n: Extract<MathNode, { type: "supsub" }>, color?: Color): string {
    const b = n.base;
    let limits = false;
    let base: string;
    if (b && b.type === "op") {
      limits = b.limits === "limits" || (b.limits === "display" && (this.display || true));
      // display limits become munderover with movablelimits so inline rendering moves them aside
      if (b.limits === "nolimits") limits = false;
      base = this.colored(this.opBase(b, limits, b.color ?? color), b.color, color);
    } else if (b && (b.type === "brace" || b.type === "stack" || b.type === "xarrow")) {
      limits = true;
      base = this.node(b, color);
    } else base = b ? this.node(b, color) : "<mrow></mrow>";
    const sup = n.sup ? this.row(n.sup, color) : null;
    const sub = n.sub ? this.row(n.sub, color) : null;
    if (limits) {
      if (sup && sub) return `<munderover>${base}${sub}${sup}</munderover>`;
      if (sup) return `<mover>${base}${sup}</mover>`;
      if (sub) return `<munder>${base}${sub}</munder>`;
      return base;
    }
    if (sup && sub) return `<msubsup>${base}${sub}${sup}</msubsup>`;
    if (sup) return `<msup>${base}${sup}</msup>`;
    if (sub) return `<msub>${base}${sub}</msub>`;
    return base;
  }

  private frac(n: Extract<MathNode, { type: "frac" }>, color?: Color): string {
    let a = "";
    if (n.thickness) a = attr("linethickness", n.thickness.v === 0 ? "0" : dimStr(n.thickness));
    let s = `<mfrac${a}>${this.row(n.num, color)}${this.row(n.den, color)}</mfrac>`;
    if (n.left || n.right) {
      const l = n.left ? `<mo${attr("fence", "true")}${attr("stretchy", "true")}>${escapeXml(n.left.text)}</mo>` : "";
      const r = n.right ? `<mo${attr("fence", "true")}${attr("stretchy", "true")}>${escapeXml(n.right.text)}</mo>` : "";
      s = `<mrow>${l}${s}${r}</mrow>`;
    }
    if (n.style === "display") s = `<mstyle${attr("displaystyle", "true")}${attr("scriptlevel", "0")}>${s}</mstyle>`;
    else if (n.style === "text") s = `<mstyle${attr("displaystyle", "false")}${attr("scriptlevel", "0")}>${s}</mstyle>`;
    else if (n.style) s = `<mstyle${attr("displaystyle", "false")}${attr("scriptlevel", n.style === "script" ? "1" : "2")}>${s}</mstyle>`;
    return s;
  }

  text(items: readonly TextItem[], color?: Color): string {
    const parts: string[] = [];
    for (const it of items) {
      const c = it.color;
      let s: string;
      switch (it.k) {
        case "chars": {
          const st: string[] = [];
          if (it.font.bold) st.push("font-weight:bold");
          if (it.font.italic) st.push("font-style:italic");
          if (it.font.family === "tt") st.push("font-family:monospace");
          if (it.font.family === "sf") st.push("font-family:sans-serif");
          s = `<mtext${st.length ? attr("style", st.join(";")) : ""}>${escapeXml(it.s.replace(/ /g, " "))}</mtext>`;
          break;
        }
        case "space":
          s = it.dim ? `<mspace${attr("width", dimStr(it.dim))}/>` : "<mtext> </mtext>";
          break;
        case "math":
          s = this.row(it.body, c ?? color);
          break;
        case "accent":
          s = `<mtext>${escapeXml((it.base + it.mark).normalize("NFC"))}</mtext>`;
          break;
      }
      parts.push(this.colored(s, c, color));
    }
    // merge adjacent plain mtext
    const merged = parts.join("").replace(/<\/mtext><mtext>/g, "");
    if (parts.length === 1) return merged;
    if (parts.length === 0) return "<mtext></mtext>";
    return `<mrow>${merged}</mrow>`;
  }

  tagText(tag: TagSpec | string, color?: Color): string {
    if (typeof tag === "string") return `<mtext>(${escapeXml(tag)})</mtext>`;
    const inner = this.text(tag.body, color);
    return tag.star ? inner : `<mrow><mtext>(</mtext>${inner}<mtext>)</mtext></mrow>`;
  }

  /** A table; with `tags`, a right-aligned tag column is appended. */
  table(n: ArrayNode, color: Color | undefined, tags: ((TagSpec | string) | null)[] | null): string {
    const ncols = Math.max(1, ...n.rows.map((r) => r.cells.length), n.cols?.length ?? 0);
    const aligns: string[] = [];
    for (let j = 0; j < ncols; j++) {
      switch (n.kind) {
        case "array":
        case "subarray":
        case "matrix":
          aligns.push(({ l: "left", c: "center", r: "right" } as const)[n.cols?.[j]?.align ?? "c"]);
          break;
        case "cases":
          aligns.push("left");
          break;
        case "aligned":
          aligns.push(j % 2 === 0 ? "right" : "left");
          break;
        case "eqnarray":
          aligns.push(j === 0 ? "right" : j === 1 ? "center" : "left");
          break;
        default:
          aligns.push("center");
      }
    }
    const display = n.style === "display";
    const hasTags = !!tags && tags.some((t) => t !== null);
    let a = attr("columnalign", [...aligns, ...(hasTags ? ["right"] : [])].join(" "));
    if (n.kind === "aligned") {
      const sp: string[] = [];
      for (let j = 1; j < ncols; j++) sp.push(j % 2 === 1 ? "0em" : "1em");
      if (sp.length) a += attr("columnspacing", sp.join(" "));
      a += attr("rowspacing", "0.25em");
    } else if (n.kind === "smallmatrix" || n.kind === "subarray") {
      a += attr("rowspacing", "0.1em") + attr("columnspacing", "0.2778em");
    } else if (n.kind === "cases") a += attr("columnspacing", "1em");
    if (n.cols?.some((c) => c.lines) || n.trailingLines) {
      const lines: string[] = [];
      for (let j = 1; j < ncols; j++) lines.push(n.cols?.[j]?.lines ? "solid" : "none");
      if (lines.length) a += attr("columnlines", lines.join(" "));
      if (n.cols?.[0]?.lines || n.trailingLines) a += attr("frame", "solid");
    }
    if (n.rows.some((r, i) => i > 0 && r.hlines)) {
      const lines: string[] = [];
      for (let i = 1; i < n.rows.length; i++) lines.push(n.rows[i]!.hlines ? "solid" : "none");
      a += attr("rowlines", lines.join(" "));
    }
    if (display) a += attr("displaystyle", "true");
    const rows = n.rows.map((r, i) => {
      const cells: string[] = [];
      for (let j = 0; j < ncols; j++) {
        const list = r.cells[j] ?? [];
        const al = n.kind === "multline" ? (i === 0 && n.rows.length > 1 ? "left" : i === n.rows.length - 1 && n.rows.length > 1 ? "right" : "center") : aligns[j]!;
        // aligned pairs touch: no padding between the right and left halves
        const pad = n.kind === "aligned" ? (j % 2 === 0 ? "padding-right:0" : "padding-left:0") : undefined;
        const ca = cellAttrs(al, pad);
        let body = this.items(list, color).join("");
        if (n.kind === "aligned" && j % 2 === 1 && list.length) body = `<mi></mi>${body}`;
        // display tables carry displaystyle="true" on the mtable itself
        if (display && n.kind === "eqnarray" && j === 1) body = `<mstyle${attr("displaystyle", "false")}>${body}</mstyle>`;
        else if (n.style === "script") body = `<mstyle${attr("displaystyle", "false")}${attr("scriptlevel", "1")}>${body}</mstyle>`;
        else if (!display && body.includes("<")) body = `<mrow>${body}</mrow>`;
        cells.push(`<mtd${ca}>${body}</mtd>`);
      }
      if (hasTags) {
        const t = tags![i];
        // Every row has a tag cell (empty for unnumbered rows), classed so HTML can move it to the margin.
        cells.push(t ? `<mtd${TAG_CELL}>${this.tagText(t, color)}</mtd>` : `<mtd${TAG_CELL}></mtd>`);
      }
      const inter = r.intertext ? `<mtr><mtd${attr("columnalign", "left")}${attr("columnspan", String(ncols + (hasTags ? 1 : 0)))}>${this.text(r.intertext, color)}</mtd></mtr>` : "";
      return `${inter}<mtr>${cells.join("")}</mtr>`;
    });
    let s = `<mtable${a}>${rows.join("")}</mtable>`;
    if (n.style === "text" && !display && (n.kind === "matrix" || n.kind === "array" || n.kind === "cases")) {
      // cells are in text style
    }
    if (n.vpos !== "c" && n.kind !== "subarray") s = `<mpadded>${s}</mpadded>`;
    return s;
  }
}

function rowTags(n: ArrayNode, opts: Pick<DisplayOptions, "tags">): ((TagSpec | string) | null)[] {
  const rows = n.rows.length;
  return n.rows.map((r, i) => {
    if (r.tag) return r.tag;
    if (r.notag) return null;
    if (Array.isArray(opts.tags)) return opts.tags[i] ?? null;
    if (typeof opts.tags === "string") return i === rows - 1 ? opts.tags : null;
    return null;
  });
}

/** MathML for a parsed formula. */
export function formulaToMathML(f: Formula, tex: string, display: boolean, opts: Pick<DisplayOptions, "tags">): string {
  const w = new Writer(display);
  let body: string;
  const items = f.body.filter((n) => !(n.type === "space" || n.type === "style"));
  if (display && f.rows && f.rows.length > 1) {
    const node: ArrayNode = {
      type: "array",
      env: "gather*",
      kind: "gathered",
      rows: f.rows.map((r) => ({ cells: [r.body], hlines: 0, pos: r.pos, tag: r.tag, notag: r.notag })),
      hlinesBelow: 0,
      style: "display",
      vpos: "c",
      display: true,
      arrayStretch: 1,
      outerSep: false,
      pos: 0,
    };
    body = w.table(node, undefined, rowTags(node, opts));
  } else if (display && items.length === 1 && items[0]!.type === "array" && items[0]!.display) {
    const node = items[0]!;
    body = w.table(node, node.color, rowTags(node, opts));
  } else {
    body = w.row(f.body);
    if (display) {
      const tag = f.tag ?? (f.notag ? null : Array.isArray(opts.tags) ? (opts.tags.find((t) => t !== null) ?? null) : (opts.tags ?? null));
      if (tag) {
        body =
          `<mtable${attr("columnalign", "center right")}${attr("displaystyle", "true")}>` +
          `<mtr><mtd${cellAttrs("center")}>${body}</mtd><mtd${TAG_CELL}>${w.tagText(tag)}</mtd></mtr></mtable>`;
      }
    }
  }
  if (!body.startsWith("<mrow>") || !body.endsWith("</mrow>")) body = `<mrow>${body}</mrow>`;
  return (
    `<math xmlns="http://www.w3.org/1998/Math/MathML"${attr("display", display ? "block" : "inline")}>` +
    `<semantics>${body}<annotation${attr("encoding", "application/x-tex")}>${escapeXml(tex)}</annotation></semantics></math>`
  );
}

/** MathML shown in place of a formula that does not parse. */
export function errorMathML(tex: string, display: boolean, message: string): string {
  return (
    `<math xmlns="http://www.w3.org/1998/Math/MathML"${attr("display", display ? "block" : "inline")}>` +
    `<merror${attr("title", message)}><mtext>${escapeXml(tex)}</mtext></merror></math>`
  );
}
