#!/usr/bin/env node
/**
 * Memory of a long-running MCP server: starts `node <dist>/cli.mjs mcp`,
 * sends it render calls over varied documents (the benchmark corpus, the
 * LaTeX stress set, TikZ, PSTricks, Mermaid and SVG suites) and samples the
 * server's resident set size as it goes, with its caches (layout, fonts,
 * compressed streams) on as in use. Memory should level off after the first
 * few kinds of document.
 *
 *   node scripts/mcp-memory.mjs [--dist dist] [--calls 200] [--every 10] [--pause 0] [--json]
 *
 * --pause waits that many milliseconds between calls, as a client reading the
 * answers would; seconds and ms per call count the server's time only.
 *
 * The documents are copied to a temporary folder that serves as the server's
 * root, so nothing is written next to the sources.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { dist: { type: "string", default: "dist" }, calls: { type: "string", default: "200" }, pause: { type: "string", default: "0" }, every: { type: "string", default: "10" }, json: { type: "boolean" } },
});
const dist = resolve(values.dist);
const calls = Math.max(1, Number(values.calls) || 200);
const every = Math.max(1, Number(values.every) || 10);
const pause = Math.max(0, Number(values.pause) || 0);

// The documents, in a folder of their own.
const root = mkdtempSync(join(tmpdir(), "tw-mcp-memory-"));
const SOURCES = ["bench/corpus", "test/latex-stress", "test/tikz-suite", "test/tikz-suite-3d", "test/tikz-suite-trees", "test/tikz-suite-circuits", "test/pstricks-suite", "test/diagram-suite", "test/svg-suite"];
for (const dir of SOURCES) if (existsSync(dir)) cpSync(dir, join(root, dir), { recursive: true });
mkdirSync(join(root, "out"));

/** Every document to render, as tool arguments. */
const docs = [];
const walk = (dir) => {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel);
    else if (/\.(md|tex)$/.test(e.name)) docs.push({ path: rel });
    else if (e.name.endsWith(".mmd")) docs.push({ source: `# ${e.name}\n\n\`\`\`mermaid\n${readFileSync(join(root, rel), "utf8")}\n\`\`\`\n`, base_dir: dir });
    else if (e.name.endsWith(".svg") && dir.endsWith("svg-suite")) docs.push({ source: `# ${e.name}\n\n![${e.name}](${e.name})\n`, base_dir: dir });
  }
};
for (const dir of SOURCES) if (existsSync(join(root, dir))) walk(dir);
// A fixed shuffle, so that kinds of document alternate as they would in use.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (let k = docs.length - 1; k > 0; k--) {
  const j = Math.floor(rand() * (k + 1));
  [docs[k], docs[j]] = [docs[j], docs[k]];
}

/** Resident set size of a process in MB, and its peak where the system reports one. */
function memory(pid) {
  try {
    if (process.platform === "linux") {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = (key) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? NaN);
      return { rss: kb("VmRSS") / 1024, peak: kb("VmHWM") / 1024 };
    }
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64)"`], { encoding: "utf8" });
      const [ws, peak] = r.stdout.trim().split(/\s+/).map(Number);
      return { rss: ws / 2 ** 20, peak: peak / 2 ** 20 };
    }
    const r = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
    return { rss: Number(r.stdout.trim()) / 1024, peak: NaN };
  } catch {
    return { rss: NaN, peak: NaN };
  }
}

const server = spawn(process.execPath, [join(dist, "cli.mjs"), "mcp", "--root", root], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, SOURCE_DATE_EPOCH: "0" } });
const pending = new Map();
let buffer = "";
server.stdout.setEncoding("utf8");
server.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
let nextId = 0;
const request = (method, params) =>
  new Promise((done) => {
    const id = ++nextId;
    pending.set(id, done);
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-memory", version: "1" } });
server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const samples = [{ call: 0, ...memory(server.pid) }];
let failed = 0;
let busy = 0;
for (let k = 1; k <= calls; k++) {
  const doc = docs[(k - 1) % docs.length];
  const args = { ...doc, to: "pdf", output_path: `out/${k}.pdf`, compact: true };
  const t0 = Date.now();
  const reply = await request("tools/call", { name: "render_document", arguments: args });
  busy += Date.now() - t0;
  if (reply.error || reply.result?.isError) {
    failed++;
    if (failed === 1 && process.env.MCP_MEMORY_DEBUG) process.stderr.write(`${JSON.stringify(reply).slice(0, 600)}
`);
  }
  if (k % every === 0 || k === calls) samples.push({ call: k, ...memory(server.pid) });
  if (pause) await new Promise((done) => setTimeout(done, pause));
}
const seconds = busy / 1000;
server.stdin.end();
await new Promise((done) => server.on("exit", done));
rmSync(root, { recursive: true, force: true });

const rss = samples.map((s) => s.rss);
const report = {
  dist,
  documents: docs.length,
  calls,
  failedCalls: failed,
  seconds: Math.round(seconds * 10) / 10,
  msPerCall: Math.round(busy / calls),
  rssMB: { start: Math.round(rss[0]), afterFirstTenth: Math.round(rss[Math.ceil(samples.length / 10)]), end: Math.round(rss[rss.length - 1]), maxSampled: Math.round(Math.max(...rss)), peak: Math.round(Math.max(...samples.map((s) => s.peak))) },
  samples: samples.map((s) => ({ call: s.call, rss: Math.round(s.rss) })),
};
if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stdout.write(`${calls} render calls over ${docs.length} documents in ${report.seconds} s, ${report.msPerCall} ms per call (${failed} reported errors)\n`);
  process.stdout.write(`RSS MB: start ${report.rssMB.start}, end ${report.rssMB.end}, max sampled ${report.rssMB.maxSampled}, peak ${report.rssMB.peak}\n`);
  process.stdout.write(`${samples.map((s) => `${s.call}:${Math.round(s.rss)}`).join(" ")}\n`);
}
