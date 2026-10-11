/**
 * Starter documents: complete, valid examples of each common kind, so an
 * agent fills in a structure that already works instead of inventing one.
 * They live in the package's templates/ folder; `texwright new <kind>`
 * and the MCP tool `new_document` hand them out.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "./write/assets.js";

export interface TemplateInfo {
  kind: string;
  description: string;
  /** Other files the template refers to (written next to it). */
  assets: string[];
}

export const TEMPLATES: readonly TemplateInfo[] = [
  { kind: "paper", description: "Research paper: abstract, numbered sections, equations, theorem and proof, results table, citations", assets: ["refs.bib"] },
  { kind: "report", description: "Report: summary first, findings with a table, footnote, callout, recommendations, contents", assets: [] },
  { kind: "homework", description: "Problem set solutions: unnumbered problems, derivations, an induction proof, matrices", assets: [] },
  { kind: "notes", description: "Lecture notes: definitions, lemmas, theorems with proofs, examples, exercises", assets: [] },
  { kind: "cv", description: "One-page résumé (max-pages: 1, compact theme)", assets: [] },
  { kind: "letter", description: "Formal letter on one page: addresses, subject line, body, closing", assets: [] },
  { kind: "memo", description: "Decision memo: header table, decision needed, options table, next steps", assets: [] },
  { kind: "proposal", description: "Project proposal: problem, solution, timeline and budget tables, measures, risks", assets: [] },
];

/** A template's text and its asset files, or undefined for an unknown kind. */
export function template(kind: string): { text: string; assets: Record<string, string> } | undefined {
  const info = TEMPLATES.find((t) => t.kind === kind);
  if (!info) return undefined;
  const dir = join(packageRoot(), "templates");
  const file = join(dir, `${kind}.md`);
  if (!existsSync(file)) return undefined;
  const assets: Record<string, string> = {};
  for (const a of info.assets) assets[a] = readFileSync(join(dir, a), "utf8");
  return { text: readFileSync(file, "utf8"), assets };
}
