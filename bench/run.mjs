#!/usr/bin/env node
/**
 * Benchmark: documents written by language models the way they write them
 * when asked for a PDF, run through texwright unchanged. It reports how many
 * come out clean on the first try, how many a safe automatic fix repairs,
 * and which diagnostics stop the rest.
 *
 *   node bench/run.mjs [--build dist] [--bundle] [--corpus bench/corpus] [--sets a,c] [--out bench/out] [--json results.json] [--verbose]
 *
 * Each folder under the corpus holds documents, their assets and a
 * manifest.json listing them. The documents are never modified: fixes are
 * tried on copies in the output folder. --bundle runs the single-file bundle
 * (dist/texwright.mjs) instead of the modules under dist/src.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    build: { type: "string", default: join(here, "..", "dist") },
    bundle: { type: "boolean", default: false },
    corpus: { type: "string", default: join(here, "corpus") },
    sets: { type: "string" },
    out: { type: "string", default: join(here, "out") },
    json: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
});

const api = await import(pathToFileURL(values.bundle ? join(resolve(values.build), "texwright.mjs") : join(resolve(values.build), "src", "index.js")).href);
const { convert, fixDocument } = api;

const corpus = resolve(values.corpus);
const sets = readdirSync(corpus, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(corpus, d.name, "manifest.json")))
  .map((d) => d.name)
  .filter((name) => !values.sets || values.sets.split(",").includes(name))
  .sort();

const results = [];
for (const set of sets) {
  const dir = join(corpus, set);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const out = join(resolve(values.out), set);
  mkdirSync(out, { recursive: true });
  for (const entry of manifest) {
    const input = join(dir, entry.file);
    const t0 = performance.now();
    const res = await convert({ input, to: "pdf", output: join(out, `${basename(entry.file).replace(/\.\w+$/, "")}.pdf`) });
    const ms = performance.now() - t0;
    const errors = res.diagnostics.filter((d) => d.severity === "error");
    const warnings = res.diagnostics.filter((d) => d.severity === "warning");
    const infos = res.diagnostics.filter((d) => d.severity === "info");

    // Safe fixes, tried on a copy of the document and its assets.
    let afterFix;
    if (res.diagnostics.some((d) => d.fix?.safe)) {
      const work = join(out, "fixed", basename(entry.file, ".md").replace(/\.tex$/, ""));
      mkdirSync(work, { recursive: true });
      for (const f of [entry.file, ...(entry.assets ?? [])]) if (existsSync(join(dir, f))) copyFileSync(join(dir, f), join(work, f));
      const fixed = fixDocument({ input: join(work, entry.file) });
      afterFix = {
        applied: fixed.applied.length,
        errors: fixed.diagnostics.filter((d) => d.severity === "error").length,
        warnings: fixed.diagnostics.filter((d) => d.severity === "warning").length,
      };
    }
    results.push({
      set,
      file: entry.file,
      kind: entry.kind,
      format: entry.format,
      pages: res.stats.pages,
      ms: Math.round(ms),
      errors: errors.length,
      warnings: warnings.length,
      infos: infos.length,
      afterFix,
      diagnostics: res.diagnostics.map((d) => ({ code: d.code, severity: d.severity, line: d.line, message: d.message, fix: d.fix })),
    });
  }
}

// ---------------------------------------------------------------- report

const n = results.length;
const pct = (k) => `${k}/${n} (${n ? Math.round((100 * k) / n) : 0}%)`;
const clean = results.filter((r) => r.errors === 0 && r.warnings === 0);
const renders = results.filter((r) => r.errors === 0);
const fixedClean = results.filter((r) => (r.afterFix ? r.afterFix.errors === 0 && r.afterFix.warnings === 0 : r.errors === 0 && r.warnings === 0));

console.log(`${n} documents in ${sets.length} set(s): ${sets.join(", ")}`);
console.log(`  clean on the first try (no errors, no warnings): ${pct(clean.length)}`);
console.log(`  render without errors on the first try:          ${pct(renders.length)}`);
console.log(`  clean after safe automatic fixes:                ${pct(fixedClean.length)}`);
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
if (n) console.log(`  time per document: median ${ms[Math.floor(n / 2)]} ms, max ${ms[n - 1]} ms`);

for (const fmt of ["markdown", "latex"]) {
  const sub = results.filter((r) => r.format === fmt);
  if (sub.length) console.log(`  ${fmt}: ${sub.filter((r) => r.errors === 0 && r.warnings === 0).length}/${sub.length} clean`);
}

const byCode = new Map();
for (const r of results) {
  for (const code of new Set(r.diagnostics.filter((d) => d.severity !== "info").map((d) => d.code))) {
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
}
if (byCode.size) {
  console.log("\nDocuments affected, by diagnostic code:");
  for (const [code, k] of [...byCode].sort((a, b) => b[1] - a[1])) console.log(`  ${code.padEnd(8)} ${k}`);
}

console.log("\nPer document:");
for (const r of results) {
  const status = r.errors ? "ERR " : r.warnings ? "WARN" : "ok  ";
  const fix = r.afterFix ? ` (after fixes: ${r.afterFix.errors}E ${r.afterFix.warnings}W)` : "";
  console.log(`  ${status} ${r.set}/${r.file} ${r.errors}E ${r.warnings}W ${r.infos}I ${r.pages ?? "-"}p ${r.ms}ms${fix}`);
  if (values.verbose || r.errors || r.warnings) {
    for (const d of r.diagnostics.filter((x) => values.verbose || x.severity !== "info")) {
      console.log(`         ${d.severity[0].toUpperCase()} ${d.code} L${d.line ?? "?"} ${d.message.slice(0, 150)}`);
    }
  }
}

if (values.json) writeFileSync(values.json, JSON.stringify(results, null, 2));
