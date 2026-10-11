/** tabular, tabular*, tabularx, tabulary and longtable. */

import type { Align, Block, TableCell } from "../../ast.js";
import type { FixSpec } from "../../diagnostics.js";
import { slugify } from "../../ast.js";
import { isChar, isCmd, type Open, type Sink, type Target } from "./base.js";
import type { Token } from "./lexer.js";
import type { Parser } from "./parser.js";
import { trimInlines } from "./text.js";

type TableBlock = Extract<Block, { t: "Table" }>;

interface Col {
  align: Align;
  /** Fraction of the text width, "X" for a tabularx column, null when not relative. */
  width: number | "X" | null;
}

/**
 * Repeats (`*{n}{...}`) nest, so a spec of a few dozen characters can ask for
 * 100^k columns. These bound the columns made and the characters of
 * repeated specs read.
 */
const MAX_COLUMNS = 1000;
const MAX_REPEAT_CHARS = 1_000_000;

/** Parse a column specification such as "|l|c|p{0.3\textwidth}|*{2}{r}@{}". */
function parseColSpec(spec: string, room = { columns: MAX_COLUMNS, chars: MAX_REPEAT_CHARS }): Col[] {
  const cols: Col[] = [];
  const push = (col: Col): void => {
    if (room.columns <= 0) return;
    room.columns--;
    cols.push(col);
  };
  let i = 0;
  const group = (): string => {
    while (spec[i] === " ") i++;
    if (spec[i] !== "{") return spec[i++] ?? "";
    const start = i;
    let depth = 0;
    for (; i < spec.length; i++) {
      if (spec[i] === "{") depth++;
      else if (spec[i] === "}" && --depth === 0) return spec.slice(start + 1, i++);
    }
    return spec.slice(start + 1);
  };
  /** Options after a column type, S[table-format=1.3] or X[2]: skipped (the letters inside are not columns). */
  const options = (): void => {
    let j = i;
    while (spec[j] === " " || spec[j] === "\n") j++;
    if (spec[j] !== "[") return;
    const close = spec.indexOf("]", j);
    i = close < 0 ? spec.length : close + 1;
  };
  while (i < spec.length && room.columns > 0) {
    const c = spec[i++];
    if (/[A-Za-z]/.test(c!)) options();
    if (c === "l" || c === "L") push({ align: "left", width: null });
    else if (c === "c" || c === "C" || c === "S") push({ align: "center", width: null });
    else if (c === "r" || c === "R") push({ align: "right", width: null });
    else if (c === "p" || c === "m" || c === "b") push({ align: "left", width: relWidth(group()) });
    else if (c === "X") push({ align: "left", width: "X" });
    else if (c === "@" || c === "!" || c === ">" || c === "<") group();
    else if (c === "*") {
      const n = Number(group());
      const sub = group();
      for (let k = 0; k < n && k < 100 && room.columns > 0 && (room.chars -= sub.length + 1) >= 0; k++) cols.push(...parseColSpec(sub, room));
    } else if (c === "\\") while (/[A-Za-z]/.test(spec[i] ?? "")) i++;
    else if (c === "D") {
      // dcolumn's D{.}{.}{2.3}: one column, numbers aligned on the separator.
      group();
      group();
      group();
      push({ align: "right", width: null });
    } else if (/[A-Za-z]/.test(c!)) {
      // A column type the document declared (\newcolumntype{Y}{...}, tabulary's J, siunitx's s):
      // still one column, with its brace arguments.
      while (spec[i] === "{") group();
      push({ align: "left", width: c === "Y" ? "X" : null });
    }
  }
  return cols;
}

function relWidth(w: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)?\s*\\(textwidth|linewidth|columnwidth|hsize)\s*$/.exec(w);
  return m ? (m[1] ? Number(m[1]) : 1) : null;
}

/** Relative widths; normalized to sum to 1 when every column has one. */
function widthsOf(cols: Col[]): (number | null)[] | undefined {
  if (!cols.some((c) => c.width !== null)) return undefined;
  const fixed = cols.reduce((s, c) => s + (typeof c.width === "number" ? c.width : 0), 0);
  const nx = cols.filter((c) => c.width === "X").length;
  const x = nx ? Math.max(0, 1 - fixed) / nx || 1 / nx : 0;
  const ws = cols.map((c) => (c.width === "X" ? x : c.width));
  const round = (n: number): number => Math.round(n * 1e6) / 1e6;
  if (ws.every((w) => w !== null)) {
    const total = ws.reduce((s: number, w) => s + (w ?? 0), 0);
    if (total > 0) return ws.map((w) => round((w ?? 0) / total));
  }
  return ws.map((w) => (w === null ? null : round(w)));
}

