#!/usr/bin/env node
/**
 * Development check for the SVG renderer: draws every SVG in a folder with
 * texwright (svgToDrawing, then the page rasterizer) and with Chrome, and
 * compares the two pixel by pixel. Writes a side-by-side image per file
 * (Chrome | texwright | difference) and prints a table.
 *
 *   node scripts/svg-compare.mjs [folder] [--out dir] [--width 480] [--only name] [--pdf]
 *
 * With --pdf, texwright's side is the PDF writer's output drawn by poppler's
 * pdftoppm (set PDFTOPPM to its path if it is not on PATH), which checks the
 * PDF itself: shadings, soft masks, transparency groups, blend modes.
 *
 * Needs Chrome or Edge installed (set CHROME to its path otherwise). It is a
 * tool for working on the renderer, not part of the test suite.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string", default: ".mybuild/svg-compare" }, width: { type: "string", default: "480" }, only: { type: "string" }, build: { type: "string", default: "dist" }, pdf: { type: "boolean", default: false } },
});
const folder = resolve(positionals[0] ?? "test/svg-suite");
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const build = resolve(values.build);
const { svgToDrawing } = await import(pathToFileURL(join(build, "src/svg/index.js")).href);
const { drawOps } = await import(pathToFileURL(join(build, "src/layout/shipout.js")).href);
const { createRasterWriter } = await import(pathToFileURL(join(build, "src/raster/index.js")).href);
const { decodePng } = await import(pathToFileURL(join(build, "src/pdf/png.js")).href);
const { encodePng } = await import(pathToFileURL(join(build, "src/raster/png.js")).href);
const { isEmbeddedImage } = await import(pathToFileURL(join(build, "src/svg/image.js")).href);
const { Diagnostics } = await import(pathToFileURL(join(build, "src/diagnostics.js")).href);
const { createPdfWriter } = await import(pathToFileURL(join(build, "src/pdf/writer.js")).href);

const chrome = process.env.CHROME ?? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => existsSync(p));
if (!chrome) throw new Error("No Chrome or Edge found; set CHROME");

const W = Number(values.width);
const files = readdirSync(folder).filter((f) => f.endsWith(".svg") && (!values.only || f.includes(values.only))).sort();
const scratch = join(tmpdir(), "texwright-svg-compare");
mkdirSync(scratch, { recursive: true });

/** Every op, nested groups and masks included. */
function* allOps(ops) {
  for (const op of ops) {
    yield op;
    if (op.ops) yield* allOps(op.ops);
    if (op.mask?.ops) yield* allOps(op.mask.ops);
  }
}

function ours(text) {
  const diagnostics = new Diagnostics();
  const drawing = svgToDrawing(text, { widthPt: W * 0.75, diagnostics });
  if (values.pdf) return { png: viaPdf(drawing), notes: diagnostics.items.map((d) => d.message) };
  const writer = createRasterWriter({ dpi: 96 });
  for (const op of allOps(drawing.ops)) if (op.op === "image" && isEmbeddedImage(op.image)) op.image = writer.addImage(op.image.bytes);
  const page = writer.addPage(drawing.width, drawing.height);
  drawOps(page, drawing, 0, 0);
  writer.finish();
  const png = writer.pages[0].png();
  return { png: decodePng(png), notes: diagnostics.items.map((d) => d.message) };
}

/** The drawing written as a one-page PDF and drawn by pdftoppm at 96 dpi. */
function viaPdf(drawing) {
  const writer = createPdfWriter();
  for (const op of allOps(drawing.ops)) if (op.op === "image" && isEmbeddedImage(op.image)) op.image = writer.addImage(op.image.bytes);
  const page = writer.addPage(drawing.width, drawing.height);
  drawOps(page, drawing, 0, 0);
  const pdf = join(scratch, "page.pdf");
  writeFileSync(pdf, writer.finish());
  const base = join(scratch, "pdfpage");
  rmSync(base + ".png", { force: true });
  const r = spawnSync(process.env.PDFTOPPM ?? "pdftoppm", ["-r", "96", "-png", "-singlefile", pdf, base], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pdftoppm failed: ${r.stderr || r.error}`);
  return decodePng(new Uint8Array(readFileSync(base + ".png")));
}

function reference(file, w, h) {
  const html = join(scratch, "page.html");
  writeFileSync(html, `<!doctype html><html><body style="margin:0;background:#fff"><img src="${pathToFileURL(file).href}" style="display:block;width:${w}px;height:${h}px"></body></html>`);
  const shot = join(scratch, "shot.png");
  rmSync(shot, { force: true });
  spawnSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--allow-file-access-from-files", `--window-size=${w},${h}`, `--screenshot=${shot}`, pathToFileURL(html).href], { stdio: "ignore", timeout: 60000 });
  return decodePng(new Uint8Array(readFileSync(shot)));
}

const rgbAt = (img, x, y) => {
  if (x >= img.width || y >= img.height) return [255, 255, 255];
  const ch = img.color === "rgb" ? 3 : 1;
  const i = (y * img.width + x) * ch;
  const p = img.pixels;
  let c = ch === 3 ? [p[i], p[i + 1], p[i + 2]] : [p[i], p[i], p[i]];
  if (img.alpha) {
    const a = img.alpha[y * img.width + x] / 255;
    c = c.map((v) => v * a + 255 * (1 - a));
  }
  return c;
};

const rows = [];
for (const f of files) {
  const text = readFileSync(join(folder, f), "utf8");
  let mine;
  try {
    mine = ours(text);
  } catch (e) {
    rows.push({ f, err: e.message });
    continue;
  }
  const w = mine.png.width;
  const h = mine.png.height;
  const ref = reference(join(folder, f), w, h);
  // Side by side: reference | ours | difference.
  const SW = w * 3 + 8;
  const sheet = new Uint8Array(SW * h * 3).fill(128);
  let sum = 0;
  let big = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = rgbAt(ref, x, y);
      const b = rgbAt(mine.png, x, y);
      const d = Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
      sum += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
      if (d > 64) big++;
      const put = (ox, c) => {
        const o = (y * SW + ox + x) * 3;
        sheet[o] = c[0];
        sheet[o + 1] = c[1];
        sheet[o + 2] = c[2];
      };
      put(0, a);
      put(w + 4, b);
      put(2 * w + 8, [255, 255 - Math.min(255, d * 2), 255 - Math.min(255, d * 2)]);
    }
  }
  writeFileSync(join(out, basename(f, ".svg") + ".png"), encodePng(SW, h, sheet));
  rows.push({ f, mean: sum / (w * h), big: (100 * big) / (w * h), notes: mine.notes });
}

console.log("file                                  mean   >64%   notes");
for (const r of rows) {
  if (r.err) console.log(`${r.f.padEnd(36)}  ERROR ${r.err}`);
  else console.log(`${r.f.padEnd(36)} ${r.mean.toFixed(2).padStart(6)} ${r.big.toFixed(2).padStart(6)}   ${r.notes.slice(0, 2).join(" / ").slice(0, 110)}`);
}
console.log(`side-by-side images in ${out}`);
