/** The MCP server, driven by the official MCP client over stdio, as an agent would use it. */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpServer } from "../src/mcp.js";

/** The command line under test: dist/src/cli.js, or another entry (the bundle's dist/cli.mjs) named by TEXWRIGHT_CLI. */
const cli = process.env.TEXWRIGHT_CLI ?? resolve(fileURLToPath(import.meta.url), "..", "..", "src", "cli.js");
const tmp = mkdtempSync(join(tmpdir(), "texwright-mcp-test-"));
let client: Client;

function payload(result: unknown): { ok: boolean; output?: string; diagnostics: { code: string; line?: number; hint?: string }[] } {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text);
}

const work = join(tmp, "work");

describe("mcp server", () => {
  before(async () => {
    mkdirSync(work, { recursive: true });
    writeFileSync(join(tmp, "secret.txt"), "SECRET-OUTSIDE-ROOT");
    writeFileSync(join(tmp, "precious.txt"), "do not overwrite");
    client = new Client({ name: "texwright-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--root", work] }));
  });
  after(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("lists its tools", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["check_document", "fix_document", "get_guide", "get_schema", "new_document", "outline_document", "preview_page", "render_document", "repair_document"]);
    const render = tools.find((t) => t.name === "render_document")!;
    assert.ok((render.inputSchema.properties as Record<string, unknown>).source);
  });

  test("check_document reports problems an agent can act on", async () => {
    const res = await client.callTool({ name: "check_document", arguments: { source: "# Intro {#sec:intro}\n\nSee @sec:intr and $x^{2$.\n" } });
    const body = payload(res);
    assert.equal(body.ok, false);
    const ref = body.diagnostics.find((d) => d.code === "REF001")!;
    assert.equal(ref.line, 3);
    assert.match(ref.hint ?? "", /sec:intro/);
    assert.ok(body.diagnostics.some((d) => d.code === "MATH001"));
  });

  test("diagnostics carry fixes, come one line each with compact, and fix_document applies the safe ones", async () => {
    const doc = "# Intro {#sec:intro}\n\nSee @sec:intr.\n";
    const full = payload(await client.callTool({ name: "check_document", arguments: { source: doc } }));
    const ref = full.diagnostics.find((d) => d.code === "REF001")! as { fix?: { old: string; new: string; safe: boolean } };
    assert.deepEqual(ref.fix && [ref.fix.old, ref.fix.new, ref.fix.safe], ["sec:intr", "sec:intro", true]);
    const compact = JSON.parse(((await client.callTool({ name: "check_document", arguments: { source: doc, compact: true } })) as { content: { text: string }[] }).content[0]!.text);
    assert.match(compact.diagnostics, / E REF001 Reference to undefined label "sec:intr" \| .* \| fix "sec:intr" -> "sec:intro" safe$/);
    writeFileSync(join(work, "fixme.md"), doc);
    const fixed = JSON.parse(((await client.callTool({ name: "fix_document", arguments: { path: "fixme.md" } })) as { content: { text: string }[] }).content[0]!.text);
    assert.equal(fixed.ok, true, JSON.stringify(fixed));
    assert.equal(fixed.applied.length, 1);
    assert.equal(readFileSync(join(work, "fixme.md"), "utf8"), "# Intro {#sec:intro}\n\nSee @sec:intro.\n");
    const outside = payload(await client.callTool({ name: "fix_document", arguments: { path: "../fixme.md" } }));
    assert.equal(outside.ok, false);
  });

  test("new_document hands out templates and writes them inside the workspace only", async () => {
    const text = ((await client.callTool({ name: "new_document", arguments: { kind: "memo" } })) as { content: { text: string }[] }).content[0]!.text;
    assert.match(text, /^---\ntitle: "Memo/);
    const wrote = JSON.parse(((await client.callTool({ name: "new_document", arguments: { kind: "paper", path: "drafts/paper.md" } })) as { content: { text: string }[] }).content[0]!.text);
    assert.equal(wrote.ok, false, "the drafts folder does not exist yet");
    mkdirSync(join(work, "drafts"));
    const ok = JSON.parse(((await client.callTool({ name: "new_document", arguments: { kind: "paper", path: "drafts/paper.md" } })) as { content: { text: string }[] }).content[0]!.text);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.ok(existsSync(join(work, "drafts", "refs.bib")));
    const again = payload(await client.callTool({ name: "new_document", arguments: { kind: "paper", path: "drafts/paper.md" } }));
    assert.equal(again.ok, false);
    const outside = payload(await client.callTool({ name: "new_document", arguments: { kind: "memo", path: "../memo.md" } }));
    assert.equal(outside.ok, false);
    const short = ((await client.callTool({ name: "get_guide", arguments: { short: true } })) as { content: { text: string }[] }).content[0]!.text;
    assert.match(short, /^# texwright cheat sheet/);
  });

  test("preview_page returns PNG pages and where each heading landed", async () => {
    const source = "# One\n\nText.\n\n\\newpage\n\n# Two\n\nMore.\n";
    const res = (await client.callTool({ name: "preview_page", arguments: { source, pages: [2], dpi: 50 } })) as {
      content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
      isError?: boolean;
    };
    assert.equal(res.isError, false);
    const summary = JSON.parse((res.content[0] as { text: string }).text);
    assert.equal(summary.pageCount, 2);
    assert.deepEqual(
      summary.placement.map((p: { text: string; page: number }) => [p.text, p.page]),
      [
        ["One", 1],
        ["Two", 2],
      ],
    );
    const image = res.content[1] as { type: string; data: string; mimeType: string };
    assert.equal(image.type, "image");
    assert.equal(image.mimeType, "image/png");
    const png = Buffer.from(image.data, "base64");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 425, "letter width at 50 dpi");
  });

  test("outline_document lists what is where, as JSON or text", async () => {
    const source = "# One {#sec:one}\n\n## Two\n\nSee @sec:one.\n";
    const json = JSON.parse(((await client.callTool({ name: "outline_document", arguments: { source } })) as { content: { text: string }[] }).content[0]!.text);
    assert.deepEqual(json.outline.items.map((i: { kind: string; line: number }) => [i.kind, i.line]), [["heading", 1], ["heading", 3]]);
    const text = ((await client.callTool({ name: "outline_document", arguments: { source, text: true } })) as { content: { text: string }[] }).content[0]!.text;
    assert.match(text, /^L1 One \[sec:one\]\nL3 {3}Two/);
  });

  test("paths outside the workspace root are refused", async () => {
    const attempts = [
      { name: "render_document", arguments: { source: "# x\n", to: "html", output_path: join(tmp, "precious.txt") } },
      { name: "render_document", arguments: { source: "# x\n", to: "html", output_path: "../precious.txt" } },
      { name: "check_document", arguments: { path: join(tmp, "secret.txt") } },
      { name: "check_document", arguments: { source: "\\input{secret.txt}", format: "latex", base_dir: tmp } },
      { name: "check_document", arguments: { source: "# x\n", base_dir: "//attacker/share" } },
    ];
    for (const call of attempts) {
      const body = payload(await client.callTool(call));
      assert.equal(body.ok, false, JSON.stringify(call));
      assert.equal(body.diagnostics[0]!.code, "PATH001", JSON.stringify(body));
    }
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(join(tmp, "precious.txt"), "utf8"), "do not overwrite");
  });

  test("render_document writes the output after the agent fixes the source", async () => {
    const out = join(work, "fixed.html");
    const res = await client.callTool({
      name: "render_document",
      arguments: { source: "# Intro {#sec:intro}\n\nSee @sec:intro and $x^{2}$.\n", to: "html", output_path: out },
    });
    const body = payload(res);
    assert.equal(body.ok, true, JSON.stringify(body.diagnostics));
    assert.equal(body.output, out);
    assert.ok(existsSync(out));
  });

  test("a request over its time limit is stopped and reported, and the host keeps working", async () => {
    const { runIsolated } = await import("../src/isolate.js");
    const slow = await runIsolated({ op: "check", options: { source: "# Hi\n", to: "html" } }, 1);
    assert.equal(slow.ok, false);
    assert.equal(slow.diagnostics[0]!.code, "TIME001");
    const fine = await runIsolated({ op: "check", options: { source: "# Hi\n\n$x^2$\n", to: "html" } }, 30_000);
    assert.equal(fine.ok, true, JSON.stringify(fine.diagnostics));
  });

  test("get_schema and get_guide answer", async () => {
    const schema = JSON.parse(((await client.callTool({ name: "get_schema", arguments: {} })) as { content: { text: string }[] }).content[0]!.text);
    assert.equal(schema.title, "texwright document");
    const guide = ((await client.callTool({ name: "get_guide", arguments: {} })) as { content: { text: string }[] }).content[0]!.text;
    assert.match(guide, /## The loop/);
  });
});

