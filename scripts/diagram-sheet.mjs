#!/usr/bin/env node
/**
 * Development check for diagrams: draws every .mmd file in a folder with
 * texwright's diagram engine, writes the SVG and a PNG (texwright's own
 * rasterizer) next to each other in the output folder, and prints errors and
 * timings. With --mermaid it also renders the same sources with Mermaid in
 * Chrome for comparison, when a mermaid.min.js is given via MERMAID_JS.
 *
 *   node scripts/diagram-sheet.mjs [folder] [--out dir] [--only name] [--scale 1.5]
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string", default: ".mybuild/diagrams" }, only: { type: "string" }, scale: { type: "string", default: "1.5" }, build: { type: "string", default: "dist" } },
});
const folder = resolve(positionals[0] ?? "test/diagram-suite");
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const build = resolve(values.build);
const load = (p) => import(pathToFileURL(join(build, p)).href);
const { renderDiagram } = await load("src/diagram/index.js");
const { svgToDrawing } = await load("src/svg/index.js");
const { drawOps } = await load("src/layout/shipout.js");
const { createRasterWriter } = await load("src/raster/index.js");

const scale = Number(values.scale);
for (const f of readdirSync(folder).filter((x) => x.endsWith(".mmd") && (!values.only || x.includes(values.only))).sort()) {
  const src = readFileSync(join(folder, f), "utf8");
  const t0 = performance.now();
  const r = renderDiagram(src);
  const ms = performance.now() - t0;
  const name = basename(f, ".mmd");
  if (r.svg) {
    writeFileSync(join(out, `${name}.svg`), r.svg);
    const drawing = svgToDrawing(r.svg, { widthPt: r.width * 0.75 * scale });
    const writer = createRasterWriter({ dpi: 96 });
    const page = writer.addPage(drawing.width + 8, drawing.height + 8);
    drawOps(page, drawing, 4, 4);
    writer.finish();
    writeFileSync(join(out, `${name}.png`), writer.pages[0].png());
  }
  console.log(`${name.padEnd(28)} ${r.kind.padEnd(10)} ${String(Math.round(r.width)).padStart(5)}x${String(Math.round(r.height)).padEnd(5)} ${ms.toFixed(1).padStart(6)} ms  ${r.errors.map((e) => `L${e.line + 1}:${e.col + 1} ${e.message}`).join(" | ")}`);
}
console.log(`output in ${out}`);
