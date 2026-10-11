#!/usr/bin/env node
/**
 * Startup profile of the bundled command line: how long short commands take
 * from spawn to exit, how big the bundle is, how long importing it takes, and
 * which modules cost the most while it is evaluated.
 *
 *   node scripts/startup-profile.mjs [--dist dist] [--runs 9] [--json]
 *
 * Every command runs once to warm the code cache, then --runs times, round
 * robin; the medians are reported. Bare `node -e 0` is measured too, as the floor.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { dist: { type: "string", default: "dist" }, runs: { type: "string", default: "9" }, json: { type: "boolean" } } });
const dist = resolve(values.dist);
const runs = Math.max(1, Number(values.runs) || 9);
const cli = join(dist, "cli.mjs");
const bundle = join(dist, "texwright.mjs");
// The modules themselves: texwright-core.js, or in older builds texwright.mjs.
const core = existsSync(join(dist, "texwright-core.js")) ? join(dist, "texwright-core.js") : bundle;
const work = mkdtempSync(join(tmpdir(), "tw-startup-"));
const tiny = join(work, "tiny.md");
writeFileSync(tiny, "# Hello\n\nA line with $x^2$ in it.\n");

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Wall time of one spawn in ms. */
function time(args) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, SOURCE_DATE_EPOCH: "0" } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0 && r.status !== 1) throw new Error(`${args.join(" ")} exited ${r.status}: ${r.stderr}`);
  return ms;
}


const commands = [
  ["node -e 0 (floor)", ["-e", "0"]],
  ["--version", [cli, "--version"]],
  ["check showcase.md", [cli, "check", resolve("examples/showcase/showcase.md"), "--diagnostics", "compact"]],
  ["check 3-line doc", [cli, "check", tiny, "--diagnostics", "compact"]],
  ["render 3-line doc to PDF", [cli, tiny, "-o", join(work, "tiny.pdf"), "-q"]],
  ["render 3-line doc to HTML", [cli, tiny, "-o", join(work, "tiny.html"), "-q"]],
];

const results = {};
// Round robin, after one warm-up round, so that a busy machine slows every command alike.
const times = commands.map(() => []);
for (let round = 0; round <= runs; round++) commands.forEach(([, args], k) => {
    const ms = time(args);
    if (round) times[k].push(ms);
  });
commands.forEach(([name], k) => (results[name] = Math.round(median(times[k]))));

// Import time of the bundle alone, measured inside the process.
const importScript = `import { enableCompileCache } from "node:module"; enableCompileCache?.(); globalThis[Symbol.for("texwright.codeCache")] = "read"; const t = performance.now(); await import(${JSON.stringify(pathToFileURL(bundle).href)}); process.stdout.write(String(performance.now() - t));`;
const importTimes = [];
for (let k = 0; k <= runs; k++) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", importScript], { encoding: "utf8" });
  if (k) importTimes.push(Number(r.stdout));
}
results["import bundle (in-process)"] = Math.round(median(importTimes) * 10) / 10;

// How many of the bundle's modules each command evaluates (builds that can tell).
const loadedScript = `const b = await import(${JSON.stringify(pathToFileURL(bundle).href)}); if (b.__texwrightLoaded) { const exit = process.exit; process.exit = (c) => { process.stderr.write("\\n@@" + b.__texwrightLoaded().length + "\\n"); exit(c); }; process.argv.splice(1, 0, "cli"); b.__texwrightModule("cli.js"); }`;
const modulesLoaded = {};
for (const [name, args] of commands.slice(1)) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", loadedScript, ...args.slice(1)], { encoding: "utf8" });
  const m = /@@(\d+)/.exec(r.stderr);
  if (m) modulesLoaded[name] = Number(m[1]);
}

// Where a short check spends its time: CPU profile, self time by bundle module.
const profDir = join(work, "prof");
spawnSync(process.execPath, ["--cpu-prof", `--cpu-prof-dir=${profDir}`, "--cpu-prof-interval=50", cli, "check", tiny], { encoding: "utf8" });
const profFile = readdirSync(profDir).find((f) => f.endsWith(".cpuprofile"));
const topModules = [];
if (profFile) {
  const prof = JSON.parse(readFileSync(join(profDir, profFile), "utf8"));
  const text = readFileSync(core, "utf8");
  // Line ranges of each module: "// path" followed by "__tw_fns[k] = function".
  const marks = [];
  const lines = text.split("\n");
  for (let k = 0; k < lines.length - 1; k++) if (lines[k].startsWith("// ") && lines[k + 1].startsWith("__tw_fns[")) marks.push([k, lines[k].slice(3)]);
  const moduleAt = (line) => {
    let lo = 0;
    let hi = marks.length - 1;
    let found = "(bundle runtime)";
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (marks[mid][0] <= line) {
        found = marks[mid][1];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const dt = new Map();
  const ids = prof.samples;
  const deltas = prof.timeDeltas;
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  for (let k = 0; k < ids.length; k++) self.set(ids[k], (self.get(ids[k]) ?? 0) + (deltas[k] ?? 0));
  for (const [id, us] of self) {
    const n = nodes.get(id);
    const f = n.callFrame;
    const key = f.url.endsWith(core.slice(dist.length + 1)) ? moduleAt(f.lineNumber) : f.url ? "(node internals)" : `(${f.functionName || "native"})`;
    dt.set(key, (dt.get(key) ?? 0) + us);
  }
  for (const [name, us] of [...dt].sort((a, b) => b[1] - a[1]).slice(0, 15)) topModules.push({ name, ms: Math.round(us / 100) / 10 });
}

const report = {
  dist,
  runs,
  bundleKB: Math.round(statSync(core).size / 1024),
  medianMs: results,
  modulesEvaluated: modulesLoaded,
  checkTinySelfTimeByModule: topModules,
};
rmSync(work, { recursive: true, force: true });
if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`dist ${dist}, bundle ${report.bundleKB} KB, median of ${runs} runs\n`);
  for (const [name, ms] of Object.entries(results)) process.stdout.write(`  ${name.padEnd(30)} ${String(ms).padStart(7)} ms\n`);
  if (Object.keys(modulesLoaded).length) process.stdout.write(`modules evaluated: ${Object.entries(modulesLoaded).map(([n, k]) => `${n} ${k}`).join(", ")}
`);
  process.stdout.write("self time of check (3-line doc) by module, top 15\n");
  for (const m of topModules) process.stdout.write(`  ${m.name.padEnd(40)} ${String(m.ms).padStart(7)} ms\n`);
}
