import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { createMcpServer } from "../src/mcp.js";
import { isInside } from "../src/write/assets.js";

const temp = mkdtempSync(join(tmpdir(), "texwright-paths-"));
const workspace = join(temp, "workspace");
const alias = join(temp, "alias");
const outside = join(temp, "outside");
mkdirSync(workspace);
mkdirSync(outside);
symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
writeFileSync(join(workspace, "existing.md"), "# Existing\n");
writeFileSync(join(outside, "private.md"), "# Outside\n");
after(() => rmSync(temp, { recursive: true, force: true }));

describe("workspace paths through directory aliases", () => {
  test("accepts new files and missing subdirectories inside a linked workspace", () => {
    for (const name of ["existing.md", "report.pdf", "drafts/deep/paper.md"]) {
      assert.equal(isInside(join(alias, name), [alias]), true, name);
    }
  });

  test("rejects symlink escapes even when the output file does not exist", () => {
    for (const name of ["escape/private.md", "escape/new.pdf", "escape/new/deep/file.md"]) {
      assert.equal(isInside(join(alias, name), [alias]), false, name);
    }
    assert.equal(isInside(join(outside, "new.pdf"), [alias]), false);
    assert.equal(isInside(join(alias, "../outside/new.pdf"), [alias]), false);
    assert.equal(isInside(join(alias, "existing.md", "child.pdf"), [alias]), false);
    assert.equal(isInside("//host/share/file.pdf", [alias]), false);
  });

  test("rejects dangling directory links rather than treating them as missing directories", () => {
    const target = join(temp, "removed-target");
    mkdirSync(target);
    symlinkSync(target, join(workspace, "dangling"), process.platform === "win32" ? "junction" : "dir");
    rmSync(target, { recursive: true });
    for (const root of [alias, workspace]) {
      assert.equal(isInside(join(root, "dangling", "new.pdf"), [root]), false);
    }
  });

  test("MCP creates and renders documents under a linked root while blocking escapes", async () => {
    mkdirSync(join(workspace, "drafts"));
    const server = createMcpServer({ root: alias });
    await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "path-test", version: "1" },
    } });
    const tool = async (name: string, args: Record<string, unknown>) => {
      const reply = await server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }));
      return JSON.parse(reply!).result;
    };
    const created = await tool("new_document", { kind: "report", path: "drafts/report.md" });
    assert.notEqual(created.isError, true, JSON.stringify(created));
    assert.equal(existsSync(join(workspace, "drafts/report.md")), true);
    const rendered = await tool("render_document", { source: "# Report\n\nHello.", to: "html", output_path: "report.html" });
    assert.notEqual(rendered.isError, true, JSON.stringify(rendered));
    assert.equal(existsSync(join(workspace, "report.html")), true);
    const blocked = await tool("render_document", { source: "# Report", to: "html", output_path: "escape/new.html" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /PATH001/);
    assert.equal(existsSync(join(outside, "new.html")), false);
  });

  test("repair reports use short paths when input and cwd name the same directory differently", () => {
    const input = join(alias, "repair.md");
    writeFileSync(input, "# Intro {#sec:intro}\n\nSee @sec:intr.\n");
    const cli = process.env.TEXWRIGHT_CLI ?? resolve(dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
    const run = spawnSync(process.execPath, [cli, "repair", input], { cwd: realpathSync(workspace), encoding: "utf8" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /^fixed repair\.md:/m);
    assert.match(run.stdout, /^ok repair\.pdf \(1 page\):/m);
  });
});