const RULES = new Set(["hline", "toprule", "midrule", "bottomrule", "cline", "cmidrule", "specialrule", "addlinespace", "morecmidrules", "hhline", "noalign", "rowcolor", "arrayrulecolor"]);
const LONGTABLE_MARKS = new Set(["endfirsthead", "endhead", "endfoot", "endlastfoot"]);

function skipRule(p: Parser, t: Token): void {
  switch (t.value) {
    case "cline":
    case "hhline":
    case "noalign":
      p.readArgRaw(t);
      break;
    case "cmidrule": {
      p.readOptRaw();
      const u = p.toks[p.i];
      const close = u?.type === "text" && u.value.startsWith("(") ? u.value.indexOf(")") : -1;
      if (close >= 0) {
        p.splitAt(p.i, close + 1);
        p.i++;
      }
      p.readArgRaw(t);
      break;
    }
    case "specialrule":
      p.readArgRaw(t);
      p.readArgRaw(t);
      p.readArgRaw(t);
      break;
    case "rowcolor":
    case "arrayrulecolor":
      p.readOptRaw();
      p.readArgRaw(t);
      break;
    case "toprule":
    case "midrule":
    case "bottomrule":
    case "addlinespace":
      p.readOptRaw();
      break;
  }
}

function isEmptyCell(c: TableCell): boolean {
  return !c.content.length && !c.colspan && !c.rowspan && c.align === undefined;
}

function parseCell(p: Parser): TableCell {
  p.skipWhite();
  const t = p.toks[Math.min(p.i, p.toks.length - 1)];
  const cell: TableCell = { content: [] };
  let lead: TableCell["content"] = [];
  if (isCmd(p.toks[p.i], "multicolumn")) {
    p.i++;
    const n = Number(p.readArgRaw(t)?.text.trim());
    const spec = parseColSpec(p.readArgRaw(t)?.text ?? "");
    lead = p.parseArgInlines(t);
    if (n > 1) cell.colspan = n;
    cell.align = spec[0]?.align ?? null;
  } else if (isCmd(p.toks[p.i], "multirow")) {
    p.i++;
    p.readOptRaw();
    const n = Math.abs(Number(p.readArgRaw(t)?.text.trim()));
    p.readOptRaw();
    p.readArgRaw(t);
    p.readOptRaw();
    lead = p.parseArgInlines(t);
    if (n > 1) cell.rowspan = n;
  }
  const rest = p.finishInlines(p.parseScoped({ kind: "cell", tok: t }, true, true));
  cell.content = trimInlines([...lead, ...rest]);
  return cell;
}

function parseRow(p: Parser): TableCell[] {
  const cells: TableCell[] = [];
  for (;;) {
    cells.push(parseCell(p));
    const t = p.toks[p.i];
    if (isChar(t, "&")) {
      p.i++;
      continue;
    }
    if (isCmd(t, "\\") || isCmd(t, "tabularnewline")) {
      p.i++;
      p.consumeStar();
      p.readOptRaw();
    }
    return cells;
  }
}

/** Drop the empty cells that LaTeX needs under a \multirow but HTML must not see. */
function removeCovered(rows: TableCell[][]): void {
  const pending = new Map<number, number>();
  for (let r = 0; r < rows.length; r++) {
    const kept: TableCell[] = [];
    let col = 0;
    for (const cell of rows[r]) {
      const left = pending.get(col) ?? 0;
      if (left > 0 && isEmptyCell(cell)) {
        pending.set(col, left - 1);
        col++;
        continue;
      }
      kept.push(cell);
      if (cell.rowspan && cell.rowspan > 1) pending.set(col, cell.rowspan - 1);
      col += cell.colspan ?? 1;
    }
    rows[r] = kept;
  }
}

/**
 * A column spec with `extra` more l columns ({ll} to {lll}, {|l|l|} to {|l|l|l|}). Never safe: the
 * extra & may be the mistake instead, which only the writer knows.
 */