// ---------------------------------------------------------------- the protocol itself, without the SDK

describe("mcp protocol (raw JSON-RPC)", () => {
  const rawRoot = mkdtempSync(join(tmpdir(), "texwright-mcp-raw-"));
  after(() => rmSync(rawRoot, { recursive: true, force: true }));

  // biome-ignore lint/suspicious/noExplicitAny: replies are checked field by field
  const call = async (server: ReturnType<typeof createMcpServer>, message: unknown): Promise<any> => {
    const line = await server.handleLine(typeof message === "string" ? message : JSON.stringify(message));
    return line === undefined ? undefined : JSON.parse(line);
  };
  const init = (version: string) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "t", version: "1" } } });

  test("initialize negotiates the protocol version", async () => {
    for (const [asked, agreed] of [
      ["2025-06-18", "2025-06-18"],
      ["2025-03-26", "2025-03-26"],
      ["2024-11-05", "2024-11-05"],
      ["2025-11-25", "2025-06-18"],
      ["1999-01-01", "2025-06-18"],
    ]) {
      const server = createMcpServer({ root: rawRoot });
      const res = await call(server, init(asked!));
      assert.match(res.result.serverInfo.version, /^\d+\.\d+\.\d+/);
      assert.deepEqual(res, { jsonrpc: "2.0", id: 1, result: { protocolVersion: agreed, capabilities: { tools: {} }, serverInfo: { name: "texwright", version: res.result.serverInfo.version } } });
      assert.equal(server.protocolVersion, agreed);
    }
    const server = createMcpServer({ root: rawRoot });
    assert.deepEqual(await call(server, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} }), {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32602, message: 'initialize needs "protocolVersion" (a string)' },
    });
  });

  test("ping, tools/list and notifications", async () => {
    const server = createMcpServer({ root: rawRoot });
    await call(server, init("2025-06-18"));
    assert.equal(await call(server, { jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
    assert.deepEqual(await call(server, { jsonrpc: "2.0", id: "p", method: "ping" }), { jsonrpc: "2.0", id: "p", result: {} });
    const { tools } = (await call(server, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })).result;
    assert.deepEqual(
      tools.map((t: { name: string }) => t.name),
      ["render_document", "preview_page", "check_document", "fix_document", "repair_document", "outline_document", "get_schema", "get_guide", "new_document"],
    );
    for (const t of tools) {
      assert.equal(t.inputSchema.type, "object");
      assert.ok(t.title && t.description && t.annotations, t.name);
    }
    assert.deepEqual(tools[0].inputSchema.properties.to, { type: "string", enum: ["pdf", "html", "json"], default: "pdf" });
    assert.deepEqual(tools[0].annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(Object.keys(tools.find((t: { name: string }) => t.name === "check_document").inputSchema.properties), ["source", "path", "format", "base_dir", "files", "bibliography", "citation_style", "strict", "compact"]);
    assert.deepEqual(tools[1].annotations, { readOnlyHint: true, openWorldHint: false });
    // Unknown notifications are ignored, and so are responses (the server never sends requests).
    assert.equal(await call(server, { jsonrpc: "2.0", method: "notifications/whatever", params: { x: 1 } }), undefined);
    assert.equal(await call(server, { jsonrpc: "2.0", id: 99, result: {} }), undefined);
    assert.equal(await call(server, "   "), undefined);
  });

  test("malformed messages get the standard JSON-RPC errors", async () => {
    const server = createMcpServer({ root: rawRoot });
    const cases: [unknown, unknown, number][] = [
      ["not json", null, -32700],
      ['{"jsonrpc":"2.0","id":1,', null, -32700],
      ["42", null, -32600],
      ['"text"', null, -32600],
      ["null", null, -32600],
      [{ id: 5, method: "ping" }, 5, -32600],
      [{ jsonrpc: "1.0", id: 6, method: "ping" }, 6, -32600],
      [{ jsonrpc: "2.0", id: 7 }, 7, -32600],
      [{ jsonrpc: "2.0", id: { x: 1 }, method: "ping" }, null, -32600],
      [{ jsonrpc: "2.0", id: 8, method: 3 }, 8, -32600],
      [{ jsonrpc: "2.0", id: 9, method: "nope" }, 9, -32601],
      [{ jsonrpc: "2.0", id: 10, method: "resources/list" }, 10, -32601],
      [{ jsonrpc: "2.0", id: 11, method: "tools/call" }, 11, -32602],
      [{ jsonrpc: "2.0", id: 12, method: "tools/call", params: [1] }, 12, -32602],
      [{ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "nosuch" } }, 13, -32602],
      [{ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "get_schema", arguments: [1] } }, 14, -32602],
      [{ jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: 15 } }, 15, -32602],
    ];
    for (const [message, id, code] of cases) {
      const res = await call(server, message);
      assert.equal(res.jsonrpc, "2.0", JSON.stringify(message));
      assert.equal(res.id, id, JSON.stringify(message));
      assert.equal(res.error.code, code, `${JSON.stringify(message)}: ${JSON.stringify(res)}`);
      assert.equal(typeof res.error.message, "string");
      assert.equal(res.result, undefined);
    }
    assert.equal((await call(server, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "nosuch" } })).error.message, "Unknown tool: nosuch");
    // A notification never gets a reply, even a broken one.
    assert.equal(await call(server, { jsonrpc: "2.0", method: "notifications/cancelled", params: 5 }), undefined);
  });

  test("bad tool arguments come back as a tool error the agent can read", async () => {
    const server = createMcpServer({ root: rawRoot });
    const res = await call(server, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_document", arguments: { source: 5, format: "bogus" } } });
    assert.equal(res.result.isError, true);
    const body = JSON.parse(res.result.content[0].text);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'Invalid arguments for check_document: source: expected a string, got the number 5; format: must be one of "markdown", "latex", "json"; got "bogus"');
  });

  test("tools answer through the raw protocol", async () => {
    const server = createMcpServer({ root: rawRoot });
    const schema = await call(server, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_schema" } });
    assert.equal(schema.result.isError, false);
    assert.equal(JSON.parse(schema.result.content[0].text).title, "texwright document");
    const check = await call(server, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_document", arguments: { source: "# Hi\n\nSee @sec:nope.\n" } } });
    assert.equal(check.result.isError, true);
    const body = JSON.parse(check.result.content[0].text);
    assert.equal(body.ok, false);
    assert.equal(body.diagnostics[0].code, "REF001");
    const outside = await call(server, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_document", arguments: { path: "../../etc/passwd" } } });
    assert.equal(JSON.parse(outside.result.content[0].text).diagnostics[0].code, "PATH001");
  });

  test("batches are refused unless 2025-03-26 was negotiated, then answered in one array", async () => {
    const modern = createMcpServer({ root: rawRoot });
    await call(modern, init("2025-06-18"));
    const refused = await call(modern, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    assert.equal(refused.id, null);
    assert.equal(refused.error.code, -32600);
    const old = createMcpServer({ root: rawRoot });
    await call(old, init("2025-03-26"));
    assert.deepEqual(
      await call(old, [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "nope" },
        { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-03-26" } },
        7,
      ]),
      [
        { jsonrpc: "2.0", id: 1, result: {} },
        { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found: nope" } },
        { jsonrpc: "2.0", id: 3, error: { code: -32600, message: "initialize can't be part of a batch" } },
        { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: expected a JSON-RPC 2.0 object" } },
      ],
    );
    assert.equal(await call(old, [{ jsonrpc: "2.0", method: "notifications/initialized" }]), undefined);
    assert.equal((await call(old, [])).error.code, -32600);
  });

  test("a cancelled request gets no reply, and the server carries on", async () => {
    const server = createMcpServer({ root: rawRoot });
    const pending = server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "check_document", arguments: { source: "# Hi\n" } } }));
    assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42, reason: "user" } })), undefined);
    assert.equal(await pending, undefined);
    assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999 } })), undefined);
    assert.deepEqual(await call(server, { jsonrpc: "2.0", id: 43, method: "ping" }), { jsonrpc: "2.0", id: 43, result: {} });
  });

  test("over stdio: one reply per line, errors included, the server keeps going", async () => {
    const child = spawn(process.execPath, [cli, "mcp", "--root", rawRoot], { stdio: ["pipe", "pipe", "pipe"] });
    const lines: string[] = [];
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buffered += d;
      for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
        lines.push(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
      }
    });
    const waitFor = async (n: number) => {
      const until = Date.now() + 20_000;
      while (lines.length < n) {
        if (Date.now() > until) throw new Error(`only ${lines.length} replies: ${lines.join("\n")}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    // Malformed JSON first, then a CRLF line end, a message split across writes and a blank line.
    child.stdin.write("this is not json\n");
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"raw","version":"1"}}}\r\n');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"meth');
    child.stdin.write('od":"nope"}\n\n');
    child.stdin.write('{"jsonrpc":"2.0","id":3,"method":"tools/call"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":4,"method":"ping"}\n');
    await waitFor(5);
    const byId = new Map(lines.map((l) => JSON.parse(l)).map((r) => [r.id, r]));
    assert.equal(byId.get(null).error.code, -32700);
    assert.equal(byId.get(1).result.protocolVersion, "2024-11-05");
    assert.equal(byId.get(2).error.code, -32601);
    assert.equal(byId.get(3).error.code, -32602);
    assert.deepEqual(byId.get(4).result, {});
    assert.equal(lines.length, 5);
    const exited = new Promise((r) => child.once("exit", r));
    child.stdin.end();
    await exited;
  });
});
