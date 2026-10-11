/**
 * Where each parsed entry came from, so later diagnostics (CITE004) can point
 * at the .bib line. Kept outside the entry objects so they stay plain CSL-JSON.
 */

import type { Pos } from "../ast.js";
import type { BibEntry } from "./types.js";

export type SourceRef = Pos | { file?: string };

const sources = new WeakMap<BibEntry, SourceRef>();

export function setEntrySource(entry: BibEntry, where: SourceRef): void {
  sources.set(entry, where);
}

export function entrySource(entry: BibEntry): SourceRef | undefined {
  return sources.get(entry);
}
