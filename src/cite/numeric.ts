/** Reference list entries in the numeric (IEEE-like) style. */

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
  pagesLabel,
  piece,
  richText,
  stripPeriod,
  text,
  type Piece,
} from "./format.js";
import type { BibEntry, Name } from "./types.js";

const MAX_NAMES = 6;

const names = (list: Name[]): string => nameList(list, MAX_NAMES, false);

export function numericReference(e: BibEntry): Inline[] {
  if (e.formatted) return e.formatted;
  const title = e.title ? richText(stripPeriod(e.title)) : undefined;
  const quotedTitle: Piece | undefined = title && { content: title, quoted: true };
  const container = e["container-title"] ? richText(e["container-title"]) : undefined;
  const inContainer: Piece | undefined = container && { content: [text("in "), emph(container)] };
  const place = e["publisher-place"];
  const placePublisher = piece([place, e.publisher].filter(Boolean).join(": "), ". ");
  const edition = piece(e.edition && editionLabel(e.edition));
  const date = piece(formatDate(e.issued, false));
  const pages = piece(e.page && pagesLabel(e.page));
  const editors = piece(e.editor?.length ? `${names(e.editor)}, ${editorLabel(e.editor, true)}` : undefined);
  const note = piece(e.note);

  let body: (Piece | undefined)[];
  switch (e.type) {
    case "article-journal":
    case "article-magazine":
    case "article-newspaper":
    case "article":
      body = [
        authors(e),
        quotedTitle,
        container && { content: [emph(container)] },
        piece(e.volume && `vol.${NBSP}${e.volume}`),
        piece(e.issue && `no.${NBSP}${e.issue}`),
        pages,
        date,
      ];
      break;
    case "book":
    case "periodical":
      body = [authors(e), title && { content: [emph(title)] }, edition, placePublisher, date];
      break;
    case "chapter":
    case "entry-encyclopedia":
    case "entry-dictionary":
      body = [authors(e), quotedTitle, inContainer, edition, editors, placePublisher, date, pages];
      break;
    case "paper-conference":
      body = [authors(e), quotedTitle, inContainer, piece(place ?? (typeof e["event-place"] === "string" ? e["event-place"] : undefined)), date, pages];
      break;
    case "thesis":
      body = [authors(e), quotedTitle, piece(e.genre ?? "Thesis"), piece(e.publisher), piece(place), date];
      break;
    case "report": {
      const genre = e.genre ?? "Tech. Rep.";
      body = [authors(e), quotedTitle, piece(e.publisher), piece(place), piece(e.number ? `${genre}${NBSP}${e.number}` : genre), date];
      break;
    }
    default:
      body = [
        authors(e),
        italicTitle(e.type, "numeric") && title ? { content: [emph(title)] } : quotedTitle,
        container && { content: container },
        piece(e.publisher),
        piece(e.number),
        date,
      ];
  }
  body.push(note);

  if (e.DOI) return chain([...body, { content: [text("doi: "), link(doiUrl(e.DOI), [text(e.DOI)])] }], ".");
  if (e.URL) {
    const accessed = formatDate(e.accessed, false);
    return chain(
      [
        ...body,
        piece(accessed && `Accessed: ${accessed}`, ". "),
        { content: [text("[Online]. Available: "), link(e.URL, [text(e.URL)])], before: ". " },
      ],
      "",
    );
  }
  return chain(body, ".");
}

/** "A. Doe and C. Roe", or "E. Editor, Ed." for an edited work. */
function authors(e: BibEntry): Piece | undefined {
  const head = creators(e);
  return head && piece(head.editors ? `${names(head.names)}, ${editorLabel(head.names, true)}` : names(head.names));
}
