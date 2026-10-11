/**
 * Bibliography records in CSL-JSON shape. Both the BibTeX and the CSL-JSON
 * readers produce these, and the citation processor formats them.
 *
 * Text fields are plain Unicode. Title-like fields (title, container-title,
 * collection-title, event-title, title-short) may carry CSL rich-text markup:
 * <i>, <b>, <sup>, <sub>, <span style="font-variant:small-caps;">,
 * <span class="nocase"> and $...$ for math.
 */

import type { Inline } from "../ast.js";

export interface Name {
  family?: string;
  given?: string;
  /** Institutional or single-string names, used verbatim. "others" marks an et al. */
  literal?: string;
  "non-dropping-particle"?: string;
  "dropping-particle"?: string;
  suffix?: string;
}

export interface DateParts {
  /** [[year, month?, day?]]; a second inner array (a range end) is ignored when formatting. */
  "date-parts"?: number[][];
  literal?: string;
  raw?: string;
}

export interface BibEntry {
  id: string;
  type: string;
  /** The reference as written by hand (thebibliography); printed as is. */
  formatted?: Inline[];
  title?: string;
  author?: Name[];
  editor?: Name[];
  issued?: DateParts;
  "container-title"?: string;
  "collection-title"?: string;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  "publisher-place"?: string;
  edition?: string;
  DOI?: string;
  URL?: string;
  ISBN?: string;
  ISSN?: string;
  note?: string;
  genre?: string;
  "event-title"?: string;
  accessed?: DateParts;
  number?: string;
  [key: string]: unknown;
}
