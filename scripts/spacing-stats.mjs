// Interword spacing statistics from texwright's own layout (not from the PDF):
// for every justified line set at its full measure that is not the last line of
// a paragraph, the average interword space; then the 10th, 50th and 90th
// percentiles over all such lines, and the number of lines ending in a hyphen.
//
//   node scripts/spacing-stats.mjs                     bench corpus + generated text, microtype on and off
//   node scripts/spacing-stats.mjs doc.md other.tex    just these files
//   options: --dist <folder> (default dist), --size <pt> for the generated text,
//            --pages <n> generated pages (default 30), --only on|off, --time
//
// The pages are taken where typesetPdf hands them to shipout, through a module
// hook that only this script installs.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const dist = resolve(root, opt("--dist", "dist"));
const genSize = Number(opt("--size", "0")) || undefined;
const genPages = Number(opt("--pages", "30"));
const only = opt("--only", "");
const timing = flag("--time");

// Hand the laid-out pages to this script before they are shipped.
const hook = `
export async function load(url, context, next) {
  const r = await next(url, context);
  if (url.endsWith("/typeset/index.js")) {
    const src = String(r.source).replace("shipout(writer, pages, ship);", "globalThis.__twPages?.(pages, ship); shipout(writer, pages, ship);");
    return { ...r, source: src };
  }
  return r;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, pathToFileURL("./"));
const { convert } = await import(pathToFileURL(join(dist, "src/index.js")).href);

let captured = [];
globalThis.__twPages = (pages, ship) => {
  captured = pages.map((p) => ("box" in p ? p.box : p));
  captured.textWidth = ship.pageWidth - ship.margins.left - (ship.margins.right ?? ship.margins.left);
};

/** Glue width inside a packed box (as layout/pack.ts glueSize). */
function glueSize(g, set) {
  if (!set || set.sign === "none" || set.ratio === 0) return g.width;
  if (set.sign === "stretch") return g.stretchOrder === set.order ? g.width + set.ratio * g.stretch : g.width;
  return g.shrinkOrder === set.order ? g.width - set.ratio * g.shrink : g.width;
}

const isSpace = (n) => n.t === "glue" && !n.leader && n.stretchOrder === 0 && n.stretch > 0 && n.width > 0;

/** The last glyph's text on a line, looking into nested boxes and past kerns. */
function lastText(children) {
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    if (c.t === "glyphs" && c.text.length) return c.text[c.text.length - 1];
    if (c.t === "hbox") {
      const t = lastText(c.children);
      if (t !== undefined) return t;
    }
    if (c.t === "glyphs" || c.t === "rule" || c.t === "image" || c.t === "drawing" || c.t === "vbox") return undefined;
    if (c.t === "glue" && c.width > 0) return undefined;
  }
  return undefined;
}

/** Justified lines of a page: hboxes in vertical lists with finite glue only and at least two interword spaces between glyphs. */
function collect(box, textWidth, out) {
  for (const c of box.children) {
    if (c.t === "vbox") collect(c, textWidth, out);
    else if (c.t === "hbox") {
      const kids = c.children;
      const infinite = kids.some((n) => n.t === "glue" && (n.stretchOrder > 0 || n.shrinkOrder > 0));
      const spaces = [];
      for (let i = 1; i + 1 < kids.length; i++) if (isSpace(kids[i]) && kids[i - 1].t === "glyphs" && kids[i + 1].t === "glyphs") spaces.push(glueSize(kids[i], c.glueSet));
      if (!infinite && spaces.length >= 2 && c.glueSet && c.glueSet.sign !== "none") {
        const end = lastText(kids);
        out.push({ width: c.width, full: Math.abs(c.width - textWidth) < 0.5, avg: spaces.reduce((a, b) => a + b, 0) / spaces.length, hyphen: end === "-" || end === "‐", hscale: hscaleOf(kids) });
      } else {
        // Boxes holding lists (tables, callouts drawn as hboxes) may contain lines.
        for (const k of kids) if (k.t === "vbox") collect(k, textWidth, out);
      }
    }
  }
}

function hscaleOf(kids) {
  for (const k of kids) if (k.t === "glyphs" && k.hscale) return k.hscale;
  return 1;
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const x = (sorted.length - 1) * p;
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (x - lo);
}

async function measure(input, extra = {}) {
  captured = [];
  const t = performance.now();
  const r = await convert({ to: "pdf", ...input, ...extra });
  const ms = performance.now() - t;
  const lines = [];
  for (const p of captured) collect(p, captured.textWidth, lines);
  return { lines, ms, pages: r.stats.pages ?? 0, ok: r.ok };
}

function summary(label, lines, pages, ms) {
  const full = lines.filter((l) => l.full);
  const avg = full.map((l) => l.avg).sort((a, b) => a - b);
  const hy = full.filter((l) => l.hyphen).length;
  const expanded = full.filter((l) => l.hscale !== 1).length;
  const f = (v) => v.toFixed(2);
  return `${label.padEnd(26)} lines ${String(full.length).padStart(5)}  p10 ${f(pct(avg, 0.1))}  p50 ${f(pct(avg, 0.5))}  p90 ${f(pct(avg, 0.9))}  spread ${f(pct(avg, 0.9) - pct(avg, 0.1))}  hyphen ends ${String(hy).padStart(4)}  expanded ${String(expanded).padStart(4)}  pages ${pages}${timing ? `  ${ms.toFixed(0)} ms` : ""}`;
}

/** A long text of real words in sentences and paragraphs, deterministic. */
function generatedText(pages) {
  const sources = ["README.md", "DESIGN.md", "paper/texwright.md", "CONTRIBUTING.md"].map((f) => readFileSync(join(root, f), "utf8"));
  const words = sources
    .join(" ")
    .replace(/`[^`]*`|\$[^$]*\$|\[[^\]]*\]\([^)]*\)|https?:\S+|[#*_|{}<>\\=]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z'-]/g, "").replace(/^-+|-+$/g, ""))
    .filter((w) => /^[A-Za-z][a-z'-]*$/.test(w) && w.length < 16);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = () => words[Math.floor(rnd() * words.length)];
  const paras = [];
  const target = pages * 470; // about 470 words a page at 11pt on letter paper
  let count = 0;
  while (count < target) {
    const sentences = [];
    const ns = 3 + Math.floor(rnd() * 6);
    for (let s = 0; s < ns; s++) {
      const n = 6 + Math.floor(rnd() * 20);
      const ws = [];
      for (let k = 0; k < n; k++) ws.push(pick().toLowerCase());
      ws[0] = ws[0][0].toUpperCase() + ws[0].slice(1);
      if (n > 10 && rnd() < 0.4) ws[Math.floor(n / 2)] += ",";
      sentences.push(ws.join(" ") + (rnd() < 0.1 ? "?" : "."));
      count += n;
    }
    paras.push(sentences.join(" "));
    if (paras.length % 12 === 0) paras.push(`# Section ${paras.length / 12}`);
  }
  return `---\ntitle: Spacing test\n---\n\n${paras.join("\n\n")}\n`;
}

const inputs = [];
if (args.length) for (const f of args) inputs.push({ name: f, input: { input: resolve(f) } });
else {
  for (const set of ["a", "b", "c", "d"]) {
    const dir = join(root, "bench/corpus", set);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) if (/\.(md|tex)$/.test(f)) inputs.push({ name: `${set}/${f}`, corpus: true, input: { input: join(dir, f) } });
  }
  inputs.push({ name: "showcase", input: { input: join(root, "examples/showcase/showcase.md") } });
  inputs.push({ name: "paper", input: { input: join(root, "paper/texwright.md") } });
  inputs.push({ name: "generated 11pt", gen: true, input: { source: generatedText(genPages), baseDir: root, fontSize: genSize ?? 11 } });
  inputs.push({ name: "generated 10pt", gen: true, input: { source: generatedText(genPages), baseDir: root, fontSize: 10 } });
}

const modes = only ? [only] : ["off", "on"];
for (const mode of modes) {
  const extra = mode === "off" ? { meta: { microtype: false } } : {};
  const corpus = [];
  let corpusPages = 0;
  let corpusMs = 0;
  console.log(`\nmicrotype ${mode}`);
  for (const it of inputs) {
    const { lines, pages, ms } = await measure(it.input, extra);
    if (it.corpus) {
      corpus.push(...lines);
      corpusPages += pages;
      corpusMs += ms;
      if (args.length) console.log(summary(it.name, lines, pages, ms));
    } else console.log(summary(it.name, lines, pages, ms));
  }
  if (corpus.length || corpusPages) console.log(summary("bench corpus (80 docs)", corpus, corpusPages, corpusMs));
}
