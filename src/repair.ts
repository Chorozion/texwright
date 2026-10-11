/**
 * Repair in one call: check a document, apply every safe fix until nothing more applies (taking
 * back any round that makes it worse), render it when it is clean, and say in a few lines what
 * was fixed, what is left (with the fixes that need a look), and where things landed.
 *
 * The steps run through a caller's runner, so the command line can run them in-process and the
 * MCP server in its isolated workers with a time limit.
 */

import { relative } from "node:path";
import type { Diagnostic, Fix } from "./diagnostics.js";
import type { ConvertOptions, OutputFormat, Placement } from "./index.js";
import type { IsolatedRequest, IsolatedResult } from "./isolate.js";

export interface RepairReport {
  ok: boolean;
  /** The file written, when the document was clean enough to render. */
  output?: string;
  pages?: number;
  /** Safe fixes written to the files, in the order they were applied. */
  fixed: Fix[];
  /** Safe fixes taken back because the document checked worse with them, or that could not be placed. */
  unplaced: Fix[];
  /** What is left: errors and warnings after fixing (and rendering), each with its fix when one is known. */
  remaining: Diagnostic[];
  errors: number;
  warnings: number;
  /** PDF: the page each heading, figure, table and numbered equation landed on. */
  placement?: Placement[];
}

export type Runner = (req: IsolatedRequest) => Promise<IsolatedResult>;

/**
 * Fix `opts.input` in place, then render it to `output` (format `to`) unless errors remain.
 * `strict` makes warnings stop the render too.
 */
export async function repairDocument(run: Runner, opts: Omit<ConvertOptions, "to" | "output">, to: OutputFormat, output: string): Promise<RepairReport> {
  const fixed = await run({ op: "fix", options: { ...opts, to: "html" } });
  const report: RepairReport = { ok: fixed.ok, fixed: fixed.applied ?? [], unplaced: fixed.skipped ?? [], remaining: problems(fixed.diagnostics), errors: 0, warnings: 0 };
  if (fixed.ok) {
    const res = await run({ op: "convert", options: { ...opts, to, output } });
    report.ok = res.ok;
    report.remaining = problems(res.diagnostics);
    if (res.output) report.output = res.output;
    if (res.stats?.pages) report.pages = res.stats.pages;
    if (res.placement) report.placement = res.placement;
  }
  report.errors = report.remaining.filter((d) => d.severity === "error").length;
  report.warnings = report.remaining.filter((d) => d.severity === "warning").length;
  return report;
}

/** Errors and warnings; notes (info) are left out of a repair summary. */
function problems(ds: readonly Diagnostic[]): Diagnostic[] {
  return ds.filter((d) => d.severity !== "info");
}

/** Text shortened to `n` characters, line ends shown as \n so each item stays on one line. */
function clip(s: string, n = 60): string {
  const t = s.replace(/\r?\n/g, "\\n");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * The report as short lines, for agents that pay per token: one per fix made ("fixed"), one per
 * problem left ("left", with its fix and whether it is safe), a status line, and where things
 * landed, page by page. Past `budget` characters the rest is counted, not listed.
 */
export function formatRepair(r: RepairReport, input: string, budget = 4000): string {
  const name = (f: string | undefined) => (f ? relative(process.cwd(), f) || f : input);
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;
  const push = (line: string) => {
    if (used + line.length + 1 > budget) {
      dropped++;
      return;
    }
    lines.push(line);
    used += line.length + 1;
  };
  for (const f of r.fixed) push(`fixed ${name(f.file)}:${f.line}:${f.col} "${clip(f.old)}" -> "${clip(f.new)}"`);
  for (const d of r.remaining) {
    const parts = [`left ${name(d.file)}${d.line ? `:${d.line}:${d.col ?? 1}` : ""} ${d.severity === "error" ? "E" : "W"} ${d.code} ${d.message}`];
    if (d.hint) parts.push(d.hint);
    if (d.fix) parts.push(`fix "${clip(d.fix.old)}" -> "${clip(d.fix.new)}"${d.fix.safe ? " safe" : " (check, then apply)"}`);
    push(parts.join(" | "));
  }
  const counts = `${r.fixed.length} fixed, ${r.errors} error${r.errors === 1 ? "" : "s"} and ${r.warnings} warning${r.warnings === 1 ? "" : "s"} left`;
  const status = r.output ? `ok ${name(r.output)}${r.pages ? ` (${r.pages} page${r.pages === 1 ? "" : "s"})` : ""}: ${counts}` : `not rendered: ${counts}`;
  const tail: string[] = [];
  if (r.placement?.length) {
    const byPage = new Map<number, string[]>();
    for (const it of r.placement) {
      const label = it.kind === "heading" ? `${it.number ? `${it.number} ` : ""}${it.text ?? ""}`.trim() : it.kind === "equation" ? `(${it.number ?? "?"})` : `${it.kind[0]!.toUpperCase()}${it.kind.slice(1)} ${it.number ?? ""}`.trim();
      if (!label) continue;
      byPage.set(it.page, [...(byPage.get(it.page) ?? []), clip(label, 40)]);
    }
    for (const [page, names] of byPage) tail.push(`  p${page}: ${names.join(", ")}`);
  }
  // The status line always shows; placement fills what budget is left.
  const out = [...lines];
  if (dropped) out.push(`... ${dropped} more not listed (texwright check ${input} --diagnostics compact lists all)`);
  out.push(status);
  let room = budget - used - status.length;
  let cut = 0;
  for (const t of tail) {
    if (t.length + 1 > room) {
      cut++;
      continue;
    }
    out.push(t);
    room -= t.length + 1;
  }
  if (cut) out.push(`  ... ${cut} more page${cut === 1 ? "" : "s"}`);
  return out.join("\n");
}
