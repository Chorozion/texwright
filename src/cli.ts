#!/usr/bin/env node
/**
 * texwright command line.
 *
 * Exit status: 0 success, 1 the document has errors (or warnings with
 * --strict), 2 bad command-line usage, 3 internal failure.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { CODES, type Diagnostic, Diagnostics, type Fix, formatCompact } from "./diagnostics.js";
import {
  type ConvertOptions,
  type InputFormat,
  type OutputFormat,
  type Placement,
  check,
  convert,
  defaultOutput,
  diagnosticJsonSchema,
  documentJsonSchema,
  fixDocument,
  formatOutline,
  listThemes,
  outline,
  preview,
  type PreviewOptions,
} from "./index.js";
import { runIsolated } from "./isolate.js";
import { TEMPLATES, template } from "./templates.js";
import { parseYaml } from "./util/yaml.js";
import { packageRoot } from "./write/assets.js";

const VERSION: string = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version;

const HELP = `texwright ${VERSION}
Markdown and LaTeX to PDF and HTML, with real math, cross-references and citations. No TeX install.

Usage
  texwright <input> [options]          convert (PDF next to the input by default)
  texwright check <input> [options]    validate only: parse, number, typeset math, resolve refs, cite
  texwright check <input> --fix        ...and apply the safe fixes (typos, missing closers, broken front matter)
  texwright repair <input> [-o file] [--budget 4000]
                                       apply every safe fix, render if clean, and list in a few lines
                                       what was fixed, what is left (with fixes to check) and where things landed
  texwright outline <input> [--json]   headings, figures, tables, equations, citations, with line numbers
  texwright preview <input> [--page 1,3] [--dpi 100] [-o page.png]
                                       draw PDF pages as PNG images, to look at the result
  texwright watch <input> [-o file] [--debounce 30]
                                       render, then again on every change to it or a file it uses
  texwright schema [document|diagnostics]
  texwright guide [--short]            writing guide for people and AI agents (--short: one-page cheat sheet)
  texwright new [kind] [-o file]       start from a template: paper, report, homework, notes, cv, letter, memo, proposal
  texwright codes                      list diagnostic codes
  texwright themes                     list themes
  texwright doctor                     show the fonts the PDF engine found
  texwright mcp                        run as an MCP server on stdio

Input and output
  -o, --output <file>        output path; "-" writes to stdout; the extension picks the format
  -t, --to <pdf|html|json>   output format (default pdf, or from --output)
  -f, --from <markdown|latex|json>   input format (default from the extension)
  "-" as input reads stdin

Document
      --title <text>  --author <name> (repeatable)  --date <text|today>
  -M, --meta key=value       set any metadata field (value parsed as YAML)
      --toc  --toc-depth <n>
  -N, --number-sections      (default on for LaTeX input)   --no-number-sections
      --bibliography <file>  (repeatable)   --citation-style <numeric|author-year>

Layout
      --theme <article|modern|compact>     --css <file> (repeatable)
      --paper <letter|a4|a5|legal|b5>      --landscape      --margin <1in | 1in,0.8in>
      --page-numbers <center|right|none>   --header <text>  --footer <text>
      --max-pages <n>        tighten margins, then the body size, until the PDF fits

Safety
      --allow-net            allow remote images (off by default)
      --allow-path <dir>     extra folder images may come from (repeatable)
      --unsafe-html          keep raw HTML as written (trusted input only)
      --timeout <seconds>    stop and report TIME001 if a document takes longer
      --root <dir>           (mcp) folder the server may read and write; default: current folder

Reporting
      --diagnostics <pretty|json|compact>   json: one report on stdout; compact: one line per problem
      --strict               warnings count as errors
  -q, --quiet                no output on success
  -h, --help   -v, --version
`;

interface Report {
  ok: boolean;
  output?: string;
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
  stats?: Record<string, unknown>;
  /** PDF: the page each heading, figure, table, numbered equation and theorem landed on. */
  placement?: Placement[];
  /** check --fix: fixes written, and safe fixes whose text was not found. */
  fixed?: Fix[];
  unplaced?: Fix[];
}

