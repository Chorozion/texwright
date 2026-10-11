/** JSON input: a texwright document tree, validated against the schema. */

import { type Document, emptyDocument } from "../ast.js";
import { offsetToPos } from "../diagnostics.js";
import { validateDocument } from "../schema.js";
import type { ParseContext } from "./context.js";

const MAX_JSON_DEPTH = 400;

/** Nesting depth of a JSON value, computed without recursion. */
function maxDepth(value: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop()!;
    if (d > max) max = d;
    if (d > MAX_JSON_DEPTH) return d;
    if (v && typeof v === "object") for (const child of Object.values(v as object)) stack.push([child, d + 1]);
  }
  return max;
}

export function parseJsonDocument(text: string, ctx: ParseContext): Document {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const message = (e as Error).message;
    const at = /position (\d+)/.exec(message);
    const pos = at ? offsetToPos(text, Number(at[1]), ctx.file) : ctx.file ? { file: ctx.file } : undefined;
    ctx.diagnostics.add("JSON001", `Not valid JSON: ${message}`, pos);
    return emptyDocument();
  }
  // Validation and every later stage recurse through the tree; refuse absurd nesting up front.
  const depth = maxDepth(data);
  if (depth > MAX_JSON_DEPTH) {
    ctx.diagnostics.add("JSON001", `Document nests ${depth} levels deep; the limit is ${MAX_JSON_DEPTH}`, ctx.file ? { file: ctx.file } : undefined);
    return emptyDocument();
  }
  // Accept a bare block list as a convenience for agents.
  if (Array.isArray(data)) data = { texwright: 1, meta: {}, blocks: data };
  if (data && typeof data === "object" && !("texwright" in data)) data = { texwright: 1, meta: {}, ...(data as object) };
  const result = validateDocument(data, 25);
  if (!result.ok) {
    for (const issue of result.issues) {
      ctx.diagnostics.add("JSON001", `${issue.path || "(root)"}: ${issue.message}`, ctx.file ? { file: ctx.file } : undefined, {
        hint: "Run `texwright schema` for the document format",
      });
    }
    return emptyDocument();
  }
  return result.document;
}
