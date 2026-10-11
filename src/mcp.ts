/**
 * MCP server: lets an AI agent render, check and inspect documents.
 *
 * Tools:
 *   render_document  source or path -> PDF/HTML/JSON file, with diagnostics
 *   check_document   source or path -> diagnostics only (fast), many with an applicable fix
 *   fix_document     path -> applies the safe fixes to the files, then checks again
 *   repair_document  path -> applies every safe fix to a fixed point, renders if clean, short report
 *   outline_document source or path -> headings, figures, tables, equations, citations, with lines
 *   new_document     kind -> a complete starter document (paper, report, cv, ...), optionally written to a file
 *   preview_page     source or path, pages -> PNG images of those PDF pages, and the page each heading,
 *                    figure and table landed on
 *   get_schema       JSON Schema of the document tree, for agents that emit JSON
 *   get_guide        the writing guide (Markdown and LaTeX syntax, diagnostics, workflow)
 *
 * Every result is JSON text with `ok`, the diagnostics (stable codes, line,
 * column, hint) and, for render, the output path. Agents are expected to
 * read the diagnostics, fix the source and call again.
 *
 * Safety: the server only reads and writes inside its workspace root (the
 * folder it was started in, or --root), and every request runs in its own
 * worker thread with a time limit, so one hostile document can neither reach
 * other files nor stall the server.
 *
 * Protocol: the Model Context Protocol's stdio transport, implemented here
 * without an SDK. Messages are JSON-RPC 2.0 objects, one per line. The server
 * answers `initialize` (negotiating 2025-06-18, 2025-03-26 or 2024-11-05),
 * `ping`, `tools/list` and `tools/call`; accepts and ignores notifications
 * (`notifications/initialized`, `notifications/cancelled`, ...); and replies
 * with the standard errors: -32700 for text that isn't JSON, -32600 for a
 * malformed message, -32601 for an unknown method, -32602 for bad params.
 * Batches (JSON arrays) are handled when the client negotiated 2025-03-26,
 * the one version that had them, and refused otherwise.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ConvertOptions, defaultOutput, documentJsonSchema, formatCompact, formatOutline, listThemes } from "./index.js";
import { type IsolatedResult, runIsolated, warmUpIsolated } from "./isolate.js";
import { TEMPLATES, template } from "./templates.js";
import { type JsonSchema, validate } from "./util/validate.js";
import { isInside, isInsideLexically, packageRoot } from "./write/assets.js";

export interface McpOptions {
  /** Folder the server may read from and write to. Default: the current directory. */
  root?: string;
  /** Per-request time limit in milliseconds. Default 120 s. */
  timeoutMs?: number;
  allowNet?: boolean;
}

/** Protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS[0]!;
const BATCH_PROTOCOL_VERSION = "2025-03-26";

/** JSON-RPC 2.0 error codes. */
export const RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** Longest accepted message line, in characters. */
const MAX_MESSAGE = 64 * 1024 * 1024;

type RequestId = string | number;
type JsonRpcResponse = { jsonrpc: "2.0"; id: RequestId | null; result: unknown } | { jsonrpc: "2.0"; id: RequestId | null; error: { code: number; message: string } };

interface ToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>): Promise<ToolResult>;
}

