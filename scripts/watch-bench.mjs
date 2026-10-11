#!/usr/bin/env node
/**
 * Watch-mode benchmark: how long from saving an edit to the new PDF being in
 * place, with and without the layout caches.
 *
 *   node scripts/watch-bench.mjs [--cli dist/src/cli.js] [--docs a,b,tikz3d] [--n 10] [--memory-edits 100]
 *                                [--modes before,after] [--debounce 30] [--work bench/out/watch-bench] [--json out.json] [--verbose]
 *                                [--memory-only] [--worker-mb 64]
 *
 * For each document a copy is made under --work and `texwright watch --diagnostics json` is started on it.
 * Then, one at a time, the copy is edited and the time until watch reports the new PDF written is measured:
 *   text     a sentence appended to a paragraph near the middle, --n times (cumulative)
 *   formula  an inline formula changed (+ k), --n times
 *   diagram  a node added to a TikZ picture, --n times (documents with one)
 * "before" runs watch with TEXWRIGHT_NO_CACHE=1: every render redone in full in the warm process, as the MCP
 * server's render_document did; "after" uses the caches. Latency includes the debounce (default 30 ms); the
 * render-only time watch reports is given beside it. Finally --memory-edits text edits on the largest document
 * show resident memory and heap over a long session, and a warm worker (the MCP server's render path) is timed
 * on the same edits (--worker-mb sets TEXWRIGHT_WORKER_MB, the size past which that worker is replaced).
 * --memory-only skips the per-document edits.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    cli: { type: "string" },
    docs: { type: "string", default: "a,b,tikz3d" },
    n: { type: "string", default: "10" },
    "memory-edits": { type: "string", default: "100" },
    modes: { type: "string", default: "before,after" },
    debounce: { type: "string", default: "30" },
    work: { type: "string", default: join(root, "bench", "out", "watch-bench") },
    json: { type: "string" },
    verbose: { type: "boolean", default: false },
    "mcp-child": { type: "string" },
    "memory-only": { type: "boolean", default: false },
    "worker-mb": { type: "string" },
  },
});

const cli = resolve(values.cli ?? [join(root, "dist", "src", "cli.js"), join(root, "dist", "cli.mjs")].find((p) => existsSync(p)) ?? "dist/src/cli.js");
const N = Math.max(1, Number(values.n));
const MEM_EDITS = Math.max(0, Number(values["memory-edits"]));
const modes = values.modes.split(",").filter((m) => m === "before" || m === "after");
const work = resolve(values.work);

// ------------------------------------------------------------------ MCP worker child

if (values["mcp-child"]) {
  // Times runIsolated (the MCP server's render path) on a document edited between calls; prints one JSON line.
  const { runIsolated } = await import(pathToFileURL(join(dirname(cli), "isolate.js")).href);
  const [doc, count] = JSON.parse(values["mcp-child"]);
  const out = doc.replace(/\.[^.]+$/, ".pdf");
  const text = readFileSync(doc, "utf8");
  const plan = editPlan(text, extname(doc));
  const times = [];
  await runIsolated({ op: "convert", options: { input: doc, output: out, to: "pdf" } }, 120_000);
  for (let k = 1; k <= count; k++) {
    writeFileSync(doc, plan.text(k));
    const t0 = performance.now();
    await runIsolated({ op: "convert", options: { input: doc, output: out, to: "pdf" } }, 120_000);
    times.push(performance.now() - t0);
  }
  process.stdout.write(`${JSON.stringify({ times })}\n`);
  process.exit(0);
}

// ------------------------------------------------------------------ documents and edits

function listDocs() {
  const sets = { a: "bench/corpus/a", b: "bench/corpus/b", c: "bench/corpus/c", d: "bench/corpus/d", tikz3d: "test/tikz-suite-3d" };
  const out = [];
  for (const name of values.docs.split(",")) {
    const dir = sets[name] ? join(root, sets[name]) : resolve(name);
    if (!existsSync(dir)) continue;
    if (statSync(dir).isFile()) out.push(dir);
    else for (const f of readdirSync(dir).sort()) if (/\.(md|tex)$/.test(f)) out.push(join(dir, f));
  }
  return out;
}

/** Where the body starts (after front matter or \begin{document}) and ends. */
function body(lines, tex) {
  let start = 0;
  let end = lines.length;
  if (tex) {
    start = lines.findIndex((l) => /\\begin\{document\}/.test(l)) + 1;
    const e = lines.findIndex((l) => /\\end\{document\}/.test(l));
    if (e >= 0) end = e;
  } else if (lines[0]?.trim() === "---") {
    const e = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    start = e + 1;
  }
  return { start: Math.max(0, start), end };
}