function fail(message: string): never {
  process.stderr.write(`texwright: ${message}\nRun "texwright --help" for usage.\n`);
  process.exit(2);
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function emit(report: Report, mode: "pretty" | "json" | "compact", quiet: boolean, toStdout: boolean): void {
  if (mode === "json") {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    (toStdout ? process.stderr : process.stdout).write(text);
    return;
  }
  if (mode === "compact") {
    // One line per problem and a last summary line; no source excerpts, no colour.
    const lines = formatCompact(report.diagnostics);
    const summary = report.ok ? (report.output ? `ok ${report.output}` : "ok") : `failed ${report.errors} error${report.errors === 1 ? "" : "s"}`;
    const tail = `${summary}${report.warnings ? `, ${report.warnings} warning${report.warnings === 1 ? "" : "s"}` : ""}`;
    (toStdout ? process.stderr : process.stdout).write(`${lines ? `${lines}\n` : ""}${quiet && report.ok ? "" : `${tail}\n`}`);
    return;
  }
  const bag = new Diagnostics();
  for (const d of report.diagnostics) bag.items.push(d);
  const pretty = bag.format(!!process.stderr.isTTY);
  if (pretty) process.stderr.write(`${pretty}\n`);
  if (!quiet && !toStdout) {
    const summary = report.ok ? (report.output ? `wrote ${report.output}` : "ok") : `failed: ${report.errors} error${report.errors === 1 ? "" : "s"}`;
    const extra = report.stats?.pages ? ` (${report.stats.pages} page${report.stats.pages === 1 ? "" : "s"})` : "";
    process.stderr.write(`${summary}${extra}${report.warnings ? `, ${report.warnings} warning${report.warnings === 1 ? "" : "s"}` : ""}\n`);
    if (report.placement?.length) process.stderr.write(`${placementLines(report.placement)}\n`);
  }
}

/** Where things landed, one line per page: "  p2: 2 Method, Figure 1, (3)". */
function placementLines(items: Placement[]): string {
  const byPage = new Map<number, string[]>();
  for (const it of items) {
    const name =
      it.kind === "heading"
        ? `${it.number ? `${it.number} ` : ""}${it.text ?? ""}`.trim()
        : it.kind === "equation"
          ? `(${it.number ?? "?"})`
          : `${it.kind[0]!.toUpperCase()}${it.kind.slice(1)} ${it.number ?? ""}`.trim();
    if (!name) continue;
    const list = byPage.get(it.page) ?? [];
    list.push(name.length > 40 ? `${name.slice(0, 39)}…` : name);
    byPage.set(it.page, list);
  }
  return [...byPage].map(([page, names]) => `  p${page}: ${names.join(", ")}`).join("\n");
}

function parseMetaPairs(pairs: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs ?? []) {
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const raw = eq < 0 ? "true" : pair.slice(eq + 1);
    // The value is YAML (3 is a number, [a, b] a list); text that isn't valid YAML stays a string.
    const parsed = parseYaml(raw);
    const value = parsed.error ? raw : raw.trim() === "" ? undefined : parsed.value;
    const name = key.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          output: { type: "string", short: "o" },
          to: { type: "string", short: "t" },
          from: { type: "string", short: "f" },
          title: { type: "string" },
          author: { type: "string", multiple: true },
          date: { type: "string" },
          meta: { type: "string", short: "M", multiple: true },
          toc: { type: "boolean" },
          "toc-depth": { type: "string" },
          "number-sections": { type: "boolean", short: "N" },
          "no-number-sections": { type: "boolean" },
          bibliography: { type: "string", multiple: true },
          "citation-style": { type: "string" },
          theme: { type: "string" },
          css: { type: "string", multiple: true },
          paper: { type: "string" },
          landscape: { type: "boolean" },
          margin: { type: "string" },
          "page-numbers": { type: "string" },
          "max-pages": { type: "string" },
          debounce: { type: "string" },
          page: { type: "string" },
          dpi: { type: "string" },
          short: { type: "boolean" },
          force: { type: "boolean" },
          header: { type: "string" },
          footer: { type: "string" },
          "allow-net": { type: "boolean" },
          "allow-path": { type: "string", multiple: true },
          "unsafe-html": { type: "boolean" },
          timeout: { type: "string" },
          root: { type: "string" },
          diagnostics: { type: "string" },
          fix: { type: "boolean" },
          budget: { type: "string" },
          json: { type: "boolean" },
          strict: { type: "boolean" },
          quiet: { type: "boolean", short: "q" },
          help: { type: "boolean", short: "h" },
          version: { type: "boolean", short: "v" },
        },
      });
    } catch (e) {
      fail((e as Error).message);
    }
  })();

  if (values.version) {
    // --version --json says which build is actually running: where it is installed, a hash of the
    // code that runs, and the compile cache in use. A stale install shows up here at once.
    if (values.json) process.stdout.write(`${JSON.stringify(provenance(), null, 2)}\n`);
    else process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return positionals.length === 0 && !values.help ? 2 : 0;
  }

  const command = positionals[0]!;
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const seconds = Number(values.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) fail("--timeout takes a number of seconds");
    timeoutMs = seconds * 1000;
  }
  switch (command) {
    case "schema": {
      const which = positionals[1] ?? "document";
      if (which !== "document" && which !== "diagnostics") fail('schema takes "document" or "diagnostics"');
      process.stdout.write(`${JSON.stringify(which === "document" ? documentJsonSchema() : diagnosticJsonSchema(), null, 2)}\n`);
      return 0;
    }
    case "guide":
      process.stdout.write(readFileSync(join(packageRoot(), values.short ? "CHEATSHEET.md" : "AGENTS.md"), "utf8"));
      return 0;
    case "new": {
      const kind = positionals[1];
      if (!kind) {
        for (const t of TEMPLATES) process.stdout.write(`${t.kind.padEnd(10)} ${t.description}\n`);
        return 0;
      }
      const tpl = template(kind);
      if (!tpl) fail(`unknown template "${kind}"; one of ${TEMPLATES.map((t) => t.kind).join(", ")}`);
      if (!values.output || values.output === "-") {
        process.stdout.write(tpl.text);
        return 0;
      }
      const target = resolve(values.output);
      const files: [string, string][] = [[target, tpl.text], ...Object.entries(tpl.assets).map(([name, text]): [string, string] => [join(dirname(target), name), text])];
      const clash = files.find(([f]) => existsSync(f));
      if (clash && !values.force) fail(`${clash[0]} exists; pass --force to overwrite`);
      for (const [f, text] of files) writeFileSync(f, text);
      if (!values.quiet) process.stderr.write(`wrote ${files.map(([f]) => f).join(", ")}\n`);
      return 0;
    }
    case "codes":
      for (const [code, info] of Object.entries(CODES)) process.stdout.write(`${code.padEnd(8)} ${info.severity.padEnd(8)} ${info.summary}\n`);
      return 0;
    case "themes":
      process.stdout.write(`${listThemes().join("\n")}\n`);
      return 0;
    case "doctor": {
      const { theme } = await import("./typeset/index.js");
      const modern = theme("modern");
      const face = (f: { fullName: string; familyName: string }) => f.fullName || f.familyName;
      const lines = [
        `texwright ${VERSION}`,
        `node ${process.version}`,
        "PDF engine: built in (no browser or TeX needed)",
        `serif: ${face(theme("article").serif.regular)} (bundled)`,
        `sans: ${face(modern.sans.regular)}`,
        `mono: ${face(modern.mono)}`,
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }
    case "mcp": {
      const { runMcpServer } = await import("./mcp.js");
      await runMcpServer({ root: values.root, timeoutMs: timeoutMs ?? 120_000, allowNet: values["allow-net"] });
      return 0;
    }
    default:
      break;
  }

  const isCheck = command === "check";
  const isOutline = command === "outline";
  const isPreview = command === "preview";
  const isWatch = command === "watch";
  const isRepair = command === "repair";
  const input = isCheck || isOutline || isPreview || isWatch || isRepair ? positionals[1] : command;
  if (!input) fail("no input file given");
  const sub = isCheck || isOutline || isPreview || isWatch || isRepair;
  if (positionals.length > (sub ? 2 : 1)) fail(`one input file at a time (got ${positionals.slice(sub ? 1 : 0).join(", ")}); use \\input in LaTeX to combine files`);
  if (values.fix && !isCheck) fail("--fix goes with check: texwright check <input> --fix");

  const diagMode = values.diagnostics === "json" ? "json" : values.diagnostics === "compact" ? "compact" : "pretty";
  if (values.diagnostics && !["json", "pretty", "compact"].includes(values.diagnostics)) fail("--diagnostics takes pretty, json or compact");

  const from = values.from;
  if (from && !["markdown", "latex", "json", "md", "tex"].includes(from)) fail(`unknown input format "${from}"`);
  const fromNorm = (from === "md" ? "markdown" : from === "tex" ? "latex" : from) as InputFormat | undefined;

  let to = values.to as OutputFormat | undefined;
  if (to && !["pdf", "html", "json"].includes(to)) fail(`unknown output format "${to}"`);
  if (!to && values.output && values.output !== "-") {
    const ext = extname(values.output).toLowerCase();
    to = ext === ".html" || ext === ".htm" ? "html" : ext === ".json" ? "json" : "pdf";
  }
  to ??= "pdf";

  const meta: ConvertOptions["meta"] = { ...(parseMetaPairs(values.meta) as ConvertOptions["meta"]) };
  if (values.title !== undefined) meta.titleText = values.title;
  if (values.author) meta.authorText = values.author;
  if (values.date !== undefined) meta.dateText = values.date;
  if (values.toc) meta.toc = true;
  if (values["toc-depth"]) meta.tocDepth = Number.parseInt(values["toc-depth"], 10);
  if (values["number-sections"]) meta.numberSections = true;
  if (values["no-number-sections"]) meta.numberSections = false;
  if (values.bibliography) meta.bibliography = values.bibliography;
  if (values["citation-style"]) {
    if (!["numeric", "author-year"].includes(values["citation-style"])) fail("--citation-style takes numeric or author-year");
    meta.citationStyle = values["citation-style"] as "numeric" | "author-year";
  }
  const paper = values.paper?.toLowerCase();
  if (paper && !["letter", "a4", "a5", "legal", "b5"].includes(paper)) fail(`unknown paper size "${values.paper}"`);
  const pageNumbers = values["page-numbers"];
  const maxPages = values["max-pages"] === undefined ? undefined : Number(values["max-pages"]);
  if (maxPages !== undefined && !(Number.isInteger(maxPages) && maxPages >= 1)) fail("--max-pages takes a whole number of pages");
  if (pageNumbers && !["center", "right", "none"].includes(pageNumbers)) fail("--page-numbers takes center, right or none");

  const opts: ConvertOptions = {
    to,
    from: fromNorm,
    meta,
    theme: values.theme,
    css: values.css,
    paper: paper as ConvertOptions["paper"],
    landscape: values.landscape,
    margin: values.margin,
    pageNumbers: pageNumbers as ConvertOptions["pageNumbers"],
    header: values.header,
    footer: values.footer,
    maxPages: maxPages,
    allowNet: values["allow-net"],
    allowPaths: values["allow-path"],
    unsafeHtml: values["unsafe-html"],
    strict: values.strict,
  };
  if (input === "-") {
    opts.source = readStdin();
    opts.input = undefined;
  } else {
    opts.input = input;
  }

  if (isOutline) {
    const res = timeoutMs ? await runIsolated({ op: "outline", options: opts }, timeoutMs) : outline(opts);
    if (!res.outline) {
      emit({ ok: false, errors: 1, warnings: 0, diagnostics: res.diagnostics }, diagMode, false, false);
      return 1;
    }
    process.stdout.write(values.json ? `${JSON.stringify(res.outline, null, 1)}\n` : `${formatOutline(res.outline)}\n`);
    return res.ok ? 0 : 1;
  }

  if (isPreview) {
    // "2", "2,3" or ranges such as "1-4,7" (at most 200 pages).
    const pages: number[] = [];
    for (const part of values.page ? values.page.split(",") : ["1"]) {
      const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(part);
      const a = m ? Number(m[1]) : NaN;
      const b = m?.[2] ? Number(m[2]) : a;
      if (!m || a < 1 || b < a) fail("--page takes page numbers or ranges, e.g. --page 1, --page 2,3 or --page 1-4");
      for (let n = a; n <= b && pages.length < 200; n++) pages.push(n);
    }
    const dpi = values.dpi === undefined ? 100 : Number(values.dpi);
    if (!(dpi >= 10 && dpi <= 600)) fail("--dpi takes a number from 10 to 600");
    const popts: PreviewOptions = { ...opts, dpi, pages };
    const res = timeoutMs ? await runIsolated({ op: "preview", options: popts }, timeoutMs) : preview(popts);
    const drawn = res.pages ?? [];
    const base = values.output && values.output !== "-" ? values.output : `${(input === "-" ? "document" : input).replace(/\.[^./\\]+$/, "")}.png`;
    const written: string[] = [];
    for (const pg of drawn) {
      // One page goes to the name given; several get -p<N> before the extension.
      const file = drawn.length === 1 && values.output ? base : base.replace(/(\.png)?$/i, `-p${pg.page}.png`);
      writeFileSync(file, pg.png);
      written.push(file);
    }
    const errors = res.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = res.diagnostics.filter((d) => d.severity === "warning").length;
    if (diagMode !== "json" && !values.quiet) {
      for (const f of written) process.stderr.write(`wrote ${resolve(f)}\n`);
      if (res.pageCount !== undefined) process.stderr.write(`${res.pageCount} page${res.pageCount === 1 ? "" : "s"} in all\n`);
    }
    emit({ ok: res.ok, errors, warnings, diagnostics: res.diagnostics }, diagMode, !!values.quiet, false);
    return res.ok ? 0 : 1;
  }

  if (isCheck && values.fix) {
    if (input === "-") fail("--fix needs a file (it writes the fixes back)");
    const res = timeoutMs ? await runIsolated({ op: "fix", options: opts }, timeoutMs) : fixDocument(opts);
    const applied = res.applied ?? [];
    const errors = res.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = res.diagnostics.filter((d) => d.severity === "warning").length;
    if (diagMode !== "json" && !values.quiet) {
      for (const f of applied) process.stderr.write(`fixed ${f.file ?? input}:${f.line}:${f.col} "${f.old}" -> "${f.new}"\n`);
      if (!applied.length) process.stderr.write("no safe fixes to apply\n");
    }
    emit({ ok: res.ok, errors, warnings, diagnostics: res.diagnostics, fixed: applied, unplaced: res.skipped ?? [] }, diagMode, !!values.quiet, false);
    return res.ok ? 0 : 1;
  }

  if (isCheck) {
    const res = timeoutMs ? await runIsolated({ op: "check", options: opts }, timeoutMs) : check(opts);
    const errors = res.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = res.diagnostics.filter((d) => d.severity === "warning").length;
    emit({ ok: res.ok, errors, warnings, diagnostics: res.diagnostics }, diagMode, !!values.quiet, false);
    return res.ok ? 0 : 1;
  }

  // ---------------------------------------------------------------- watch (src/watch.ts)
  if (isWatch) {
    if (input === "-") fail("watch needs a file, not stdin");
    if (values.output === "-") fail("watch writes a file; give -o <file>");
    if (timeoutMs) fail("--timeout does not apply to watch");
    const debounce = values.debounce === undefined ? 30 : Number(values.debounce);
    if (!(debounce >= 0 && debounce <= 10_000)) fail("--debounce takes milliseconds from 0 to 10000");
    const { watchDocument } = await import("./watch.js");
    return watchDocument({ ...opts, input, output: values.output ?? defaultOutput(input, to) }, { diagnostics: diagMode, debounceMs: debounce, quiet: !!values.quiet });
  }
  // ---------------------------------------------------------------- end of watch

  // ---------------------------------------------------------------- repair (src/repair.ts)
  if (isRepair) {
    if (input === "-") fail("repair needs a file (it writes the fixes back)");
    if (values.output === "-") fail("repair writes a file; give -o <file> or leave -o out");
    const budget = values.budget === undefined ? 4000 : Number(values.budget);
    if (!(Number.isInteger(budget) && budget >= 200)) fail("--budget takes a number of characters, at least 200");
    const { repairDocument, formatRepair } = await import("./repair.js");
    const run = async (req: Parameters<typeof runIsolated>[0]) => {
      if (timeoutMs) return runIsolated(req, timeoutMs);
      if (req.op === "fix") {
        const r = fixDocument(req.options);
        return { ok: r.ok, diagnostics: r.diagnostics, applied: r.applied, skipped: r.skipped };
      }
      const r = await convert(req.options as ConvertOptions);
      return { ok: r.ok, diagnostics: r.diagnostics, output: r.output, stats: r.stats, ...(r.placement ? { placement: r.placement } : {}) };
    };
    const report = await repairDocument(run, opts, to, values.output ?? defaultOutput(input, to));
    if (diagMode === "json") process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (!values.quiet || !report.ok) process.stdout.write(`${formatRepair(report, input, budget)}\n`);
    return report.ok ? 0 : 1;
  }
  // ---------------------------------------------------------------- end of repair

  const toStdout = values.output === "-";
  if (!toStdout) opts.output = values.output ?? defaultOutput(opts.input, to);
  if (timeoutMs) {
    if (toStdout) fail("--timeout needs an output file (not -o -)");
    const iso = await runIsolated({ op: "convert", options: opts }, timeoutMs);
    const errs = iso.diagnostics.filter((d) => d.severity === "error").length;
    const warns = iso.diagnostics.filter((d) => d.severity === "warning").length;
    emit({ ok: iso.ok, output: iso.output, errors: errs, warnings: warns, diagnostics: iso.diagnostics, stats: iso.stats, ...(iso.placement ? { placement: iso.placement } : {}) }, diagMode, !!values.quiet, false);
    return iso.ok ? 0 : 1;
  }
  const res = await convert(opts);
  if (toStdout && res.data !== undefined) {
    process.stdout.write(typeof res.data === "string" ? res.data : Buffer.from(res.data));
  }
  const errors = res.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = res.diagnostics.filter((d) => d.severity === "warning").length;
  emit({ ok: res.ok, output: res.output, errors, warnings, diagnostics: res.diagnostics, stats: res.stats, ...(res.placement ? { placement: res.placement } : {}) }, diagMode, !!values.quiet, toStdout);
  return res.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`texwright: internal error: ${(e as Error).stack ?? e}\nPlease report this with the input that caused it.\n`);
    process.exit(3);
  },
);


/** What is running: version, install folder, the hash of the code file that runs, Node, compile cache, codes known. */
function provenance(): Record<string, unknown> {
  const root = packageRoot();
  // The bundle's code lives in texwright-core.js (texwright.mjs is only its loader).
  const running = [join(root, "dist", "texwright-core.js"), join(root, "dist", "texwright.mjs")].find((f) => existsSync(f)) ?? fileURLToPath(import.meta.url);
  let sha256: string | undefined;
  try {
    sha256 = createHash("sha256").update(readFileSync(running)).digest("hex");
  } catch {
    sha256 = undefined;
  }
  const cacheDir = (nodeModule as { getCompileCacheDir?: () => string | undefined }).getCompileCacheDir?.();
  return { version: VERSION, packageRoot: root, code: running, sha256, node: process.version, compileCache: cacheDir ?? null, codes: Object.keys(CODES).length };
}