/** A transport-independent MCP server: feed it lines (or parsed messages), write back what it returns. */
export interface McpServer {
  /** Handle one line of input; resolves to the reply line (without the newline), or undefined when there is nothing to send. */
  handleLine(line: string): Promise<string | undefined>;
  /** Handle one parsed message or batch; resolves to the reply, or undefined. */
  handleMessage(message: unknown): Promise<unknown>;
  /** The protocol version agreed in `initialize`, if any. */
  readonly protocolVersion: string | undefined;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

class PathError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function json(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}

function pathFailure(message: string): ToolResult {
  return json({ ok: false, diagnostics: [{ code: "PATH001", severity: "error", message, hint: "Use paths inside the folder the texwright MCP server was started in (or its --root)" }] }, true);
}

function serverVersion(): string {
  try {
    return String(JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version);
  } catch {
    return "0.0.0";
  }
}

// ------------------------------------------------------------------ tool arguments

const INPUT_PROPERTIES: Record<string, JsonSchema> = {
  source: { type: "string", description: "Document text. Give this or `path`." },
  path: { type: "string", description: "Path of a .md, .tex or .json file inside the workspace. Give this or `source`." },
  format: { type: "string", enum: ["markdown", "latex", "json"], description: "Input format; inferred from the path extension, default markdown" },
  base_dir: { type: "string", description: "Folder inside the workspace that images, \\input files and bibliographies resolve against when using `source`" },
  files: { type: "object", additionalProperties: { type: "string" }, description: 'In-memory files for `source` input, e.g. {"refs.bib": "@article{...}"}' },
  bibliography: { type: "array", items: { type: "string" }, description: "Bibliography files (.bib or CSL-JSON), relative to the document" },
  citation_style: { type: "string", enum: ["numeric", "author-year"] },
  strict: { type: "boolean", description: "Treat warnings as errors" },
  compact: { type: "boolean", description: "Return diagnostics as one line each (file:line:col severity code message | hint | fix) to save tokens" },
};

const RENDER_PROPERTIES: Record<string, JsonSchema> = {
  ...INPUT_PROPERTIES,
  to: { type: "string", enum: ["pdf", "html", "json"], default: "pdf" },
  output_path: { type: "string", description: "Where to write the result, inside the workspace; default next to `path`, or a fresh temporary folder for `source`" },
  theme: { type: "string", enum: ["article", "modern", "compact"] },
  toc: { type: "boolean" },
  number_sections: { type: "boolean" },
  title: { type: "string" },
  paper: { type: "string", enum: ["letter", "a4", "a5", "legal", "b5"] },
  max_pages: { type: "integer", minimum: 1, description: "Tighten margins, then the body size, until the PDF fits in this many pages" },
};

interface InputArgs {
  source?: string;
  path?: string;
  format?: "markdown" | "latex" | "json";
  base_dir?: string;
  files?: Record<string, string>;
  bibliography?: string[];
  citation_style?: "numeric" | "author-year";
  strict?: boolean;
  compact?: boolean;
}

interface RenderArgs extends InputArgs {
  to?: "pdf" | "html" | "json";
  output_path?: string;
  theme?: "article" | "modern" | "compact";
  toc?: boolean;
  number_sections?: boolean;
  title?: string;
  paper?: "letter" | "a4" | "a5" | "legal" | "b5";
  max_pages?: number;
}

// ------------------------------------------------------------------ the server

export function createMcpServer(options: McpOptions = {}): McpServer {
  const root = resolve(options.root ?? process.cwd());
  const timeoutMs = options.timeoutMs ?? 120_000;
  const serverInfo = { name: "texwright", version: serverVersion() };

  /** Resolve a caller-supplied path against the root and refuse anything outside it. */
  const inRoot = (p: string, what: string): string => {
    const abs = resolve(root, p);
    if (!isInsideLexically(abs, [root]) || !isInside(abs, [root])) throw new PathError(`${what} "${p}" is outside the workspace ${root}`);
    return abs;
  };

  const baseOptions = (args: InputArgs): Omit<ConvertOptions, "to"> => {
    if (!args.source && !args.path) throw new PathError("Give `source` (the document text) or `path` (a file).");
    const meta: ConvertOptions["meta"] = {};
    if (args.bibliography) meta.bibliography = args.bibliography;
    if (args.citation_style) meta.citationStyle = args.citation_style;
    const input = args.path ? inRoot(args.path, "path") : undefined;
    const baseDir = args.base_dir ? inRoot(args.base_dir, "base_dir") : input ? dirname(input) : root;
    return {
      input,
      source: args.source,
      from: args.format,
      baseDir,
      files: args.files,
      meta,
      strict: args.strict,
      allowNet: options.allowNet,
    };
  };

  /** A tool result; with `compact`, the diagnostics become one text line each. */
  const respond = (res: IsolatedResult, compact?: boolean): ToolResult =>
    json(compact ? { ...res, diagnostics: formatCompact(res.diagnostics) } : res, !res.ok);
  const failure = (e: unknown): ToolResult => (e instanceof PathError ? pathFailure(e.message) : json({ ok: false, error: (e as Error).message }, true));

  const tools: Tool[] = [
    {
      name: "render_document",
      title: "Render a document",
      description:
        "Convert Markdown, LaTeX or a texwright JSON document to PDF, HTML or JSON and write it to a file in the workspace. LaTeX math, numbered equations/figures/tables, cross-references (@fig:x, \\ref{}), citations ([@key], \\cite{}) and a table of contents are supported. Returns the output path and diagnostics; when ok is false, fix the reported lines and call again. Call get_guide once for the syntax.",
      inputSchema: { type: "object", properties: RENDER_PROPERTIES },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async run(raw) {
        const args = raw as RenderArgs;
        const to = args.to ?? "pdf";
        try {
          const opts: ConvertOptions = { ...baseOptions(args), to };
          opts.meta = { ...opts.meta };
          if (args.toc !== undefined) opts.meta.toc = args.toc;
          if (args.number_sections !== undefined) opts.meta.numberSections = args.number_sections;
          if (args.title) opts.meta.titleText = args.title;
          opts.theme = args.theme;
          opts.paper = args.paper;
          if (args.max_pages) opts.maxPages = args.max_pages;
          opts.output = args.output_path
            ? inRoot(args.output_path, "output_path")
            : opts.input
              ? defaultOutput(opts.input, to)
              : join(mkdtempSync(join(tmpdir(), "texwright-mcp-")), `document.${to}`);
          return respond(await runIsolated({ op: "convert", options: opts }, timeoutMs), args.compact);
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "preview_page",
      title: "Look at pages",
      description:
        "Typeset the document exactly as the PDF would be and return pages as PNG images, so you can see the result: layout, figures, tables, math, what overflows. Also returns the page count and the page each heading, figure, table and numbered equation landed on, to decide which pages to look at. `pages` defaults to [1], at most 4 per call; `dpi` defaults to 100 (a letter page is then 850 x 1100 pixels).",
      inputSchema: {
        type: "object",
        properties: {
          ...INPUT_PROPERTIES,
          pages: { type: "array", items: { type: "integer", minimum: 1 }, description: "1-based page numbers, default [1]; at most 4" },
          dpi: { type: "integer", minimum: 40, maximum: 200, description: "Resolution, default 100" },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(raw) {
        const args = raw as InputArgs & { pages?: number[]; dpi?: number };
        try {
          const pages = (args.pages?.length ? args.pages : [1]).slice(0, 4);
          const res = await runIsolated({ op: "preview", options: { ...baseOptions(args), pages, dpi: args.dpi ?? 100 } }, timeoutMs);
          const drawn = res.pages ?? [];
          const summary = {
            ok: res.ok,
            pageCount: res.pageCount,
            pages: drawn.map((p) => ({ page: p.page, width: p.width, height: p.height })),
            // Where things are, so the next call can ask for the right page; long documents are cut short.
            placement: (res.placement ?? []).slice(0, 200),
            diagnostics: args.compact ? formatCompact(res.diagnostics) : res.diagnostics,
          };
          return {
            content: [
              { type: "text", text: JSON.stringify(summary, null, 2) },
              ...drawn.map((p) => ({ type: "image" as const, data: Buffer.from(p.png).toString("base64"), mimeType: "image/png" })),
            ],
            isError: !res.ok,
          };
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "check_document",
      title: "Check a document",
      description:
        "Validate a document without rendering: parses it, numbers everything, typesets every formula, resolves references, citations and images. Returns diagnostics with stable codes, line, column and a hint; many carry a `fix` ({line, col, old, new, safe}) you can apply as an edit. Fast; use it after every edit.",
      inputSchema: { type: "object", properties: INPUT_PROPERTIES },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(raw) {
        try {
          return respond(await runIsolated({ op: "check", options: { ...baseOptions(raw as InputArgs), to: "html" } }, timeoutMs), (raw as InputArgs).compact);
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "fix_document",
      title: "Apply safe fixes",
      description:
        "Check the file at `path`, apply every safe fix (typos in labels, keys, commands and image names; missing closers; broken front matter) to it and the files it includes, and check again. Returns the fixes written and the remaining diagnostics. Writes files in the workspace.",
      inputSchema: { type: "object", properties: { path: INPUT_PROPERTIES.path!, bibliography: INPUT_PROPERTIES.bibliography!, compact: INPUT_PROPERTIES.compact! }, required: ["path"] },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(raw) {
        try {
          const args = raw as InputArgs;
          if (!args.path) throw new PathError("Give `path`: fixes are written back to the file.");
          return respond(await runIsolated({ op: "fix", options: { ...baseOptions({ path: args.path, bibliography: args.bibliography }), to: "html" } }, timeoutMs), args.compact);
        } catch (e) {
          return failure(e);
        }
      },
    },
    // ---------------------------------------------------------------- repair_document (src/repair.ts)
    {
      name: "repair_document",
      title: "Repair and render",
      description:
        "One call for the whole fix loop: check the file at `path`, apply every safe fix (typos in labels, keys, commands, environment and image names and option values; missing } \\right \\end{...}; broken front matter) until nothing more applies, taking back any round that makes it worse, then render it when no errors are left. Returns what was fixed (line, old -> new), what is left (each with a hint and, where known, a fix marked safe or not: apply the unsafe ones after a look), the output path, page count and where headings, figures and tables landed. With `compact` (default true) the report is a few short text lines. Writes the file and the output in the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: INPUT_PROPERTIES.path!,
          bibliography: INPUT_PROPERTIES.bibliography!,
          to: { type: "string", enum: ["pdf", "html", "json"], default: "pdf" },
          output_path: { type: "string", description: "Where to write the result, inside the workspace; default next to `path`" },
          compact: { type: "boolean", description: "Short text lines instead of JSON (default true)" },
          budget: { type: "integer", minimum: 200, description: "Most characters of the compact report (default 4000); the rest is counted, not listed" },
        },
        required: ["path"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      async run(raw) {
        try {
          const args = raw as InputArgs & { to?: "pdf" | "html" | "json"; output_path?: string; budget?: number };
          if (!args.path) throw new PathError("Give `path`: fixes are written back to the file.");
          const to = args.to ?? "pdf";
          const opts = baseOptions({ path: args.path, bibliography: args.bibliography });
          const output = args.output_path ? inRoot(args.output_path, "output_path") : defaultOutput(opts.input, to);
          const { repairDocument, formatRepair } = await import("./repair.js");
          const report = await repairDocument((req) => runIsolated(req, timeoutMs), opts, to, output);
          if (args.compact === false) return json(report, !report.ok);
          return { content: [{ type: "text", text: formatRepair(report, args.path, args.budget ?? 4000) }], isError: !report.ok };
        } catch (e) {
          return failure(e);
        }
      },
    },
    // ---------------------------------------------------------------- end of repair_document
    {
      name: "outline_document",
      title: "Outline a document",
      description:
        "What is where in a document, without reading all of it: headings, figures, tables, equations, theorems and listings in order, with numbers, labels, source lines and how often each is referenced, plus cited keys and a word count. Use it to navigate long documents and to find unreferenced figures or tables.",
      inputSchema: { type: "object", properties: { ...INPUT_PROPERTIES, text: { type: "boolean", description: "Return the outline as short text lines instead of JSON" } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(raw) {
        try {
          const args = raw as InputArgs & { text?: boolean };
          const res = await runIsolated({ op: "outline", options: { ...baseOptions(args), to: "html" } }, timeoutMs);
          if (args.text && res.outline) return { content: [{ type: "text", text: formatOutline(res.outline) }], isError: !res.ok };
          return respond(res, args.compact);
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "get_schema",
      title: "Document JSON Schema",
      description: "JSON Schema of the texwright document tree. Use it to emit documents as JSON instead of Markdown or LaTeX.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run() {
        return json(documentJsonSchema());
      },
    },
    {
      name: "get_guide",
      title: "Writing guide",
      description:
        "How to write documents for texwright: Markdown and LaTeX syntax, math, references, citations, figures, tables, layout keys, diagnostics and the fix-and-retry workflow. Pass short: true for a one-page cheat sheet.",
      inputSchema: { type: "object", properties: { short: { type: "boolean", description: "The one-page cheat sheet instead of the full guide" } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async run(raw) {
        const short = (raw as { short?: boolean }).short;
        const text = readFileSync(join(packageRoot(), short ? "CHEATSHEET.md" : "AGENTS.md"), "utf8");
        return { content: [{ type: "text", text: short ? text : `${text}\n\nThemes: ${listThemes().join(", ")}` }] };
      },
    },
    {
      name: "new_document",
      title: "Start from a template",
      description: `A complete, valid starter document to fill in. Kinds: ${TEMPLATES.map((t) => `${t.kind} (${t.description})`).join("; ")}. With \`path\`, writes it (and any files it uses, such as refs.bib) into the workspace; existing files are not overwritten.`,
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: TEMPLATES.map((t) => t.kind) },
          path: { type: "string", description: "Where to write the document inside the workspace, e.g. report.md" },
        },
        required: ["kind"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async run(raw) {
        const args = raw as { kind: string; path?: string };
        const tpl = template(args.kind);
        if (!tpl) return json({ ok: false, error: `Unknown kind "${args.kind}"` }, true);
        if (!args.path) return { content: [{ type: "text", text: tpl.text }] };
        try {
          const target = inRoot(args.path, "path");
          const files: [string, string][] = [[target, tpl.text], ...Object.entries(tpl.assets).map(([name, text]): [string, string] => [inRoot(join(dirname(args.path!), name), "path"), text])];
          const clash = files.find(([f]) => existsSync(f));
          if (clash) return json({ ok: false, error: `${clash[0]} already exists; choose another path` }, true);
          for (const [f, text] of files) writeFileSync(f, text);
          return json({ ok: true, written: files.map(([f]) => f), next: "Edit the document, then call check_document with its path." });
        } catch (e) {
          return failure(e);
        }
      },
    },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  let protocolVersion: string | undefined;
  /** Requests being worked on, and those the client has since cancelled (their replies are not sent). */
  const inFlight = new Set<string>();
  const cancelled = new Set<string>();
  const idKey = (id: RequestId) => `${typeof id}:${id}`;

  const request = async (method: string, params: Record<string, unknown>, inBatch: boolean): Promise<unknown> => {
    switch (method) {
      case "initialize": {
        if (inBatch) throw new RpcError(RPC_ERRORS.INVALID_REQUEST, "initialize can't be part of a batch");
        const requested = params.protocolVersion;
        if (typeof requested !== "string") throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'initialize needs "protocolVersion" (a string)');
        protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return { protocolVersion, capabilities: { tools: {} }, serverInfo };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
        };
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string") throw new RpcError(RPC_ERRORS.INVALID_PARAMS, 'tools/call needs "name" (a string)');
        const tool = byName.get(name);
        if (!tool) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${name}`);
        const args = params.arguments ?? {};
        if (!isObject(args)) throw new RpcError(RPC_ERRORS.INVALID_PARAMS, '"arguments" must be an object');
        // Argument mistakes go back as a tool error, so the agent sees them and can fix the call.
        const issues = validate(args, tool.inputSchema, { maxIssues: 10 });
        if (issues.length) {
          return json({ ok: false, error: `Invalid arguments for ${name}: ${issues.map((i) => `${i.path || "arguments"}: ${i.message}`).join("; ")}` }, true);
        }
        return tool.run(args);
      }
      default:
        throw new RpcError(RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };

  const notification = (method: string, params: Record<string, unknown> | undefined): void => {
    if (method === "notifications/cancelled") {
      // The request can't be stopped mid-flight (it runs in a worker with its own time limit), but its reply is withheld.
      const id = params?.requestId;
      if ((typeof id === "string" || typeof id === "number") && inFlight.has(idKey(id))) cancelled.add(idKey(id));
    }
    // notifications/initialized, notifications/roots/list_changed, progress...: nothing to do.
  };

  const error = (id: RequestId | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

  const single = async (msg: unknown, inBatch: boolean): Promise<JsonRpcResponse | undefined> => {
    if (!isObject(msg)) return error(null, RPC_ERRORS.INVALID_REQUEST, "Invalid Request: expected a JSON-RPC 2.0 object");
    const hasId = Object.hasOwn(msg, "id");
    const rawId = msg.id;
    const idOk = typeof rawId === "string" || (typeof rawId === "number" && Number.isFinite(rawId));
    const id = idOk ? (rawId as RequestId) : null;
    if (msg.jsonrpc !== "2.0") return error(id, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request: "jsonrpc" must be "2.0"');
    if (typeof msg.method !== "string") {
      // A response to a request of ours; this server never sends any, so there is nothing to match.
      if (hasId && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) return undefined;
      return error(id, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request: "method" must be a string');
    }
    if (hasId && !idOk) return error(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid Request: "id" must be a string or a number');
    const params = msg.params;
    if (params !== undefined && !isObject(params)) {
      return hasId ? error(id, RPC_ERRORS.INVALID_PARAMS, '"params" must be an object') : undefined;
    }
    if (!hasId) {
      notification(msg.method, params);
      return undefined;
    }
    const key = idKey(id!);
    inFlight.add(key);
    let reply: JsonRpcResponse;
    try {
      reply = { jsonrpc: "2.0", id, result: await request(msg.method, params ?? {}, inBatch) };
    } catch (e) {
      reply = e instanceof RpcError ? error(id, e.code, e.message) : error(id, RPC_ERRORS.INTERNAL_ERROR, `Internal error: ${(e as Error).message}`);
    }
    inFlight.delete(key);
    return cancelled.delete(key) ? undefined : reply;
  };

  const handleMessage = async (message: unknown): Promise<unknown> => {
    if (!Array.isArray(message)) return single(message, false);
    if (message.length === 0) return error(null, RPC_ERRORS.INVALID_REQUEST, "Invalid Request: empty batch");
    if (protocolVersion !== BATCH_PROTOCOL_VERSION) {
      return error(null, RPC_ERRORS.INVALID_REQUEST, `Invalid Request: JSON-RPC batches are not supported${protocolVersion ? ` in protocol version ${protocolVersion}` : ""}; send one message per line`);
    }
    const replies = (await Promise.all(message.map((m) => single(m, true)))).filter((r) => r !== undefined);
    return replies.length ? replies : undefined;
  };

  return {
    get protocolVersion() {
      return protocolVersion;
    },
    handleMessage,
    async handleLine(line: string): Promise<string | undefined> {
      const text = line.trim();
      if (!text) return undefined;
      let message: unknown;
      try {
        message = JSON.parse(text);
      } catch (e) {
        return JSON.stringify(error(null, RPC_ERRORS.PARSE_ERROR, `Parse error: ${(e as Error).message}`));
      }
      const reply = await handleMessage(message);
      return reply === undefined ? undefined : JSON.stringify(reply);
    },
  };
}

/** Run the server on stdin/stdout until the client disconnects. */
export async function runMcpServer(options: McpOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  // Load the worker while the client is still starting up, so the first request is as quick as the rest.
  warmUpIsolated();
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdout.on("error", shutdown); // the client went away
  const send = (line: string | undefined) => {
    if (line !== undefined) process.stdout.write(`${line}\n`);
  };
  const dispatch = (line: string) => {
    server.handleLine(line).then(send, (e: Error) => send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.INTERNAL_ERROR, message: e.message } })));
  };

  // Newline-delimited messages; only new data is searched for line ends, so a long message costs linear time.
  let parts: string[] = [];
  let size = 0;
  let skipping = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    let start = 0;
    for (let nl = chunk.indexOf("\n"); nl >= 0; nl = chunk.indexOf("\n", start)) {
      const piece = chunk.slice(start, nl);
      start = nl + 1;
      if (skipping) {
        skipping = false;
        continue;
      }
      parts.push(piece);
      const line = parts.join("");
      parts = [];
      size = 0;
      dispatch(line);
    }
    if (start < chunk.length && !skipping) {
      parts.push(chunk.slice(start));
      size += chunk.length - start;
      if (size > MAX_MESSAGE) {
        parts = [];
        size = 0;
        skipping = true;
        send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: RPC_ERRORS.INVALID_REQUEST, message: `Invalid Request: message longer than ${MAX_MESSAGE} characters` } }));
      }
    }
  });
  process.stdin.on("end", shutdown);
  // Keep running until the client disconnects.
  await new Promise<void>(() => undefined);
}
