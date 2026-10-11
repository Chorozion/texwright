// Runs every compiled test file. `node --test <dir>` behaves differently
// across Node versions, so list the files explicitly.
//
// With --bundle, the suites that start the command line start the bundle's
// entry, dist/cli.mjs, instead of dist/src/cli.js. --dist <dir> runs a build
// in another folder (tsc --outDir <dir>, node scripts/bundle.mjs --dist <dir>).
//
// Suites that pin running times (hostile inputs must finish within a budget)
// run after the others, one file at a time, so that the parallel suites
// cannot slow them past their budgets.
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const TIMED = ["performance", "markdown", "robustness"];

const args = process.argv.slice(2);
const at = args.indexOf("--dist");
const distDir = at >= 0 ? args.splice(at, 2)[1] : "dist";
const dir = join(distDir, "test");
const bundle = args.includes("--bundle");
const only = args.filter((a) => a !== "--bundle");
const env = bundle ? { ...process.env, TEXWRIGHT_CLI: resolve(distDir, "cli.mjs") } : process.env;
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => !only.length || only.some((o) => f.startsWith(o)));
const timed = (f) => TIMED.some((t) => f.startsWith(`${t}.`));

let status = 0;
const phases = [
  // Half the cores: many files also check their own speed, and a fully loaded machine fails
  // those checks for reasons that have nothing to do with the code.
  { files: files.filter((f) => !timed(f)), args: [`--test-concurrency=${Math.max(2, Math.floor(availableParallelism() / 2))}`] },
  { files: files.filter(timed), args: ["--test-concurrency=1"] },
];
for (const phase of phases) {
  if (!phase.files.length) continue;
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...phase.args, ...phase.files.map((f) => join(dir, f))], { stdio: "inherit", env });
  if (run.status !== 0) status = run.status ?? 1;
}
process.exit(status);