/** Lines of plain prose: not code, tables, math, headings, list markup or LaTeX environments. */
function proseLines(lines, tex) {
  const { start, end } = body(lines, tex);
  const out = [];
  let fence = false;
  let display = false;
  for (let k = start; k < end; k++) {
    const l = lines[k];
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (/^\s*\$\$/.test(l) && !/\$\$.*\$\$/.test(l)) display = !display;
    if (fence || display) continue;
    if (l.length < 50 || !/^[A-Za-z]/.test(l) || /[|\\{}]$/.test(l) || /^(\\|#|\||>|-|\*|\d+\.)/.test(l)) continue;
    if (tex && /\\(begin|end|item|section|caption|label)/.test(l)) continue;
    out.push(k);
  }
  return out;
}

/** The edits a document allows: each a function of k (1, 2, ...) giving the whole new text, edits cumulative from the original. */
function editPlan(text, ext) {
  const tex = ext === ".tex";
  const lines = text.split("\n");
  const plan = {};
  // text: a sentence appended to the prose line nearest the middle (or a new paragraph before the end).
  const prose = proseLines(lines, tex);
  const { end } = body(lines, tex);
  const target = prose.length ? prose.reduce((a, b) => (Math.abs(b - lines.length / 2) < Math.abs(a - lines.length / 2) ? b : a)) : -1;
  plan.text = (k) => {
    const added = Array.from({ length: k }, (_, j) => ` This is added sentence number ${j + 1}, which says a little more.`).join("");
    const copy = [...lines];
    if (target >= 0) copy[target] = copy[target].replace(/\s*$/, "") + added;
    else copy.splice(end, 0, "", added.trim(), "");
    return copy.join("\n");
  };
  // formula: the first inline formula in a prose-like line gets "+ k".
  const { start } = body(lines, tex);
  for (let k = start; k < lines.length && !plan.formula; k++) {
    const m = /(?<![$\\])\$(?!\$)([^$\n]{1,80}?)\$(?!\$)/.exec(lines[k]);
    if (!m || /^\s*(```|\|)/.test(lines[k])) continue;
    const line = k;
    plan.formula = (j) => {
      const copy = [...lines];
      copy[line] = copy[line].slice(0, m.index) + `$${m[1]} + ${j}$` + copy[line].slice(m.index + m[0].length);
      return copy.join("\n");
    };
  }
  // diagram: a node added before the last \end{tikzpicture}.
  const pic = lines.map((l, k) => (/\\end\{tikzpicture\}/.test(l) ? k : -1)).filter((k) => k >= 0).pop();
  if (pic !== undefined) {
    plan.diagram = (j) => {
      const copy = [...lines];
      copy.splice(pic, 0, `\\node[opacity=0.6] at (0,0) {${j}};`);
      return copy.join("\n");
    };
  }
  return plan;
}

// ------------------------------------------------------------------ watch child

/** Starts watch on `doc`; resolves to a handle that waits for render reports. */
function startWatch(doc, mode) {
  const env = { ...process.env, SOURCE_DATE_EPOCH: "1700000000" };
  if (mode === "before") env.TEXWRIGHT_NO_CACHE = "1";
  else delete env.TEXWRIGHT_NO_CACHE;
  const child = spawn(process.execPath, [cli, "watch", doc, "--diagnostics", "json", "--debounce", values.debounce], { env, stdio: ["ignore", "pipe", "pipe"] });
  const reports = [];
  const waiters = [];
  let buf = "";
  child.stdout.on("data", (chunk) => {
    const at = performance.now();
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof r.render !== "number") continue;
      r.at = at;
      reports.push(r);
      for (const w of waiters.splice(0)) w();
    }
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  /** Waits for render number n (or fails after `ms`). */
  const waitFor = (n, ms = 30_000) =>
    new Promise((ok, fail) => {
      const check = () => {
        const r = reports.find((x) => x.render === n);
        if (r) {
          clearTimeout(timer);
          ok(r);
        } else waiters.push(check);
      };
      const timer = setTimeout(() => fail(new Error(`no render ${n} of ${basename(doc)} within ${ms} ms${stderr ? `: ${stderr.slice(0, 300)}` : ""}`)), ms);
      check();
    });
  const stop = () =>
    new Promise((ok) => {
      child.once("exit", ok);
      child.kill();
    });
  return { waitFor, stop, reports };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(0).padStart(5) : "    -");

/** Copies a document and the files beside it (images, bibliographies, data) to a fresh folder. */
function copyDoc(doc, mode) {
  const dir = join(work, mode, basename(dirname(doc)), basename(doc, extname(doc)));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dirname(doc))) {
    const p = join(dirname(doc), f);
    if (statSync(p).isFile() && !/\.(pdf|png)$/i.test(f)) copyFileSync(p, join(dir, f));
  }
  return join(dir, basename(doc));
}

/** Runs one kind of edit `count` times on a running watch; returns [latency, render ms] pairs. */
async function runEdits(w, file, edit, count, startRender) {
  const out = [];
  let n = startRender;
  for (let k = 1; k <= count; k++) {
    const text = edit(k);
    await sleep(40);
    const t0 = performance.now();
    writeFileSync(file, text);
    n++;
    const r = await w.waitFor(n);
    out.push({ latency: r.at - t0, render: r.ms, pages: r.pages, rss: r.memory?.rss, heap: r.memory?.heap });
  }
  return { results: out, last: n };
}

// ------------------------------------------------------------------ main

const docs = listDocs();
if (!docs.length) {
  console.error("no documents found");
  process.exit(2);
}
console.log(`texwright watch benchmark: ${docs.length} documents, ${N} edits of each kind, debounce ${values.debounce} ms, cli ${cli}`);
const results = { cli, debounce: Number(values.debounce), n: N, modes: {}, memory: {}, mcp: {} };

for (const mode of values["memory-only"] ? [] : modes) {
  const all = { first: [], text: [], formula: [], diagram: [] };
  const perDoc = [];
  for (const doc of docs) {
    const original = readFileSync(doc, "utf8");
    const plan = editPlan(original, extname(doc));
    const file = copyDoc(doc, mode);
    const w = startWatch(file, mode);
    try {
      const first = await w.waitFor(1, 120_000);
      all.first.push(first.ms);
      const row = { doc: doc.slice(root.length + 1).replace(/\\/g, "/"), pages: first.pages, first: first.ms };
      let n = 1;
      for (const kind of ["text", "formula", "diagram"]) {
        if (!plan[kind]) continue;
        // Each kind starts from the original text.
        writeFileSync(file, original);
        await sleep(40);
        n++;
        await w.waitFor(n).catch(() => n--); // the restore may be a no-op (same text) and render nothing
        const { results: rs, last } = await runEdits(w, file, plan[kind], N, n);
        n = last;
        all[kind].push(...rs);
        row[kind] = { latency: median(rs.map((r) => r.latency)), render: median(rs.map((r) => r.render)) };
      }
      perDoc.push(row);
      if (values.verbose) {
        console.log(
          `  ${mode.padEnd(6)} ${row.doc.padEnd(56)} first ${fmt(row.first)}  text ${fmt(row.text?.latency)}/${fmt(row.text?.render)}  formula ${fmt(row.formula?.latency)}/${fmt(row.formula?.render)}  diagram ${fmt(row.diagram?.latency)}/${fmt(row.diagram?.render)}`,
        );
      }
    } catch (e) {
      console.log(`  ${mode} ${doc}: ${e.message}`);
    } finally {
      await w.stop();
    }
  }
  const summary = {
    firstRender: median(all.first),
    text: { latency: median(all.text.map((r) => r.latency)), render: median(all.text.map((r) => r.render)), edits: all.text.length },
    formula: { latency: median(all.formula.map((r) => r.latency)), render: median(all.formula.map((r) => r.render)), edits: all.formula.length },
    diagram: { latency: median(all.diagram.map((r) => r.latency)), render: median(all.diagram.map((r) => r.render)), edits: all.diagram.length },
  };
  results.modes[mode] = { summary, perDoc };
  console.log(`\n${mode === "before" ? "before (full re-render, caches off)" : "after (incremental, caches on)"}`);
  console.log(`  first render median        ${fmt(summary.firstRender)} ms`);
  for (const kind of ["text", "formula", "diagram"]) {
    const s = summary[kind];
    console.log(`  ${kind.padEnd(8)} edit-to-PDF median ${fmt(s.latency)} ms   render ${fmt(s.render)} ms   (${s.edits} edits)`);
  }
}

// Memory over a long session, and the MCP render path, on the largest document.
if (MEM_EDITS > 0) {
  const sized = docs.map((d) => [d, readFileSync(d, "utf8").length]).sort((a, b) => b[1] - a[1]);
  const big = sized[0][0];
  for (const mode of modes) {
    const file = copyDoc(big, `memory-${mode}`);
    const plan = editPlan(readFileSync(big, "utf8"), extname(big));
    const w = startWatch(file, mode);
    try {
      const first = await w.waitFor(1, 120_000);
      const { results: rs } = await runEdits(w, file, plan.text, MEM_EDITS, 1);
      const rss = rs.map((r) => r.rss);
      const heap = rs.map((r) => r.heap);
      results.memory[mode] = {
        doc: big.slice(root.length + 1).replace(/\\/g, "/"),
        edits: rs.length,
        rss: { first: first.memory?.rss, after10: rss[9], last: rss[rss.length - 1], max: Math.max(...rss) },
        heap: { first: first.memory?.heap, after10: heap[9], last: heap[heap.length - 1], max: Math.max(...heap) },
        latency: { median: median(rs.map((r) => r.latency)), firstTen: median(rs.slice(0, 10).map((r) => r.latency)), lastTen: median(rs.slice(-10).map((r) => r.latency)) },
      };
      const m = results.memory[mode];
      console.log(`\nmemory, ${mode}, ${m.edits} text edits on ${m.doc}`);
      console.log(`  rss MB  first ${m.rss.first}  after 10 ${m.rss.after10}  last ${m.rss.last}  max ${m.rss.max}`);
      console.log(`  heap MB first ${m.heap.first}  after 10 ${m.heap.after10}  last ${m.heap.last}  max ${m.heap.max}`);
      console.log(`  edit-to-PDF median ${fmt(m.latency.median)} ms (first ten ${fmt(m.latency.firstTen)}, last ten ${fmt(m.latency.lastTen)})`);
    } catch (e) {
      console.log(`  memory ${mode}: ${e.message}`);
    } finally {
      await w.stop();
    }
    // The MCP server's path: a warm worker (runIsolated), document edited between calls.
    const mfile = copyDoc(big, `mcp-${mode}`);
    const env = { ...process.env, SOURCE_DATE_EPOCH: "1700000000" };
    if (mode === "before") env.TEXWRIGHT_NO_CACHE = "1";
    else delete env.TEXWRIGHT_NO_CACHE;
    if (values["worker-mb"]) env.TEXWRIGHT_WORKER_MB = values["worker-mb"];
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--cli", cli, "--mcp-child", JSON.stringify([mfile, Math.min(N, 20)])], { env, stdio: ["ignore", "pipe", "inherit"] });
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    await new Promise((r) => child.once("exit", r));
    try {
      const { times } = JSON.parse(text.trim().split("\n").pop());
      results.mcp[mode] = { doc: big.slice(root.length + 1).replace(/\\/g, "/"), median: median(times), calls: times.length };
      console.log(`  MCP render_document path (warm worker${values["worker-mb"] ? `, TEXWRIGHT_WORKER_MB=${values["worker-mb"]}` : ""}), ${mode}: median ${fmt(median(times))} ms over ${times.length} edited calls`);
    } catch {
      console.log(`  MCP path ${mode}: no result`);
    }
  }
}

if (values.json) writeFileSync(values.json, `${JSON.stringify(results, null, 2)}\n`);
