/** Reference list entries in the author-year (APA/Chicago-like) style. */

import type { Inline } from "../ast.js";
import {
  NBSP,
  chain,
  creators,
  doiUrl,
  editionLabel,
  editorLabel,
  emph,
  formatDate,
  italicTitle,
  link,
  nameList,
  pageRange,
  piece,
  richText,
  stripPeriod,
  text,
  type Piece,
} from "./format.js";
import type { BibEntry } from "./types.js";

const MAX_NAMES = 10;

/** `year` is the citation year label, with any disambiguating letter ("2020a"). */
export function authorYearReference(e: BibEntry, year: string): Inline[] {
  if (e.formatted) return e.formatted;
  const p = (content: Inline[] | undefined, extra?: Partial<Piece>): Piece | undefined => content && { content, before: ". ", ...extra };
  const s = (value: string | undefined): Piece | undefined => piece(value, ". ");

  const title = e.title ? richText(stripPeriod(e.title)) : undefined;
  const titlePiece = title && (italicTitle(e.type, "author-year") ? p([emph(title)]) : p(title, { quoted: true }));
  const head = creators(e);
  const names = head && nameList(head.names, MAX_NAMES, true) + (head.editors ? `, ${editorLabel(head.names, false)}` : "");
  // Without names the title moves to the front.
  const lead = names ? s(names) : titlePiece;
  const container = e["container-title"] ? richText(e["container-title"]) : undefined;
  const placePublisher = s([e["publisher-place"], e.publisher].filter(Boolean).join(": "));
  const edition = e.edition ? editionLabel(e.edition) : undefined;

  const body: (Piece | undefined)[] = [lead, s(year), names ? titlePiece : undefined];
  switch (e.type) {
    case "article-journal":
    case "article-magazine":
    case "article-newspaper":
    case "article":
      body.push(p(journalBlock(e, container)));
      break;
    case "book":
    case "periodical":
      body.push(s(edition), placePublisher);
      break;
    case "chapter":
    case "entry-encyclopedia":
    case "entry-dictionary":
    case "paper-conference": {
      const parts = [
        edition,
        e.editor?.length ? `edited by ${nameList(e.editor, MAX_NAMES, false)}` : undefined,
        e.page ? pageRange(e.page) : undefined,
      ].filter(Boolean);
      const tail = parts.length > 0 ? `, ${parts.join(", ")}` : "";
      body.push(container ? p([text("In "), emph(container), text(tail)]) : s(parts.join(", ")), placePublisher);
      break;
    }
    case "thesis":
      body.push(s([e.genre ?? "Thesis", e.publisher].filter(Boolean).join(", ")));
      break;
    case "report": {
      const genre = e.genre ?? "Tech. Rep.";
      body.push(s(e.number ? `${genre}${NBSP}${e.number}` : genre), placePublisher);
      break;
    }
    default:
      body.push(p(container), placePublisher, s(e.number));
  }
  body.push(s(e.note));

  if (e.DOI) body.push(p([link(doiUrl(e.DOI), [text(doiUrl(e.DOI))])]));
  else if (e.URL) {
    const accessed = formatDate(e.accessed, true);
    body.push(s(accessed && `Accessed ${accessed}`), p([link(e.URL, [text(e.URL)])]));
  }
  return chain(body, ".");
}

/** "*Journal* 3 (2): 10–20" */
function journalBlock(e: BibEntry, container: Inline[] | undefined): Inline[] | undefined {
  let rest = "";
  if (e.volume) rest += ` ${e.volume}`;
  if (e.issue) rest += e.volume ? ` (${e.issue})` : `, no. ${e.issue}`;
  if (e.page) rest += (e.volume || e.issue ? ": " : ", ") + pageRange(e.page);
  if (!container) rest = rest.replace(/^[\s,:]+/, "");
  const out: Inline[] = container ? [emph(container)] : [];
  if (rest) out.push(text(rest));
  return out.length > 0 ? out : undefined;
}
