import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CiteItem, Inline } from "../src/ast.js";
import { Diagnostics } from "../src/diagnostics.js";
import { createCiteProcessor, parseBibtex, parseCslJson, type BibEntry } from "../src/cite/index.js";
import { latexToText } from "../src/cite/latex.js";
import { parseBibtexNames } from "../src/cite/names.js";

type CiteNode = Extract<Inline, { t: "Cite" }>;

/** Inlines as a string: Emph as *x*, Links as <url>, Math as $x$, no-break spaces as ~. */
function render(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      if (n.t === "Text") return n.text;
      if (n.t === "Emph") return `*${render(n.content)}*`;
      if (n.t === "Link") return `<${n.url}>`;
      if (n.t === "Math") return `$${n.tex}$`;
      return "content" in n && Array.isArray(n.content) ? render(n.content) : "";
    })
    .join("")
    .replace(/\u00a0/g, "~");
}

/** Citation inlines as a string: links show their text. */
function citeText(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      if (n.t === "Text") return n.text;
      if (n.t === "Emph") return `*${citeText(n.content)}*`;
      return "content" in n && Array.isArray(n.content) ? citeText(n.content) : "";
    })
    .join("")
    .replace(/\u00a0/g, "~");
}

function links(nodes: Inline[]): string[] {
  return nodes.flatMap((n) => (n.t === "Link" ? [n.url] : "content" in n && Array.isArray(n.content) ? links(n.content) : []));
}

const cite = (mode: CiteNode["mode"], ...items: (string | CiteItem)[]): CiteNode => ({
  t: "Cite",
  mode,
  items: items.map((i) => (typeof i === "string" ? { key: i } : i)),
});

function bib(text: string, file = "refs.bib"): { entries: BibEntry[]; diagnostics: Diagnostics } {
  const diagnostics = new Diagnostics();
  return { entries: parseBibtex(text, { file, diagnostics }), diagnostics };
}

const byId = (entries: BibEntry[], id: string): BibEntry => {
  const e = entries.find((x) => x.id === id);
  assert.ok(e, `entry ${id} exists`);
  return e;
};

// ------------------------------------------------------------------ fixtures

const REAL_BIB = String.raw`% Shared bibliography. Questions to maintainer@example.org
% Exported partly by hand, partly by a reference manager.

@string{ pr = "Physical Review" }
@STRING{jgr = {Journal of } # "Geophysical Research"}

@preamble{ "\newcommand{\noopsort}[1]{}" }

@comment{ Ignored, including @misc{fake, title = {Fake}} }

@article{godel1931,
  author    = {G{\"o}del, Kurt},
  title     = {{\"U}ber formal unentscheidbare S{\"a}tze der {Principia Mathematica} und verwandter {Systeme I}},
  journal   = {Monatshefte f{\"u}r Mathematik und Physik},
  volume    = 38,
  number    = 1,
  pages     = {173--198},
  year      = 1931,
  doi       = {https://doi.org/10.1007/BF01700692},
}

@ARTICLE{schrodinger1926,
  Author  = "Schr\"{o}dinger, Erwin",
  Title   = "An Undulatory Theory of the Mechanics of {Atoms} and Molecules",
  Journal = pr,
  Volume  = "28",
  Number  = "6",
  Pages   = "1049--1070",
  Month   = dec,
  Year    = "1926"
}

@book(lukasiewicz1957,
  author    = {{\L}ukasiewicz, Jan},
  title     = {Aristotle's Syllogistic from the Standpoint of Modern Formal Logic},
  publisher = {Clarendon Press},
  address   = {Oxford},
  edition   = 2,
  year      = {1957},
)

@inproceedings{angstrom2020,
  author    = {{\AA}ngstr{\"o}m, Anders and Doe, Jane and Roe, Richard},
  title     = {Spectral Lines Revisited},
  booktitle = {Proc. Int. Conf. Spectroscopy},
  address   = {Uppsala},
  publisher = {IEEE},
  pages     = {1--9},
  year      = 2020,
}

@incollection{beethoven1802,
  author    = {Ludwig van Beethoven},
  title     = {The {Heiligenstadt} Testament},
  booktitle = {Letters and Documents},
  editor    = {Emily Anderson and Max Unger},
  publisher = {Macmillan},
  address   = {London},
  pages     = {1--9},
  year      = 1802,
}

@book{fontaine1668,
  author    = {Jean de La Fontaine},
  title     = {Fables choisies, mises en vers},
  publisher = {Claude Barbin},
  address   = {Paris},
  year      = 1668,
}

@phdthesis{doe2019,
  author  = {Doe, Jane},
  title   = {Rings of Power: A Study},
  school  = {Massachusetts Institute of Technology},
  address = {Cambridge, MA},
  year    = 2019,
}

@mastersthesis{roe2018,
  author = {Roe, Richard},
  title  = {Minor Results},
  school = {ETH Z{\"u}rich},
  year   = 2018,
}

@techreport{who2021,
  author      = {{World Health Organization}},
  title       = {Global Tuberculosis Report},
  institution = {WHO},
  address     = {Geneva},
  number      = 42,
  year        = 2021,
}

@manual{rcore2023,
  title        = {R: A Language and Environment for Statistical Computing},
  organization = {R Foundation for Statistical Computing},
  address      = {Vienna, Austria},
  year         = 2023,
  url          = {https://www.R-project.org/},
}

@misc{hodgkin2022,
  author       = {Hodgkin, Alan and others},
  title        = {Spike Train Recordings},
  howpublished = {\url{https://example.org/spikes}},
  year         = 2022,
}

@online{martin2021,
  author  = {Mart{\'\i}n, Mar{\'\i}a and {\v S}im{\v c}i{\'c}, Petar},
  title   = {Writing \LaTeX\ in 2021 --- a survey},
  date    = {2021-03-15/2021-03-20},
  url     = {https://example.com/a\_b?q=1},
  urldate = {2022-01-02},
}

@article{smith2020,
  author       = {Smith, John and Jones, Mary},
  title        = {Modern {biblatex} Dates},
  journaltitle = jgr # ": Solid Earth",
  date         = {2020-03-15},
  volume       = {125},
  number       = {3},
  pages        = {e2019JB018000},
}

@article{broken2020,
  author = {Broken, Bob},
  title  = {Missing Comma}
  year   = 2020
}

@unpublished{poe2017,
  author = {Poe, Edgar Allan},
  title  = {The Raven, Revised.},
  note   = {Unpublished manuscript},
  year   = 2017,
}

@software{harris2020,
  author    = {Harris, Charles R. and Millman, K. Jarrod},
  title     = {NumPy},
  publisher = {Zenodo},
  year      = 2020,
  doi       = {10.5281/zenodo.1234},
}

@dataset{noaa2019,
  author    = {{National Oceanic and Atmospheric Administration}},
  title     = {Global Surface Temperature},
  publisher = {NOAA},
  year      = 2019,
  url       = {https://www.ncei.noaa.gov/},
}

@booklet{guide1999,
  title        = {Conference Survival Guide},
  howpublished = {Distributed at the conference},
  year         = 1999,
}

@misc{harris2020,
  title = {A duplicate key},
}
`;

