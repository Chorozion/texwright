// Timings for the paper's performance table: node scripts/measure.mjs (after npm run build).
// Each task runs a few times after a warm-up; the median is reported.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, convert } from "../dist/src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rows = [];

async function time(label, fn, runs = 7) {
  await fn();
  const ms = [];
  let last;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    last = await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const median = ms[Math.floor(ms.length / 2)];
  rows.push([label, median]);
  console.error(`${label}: median ${median.toFixed(0)} ms`);
  return last;
}

const show = join(root, "examples/showcase/showcase.md");
const art = join(root, "examples/latex/article.tex");
const paper = join(root, "paper/texwright.md");

const pages = (r) => r.stats.pages;
await time("`check` the showcase document", () => check({ input: show }));
await time("`check` the LaTeX article example", () => check({ input: art }));
await time("showcase to standalone HTML", () => convert({ input: show, to: "html" }));
const s = await time(`showcase to PDF`, () => convert({ input: show, to: "pdf" }));
const a = await time(`LaTeX article to PDF`, () => convert({ input: art, to: "pdf" }));
const p = await time(`this paper to PDF`, () => convert({ input: paper, to: "pdf" }), 5);
rows[3][0] += ` (${pages(s)} pages)`;
rows[4][0] += ` (${pages(a)} pages)`;
rows[5][0] += ` (${pages(p)} pages)`;

const parts = ["---\nnumber-sections: true\n---\n"];
for (let k = 0; k < 200; k++) {
  parts.push(`# Section ${k} {#sec:s${k}}\n`);
  for (let j = 0; j < 10; j++) parts.push(`Paragraph ${j} with $x_${j}^2 + y$ and a reference to @sec:s${Math.max(0, k - 1)}.\n`);
  parts.push(`$$ \\sum_{i=1}^{${k + 1}} i = \\frac{n(n+1)}{2} $$ {#eq:e${k}}\n`);
}
const big = parts.join("\n");
const kb = Math.round(big.length / 1024);
await time(`\`check\` 2,000 paragraphs and 200 equations (${kb} KB)`, () => check({ source: big }), 3);
const bp = await time(`the same document to PDF`, () => convert({ source: big, to: "pdf" }), 3);
rows[rows.length - 1][0] += ` (${pages(bp)} pages)`;

let mb = "";
let i = 0;
while (mb.length < 1_000_000) {
  mb += `## Part ${i} {#sec:p${i}}\n\nSome *emphasis*, **strong** text, a [link](https://example.com) and \`code\`; see @sec:p${Math.max(0, i - 1)}.\n\n- item one\n- item two with $a^2$\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n`;
  i++;
}
await time("`check` 1 MB of mixed Markdown", () => check({ source: mb }), 3);

const fmt = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
console.log("| Task | Time |\n|:-----|-----:|");
for (const [label, ms] of rows) console.log(`| ${label} | ${fmt(ms)} |`);
