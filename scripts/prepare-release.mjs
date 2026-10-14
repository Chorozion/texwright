import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("server.json", "utf8"));
assert.equal(manifest.name, pkg.mcpName, "MCP ownership marker must match");
assert.equal(manifest.version, pkg.version, "Registry version must match package");
assert.equal(manifest.packages.length, 1);
const entry = manifest.packages[0];
assert.equal(entry.identifier, pkg.name);
assert.equal(entry.version, pkg.version);
assert.equal(entry.registryType, "npm");
assert.equal(entry.transport.type, "stdio");
assert.equal(entry.packageArguments[0].value, "mcp");
assert.equal(entry.packageArguments[1].name, "--root");
assert.equal(entry.packageArguments[1].isRequired, true);
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, "Keep runtime dependency promise");
const output = ".mybuild/release";
mkdirSync(output, { recursive: true });
// npm is a .cmd shim on Windows; only fixed repository-owned arguments go through the shell.
const result = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--json", "--pack-destination", output],
  { encoding: "utf8", shell: process.platform === "win32" });
const [packed] = JSON.parse(result);
const paths = new Set(packed.files.map(f => f.path));
for (const file of ["dist/cli.mjs", "dist/worker.mjs", "dist/texwright-core.js", "dist/src/index.js", "server.json", "AGENTS.md", "CHEATSHEET.md", "LICENSE", "THIRD-PARTY-NOTICES.md", "llms.txt", "docs/reference/mcp-tools.json"]) {
  assert(paths.has(file), `Release is missing ${file}`);
}
for (const path of paths) assert(!/(^|\/)(?:\.env(?:\..*)?|node_modules|\.git|\.mybuild|\.npmrc|\.codex|\.agents)(\/|$)/.test(path), `Unexpected private/build path: ${path}`);
const artifact = resolve(output, packed.filename);
execFileSync(process.execPath, ["scripts/release-check.mjs", artifact], { stdio: "inherit" });
const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
writeFileSync(resolve(output, "SHA256SUMS"), `${sha256}  ${packed.filename}\n`);
console.log(`Validated ${packed.filename}: ${packed.files.length} files, ${(packed.size / 1024 / 1024).toFixed(2)} MiB compressed`);
console.log(`SHA-256: ${sha256}`);
