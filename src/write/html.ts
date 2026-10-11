/**
 * HTML writer. Produces one standalone HTML document with no scripts:
 * mathematics becomes MathML from texwright's own math engine, code is
 * highlighted here (src/util/highlight.ts), fonts and images are embedded,
 * and raw HTML goes through src/util/sanitize.ts.
 */

import { highlight } from "../util/highlight.js";
import { HtmlSanitizer } from "../util/sanitize.js";
import { type Block, type Document, type Inline, type TableCell, hasQedHere, listLabel, plainText } from "../ast.js";
import type { BibItem } from "../cite/index.js";
import type { Diagnostics } from "../diagnostics.js";
import { mathml } from "../math/index.js";
import { displaySource, liftMacros } from "../transform/math.js";
import { type LabelInfo, type Numbering, refText } from "../transform/numbering.js";
import { documentFontCss } from "../typeset/brandfonts.js";
import { type ImagePolicy, bundledFontCss, resolveImage, themeCss, themeFonts } from "./assets.js";

export interface HtmlOptions {
  theme: string;
  /** Extra stylesheets (text), applied after the theme. */
  extraCss: string[];
  images: ImagePolicy;
  unsafeHtml: boolean;
}

export interface CitationOutput {
  rendered: WeakMap<object, Inline[]>;
  bibliography: BibItem[];
}

export interface WriteContext {
  doc: Document;
  numbering: Numbering;
  citations: CitationOutput;
  macros: Record<string, string>;
  diagnostics: Diagnostics;
  /** Each formula is typeset and checked once. */
  mathCache: WeakMap<object, string>;
}

const ADMONITIONS = new Set(["note", "tip", "hint", "important", "warning", "caution", "danger", "info", "box"]);

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** CSS lengths from LaTeX/pandoc attributes; anything else is dropped. */
function cssLength(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^\d+(\.\d+)?(%|px|pt|cm|mm|in|em|rem|vw|ex|pc)$/.test(t)) return t;
  if (/^\d+(\.\d+)?$/.test(t)) return `${t}px`;
  return undefined;
}

export class HtmlWriter {
  private notes: string[] = [];
  private noteCounter = 0;
  private bibliographyWritten = false;
  /** A diagram was written: its font and sizing rules go in the head. */
  private diagrams = false;

  constructor(
    private readonly ctx: WriteContext,
    private readonly opts: HtmlOptions,
  ) {}

  // ---------------------------------------------------------------- document