/** One plain entry of each type, for exact formatting checks. */
const STYLE_BIB = String.raw`
@article{art, author = {Doe, Albert B. and Roe, Carl and Poe, Edgar}, title = {Title}, journal = {Journal},
  volume = 3, number = 2, pages = {10--20}, month = mar, year = 2020, doi = {10.x/y}}
@book{bk, author = {Doe, Albert B.}, title = {Title}, edition = {2}, address = {Place}, publisher = {Publisher}, year = 2020}
@inproceedings{conf, author = {Doe, Albert}, title = {Title}, booktitle = {Proc. Name}, address = {Place}, year = 2020, pages = {1--9}}
@incollection{chap, author = {Doe, Albert}, title = {Title}, booktitle = {Book}, editor = {Editor, Ernest},
  address = {Place}, publisher = {Publisher}, year = 2020, pages = {1--9}}
@phdthesis{thes, author = {Doe, Albert}, title = {Title}, school = {School}, address = {Place}, year = 2020}
@techreport{rep, author = {Doe, Albert}, title = {Title}, institution = {Publisher}, address = {Place}, number = 42, year = 2020}
@online{web, author = {Doe, Albert}, title = {Title}, organization = {Example Org}, year = 2020, url = {https://example.org/x}}
`;

const NUM_BIB = String.raw`
@article{doe2020, author = {Doe, Jane}, title = {Alpha}, journal = {J}, year = 2020}
@article{roe2019, author = {Roe, Richard and Doe, Jane}, title = {Beta}, journal = {J}, year = 2019}
@article{poe2018, author = {Poe, Edgar and Doe, Jane and Roe, Richard}, title = {Gamma}, journal = {J}, year = 2018}
@book{lee2017, author = {Lee, Kim}, title = {Delta}, year = 2017}
@book{kim2016, author = {Kim, Lee}, title = {Epsilon}, year = 2016}
@misc{extra1, title = {Extra One}, year = 2001}
@misc{extra2, title = {Extra Two}, year = 2002}
`;

// ------------------------------------------------------------------ LaTeX to Unicode

describe("LaTeX field values", () => {
  it("converts accents in all common spellings", () => {
    assert.equal(latexToText(String.raw`G{\"o}del`), "Gödel");
    assert.equal(latexToText(String.raw`Schr\"{o}dinger`), "Schrödinger");
    assert.equal(latexToText(String.raw`Schr\"odinger`), "Schrödinger");
    assert.equal(latexToText(String.raw`{\AA}ngstr{\"o}m`), "Ångström");
    assert.equal(latexToText(String.raw`{\L}ukasiewicz`), "Łukasiewicz");
    assert.equal(
      latexToText(String.raw`\'e \'{e} {\'e} \`a \^a \~n \=a \u{a} \H{o} \k{a} \r{a} \c{c} \c c \v{s} \.{z}`),
      "é é é à â ñ ā ă ő ą å ç ç š ż",
    );
    assert.equal(latexToText(String.raw`Mar{\'\i}a \'{\i}`), "María í");
    assert.equal(latexToText(String.raw`{\ss} {\o} {\O} {\aa} {\ae} {\AE} {\oe} {\l}`), "ß ø Ø å æ Æ œ ł");
    assert.equal(latexToText(String.raw`Stra\ss e`), "Straße");
  });

  it("unescapes specials and converts dashes, ties and quotes", () => {
    assert.equal(latexToText(String.raw`R\&D 50\% \$5 a\_b \#1`), "R&D 50% $5 a_b #1");
    assert.equal(latexToText("pages 10--20 and a---b"), "pages 10–20 and a—b");
    assert.equal(latexToText("A.~Doe"), "A.\u00a0Doe");
    assert.equal(latexToText("``quoted'' and it's"), "“quoted” and it’s");
  });

  it("strips formatting and protective braces, keeps math and normalizes space", () => {
    assert.equal(latexToText(String.raw`\textit{x} and \emph{y} and {\em z} and \textbf{w}`), "x and y and z and w");
    assert.equal(latexToText("{Protected} {{Double}}  words\n\tnext"), "Protected Double words next");
    assert.equal(latexToText(String.raw`The $E = mc^2$ relation`), "The $E = mc^2$ relation");
    assert.equal(latexToText(String.raw`see \url{https://x.org/a_b--c}`), "see https://x.org/a_b--c");
    assert.equal(latexToText(String.raw`{\noopsort{a}}Zed \unknown{kept}`), "Zed kept");
  });

  it("keeps italics as CSL rich text in rich mode", () => {
    assert.equal(latexToText(String.raw`The \emph{Drosophila} {\em gene} \textsc{Caps}`, true), 'The <i>Drosophila</i> <i>gene</i> <span style="font-variant:small-caps;">Caps</span>');
  });
});

// ------------------------------------------------------------------ names

