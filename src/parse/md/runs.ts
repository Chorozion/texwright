/**
 * Small operations on runs of inline nodes, shared by the reader and the
 * passes over the finished tree.
 */
import type { Inline } from "../../ast.js";

/** Append `node`, joining it to a Text that ends the run. */
export function pushInline(out: Inline[], node: Inline): void {
  const last = out[out.length - 1];
  if (node.t === "Text" && last && last.t === "Text") out[out.length - 1] = { t: "Text", text: last.text + node.text };
  else out.push(node);
}

const isBreak = (n: Inline): boolean => n.t === "SoftBreak" || n.t === "LineBreak";

/**
 * Drop blank space and line breaks at both ends of a run, as paragraphs,
 * headings, table cells and captions have them. JavaScript's notion of
 * blank space is used, so a leading no-break space goes too.
 */
export function trimInlines(run: Inline[]): Inline[] {
  let start = 0;
  let end = run.length;
  let head: Inline | undefined;
  let tail: Inline | undefined;
  for (; start < end; start++) {
    const n = run[start];
    if (isBreak(n)) continue;
    if (n.t !== "Text") break;
    const text = n.text.trimStart();
    if (text) {
      if (text !== n.text) head = { t: "Text", text };
      break;
    }
  }
  for (; end > start; end--) {
    const n = end - 1 === start && head ? head : run[end - 1];
    if (isBreak(n)) continue;
    if (n.t !== "Text") break;
    const text = n.text.trimEnd();
    if (text) {
      if (text !== n.text) tail = { t: "Text", text };
      break;
    }
  }
  if (!head && !tail && start === 0 && end === run.length) return run;
  const out = run.slice(start, end);
  if (head) out[0] = head;
  if (tail) out[out.length - 1] = tail;
  return out;
}
