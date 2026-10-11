/**
 * Citations: load the bibliography files named in the metadata, format every
 * citation in document order, and collect the bibliography.
 */

import { extname } from "node:path";
import { type Document, type Inline, plainText } from "../ast.js";
import { type BibEntry, createCiteProcessor, parseBibtex, parseCslJson } from "../cite/index.js";
import type { Diagnostics } from "../diagnostics.js";
import type { CitationOutput } from "../write/html.js";
import { allInlines } from "./numbering.js";

export interface BibSource {
  /** Name as given in the metadata, for diagnostics. */
  name: string;
  text: string | undefined;
}

export function processCitations(
  doc: Document,
  sources: BibSource[],
  diagnostics: Diagnostics,
): CitationOutput {
  const cites: Extract<Inline, { t: "Cite" }>[] = [];
  allInlines(doc, (i) => {
    if (i.t === "Cite") cites.push(i);
  });
  const rendered = new WeakMap<object, Inline[]>();
  // Reference lists written out by hand (thebibliography) count as entries, listed in their order.
  const manual: BibEntry[] = [];
  for (const b of doc.blocks) {
    if (b.t === "Bibliography" && b.items) for (const it of b.items) manual.push({ id: it.key, type: "manual", formatted: it.content });
  }
  if (!cites.length && !sources.length && !manual.length) return { rendered, bibliography: [] };

  const entries: BibEntry[] = [...manual];
  for (const src of sources) {
    if (src.text === undefined) {
      diagnostics.add("IO001", `Bibliography file not found: ${src.name}`, undefined, { hint: "Paths are relative to the input file" });
      continue;
    }
    const json = extname(src.name).toLowerCase() === ".json" || /^\s*[[{]/.test(src.text);
    const parsed = json ? parseCslJson(src.text, { file: src.name, diagnostics }) : parseBibtex(src.text, { file: src.name, diagnostics });
    entries.push(...parsed);
  }

  if (cites.length && !sources.length && !manual.length) {
    diagnostics.add("CITE002", `${cites.length} citation${cites.length > 1 ? "s" : ""} but no bibliography file`, cites[0]?.pos, {
      hint: "Add `bibliography: refs.bib` to the front matter, \\bibliography{refs} to LaTeX, or pass --bibliography refs.bib",
    });
  }

  // A hand-written list has no authors or years to cite by, so it is always numbered.
  const style = manual.length && !sources.length ? "numeric" : (doc.meta.citationStyle ?? "numeric");
  const processor = createCiteProcessor(entries, style, diagnostics);
  for (const c of cites) rendered.set(c, processor.cite(c));
  const bibliography = processor.bibliography();
  // pandoc's habit: the document ends with an empty "# References" heading, and the list goes under it.
  if (bibliography.length && !doc.blocks.some((b) => b.t === "Bibliography")) {
    const last = doc.blocks[doc.blocks.length - 1];
    if (last?.t === "Heading" && REFERENCE_TITLES.test(plainText(last.content).trim())) doc.blocks.push(last.pos ? { t: "Bibliography", pos: last.pos } : { t: "Bibliography" });
  }
  return { rendered, bibliography };
}

const REFERENCE_TITLES = /^(?:[\d.]+\s+)?(?:references?|bibliography|works cited|literature cited|literature|sources|citations|reference list)$/i;