describe("BibTeX names", () => {
  it("splits on 'and' outside braces, in any case", () => {
    assert.deepEqual(parseBibtexNames("Doe, Jane AND Roe, Richard"), [
      { family: "Doe", given: "Jane" },
      { family: "Roe", given: "Richard" },
    ]);
    assert.deepEqual(parseBibtexNames("{Barnes and Noble, Inc.} and Doe, J."), [{ literal: "Barnes and Noble, Inc." }, { family: "Doe", given: "J." }]);
  });

  it("finds von parts in both name orders", () => {
    assert.deepEqual(parseBibtexNames("Ludwig van Beethoven"), [{ family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" }]);
    assert.deepEqual(parseBibtexNames("Jean de La Fontaine"), [{ family: "La Fontaine", given: "Jean", "non-dropping-particle": "de" }]);
    assert.deepEqual(parseBibtexNames("de La Fontaine, Jean"), [{ family: "La Fontaine", given: "Jean", "non-dropping-particle": "de" }]);
  });

  it("handles Jr parts, corporate names, others and single names", () => {
    assert.deepEqual(parseBibtexNames("Doe, Jr., John"), [{ family: "Doe", given: "John", suffix: "Jr." }]);
    assert.deepEqual(parseBibtexNames("{World Health Organization}"), [{ literal: "World Health Organization" }]);
    assert.deepEqual(parseBibtexNames("Hodgkin, Alan and others"), [{ family: "Hodgkin", given: "Alan" }, { literal: "others" }]);
    assert.deepEqual(parseBibtexNames("Plato"), [{ family: "Plato" }]);
    assert.deepEqual(parseBibtexNames(String.raw`{\'E}mile Zola`), [{ family: "Zola", given: "Émile" }]);
  });
});

// ------------------------------------------------------------------ BibTeX parser

describe("BibTeX parser on a realistic file", () => {
  const { entries, diagnostics } = bib(REAL_BIB);

  it("reads every valid entry, skipping the broken one and the duplicate", () => {
    assert.deepEqual(
      entries.map((e) => e.id),
      [
        "godel1931",
        "schrodinger1926",
        "lukasiewicz1957",
        "angstrom2020",
        "beethoven1802",
        "fontaine1668",
        "doe2019",
        "roe2018",
        "who2021",
        "rcore2023",
        "hodgkin2022",
        "martin2021",
        "smith2020",
        "poe2017",
        "harris2020",
        "noaa2019",
        "guide1999",
      ],
    );
  });

  it("reports the malformed entry on the right line and keeps going", () => {
    const lines = REAL_BIB.split("\n");
    const expectedLine = lines.findIndex((l) => l.includes("{Missing Comma}")) + 2;
    const err = diagnostics.errors;
    assert.equal(err.length, 1);
    assert.equal(err[0].code, "CITE003");
    assert.equal(err[0].line, expectedLine);
    assert.equal(err[0].col, 3);
    assert.equal(err[0].file, "refs.bib");
    assert.match(err[0].message, /after field "title" in entry "broken2020"/);
    assert.match(err[0].hint ?? "", /comma/);
    assert.equal(err[0].excerpt, "  year   = 2020");
    assert.equal(byId(entries, "poe2017").title, "The Raven, Revised.");
  });

  it("keeps the first of two entries with the same key and warns", () => {
    const dup = diagnostics.warnings.filter((d) => d.code === "CITE003");
    assert.equal(dup.length, 1);
    assert.match(dup[0].message, /Duplicate entry key "harris2020"/);
    assert.equal(byId(entries, "harris2020").title, "NumPy");
  });

  it("ignores @comment, @preamble and free text", () => {
    assert.ok(!entries.some((e) => e.id === "fake"));
  });

  it("maps types to CSL", () => {
    const types = Object.fromEntries(entries.map((e) => [e.id, e.type]));
    assert.equal(types.godel1931, "article-journal");
    assert.equal(types.lukasiewicz1957, "book");
    assert.equal(types.angstrom2020, "paper-conference");
    assert.equal(types.beethoven1802, "chapter");
    assert.equal(types.doe2019, "thesis");
    assert.equal(types.who2021, "report");
    assert.equal(types.rcore2023, "report");
    assert.equal(types.hodgkin2022, "document");
    assert.equal(types.martin2021, "webpage");
    assert.equal(types.poe2017, "manuscript");
    assert.equal(types.harris2020, "software");
    assert.equal(types.noaa2019, "dataset");
    assert.equal(types.guide1999, "pamphlet");
  });

  it("converts accents in titles, names and containers without changing case", () => {
    const godel = byId(entries, "godel1931");
    assert.equal(godel.title, "Über formal unentscheidbare Sätze der Principia Mathematica und verwandter Systeme I");
    assert.equal(godel.author?.[0].family, "Gödel");
    assert.equal(godel["container-title"], "Monatshefte für Mathematik und Physik");
    assert.equal(byId(entries, "schrodinger1926").author?.[0].family, "Schrödinger");
    assert.equal(byId(entries, "angstrom2020").author?.[0].family, "Ångström");
    assert.equal(byId(entries, "lukasiewicz1957").author?.[0].family, "Łukasiewicz");
    assert.equal(byId(entries, "lukasiewicz1957").title, "Aristotle’s Syllogistic from the Standpoint of Modern Formal Logic");
    assert.deepEqual(byId(entries, "martin2021").author, [
      { family: "Martín", given: "María" },
      { family: "Šimčić", given: "Petar" },
    ]);
    assert.equal(byId(entries, "martin2021").title, "Writing LaTeX in 2021 — a survey");
    assert.equal(byId(entries, "smith2020").title, "Modern biblatex Dates");
  });

  it("expands @string macros, # concatenation and month macros", () => {
    assert.equal(byId(entries, "schrodinger1926")["container-title"], "Physical Review");
    assert.deepEqual(byId(entries, "schrodinger1926").issued, { "date-parts": [[1926, 12]] });
    assert.equal(byId(entries, "smith2020")["container-title"], "Journal of Geophysical Research: Solid Earth");
  });

  it("maps fields to CSL names", () => {
    const godel = byId(entries, "godel1931");
    assert.equal(godel.DOI, "10.1007/BF01700692");
    assert.equal(godel.page, "173–198");
    assert.equal(godel.volume, "38");
    assert.equal(godel.issue, "1");
    assert.equal(byId(entries, "who2021").number, "42");
    assert.equal(byId(entries, "who2021").issue, undefined);
    assert.deepEqual(byId(entries, "who2021").author, [{ literal: "World Health Organization" }]);
    const thesis = byId(entries, "doe2019");
    assert.equal(thesis.publisher, "Massachusetts Institute of Technology");
    assert.equal(thesis["publisher-place"], "Cambridge, MA");
    assert.equal(thesis.genre, "PhD thesis");
    assert.equal(byId(entries, "roe2018").genre, "Master’s thesis");
    const manual = byId(entries, "rcore2023");
    assert.equal(manual.genre, "Manual");
    assert.equal(manual.publisher, "R Foundation for Statistical Computing");
    assert.equal(manual.URL, "https://www.R-project.org/");
    assert.equal(byId(entries, "lukasiewicz1957").edition, "2");
    assert.deepEqual(byId(entries, "beethoven1802").editor, [
      { family: "Anderson", given: "Emily" },
      { family: "Unger", given: "Max" },
    ]);
    assert.equal(byId(entries, "beethoven1802")["container-title"], "Letters and Documents");
  });

  it("reads biblatex dates, journaltitle, urls and howpublished", () => {
    const smith = byId(entries, "smith2020");
    assert.deepEqual(smith.issued, { "date-parts": [[2020, 3, 15]] });
    assert.equal(smith.issue, "3");
    const martin = byId(entries, "martin2021");
    assert.deepEqual(martin.issued, { "date-parts": [[2021, 3, 15]] });
    assert.deepEqual(martin.accessed, { "date-parts": [[2022, 1, 2]] });
    assert.equal(martin.URL, "https://example.com/a_b?q=1");
    assert.equal(byId(entries, "hodgkin2022").URL, "https://example.org/spikes");
    assert.equal(byId(entries, "hodgkin2022").note, undefined);
    assert.equal(byId(entries, "guide1999").note, "Distributed at the conference");
    assert.deepEqual(byId(entries, "hodgkin2022").author?.[1], { literal: "others" });
  });
});

describe("BibTeX parser recovery and edge cases", () => {
  it("recovers from an unclosed brace and reports where it opened", () => {
    const { entries, diagnostics } = bib("@article{a, title = {Never closed\n@book{b, title = {B}, year = 2000}\n");
    assert.deepEqual(
      entries.map((e) => e.id),
      ["b"],
    );
    assert.equal(diagnostics.errors.length, 1);
    assert.match(diagnostics.errors[0].message, /Unclosed "\{" in field "title" of entry "a"/);
    assert.deepEqual([diagnostics.errors[0].line, diagnostics.errors[0].col], [1, 21]);
  });

  it("reports a missing key, an unknown macro and a duplicate field", () => {
    const { entries, diagnostics } = bib("@article{, title = {x}}\n@misc{m, title = {T}, title = {Again}, publisher = acm, year = 2001}");
    assert.deepEqual(
      entries.map((e) => e.id),
      ["m"],
    );
    assert.equal(byId(entries, "m").title, "T");
    assert.equal(byId(entries, "m").publisher, undefined);
    const messages = diagnostics.items.map((d) => `${d.severity}:${d.message}`);
    assert.ok(messages.includes("error:@article entry has no citation key"), messages.join("\n"));
    assert.ok(messages.some((m) => m.startsWith('warning:Undefined @string macro "acm"')));
    assert.ok(messages.some((m) => m.startsWith('warning:Field "title" appears twice')));
  });

  it("accepts quotes with braces inside, % comments, trailing commas and a BOM", () => {
    const source = String.raw`@misc{q,
  % a comment between fields
  title = "The {"}Quoted{"} Word",
  author = "G\"odel, Kurt",
  year = 2000,,
}
`;
    const { entries, diagnostics } = bib(String.fromCharCode(0xfeff) + source);
    assert.equal(diagnostics.items.length, 0);
    assert.equal(byId(entries, "q").title, 'The "Quoted" Word');
    assert.deepEqual(byId(entries, "q").author, [{ family: "Gödel", given: "Kurt" }]);
  });

  it("inherits fields through crossref", () => {
    const { entries } = bib(String.raw`
@inproceedings{paper, author = {Doe, Jane}, title = {A Paper}, pages = {1--5}, crossref = {conf2020}}
@proceedings{conf2020, title = {Proceedings of Conf 2020}, editor = {Roe, Richard}, publisher = {ACM}, year = 2020, doi = {10.1/volume}}
`);
    const paper = byId(entries, "paper");
    assert.equal(paper["container-title"], "Proceedings of Conf 2020");
    assert.equal(paper.publisher, "ACM");
    assert.deepEqual(paper.issued, { "date-parts": [[2020]] });
    assert.equal(paper.title, "A Paper");
    assert.equal(paper.DOI, undefined);
  });

  it("maps arXiv eprints and non-numeric years", () => {
    const { entries } = bib("@misc{ax, title = {Preprint}, eprint = {2101.00001}, archivePrefix = {arXiv}, year = {in press}}");
    const ax = byId(entries, "ax");
    assert.equal(ax.URL, "https://arxiv.org/abs/2101.00001");
    assert.equal(ax.number, "arXiv:2101.00001");
    assert.deepEqual(ax.issued, { literal: "in press" });
  });

  it("reports each unclosed value and keeps reading after it", () => {
    const { entries, diagnostics } = bib('@a{x, t = {one\n@a{y, t = "two\n@a{z, t = {Three}}\n@comment{never closed\n@a{w, t = {Four}}');
    assert.deepEqual(entries.map((e) => e.id), ["z", "w"]);
    assert.deepEqual(diagnostics.errors.map((d) => d.line), [1, 2]);
  });

  it("finds the closing quote past quotes that braces protect", () => {
    const { entries } = bib('@a{q, title = "x {"} y" # " z"}');
    assert.equal(byId(entries, "q").title, 'x " y z');
  });

  it("stops @string macros that double at every step", () => {
    let source = "@string{s0 = {lol}}\n";
    for (let k = 0; k < 30; k++) source += `@string{s${k + 1} = s${k} # s${k}}\n`;
    const { entries, diagnostics } = bib(source + "@misc{a, title = s30, year = 2000}");
    assert.ok(diagnostics.errors.some((d) => /@string macros expand to more than/.test(d.message)));
    assert.ok(String(byId(entries, "a").title ?? "").length <= 1_000_000);
  });

  it("converts deeply nested braces and long chains of font switches", () => {
    assert.equal(latexToText("{".repeat(20000) + "x" + "}".repeat(20000)), "x");
    assert.equal(latexToText("\\em ".repeat(20000) + "x"), "x");
    assert.equal(latexToText("\\emph".repeat(20000) + "{x}"), "x");
    assert.equal(latexToText("{\\em a {\\bf b}}", true), "<i>a <b>b</b></i>");
  });

  it("splits names on 'and' after long runs of spaces", () => {
    assert.deepEqual(
      parseBibtexNames(`Doe, J.${" ".repeat(50000)}and${" ".repeat(10)}Roe, R.`).map((n) => n.family),
      ["Doe", "Roe"],
    );
  });
});

// ------------------------------------------------------------------ CSL-JSON

describe("CSL-JSON parser", () => {
  const json = JSON.stringify([
    { id: "a", type: "article-journal", title: "The <i>E. coli</i> Genome", author: [{ family: "Doe", given: "Jane" }], issued: { "date-parts": [["2020", "3"]] }, volume: 4 },
    { id: 7, type: "book", title: "Numbered", author: ["Acme Corp."], issued: { raw: "2019-05-01" } },
    { id: "lit", type: "webpage", title: "Literal date", issued: { literal: "Spring 2018" } },
    { title: "No id" },
    { id: "notype", title: "No type", issued: "2001" },
  ]);

  it("reads items, normalizes dates, numbers and names, and reports bad items", () => {
    const diagnostics = new Diagnostics();
    const entries = parseCslJson(json, { file: "refs.json", diagnostics });
    assert.deepEqual(
      entries.map((e) => e.id),
      ["a", "7", "lit", "notype"],
    );
    assert.deepEqual(byId(entries, "a").issued, { "date-parts": [[2020, 3]] });
    assert.equal(byId(entries, "a").volume, "4");
    assert.deepEqual(byId(entries, "7").issued, { "date-parts": [[2019, 5, 1]] });
    assert.deepEqual(byId(entries, "7").author, [{ literal: "Acme Corp." }]);
    assert.deepEqual(byId(entries, "lit").issued, { literal: "Spring 2018" });
    assert.equal(byId(entries, "notype").type, "document");
    assert.deepEqual(byId(entries, "notype").issued, { "date-parts": [[2001]] });
    assert.equal(diagnostics.errors.length, 1);
    assert.match(diagnostics.errors[0].message, /item 4 has no "id"/);
    assert.equal(diagnostics.warnings.length, 1);
    assert.match(diagnostics.warnings[0].message, /"notype" has no "type"/);
  });

  it("accepts {items: [...]} and formats rich-text titles", () => {
    const diagnostics = new Diagnostics();
    const entries = parseCslJson(JSON.stringify({ items: JSON.parse(json).slice(0, 1) }), { diagnostics });
    const p = createCiteProcessor(entries, "numeric", diagnostics);
    p.cite(cite("paren", "a"));
    assert.equal(render(p.bibliography()[0].content), "J. Doe, “The *E. coli* Genome,” vol.~4, Mar. 2020.");
  });

  it("reports invalid JSON with line and column", () => {
    const diagnostics = new Diagnostics();
    const entries = parseCslJson('[\n  {"id": "a",}\n]', { file: "bad.json", diagnostics });
    assert.equal(entries.length, 0);
    const d = diagnostics.errors[0];
    assert.equal(d.code, "CITE003");
    assert.equal(d.file, "bad.json");
    assert.equal(d.line, 2);
    assert.ok(d.col !== undefined && d.col > 1);
  });

  it("rejects JSON that is not a list of items", () => {
    const diagnostics = new Diagnostics();
    assert.deepEqual(parseCslJson('{"id": "a"}', { diagnostics }), []);
    assert.match(diagnostics.errors[0].message, /must be an array/);
  });
});

// ------------------------------------------------------------------ numeric style

describe("numeric citations", () => {
  const setup = () => {
    const { entries } = bib(NUM_BIB);
    const diagnostics = new Diagnostics();
    return { p: createCiteProcessor(entries, "numeric", diagnostics), diagnostics };
  };

  it("numbers entries by first citation and lists them in that order", () => {
    const { p } = setup();
    assert.equal(citeText(p.cite(cite("paren", "lee2017"))), "[1]");
    assert.equal(citeText(p.cite(cite("paren", "doe2020", "lee2017"))), "[1, 2]");
    assert.equal(citeText(p.cite(cite("paren", "lee2017"))), "[1]");
    const items = p.bibliography();
    assert.deepEqual(
      items.map((i) => [i.label, i.key, i.id]),
      [
        ["[1]", "lee2017", "ref-lee2017"],
        ["[2]", "doe2020", "ref-doe2020"],
      ],
    );
  });

  it("sorts and compresses runs of three or more", () => {
    const { p } = setup();
    p.cite(cite("paren", "doe2020", "roe2019", "poe2018", "lee2017", "kim2016"));
    assert.equal(citeText(p.cite(cite("paren", "poe2018", "doe2020", "roe2019"))), "[1–3]");
    assert.equal(citeText(p.cite(cite("paren", "roe2019", "doe2020"))), "[1, 2]");
    assert.equal(citeText(p.cite(cite("paren", "kim2016", "doe2020", "poe2018", "lee2017"))), "[1, 3–5]");
    assert.equal(citeText(p.cite(cite("paren", "doe2020", "doe2020"))), "[1]");
  });

  it("links each number to its entry", () => {
    const { p } = setup();
    p.cite(cite("paren", "doe2020", "roe2019", "poe2018"));
    assert.deepEqual(links(p.cite(cite("paren", "doe2020", "roe2019", "poe2018"))), ["#ref-doe2020", "#ref-poe2018"]);
  });

  it("renders locators, prefixes and suffixes without compression", () => {
    const { p } = setup();
    p.cite(cite("paren", "doe2020", "roe2019", "poe2018"));
    assert.equal(citeText(p.cite(cite("paren", { key: "doe2020", locator: "p. 4" }))), "[1, p.~4]");
    assert.equal(citeText(p.cite(cite("paren", { key: "doe2020", prefix: "see", locator: "p. 4" }))), "[see 1, p.~4]");
    assert.equal(citeText(p.cite(cite("paren", { key: "roe2019", locator: "4" }))), "[2, p.~4]");
    assert.equal(citeText(p.cite(cite("paren", { key: "roe2019", locator: "10-12", suffix: "emphasis added" }))), "[2, pp.~10–12, emphasis added]");
    assert.equal(citeText(p.cite(cite("paren", { key: "poe2018", locator: "ch. 2" }, "doe2020", "roe2019"))), "[3, ch.~2; 1; 2]");
  });

  it("renders text, author and year modes", () => {
    const { p } = setup();
    assert.equal(citeText(p.cite(cite("text", "doe2020"))), "Doe~[1]");
    assert.equal(citeText(p.cite(cite("text", "roe2019"))), "Roe and Doe~[2]");
    assert.equal(citeText(p.cite(cite("text", "poe2018"))), "Poe et al.~[3]");
    assert.equal(citeText(p.cite(cite("text", "doe2020", "lee2017"))), "Doe~[1] and Lee~[4]");
    assert.equal(citeText(p.cite(cite("text", "doe2020", "lee2017", { key: "kim2016", locator: "p. 9" }))), "Doe~[1], Lee~[4], and Kim~[5, p.~9]");
    assert.equal(citeText(p.cite(cite("author", "roe2019"))), "Roe and Doe");
    assert.equal(citeText(p.cite(cite("year", "roe2019"))), "2019");
  });

  it("numbers nocite entries after all cited ones, in call order", () => {
    const { p } = setup();
    assert.deepEqual(p.cite(cite("nocite", "extra2")), []);
    p.cite(cite("paren", "doe2020"));
    p.cite(cite("nocite", "extra1", "lee2017"));
    p.cite(cite("paren", "lee2017"));
    p.cite(cite("paren", "roe2019"));
    assert.deepEqual(
      p.bibliography().map((i) => `${i.label} ${i.key}`),
      ["[1] doe2020", "[2] lee2017", "[3] roe2019", "[4] extra2", "[5] extra1"],
    );
  });

  it("includes every entry for nocite *, in file order", () => {
    const { p } = setup();
    p.cite(cite("paren", "kim2016"));
    p.cite(cite("nocite", "extra2", "*"));
    assert.deepEqual(
      p.bibliography().map((i) => i.key),
      ["kim2016", "extra2", "doe2020", "roe2019", "poe2018", "lee2017", "extra1"],
    );
  });

  it("makes unique anchors from awkward keys", () => {
    const { entries } = bib("@misc{Doe:2020/x, title = {A}, year = 1}\n@misc{doe-2020-x, title = {B}, year = 2}");
    const p = createCiteProcessor(entries, "numeric", new Diagnostics());
    p.cite(cite("paren", "Doe:2020/x", "doe-2020-x"));
    assert.deepEqual(
      p.bibliography().map((i) => i.id),
      ["ref-doe-2020-x", "ref-doe-2020-x-2"],
    );
  });

  it("lists up to six authors, then et al.", () => {
    const seven = Array.from({ length: 7 }, (_, k) => `Author${k + 1}, A.`).join(" and ");
    const { entries } = bib(`@article{many, author = {${seven}}, title = {Many}, journal = {J}, year = 2000}`);
    const p = createCiteProcessor(entries, "numeric", new Diagnostics());
    p.cite(cite("paren", "many"));
    assert.equal(render(p.bibliography()[0].content), "A. Author1, A. Author2, A. Author3, A. Author4, A. Author5, A. Author6, et al., “Many,” *J*, 2000.");
  });
});

// ------------------------------------------------------------------ author-year style

const AY_BIB = String.raw`
@article{doe2019, author = {Doe, Jane}, title = {Earlier}, journal = {J}, year = 2019}
@article{doe2020, author = {Doe, Jane}, title = {Later}, journal = {J}, year = 2020}
@article{roe2019, author = {Roe, Richard}, title = {Roe Paper}, journal = {J}, year = 2019}
@article{duo2020, author = {Doe, Jane and Roe, Richard}, title = {Pair}, journal = {J}, year = 2020}
@article{tri2020, author = {Doe, Jane and Roe, Richard and Poe, Edgar}, title = {Trio}, journal = {J}, year = 2020}
@article{doeBeta, author = {Doe, John}, title = {Beta Study}, journal = {J}, year = 2021}
@article{doeAlpha, author = {Doe, Jim}, title = {Alpha Study}, journal = {J}, year = 2021}
@techreport{who2021, author = {{World Health Organization}}, title = {Global Report}, institution = {WHO}, year = 2021}
@misc{undated, author = {Smith, Ann}, title = {Undated Note}}
@article{anon2021, title = {Anonymous Article}, journal = {J}, year = 2021}
@book{anonbook, title = {Anonymous Book}, year = 2020}
`;

describe("author-year citations", () => {
  const setup = () => {
    const { entries } = bib(AY_BIB);
    const diagnostics = new Diagnostics();
    return { p: createCiteProcessor(entries, "author-year", diagnostics), diagnostics };
  };

  it("renders one, two and three-plus authors", () => {
    const { p } = setup();
    assert.equal(citeText(p.cite(cite("paren", "doe2020"))), "(Doe 2020)");
    assert.equal(citeText(p.cite(cite("paren", "duo2020"))), "(Doe and Roe 2020)");
    assert.equal(citeText(p.cite(cite("paren", "tri2020"))), "(Doe et al. 2020)");
  });

  it("keeps citation order and groups years of the same author", () => {
    const { p } = setup();
    assert.equal(citeText(p.cite(cite("paren", "doe2020", "roe2019"))), "(Doe 2020; Roe 2019)");
    assert.equal(citeText(p.cite(cite("paren", "doe2019", "doe2020"))), "(Doe 2019, 2020)");
    assert.equal(citeText(p.cite(cite("paren", "doe2019", "roe2019", "doe2020"))), "(Doe 2019, 2020; Roe 2019)");
  });

  it("renders locators, prefixes and suffixes", () => {
    const { p } = setup();
    assert.equal(citeText(p.cite(cite("paren", { key: "doe2020", locator: "p. 4" }))), "(Doe 2020, p.~4)");
    assert.equal(citeText(p.cite(cite("paren", { key: "doe2020", prefix: "see", locator: "p. 4" }))), "(see Doe 2020, p.~4)");
    assert.equal(citeText(p.cite(cite("paren", { key: "doe2020", suffix: ", for example" }))), "(Doe 2020, for example)");
  });

  it("renders text, author and year modes", () => {
    const { p } = setup();
    assert.equal(citeText(p.cite(cite("text", "doe2020"))), "Doe (2020)");
    assert.equal(citeText(p.cite(cite("text", { key: "duo2020", locator: "p. 4" }))), "Doe and Roe (2020, p.~4)");
    assert.equal(citeText(p.cite(cite("text", "tri2020"))), "Doe et al. (2020)");
    assert.equal(citeText(p.cite(cite("text", "doe2020", "roe2019"))), "Doe (2020) and Roe (2019)");
    assert.equal(citeText(p.cite(cite("author", "duo2020"))), "Doe and Roe");
    assert.equal(citeText(p.cite(cite("year", "duo2020"))), "2020");
  });

  it("links the label to the entry", () => {
    const { p } = setup();
    const out = p.cite(cite("paren", "doe2019", "doe2020"));
    assert.deepEqual(links(out), ["#ref-doe2019", "#ref-doe2020"]);
    const link = out.find((n) => n.t === "Link");
    assert.equal(link && citeText([link]), "Doe 2019");
  });

  it("disambiguates the same author and year by title, updating earlier citations", () => {
    const { p } = setup();
    const first = p.cite(cite("paren", "doeBeta"));
    assert.equal(citeText(first), "(Doe 2021)");
    const second = p.cite(cite("paren", "doeAlpha"));
    assert.equal(citeText(second), "(Doe 2021a)");
    assert.equal(citeText(first), "(Doe 2021b)");
    assert.equal(citeText(p.cite(cite("paren", "doeAlpha", "doeBeta"))), "(Doe 2021a, 2021b)");
    const items = p.bibliography();
    assert.deepEqual(
      items.map((i) => i.key),
      ["doeAlpha", "doeBeta"],
    );
    assert.equal(render(items[0].content), "Doe, J. 2021a. “Alpha Study.” *J*.");
    assert.equal(items[0].label, undefined);
  });

  it("uses n.d., corporate authors and titles in place of missing authors", () => {
    const { p, diagnostics } = setup();
    assert.equal(citeText(p.cite(cite("paren", "undated"))), "(Smith n.d.)");
    assert.equal(citeText(p.cite(cite("paren", "who2021"))), "(World Health Organization 2021)");
    assert.equal(citeText(p.cite(cite("paren", "anon2021"))), "(“Anonymous Article” 2021)");
    assert.equal(citeText(p.cite(cite("paren", "anonbook"))), "(*Anonymous Book* 2020)");
    const cite004 = diagnostics.items.filter((d) => d.code === "CITE004");
    assert.equal(cite004.length, 1);
    assert.match(cite004[0].message, /"undated" has no year/);
    assert.equal(cite004[0].severity, "warning");
    assert.equal(cite004[0].line, 10);
    const refs = p.bibliography().map((i) => render(i.content));
    assert.ok(refs.includes("Smith, A. n.d. “Undated Note.”"), refs.join("\n"));
    assert.ok(refs.includes("World Health Organization. 2021. “Global Report.” Tech. Rep. WHO."), refs.join("\n"));
    assert.ok(refs.includes("*Anonymous Book*. 2020."), refs.join("\n"));
  });

  it("sorts the bibliography by author ignoring case and accents, then year and title", () => {
    const names = ["Zeta", "van Beethoven, Ludwig", "Schroeder", "Schr{\\\"o}dinger", "{\\O}stergaard", "Osborne", "Moore", "{\\L}ukasiewicz", "Lee", "Godfrey", "G{\\\"o}del", "Doe", "de La Fontaine, Jean", "Bauer", "{\\AA}ngstr{\\\"o}m"];
    const source = names.map((n, k) => `@book{k${k}, author = {${n}, A.}, title = {T}, year = 2000}`).join("\n").replace("{van Beethoven, Ludwig, A.}", "{van Beethoven, Ludwig}").replace("{de La Fontaine, Jean, A.}", "{de La Fontaine, Jean}");
    const { entries } = bib(source);
    const p = createCiteProcessor(entries, "author-year", new Diagnostics());
    p.cite(cite("nocite", "*"));
    assert.deepEqual(
      p.bibliography().map((i) => render(i.content).split(",")[0]),
      ["Ångström", "Bauer", "de La Fontaine", "Doe", "Gödel", "Godfrey", "Lee", "Łukasiewicz", "Moore", "Osborne", "Østergaard", "Schrödinger", "Schroeder", "van Beethoven", "Zeta"],
    );
  });

  it("sorts by year, then title, within one author", () => {
    const { p } = setup();
    p.cite(cite("paren", "doe2020", "doe2019", "duo2020", "roe2019"));
    assert.deepEqual(
      p.bibliography().map((i) => i.key),
      ["doe2019", "doe2020", "duo2020", "roe2019"],
    );
  });

  it("marks entries with an others author as et al.", () => {
    const { entries } = bib(REAL_BIB);
    const p = createCiteProcessor(entries, "author-year", new Diagnostics());
    assert.equal(citeText(p.cite(cite("paren", "hodgkin2022"))), "(Hodgkin et al. 2022)");
    assert.equal(citeText(p.cite(cite("text", "beethoven1802"))), "van Beethoven (1802)");
  });

  it("lists up to ten authors, then et al.", () => {
    const eleven = Array.from({ length: 11 }, (_, k) => `Author${k + 1}, A.`).join(" and ");
    const { entries } = bib(`@book{many, author = {${eleven}}, title = {Many}, year = 2000}`);
    const p = createCiteProcessor(entries, "author-year", new Diagnostics());
    p.cite(cite("paren", "many"));
    const ref = render(p.bibliography()[0].content);
    assert.ok(ref.startsWith("Author1, A., A. Author2, A. Author3,"), ref);
    assert.ok(ref.includes("A. Author10, et al. 2000. *Many*."), ref);
    assert.ok(!ref.includes("Author11"), ref);
  });
});

// ------------------------------------------------------------------ exact reference formats

describe("reference formats", () => {
  const formatAll = (style: "numeric" | "author-year"): Record<string, string> => {
    const { entries } = bib(STYLE_BIB);
    const p = createCiteProcessor(entries, style, new Diagnostics());
    for (const e of entries) p.cite(cite("nocite", e.id));
    return Object.fromEntries(p.bibliography().map((i) => [i.key, render(i.content)]));
  };

  it("numeric", () => {
    const r = formatAll("numeric");
    assert.equal(r.art, "A.~B. Doe, C. Roe, and E. Poe, “Title,” *Journal*, vol.~3, no.~2, pp.~10–20, Mar. 2020, doi: <https://doi.org/10.x/y>.");
    assert.equal(r.bk, "A.~B. Doe, *Title*, 2nd ed. Place: Publisher, 2020.");
    assert.equal(r.conf, "A. Doe, “Title,” in *Proc. Name*, Place, 2020, pp.~1–9.");
    assert.equal(r.chap, "A. Doe, “Title,” in *Book*, E. Editor, Ed. Place: Publisher, 2020, pp.~1–9.");
    assert.equal(r.thes, "A. Doe, “Title,” PhD thesis, School, Place, 2020.");
    assert.equal(r.rep, "A. Doe, “Title,” Publisher, Place, Tech. Rep.~42, 2020.");
    assert.equal(r.web, "A. Doe, “Title,” Example Org, 2020. [Online]. Available: <https://example.org/x>");
  });

  it("author-year (letters tell the six Doe 2020 entries apart)", () => {
    const r = formatAll("author-year");
    assert.equal(r.art, "Doe, A.~B., C. Roe, and E. Poe. 2020. “Title.” *Journal* 3 (2): 10–20. <https://doi.org/10.x/y>.");
    assert.equal(r.bk, "Doe, A.~B. 2020a. *Title*. 2nd ed. Place: Publisher.");
    assert.equal(r.chap, "Doe, A. 2020b. “Title.” In *Book*, edited by E. Editor, 1–9. Place: Publisher.");
    assert.equal(r.conf, "Doe, A. 2020c. “Title.” In *Proc. Name*, 1–9. Place.");
    assert.equal(r.rep, "Doe, A. 2020d. “Title.” Tech. Rep.~42. Place: Publisher.");
    assert.equal(r.thes, "Doe, A. 2020e. *Title*. PhD thesis, School.");
    assert.equal(r.web, "Doe, A. 2020f. “Title.” Example Org. <https://example.org/x>.");
  });

  it("formats the realistic file in both styles", () => {
    const { entries } = bib(REAL_BIB);
    const numeric = createCiteProcessor(entries, "numeric", new Diagnostics());
    numeric.cite(cite("nocite", "*"));
    const n = Object.fromEntries(numeric.bibliography().map((i) => [i.key, render(i.content)]));
    assert.equal(
      n.godel1931,
      "K. Gödel, “Über formal unentscheidbare Sätze der Principia Mathematica und verwandter Systeme I,” *Monatshefte für Mathematik und Physik*, vol.~38, no.~1, pp.~173–198, 1931, doi: <https://doi.org/10.1007/BF01700692>.",
    );
    assert.equal(n.lukasiewicz1957, "J. Łukasiewicz, *Aristotle’s Syllogistic from the Standpoint of Modern Formal Logic*, 2nd ed. Oxford: Clarendon Press, 1957.");
    assert.equal(n.beethoven1802, "L. van Beethoven, “The Heiligenstadt Testament,” in *Letters and Documents*, E. Anderson and M. Unger, Eds. London: Macmillan, 1802, pp.~1–9.");
    assert.equal(n.who2021, "World Health Organization, “Global Tuberculosis Report,” WHO, Geneva, Tech. Rep.~42, 2021.");
    assert.equal(n.hodgkin2022, "A. Hodgkin et al., “Spike Train Recordings,” 2022. [Online]. Available: <https://example.org/spikes>");
    assert.equal(n.martin2021, "M. Martín and P. Šimčić, “Writing LaTeX in 2021 — a survey,” Mar. 15, 2021. Accessed: Jan. 2, 2022. [Online]. Available: <https://example.com/a_b?q=1>");
    assert.equal(n.poe2017, "E.~A. Poe, “The Raven, Revised,” 2017, Unpublished manuscript.");
    assert.equal(n.harris2020, "C.~R. Harris and K.~J. Millman, “NumPy,” Zenodo, 2020, doi: <https://doi.org/10.5281/zenodo.1234>.");

    const ay = createCiteProcessor(entries, "author-year", new Diagnostics());
    ay.cite(cite("nocite", "*"));
    const a = Object.fromEntries(ay.bibliography().map((i) => [i.key, render(i.content)]));
    assert.equal(a.schrodinger1926, "Schrödinger, E. 1926. “An Undulatory Theory of the Mechanics of Atoms and Molecules.” *Physical Review* 28 (6): 1049–1070.");
    assert.equal(a.fontaine1668, "de La Fontaine, J. 1668. *Fables choisies, mises en vers*. Paris: Claude Barbin.");
    assert.equal(a.angstrom2020, "Ångström, A., J. Doe, and R. Roe. 2020. “Spectral Lines Revisited.” In *Proc. Int. Conf. Spectroscopy*, 1–9. Uppsala: IEEE.");
    assert.equal(a.smith2020, "Smith, J., and M. Jones. 2020. “Modern biblatex Dates.” *Journal of Geophysical Research: Solid Earth* 125 (3): e2019JB018000.");
    assert.equal(a.martin2021, "Martín, M., and P. Šimčić. 2021. “Writing LaTeX in 2021 — a survey.” Accessed January 2, 2022. <https://example.com/a_b?q=1>.");
    assert.equal(a.rcore2023, "“R: A Language and Environment for Statistical Computing.” 2023. Manual. Vienna, Austria: R Foundation for Statistical Computing. <https://www.R-project.org/>.");
    assert.equal(a.noaa2019, "National Oceanic and Atmospheric Administration. 2019. “Global Surface Temperature.” NOAA. <https://www.ncei.noaa.gov/>.");
  });

  it("places editors as authors of edited books and as container editors of chapters", () => {
    const { entries } = bib(String.raw`
@book{edbook, editor = {Editor, Ernest and Other, Olga}, title = {Collected Papers}, publisher = {P}, year = 2020}
@incollection{noauth, title = {Chapter}, booktitle = {Book}, editor = {Editor, Ernest}, publisher = {P}, year = 2020}`);
    const numeric = createCiteProcessor(entries, "numeric", new Diagnostics());
    numeric.cite(cite("paren", "edbook", "noauth"));
    assert.deepEqual(
      numeric.bibliography().map((i) => render(i.content)),
      ["E. Editor and O. Other, Eds., *Collected Papers*. P, 2020.", "“Chapter,” in *Book*, E. Editor, Ed. P, 2020."],
    );
    const ay = createCiteProcessor(entries, "author-year", new Diagnostics());
    // A chapter without authors is cited and sorted by its title, not by the book's editors.
    assert.equal(citeText(ay.cite(cite("paren", "edbook", "noauth"))), "(Editor and Other 2020; “Chapter” 2020)");
    assert.deepEqual(
      ay.bibliography().map((i) => render(i.content)),
      ["“Chapter.” 2020. In *Book*, edited by E. Editor. P.", "Editor, E., and O. Other, eds. 2020. *Collected Papers*. P."],
    );
  });

  it("never doubles punctuation and keeps math and italics in titles", () => {
    const { entries } = bib(String.raw`
@article{q, author = {Doe, J.}, title = {Why Not?}, journal = {Proc. Natl. Acad. Sci.}, year = 2001}
@article{m, author = {Doe, J.}, title = {The \emph{Drosophila} Gene $H_0$.}, journal = {J. Chem. Phys.}, year = 2002}`);
    const p = createCiteProcessor(entries, "numeric", new Diagnostics());
    p.cite(cite("paren", "q", "m"));
    const [q, m] = p.bibliography();
    assert.equal(render(q.content), "J. Doe, “Why Not?” *Proc. Natl. Acad. Sci.*, 2001.");
    assert.equal(render(m.content), "J. Doe, “The *Drosophila* Gene $H_0$,” *J. Chem. Phys.*, 2002.");
    const ay = createCiteProcessor(entries, "author-year", new Diagnostics());
    ay.cite(cite("paren", "q"));
    assert.equal(render(ay.bibliography()[0].content), "Doe, J. 2001. “Why Not?” *Proc. Natl. Acad. Sci.*");
  });
});

// ------------------------------------------------------------------ diagnostics

describe("citation diagnostics", () => {
  it("reports an unknown key once, with the closest keys as a hint", () => {
    const { entries } = bib(NUM_BIB);
    const diagnostics = new Diagnostics();
    const p = createCiteProcessor(entries, "numeric", diagnostics);
    const pos = { file: "doc.md", line: 3, col: 7 };
    assert.equal(citeText(p.cite({ ...cite("paren", "doe2021"), pos })), "[?doe2021]");
    assert.equal(citeText(p.cite(cite("paren", "doe2020", "doe2021"))), "[1, ?doe2021]");
    const errs = diagnostics.items.filter((d) => d.code === "CITE001");
    assert.equal(errs.length, 1);
    assert.equal(errs[0].severity, "error");
    assert.match(errs[0].message, /"doe2021"/);
    assert.equal(errs[0].hint, 'Did you mean "doe2020"?');
    assert.deepEqual([errs[0].file, errs[0].line, errs[0].col], ["doc.md", 3, 7]);
    assert.ok(!p.bibliography().some((i) => i.key === "doe2021"));
    p.cite(cite("paren", "roe2018"));
    assert.equal(diagnostics.items.find((d) => d.message.includes('"roe2018"'))?.hint, 'Did you mean "poe2018" or "roe2019"?');
  });

  it("suggests at most three keys", () => {
    const { entries } = bib(["a4", "a2", "a3", "a1"].map((k) => `@misc{${k}, title = {T}, year = 1}`).join("\n"));
    const diagnostics = new Diagnostics();
    createCiteProcessor(entries, "numeric", diagnostics).cite(cite("paren", "a"));
    assert.equal(diagnostics.items[0].hint, 'Did you mean "a1", "a2" or "a3"?');
  });

  it("renders unknown keys as plain text in author-year", () => {
    const { entries } = bib(AY_BIB);
    const diagnostics = new Diagnostics();
    const p = createCiteProcessor(entries, "author-year", diagnostics);
    const out = p.cite(cite("paren", "nosuchkey"));
    assert.equal(citeText(out), "(nosuchkey?)");
    assert.deepEqual(links(out), []);
    assert.equal(citeText(p.cite(cite("paren", "doe2020", "nosuchkey"))), "(Doe 2020; nosuchkey?)");
    assert.equal(citeText(p.cite(cite("text", "nosuchkey"))), "(nosuchkey?)");
    assert.equal(diagnostics.items.filter((d) => d.code === "CITE001").length, 1);
    assert.equal(diagnostics.items[0].hint, "Check the key against the bibliography file.");
  });

  it("hints when the bibliography is empty", () => {
    const diagnostics = new Diagnostics();
    const p = createCiteProcessor([], "numeric", diagnostics);
    assert.equal(citeText(p.cite(cite("text", "x"))), "[?x]");
    assert.match(diagnostics.items[0].hint ?? "", /no entries/);
  });

  it("warns once per entry about missing title or year, pointing at the .bib line", () => {
    const { entries } = bib("@article{noyear, author = {Doe, J.}, title = {No Year}}\n@article{bare, author = {Doe, J.}}\n", "x.bib");
    const diagnostics = new Diagnostics();
    const p = createCiteProcessor(entries, "author-year", diagnostics);
    p.cite(cite("paren", "noyear"));
    p.cite(cite("paren", "noyear", "bare"));
    const warns = diagnostics.items.filter((d) => d.code === "CITE004");
    assert.deepEqual(
      warns.map((d) => [d.message, d.file, d.line]),
      [
        ['Bibliography entry "noyear" has no year', "x.bib", 1],
        ['Bibliography entry "bare" has no title or year', "x.bib", 2],
      ],
    );
    assert.deepEqual(
      p.bibliography().map((i) => render(i.content)),
      ["Doe, J. n.d.-a.", "Doe, J. n.d.-b. “No Year.”"],
    );
  });
});