function widerSpec(p: Parser, spec: { text: string; tok: Token } | undefined, extra: number): FixSpec | undefined {
  if (!spec || spec.tok.type !== "open" || spec.tok.depth > 0 || !spec.text || extra < 1) return undefined;
  const bar = spec.text.trimEnd().endsWith("|");
  const at = p.posIn(spec.tok, spec.tok.end);
  return { old: spec.text, new: spec.text.trimEnd() + (bar ? "l|" : "l").repeat(extra), safe: false, line: at.line, col: at.col };
}

export function tabular(p: Parser, sink: Sink, tok: Token, name: string): void {
  if (name !== "tabular" && name !== "longtable") p.readArgRaw(tok); // width of tabular*, tabularx, tabulary
  p.readOptRaw();
  const specArg = p.readArgRaw(tok);
  const cols = parseColSpec(specArg?.text ?? "");
  // A longtable is its own float: it takes \caption and \label directly.
  const target: Target | null = name === "longtable" ? { kind: "table" } : null;
  if (target) p.targets.push(target);
  const o: Open = { kind: "env", name, tok };
  const saved = p.decls;
  p.decls = saved.slice();
  p.open.push(o);

  let rows: TableCell[][] = [];
  const rules: { at: number; kind: string }[] = [];
  let head: TableCell[][] | undefined;
  let foot: TableCell[][] | undefined;
  let mark = 0;
  for (;;) {
    p.skipWhite();
    if (p.checkStop()) break;
    const t = p.toks[p.i];
    if (t.type === "cmd" && RULES.has(t.value)) {
      p.i++;
      skipRule(p, t);
      rules.push({ at: rows.length, kind: t.value });
      continue;
    }
    if (t.type === "cmd" && LONGTABLE_MARKS.has(t.value)) {
      p.i++;
      const part = rows.splice(mark);
      if (t.value === "endfirsthead" || (t.value === "endhead" && !head)) head = part;
      else if (t.value === "endlastfoot" || (t.value === "endfoot" && !foot)) foot = part;
      mark = rows.length;
      continue;
    }
    const cells = parseRow(p);
    // LaTeX stops with "Extra alignment tab"; here the row is kept and the problem reported.
    const width = cells.reduce((n, c) => n + (c.colspan ?? 1), 0);
    if (cols.length && width > cols.length && cells.slice(cols.length).some((c) => !isEmptyCell(c)))
      p.diag("TBL001", `Table row has ${width} cells but the column spec has ${cols.length} columns`, t, `Remove the extra & or add a column to the spec`, widerSpec(p, specArg, width - cols.length));
    if (!(cells.length === 1 && isEmptyCell(cells[0]))) rows.push(cells);
  }
  p.closeOpen(o);
  p.decls = saved;
  if (target) p.targets.pop();

  removeCovered(rows);
  if (head) removeCovered(head);
  let headRows = 0;
  if (!head) {
    // Rows before the first \midrule are the header; an \hline marks one only after a row or two,
    // since it also separates groups of rows. A \multirow that crosses the rule keeps it in the body.
    const split = rules.find((r) => r.kind === "midrule" && r.at > 0) ?? rules.find((r) => r.kind === "hline" && r.at > 0 && r.at <= 2);
    const crosses = (at: number) => rows.slice(0, at).some((r, k) => r.some((c) => (c.rowspan ?? 1) > at - k));
    if (split && split.at < rows.length && !crosses(split.at)) {
      head = rows.slice(0, split.at);
      rows = rows.slice(split.at);
      headRows = split.at;
    }
  }
  // Full-width rules between body rows (\hline or \midrule separating groups) are kept.
  const inner = [...new Set(rules.filter((r) => /^(hline|midrule|specialrule)$/.test(r.kind)).map((r) => r.at - headRows))].filter((k) => k > 0 && k < rows.length);
  const node: TableBlock = { t: "Table", align: cols.map((c) => c.align), head: head ?? [], body: rows, plainHead: true, pos: p.pos(tok) };
  const widths = widthsOf(cols);
  if (widths) node.widths = widths;
  if (foot?.length) node.foot = foot;
  if (inner.length) node.rules = inner;
  if (target?.caption) node.caption = target.caption;
  if (target?.label) {
    node.label = target.label;
    node.id = slugify(target.label);
  }
  p.block(sink, node);
}
