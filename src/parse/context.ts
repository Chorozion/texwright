import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Meta, Pos } from "../ast.js";
import { Diagnostics } from "../diagnostics.js";

export interface ParseContext {
  /** Name used in positions and diagnostics. */
  file?: string;
  /** Directory that relative paths (\input, images) resolve against. */
  baseDir: string;
  diagnostics: Diagnostics;
  /** Read a file relative to baseDir or absolute; undefined when missing. Injected so tests need no disk. */
  readFile(path: string): string | undefined;
  /** Added to every line number reported (raw LaTeX embedded in Markdown). */
  lineOffset?: number;
  /** Column added on the first line only (raw LaTeX that starts mid-line). */
  colOffset?: number;
  /**
   * Shared macro table (name with backslash -> body). When present, the LaTeX
   * parser expands macros already in it and records every new definition in
   * it, so raw LaTeX fragments in one Markdown file share \newcommand state.
   */
  macros?: Record<string, string>;
  /**
   * Metadata sink for raw LaTeX fragments in Markdown: \bibliography, \title,
   * \author and similar commands found in a fragment are merged into it.
   * Fields it already has are kept (front matter wins), except that
   * bibliography files and keywords are appended.
   */
  meta?: Meta;
}

/** A context that reads from disk. */
export function fileContext(file: string | undefined, diagnostics = new Diagnostics()): ParseContext {
  const baseDir = file ? dirname(resolve(file)) : process.cwd();
  return {
    file,
    baseDir,
    diagnostics,
    readFile(path: string) {
      try {
        return readFileSync(resolve(baseDir, path), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/** A context backed by an in-memory map of files, for tests and the MCP server. */
export function memoryContext(files: Record<string, string> = {}, file?: string, diagnostics = new Diagnostics()): ParseContext {
  return {
    file,
    baseDir: ".",
    diagnostics,
    readFile(path: string) {
      const norm = path.replace(/\\/g, "/").replace(/^\.\//, "");
      return files[norm] ?? files[path];
    },
  };
}

/** Apply a context's line/col offsets to a position. */
export function shiftPos(ctx: ParseContext, line: number, col: number): Pos {
  const pos: Pos = {
    line: line + (ctx.lineOffset ?? 0),
    col: line === 1 ? col + (ctx.colOffset ?? 0) : col,
  };
  if (ctx.file) pos.file = ctx.file;
  return pos;
}