  document(): string {
    const { doc } = this.ctx;
    const meta = doc.meta;
    const body: string[] = [];
    body.push(this.titleBlock());
    const hasTocBlock = doc.blocks.some((b) => b.t === "TOC");
    if (meta.toc && !hasTocBlock) body.push(this.toc());
    body.push(this.blocks(doc.blocks));
    if (this.ctx.citations.bibliography.length && !this.bibliographyWritten) {
      body.push(this.bibliography(true));
    }
    if (this.notes.length) {
      body.push(`<section class="tw-footnotes" aria-label="Notes"><hr><ol>${this.notes.join("")}</ol></section>`);
    }

    const theme = themeCss(this.opts.theme) ?? themeCss("article") ?? "";
    // The theme's own fonts, plus any bundled family a user stylesheet names.
    const families = new Set(themeFonts(themeCss(this.opts.theme) ? this.opts.theme : "article"));
    for (const family of ["texwright-serif", "texwright-mono"]) if (this.opts.extraCss.some((c) => c.includes(family))) families.add(family);
    if (this.diagrams) families.add("KaTeX_SansSerif");
    const diagramCss = this.diagrams ? ".tw-diagram{display:inline-block;max-width:100%}.tw-diagram svg{display:block;max-width:100%;height:auto;margin:0 auto}" : "";
    // The document's own faces (mainfont, sansfont, monofont) over the theme's, before user CSS.
    const themeName = themeCss(this.opts.theme) ? this.opts.theme : "article";
    const brandCss = documentFontCss(meta.extra, this.opts.images, this.ctx.diagnostics, themeName !== "article");
    const css = [bundledFontCss([...families]), theme, diagramCss, brandCss, ...this.opts.extraCss].join("\n");
    const title = plainText(meta.title) || "Document";
    const lang = meta.lang ?? "en";
    const author = (meta.author ?? []).map((a) => plainText(a)).join(", ");
    return [
      "<!doctype html>",
      `<html lang="${escAttr(lang)}">`,
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="generator" content="texwright">',
      `<title>${esc(title)}</title>`,
      author ? `<meta name="author" content="${escAttr(author)}">` : "",
      meta.keywords?.length ? `<meta name="keywords" content="${escAttr(meta.keywords.join(", "))}">` : "",
      `<style>${css}</style>`,
      "</head>",
      `<body class="tw-theme-${escAttr(this.opts.theme)}">`,
      `<article class="tw-doc">${body.join("\n")}</article>`,
      "</body>",
      "</html>",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private titleBlock(): string {
    const m = this.ctx.doc.meta;
    if (!m.title && !m.author && !m.abstract) return "";
    const parts: string[] = [];
    if (m.title) parts.push(`<h1 class="tw-title">${this.inlines(m.title)}</h1>`);
    if (m.subtitle) parts.push(`<p class="tw-subtitle">${this.inlines(m.subtitle)}</p>`);
    if (m.author?.length) {
      const affs = m.author.map((_, k) => m.affiliation?.[k] ?? null);
      const distinct = new Set(affs.filter((a): a is Inline[] => !!a).map((a) => plainText(a)));
      // Several affiliations go under each name; one shared affiliation goes once, under all of them.
      const each = distinct.size > 1;
      parts.push(
        `<div class="tw-authors">${m.author
          .map((a, k) => `<span class="tw-author">${this.inlines(a)}${each && affs[k] ? `<span class="tw-affiliation">${this.inlines(affs[k]!)}</span>` : ""}</span>`)
          .join("")}</div>`,
      );
      const shared = affs.find((a) => a);
      if (!each && shared) parts.push(`<p class="tw-affiliation">${this.inlines(shared)}</p>`);
    }
    if (m.date) parts.push(`<p class="tw-date">${this.inlines(m.date)}</p>`);
    let abstract = "";
    if (m.abstract?.length) {
      abstract = `<section class="tw-abstract"><h2 class="tw-abstract-title">Abstract</h2>${this.blocks(m.abstract)}${
        m.keywords?.length ? `<p class="tw-keywords"><span>Keywords:</span> ${esc(m.keywords.join(", "))}</p>` : ""
      }</section>`;
    }
    return `<header class="tw-titleblock">${parts.join("")}</header>${abstract}`;
  }

  // ---------------------------------------------------------------- table of contents

  private toc(): string {
    const { doc } = this.ctx;
    const depth = doc.meta.tocDepth ?? 3;
    let top = 6;
    for (const b of doc.blocks) if (b.t === "Heading") top = Math.min(top, b.level);
    const items: string[] = [];
    for (const b of doc.blocks) {
      if (b.t !== "Heading" || b.level - top >= depth || (b.attr?.classes ?? []).includes("unlisted")) continue;
      const num = b.number ? `<span class="tw-toc-num">${esc(b.number)}</span>` : "";
      items.push(
        `<li class="tw-toc-l${b.level - top + 1}"><a href="#${escAttr(b.id ?? "")}">${num}<span class="tw-toc-text">${this.inlines(b.content, true)}</span></a></li>`,
      );
    }
    if (!items.length) return "";
    return `<nav class="tw-toc" aria-label="Contents"><h2 class="tw-toc-title">Contents</h2><ul>${items.join("")}</ul></nav>`;
  }

  // ---------------------------------------------------------------- blocks

  blocks(blocks: Block[]): string {
    // Raw HTML blocks in one list share a sanitizer session, so an element
    // opened in one (<details>) can close in a later one, around Markdown blocks.
    let session: HtmlSanitizer | undefined;
    const out: string[] = [];
    for (const b of blocks) {
      if (b.t === "RawBlock" && b.format === "html" && !this.opts.unsafeHtml) {
        session ??= this.sanitizer();
        out.push(this.sanitizeRaw(session, b.text, b.pos));
      } else {
        out.push(this.block(b));
      }
    }
    const tail = session?.close();
    if (tail) out.push(tail);
    return out.join("\n");
  }

  private block(b: Block): string {
    switch (b.t) {
      case "Heading": {
        const level = Math.min(6, b.level + 1); // h1 is the document title
        const num = b.number ? `<span class="tw-secnum">${esc(b.number)}</span> ` : "";
        const classes = ["tw-heading", ...(b.attr?.classes ?? [])].join(" ");
        return `<h${level} id="${escAttr(b.id ?? "")}" class="${escAttr(classes)}">${num}${this.inlines(b.content)}</h${level}>`;
      }
      case "Para":
        return `<p>${this.inlines(b.content)}</p>`;
      case "Plain":
        return this.inlines(b.content);
      case "CodeBlock":
        return this.codeBlock(b);
      case "MathBlock":
        return this.mathBlock(b);
      case "BlockQuote":
        return `<blockquote>${this.blocks(b.blocks)}</blockquote>`;
      case "List":
        return this.list(b);
      case "DefList":
        return `<dl>${b.items
          .map((it) => `<dt>${this.inlines(it.term)}</dt>${it.defs.map((d) => `<dd>${this.blocks(d)}</dd>`).join("")}`)
          .join("")}</dl>`;
      case "Table":
        return this.table(b);
      case "Figure":
        return this.figure(b, false);
      case "Div":
        return this.div(b);
      case "Theorem":
        return this.theorem(b);
      case "RawBlock":
        return this.raw(b.format, b.text, true);
      case "HorizontalRule":
        return "<hr>";
      case "PageBreak":
        return '<div class="tw-pagebreak"></div>';
      case "TOC":
        return this.toc();
      case "Bibliography":
        return this.bibliography(false);
    }
  }

  private codeBlock(b: Extract<Block, { t: "CodeBlock" }>): string {
    const lang = b.lang?.toLowerCase();
    const highlighted = (lang ? highlight(b.text, lang) : undefined) ?? esc(b.text);
    const caption = b.attr?.attrs?.caption;
    const number = b.attr?.attrs?.number;
    const pre = `<pre class="tw-code"><code${lang ? ` class="language-${escAttr(lang)}"` : ""}>${highlighted}</code></pre>`;
    if (!caption && !b.attr?.id) return pre;
    const cap = caption
      ? `<figcaption><span class="tw-caption-label">Listing${number ? ` ${esc(number)}` : ""}:</span> ${esc(caption)}</figcaption>`
      : "";
    return `<figure class="tw-listing" id="${escAttr(b.attr?.id ?? "")}">${cap}${pre}</figure>`;
  }

  private mathBlock(b: Extract<Block, { t: "MathBlock" }>): string {
    let html = this.ctx.mathCache.get(b);
    if (html === undefined) {
      const { tex, tags } = displaySource(b, liftMacros(b.tex, this.ctx.macros, this.ctx.diagnostics, b.pos));
      // A number for the whole formula is set beside it in HTML (see .tw-numbered); row numbers stay in the table.
      const single = typeof tags === "string";
      html = mathml(tex, { display: true, tags: single ? undefined : tags, macros: this.ctx.macros, diagnostics: this.ctx.diagnostics, pos: b.pos });
      if (single) html += `<span class="tw-eqno">(${esc(tags)})</span>`;
      this.ctx.mathCache.set(b, html);
    }
    // Labelled rows after the first get their own anchors so references land on the block.
    const extraAnchors = (b.lineLabels ?? [])
      .filter((l): l is string => !!l)
      .map((l) => this.ctx.numbering.labels.get(l)?.id)
      .filter((id): id is string => !!id && id !== b.id)
      .map((id) => `<span class="tw-anchor" id="${escAttr(id)}"></span>`)
      .join("");
    const cls = html.includes('<span class="tw-eqno">') ? "tw-equation tw-numbered" : "tw-equation";
    return `<div class="${cls}"${b.id ? ` id="${escAttr(b.id)}"` : ""}>${extraAnchors}${html}</div>`;
  }

  private list(b: Extract<Block, { t: "List" }>): string {
    const tag = b.ordered ? "ol" : "ul";
    const attrs: string[] = [];
    if (b.ordered && b.start !== undefined && b.start !== 1) attrs.push(`start="${b.start}"`);
    if (b.style) attrs.push(`style="list-style-type:${b.style}"`);
    // "(a)" and "1)" have no CSS list style: the labels are written out.
    const explicit = b.ordered && b.delim !== undefined && b.delim !== ".";
    const cls = [b.tight ? "tw-tight" : "", b.task ? "tw-tasks" : "", explicit ? "tw-labelled" : ""].filter(Boolean).join(" ");
    if (cls) attrs.push(`class="${cls}"`);
    const items = b.items
      .map((item, k) => {
        const task = b.task?.[k];
        const box = task === true ? '<span class="tw-task tw-task-done" aria-label="done">☑</span> ' : task === false ? '<span class="tw-task" aria-label="to do">☐</span> ' : "";
        const label = explicit ? `<span class="tw-li-label">${esc(listLabel((b.start ?? 1) + k, b.style, b.delim))}</span>` : "";
        return `<li>${label}${box}${this.blocks(item)}</li>`;
      })
      .join("");
    return `<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${items}</${tag}>`;
  }

  private table(b: Extract<Block, { t: "Table" }>): string {
    const cell = (c: TableCell, tag: "th" | "td", col: number) => {
      const align = c.align ?? b.align[col] ?? null;
      const attrs: string[] = [];
      if (c.colspan && c.colspan > 1) attrs.push(`colspan="${c.colspan}"`);
      if (c.rowspan && c.rowspan > 1) attrs.push(`rowspan="${c.rowspan}"`);
      if (align) attrs.push(`style="text-align:${align}"`);
      return `<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${this.inlines(c.content)}</${tag}>`;
    };
    const ruled = new Set(b.rules ?? []);
    const rows = (rs: TableCell[][], tag: "th" | "td") =>
      rs
        .map((r, i) => {
          let col = 0;
          return `<tr${tag === "td" && rs === b.body && ruled.has(i) ? ' class="tw-rule-above"' : ""}>${r
            .map((c) => {
              const html = cell(c, tag, col);
              col += c.colspan ?? 1;
              return html;
            })
            .join("")}</tr>`;
        })
        .join("");
    const colgroup = b.widths?.some((w) => w)
      ? `<colgroup>${b.widths.map((w) => (w ? `<col style="width:${(w * 100).toFixed(2)}%">` : "<col>")).join("")}</colgroup>`
      : "";
    const caption = b.caption?.length
      ? `<figcaption>${b.number ? `<span class="tw-caption-label">Table ${esc(b.number)}:</span> ` : ""}${this.inlines(b.caption)}</figcaption>`
      : "";
    const head = b.head.length ? `<thead>${rows(b.head, "th")}</thead>` : "";
    const foot = b.foot?.length ? `<tfoot>${rows(b.foot, "td")}</tfoot>` : "";
    return `<figure class="tw-table"${b.id ? ` id="${escAttr(b.id)}"` : ""}>${caption}<table${b.plainHead ? ' class="tw-plain-head"' : ""}>${colgroup}${head}<tbody>${rows(b.body, "td")}</tbody>${foot}</table></figure>`;
  }

  private figure(b: Extract<Block, { t: "Figure" }>, sub: boolean): string {
    const subs = b.content.filter((c) => c.t === "Figure");
    let inner: string;
    if (subs.length) {
      inner = `<div class="tw-subfigures">${b.content
        .map((c) => (c.t === "Figure" ? this.figure(c, true) : this.block(c)))
        .join("")}</div>`;
    } else {
      inner = `<div class="tw-figure-body">${this.blocks(b.content)}</div>`;
    }
    const algorithm = b.attr?.classes?.includes("algorithm") ?? false;
    let label = "";
    if (algorithm) label = `<span class="tw-caption-label">Algorithm${b.number ? ` ${esc(b.number)}` : ""}</span> `;
    else if (b.number) {
      label = sub ? `<span class="tw-caption-label">(${esc(b.number.replace(/^\d+(\.\d+)*/, ""))})</span> ` : `<span class="tw-caption-label">Figure ${esc(b.number)}:</span> `;
    }
    const caption = b.caption?.length || algorithm ? `<figcaption>${label}${this.inlines(b.caption ?? [])}</figcaption>` : "";
    const cls = algorithm ? "tw-algorithm" : sub ? "tw-subfigure" : "tw-figure";
    // An algorithm's caption goes on top, as in LaTeX's ruled style.
    return `<figure class="${cls}"${b.id ? ` id="${escAttr(b.id)}"` : ""}>${algorithm ? caption + inner : inner + caption}</figure>`;
  }

  private div(b: Extract<Block, { t: "Div" }>): string {
    const classes = b.attr.classes ?? [];
    const kind = classes.find((c) => ADMONITIONS.has(c));
    const id = b.attr.id ? ` id="${escAttr(b.attr.id)}"` : "";
    if (kind) {
      const title = b.attr.attrs?.title ?? kind.charAt(0).toUpperCase() + kind.slice(1);
      const color = (h: string | undefined) => (h && /^#[0-9a-f]{6}$/i.test(h) ? h : undefined);
      const bg = color(b.attr.attrs?.background);
      const fg = color(b.attr.attrs?.frame);
      const style = bg || fg ? ` style="${bg ? `background:${bg};` : ""}${fg ? `border-left-color:${fg};` : ""}"` : "";
      return `<aside class="tw-callout tw-callout-${kind}"${id}${style}>${title ? `<p class="tw-callout-title">${esc(title)}</p>` : ""}${this.blocks(b.blocks)}</aside>`;
    }
    if (classes.includes("algorithmic")) {
      const every = Number(b.attr.attrs?.numbered ?? 0);
      let n = 0;
      const lines = b.blocks.map((line) => {
        if (line.t !== "Div") return this.block(line);
        const level = Number(line.attr.attrs?.level ?? 0);
        const numbered = every && !line.attr.classes?.includes("alg-nonum");
        if (numbered) n++;
        const no = numbered && n % every === 0 ? `${n}:` : "";
        const content = line.blocks.flatMap((x) => (x.t === "Plain" || x.t === "Para" ? x.content : []));
        return `<div class="tw-alg-line" style="padding-left:${(level * 1.5).toFixed(1)}em">${every ? `<span class="tw-alg-no">${no}</span>` : ""}${this.inlines(content)}</div>`;
      });
      return `<div class="tw-algorithmic${every ? " tw-alg-numbered" : ""}"${id}>${lines.join("")}</div>`;
    }
    const cls = classes.length ? ` class="${escAttr(classes.join(" "))}"` : "";
    return `<div${cls}${id}>${this.blocks(b.blocks)}</div>`;
  }

  private theorem(b: Extract<Block, { t: "Theorem" }>): string {
    const isProof = b.kind === "proof";
    const name = b.name ?? b.kind.charAt(0).toUpperCase() + b.kind.slice(1);
    const head = `<span class="tw-thm-head">${esc(name)}${b.number ? ` ${esc(b.number)}` : ""}${
      b.title?.length ? ` <span class="tw-thm-note">(${this.inlines(b.title)})</span>` : ""
    }.</span> `;
    const blocks = [...b.blocks];
    let body: string;
    // LaTeX runs the heading into the first paragraph.
    const first = blocks[0];
    if (first && (first.t === "Para" || first.t === "Plain")) {
      blocks.shift();
      body = `<p>${head}${this.inlines(first.content)}</p>${this.blocks(blocks)}`;
    } else {
      body = `<p>${head}</p>${this.blocks(blocks)}`;
    }
    if (isProof && !hasQedHere(b.blocks)) body += '<span class="tw-qed" aria-label="end of proof">&#x25A1;</span>';
    return `<div class="tw-theorem tw-thm-${escAttr(b.kind)}${isProof ? " tw-proof" : ""}"${b.id ? ` id="${escAttr(b.id)}"` : ""}>${body}</div>`;
  }

  private bibliography(appendHeading: boolean): string {
    if (this.bibliographyWritten) return "";
    this.bibliographyWritten = true;
    const items = this.ctx.citations.bibliography;
    if (!items.length) return "";
    const numeric = items.some((i) => i.label);
    const entries = items
      .map(
        (it) =>
          `<li id="${escAttr(it.id)}">${it.label ? `<span class="tw-bib-label">${esc(it.label)}</span>` : ""}<span class="tw-bib-text">${this.inlines(it.content)}</span></li>`,
      )
      .join("");
    const title = typeof this.ctx.doc.meta.extra?.["reference-section-title"] === "string" ? String(this.ctx.doc.meta.extra["reference-section-title"]) : "References";
    const heading = appendHeading || !this.precededByHeading() ? `<h2 class="tw-heading tw-bib-title">${esc(title)}</h2>` : "";
    return `<section class="tw-bibliography${numeric ? " tw-bib-numeric" : ""}">${heading}<ul>${entries}</ul></section>`;
  }

  private precededByHeading(): boolean {
    const blocks = this.ctx.doc.blocks;
    const at = blocks.findIndex((b) => b.t === "Bibliography");
    return at > 0 && blocks[at - 1]!.t === "Heading";
  }

  private raw(format: "html" | "latex", text: string, block: boolean): string {
    if (format === "latex") {
      // Raw LaTeX left after conversion is something texwright could not render (TikZ...). Show it, visibly.
      return block ? `<pre class="tw-raw-latex">${esc(text)}</pre>` : `<code class="tw-raw-latex">${esc(text)}</code>`;
    }
    if (this.opts.unsafeHtml) return text;
    const session = this.sanitizer();
    return this.sanitizeRaw(session, text, undefined) + session.close();
  }

  /** Where the raw HTML being sanitized came from, for image diagnostics. */
  private rawPos: Inline["pos"];

  /**
   * A sanitizer session for raw HTML (same policy as always: no scripts, event
   * handlers, styles, iframes or forms; http, https and mailto links). Images
   * follow the same folder and network rules as Markdown images.
   */
  private sanitizer(): HtmlSanitizer {
    return new HtmlSanitizer({
      imageSrc: (src) => {
        const res = resolveImage(src, this.opts.images, this.ctx.diagnostics, this.rawPos);
        return res.src && res.mime !== "application/pdf" ? res.src : undefined;
      },
    });
  }

  /** Sanitize one fragment of raw HTML in a session, reporting what was removed as HTML001. */
  private sanitizeRaw(session: HtmlSanitizer, text: string, pos: Inline["pos"]): string {
    this.rawPos = pos;
    const res = session.feed(text);
    if (res.removed) {
      this.ctx.diagnostics.add("HTML001", `Raw HTML was sanitized: removed ${res.removals.join(", ")}`, pos, {
        hint: "Pass --unsafe-html to keep raw HTML as written (only for trusted documents)",
      });
    }
    return res.html;
  }

  // ---------------------------------------------------------------- inlines

  inlines(inlines: Inline[], noLinks = false): string {
    let out = "";
    // Inline raw HTML arrives tag by tag (<b>, text, </b>), so one sanitizer
    // session spans the run: elements close where the author closed them, and
    // everything inside a dropped element (<script>...</script>) is skipped.
    let session: HtmlSanitizer | undefined;
    for (const i of inlines) {
      if (i.t === "RawInline" && i.format === "html" && !this.opts.unsafeHtml) {
        session ??= this.sanitizer();
        out += this.sanitizeRaw(session, i.text, i.pos);
        continue;
      }
      if (session?.dropping) continue;
      out += this.inline(i, noLinks);
    }
    return session ? out + session.close() : out;
  }

  private inline(i: Inline, noLinks: boolean): string {
    switch (i.t) {
      case "Text":
        return esc(i.text);
      case "SoftBreak":
        return "\n";
      case "LineBreak":
        return "<br>";
      case "Emph":
        return `<em>${this.inlines(i.content, noLinks)}</em>`;
      case "Strong":
        return `<strong>${this.inlines(i.content, noLinks)}</strong>`;
      case "Underline":
        return `<u>${this.inlines(i.content, noLinks)}</u>`;
      case "Strike":
        return `<s>${this.inlines(i.content, noLinks)}</s>`;
      case "SmallCaps":
        return `<span class="tw-smallcaps">${this.inlines(i.content, noLinks)}</span>`;
      case "Superscript":
        return `<sup>${this.inlines(i.content, noLinks)}</sup>`;
      case "Subscript":
        return `<sub>${this.inlines(i.content, noLinks)}</sub>`;
      case "Code":
        return `<code>${esc(i.text)}</code>`;
      case "Math": {
        let html = this.ctx.mathCache.get(i);
        if (html === undefined) {
          const tex = liftMacros(i.tex, this.ctx.macros, this.ctx.diagnostics, i.pos);
          html = mathml(tex, { display: false, macros: this.ctx.macros, diagnostics: this.ctx.diagnostics, pos: i.pos });
          this.ctx.mathCache.set(i, html);
        }
        return html;
      }
      case "Link": {
        const content = this.inlines(i.content, true);
        if (noLinks) return content;
        const safe = /^(https?:|mailto:|#|\.{0,2}\/|[^:]*$)/i.test(i.url) ? i.url : "#";
        return `<a href="${escAttr(safe)}"${i.title ? ` title="${escAttr(i.title)}"` : ""}>${content}</a>`;
      }
      case "Image":
        return this.image(i);
      case "Ref":
        return this.ref(i, noLinks);
      case "Cite": {
        const rendered = this.ctx.citations.rendered.get(i);
        if (!rendered || i.mode === "nocite") return "";
        return `<span class="tw-cite">${this.inlines(rendered, noLinks)}</span>`;
      }
      case "Note": {
        if (noLinks) return "";
        const n = ++this.noteCounter;
        const back = ` <a class="tw-fn-back" href="#fnref-${n}" aria-label="Back to text">↩</a>`;
        const body = this.blocks(i.blocks);
        this.notes.push(`<li id="fn-${n}">${body.endsWith("</p>") ? `${body.slice(0, -4)}${back}</p>` : body + back}</li>`);
        return `<sup class="tw-fnref"><a id="fnref-${n}" href="#fn-${n}">${n}</a></sup>`;
      }
      case "Span": {
        if (i.attr.classes?.includes("rule")) {
          // \rule{6cm}{0.4pt}: an inline block of ink.
          const a = i.attr.attrs ?? {};
          const css = (v: string | undefined) => (v && /^-?[\d.]+(%|pt|cm|mm|in|em|ex|px|pc)$/.test(v) ? v : undefined);
          const w = css(a.width) ?? "0";
          const h = css(a.height) ?? "0.4pt";
          return `<span class="tw-rule" style="display:inline-block;width:${w};height:${h};background:currentColor;vertical-align:${css(a.raise) ?? "0"}"></span>`;
        }
        if (i.attr.classes?.includes("color") && /^#[0-9a-f]{6}$/i.test(i.attr.attrs?.color ?? "")) {
          return `<span style="color:${i.attr.attrs!.color}">${this.inlines(i.content, noLinks)}</span>`;
        }
        const cls = i.attr.classes?.length ? ` class="${escAttr(i.attr.classes.join(" "))}"` : "";
        const id = i.attr.id ? ` id="${escAttr(i.attr.id)}"` : "";
        return `<span${cls}${id}>${this.inlines(i.content, noLinks)}</span>`;
      }
      case "RawInline":
        return this.raw(i.format, i.text, false);
    }
  }

  private image(i: Extract<Inline, { t: "Image" }>): string {
    // Diagrams texwright drew itself go in as SVG, so their labels are text in the page's own font.
    if (i.attr?.classes?.includes("tw-diagram") && i.src.startsWith("data:image/svg+xml;base64,")) {
      this.diagrams = true;
      const svg = Buffer.from(i.src.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
      const w = cssLength(i.width);
      return `<span class="tw-diagram"${w ? ` style="width:${w}"` : ""}>${svg}</span>`;
    }
    const res = resolveImage(i.src, this.opts.images, this.ctx.diagnostics, i.pos);
    const alt = plainText(i.alt);
    if (!res.src) {
      return `<span class="tw-missing-image" role="img" aria-label="${escAttr(alt)}">[image: ${esc(i.src)}]</span>`;
    }
    const style: string[] = [];
    const w = cssLength(i.width);
    const h = cssLength(i.height);
    if (w) style.push(`width:${w}`);
    if (h) style.push(`height:${h}`);
    const styleAttr = style.length ? ` style="${style.join(";")}"` : "";
    if (res.mime === "application/pdf") {
      this.ctx.diagnostics.add("IMG003", `PDF figure ${i.src} can't be shown in HTML`, i.pos, { hint: "Export the figure as SVG (vector) or PNG" });
      return `<span class="tw-missing-image" role="img" aria-label="${escAttr(alt)}">[PDF figure: ${esc(i.src)}]</span>`;
    }
    return `<img src="${escAttr(res.src)}" alt="${escAttr(alt)}"${i.title ? ` title="${escAttr(i.title)}"` : ""}${styleAttr}>`;
  }

  private ref(i: Extract<Inline, { t: "Ref" }>, noLinks: boolean): string {
    const info: LabelInfo | undefined = this.ctx.numbering.labels.get(i.label);
    let text = refText(info, i.style);
    // Page references have numbers only in PDF output (REF004).
    if (text === null) text = "??";
    if (!info) return `<span class="tw-ref tw-ref-missing">${esc(text)}</span>`;
    if (noLinks) return esc(text);
    return `<a class="tw-ref" href="#${escAttr(info.id)}">${esc(text)}</a>`;
  }
}

export function writeHtml(ctx: WriteContext, opts: HtmlOptions): string {
  return new HtmlWriter(ctx, opts).document();
}
