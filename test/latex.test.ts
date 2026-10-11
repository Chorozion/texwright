import { test } from "node:test";
import assert from "node:assert/strict";
import type { Block, Inline } from "../src/ast.js";
import type { Diagnostic } from "../src/diagnostics.js";
import { memoryContext } from "../src/parse/context.js";
import { latexToBlocks, latexToInlines, parseLatex } from "../src/parse/latex.js";

// ------------------------------------------------------------ helpers

function parse(src: string, files: Record<string, string> = {}, file = "main.tex") {
  const ctx = memoryContext(files, file);
  const doc = parseLatex(src, ctx);
  return { doc: strip(doc), raw: doc, diags: ctx.diagnostics.items };
}

/** Drop every `pos` so trees compare by content. */
function strip<T>(x: T): T {
  return JSON.parse(JSON.stringify(x, (k, v) => (k === "pos" ? undefined : v)));
}

function blocks(src: string): Block[] {
  return parse(src).doc.blocks;
}

function only<K extends Block["t"]>(bs: Block[], t: K): Extract<Block, { t: K }> {
  assert.equal(bs.length, 1, `expected one block, got ${JSON.stringify(bs)}`);
  assert.equal(bs[0].t, t);
  return bs[0] as Extract<Block, { t: K }>;
}

/** The inline content of a source that is one paragraph. */
function para(src: string): Inline[] {
  return only(blocks(src), "Para").content;
}

const T = (text: string): Inline => ({ t: "Text", text });
const codes = (ds: Diagnostic[]): string[] => ds.map((d) => d.code);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const now = new Date();
const TODAY = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;

// ------------------------------------------------------------ 1. preamble and metadata

test("preamble: class and packages are silent, metadata is collected", () => {
  const { doc, diags } = parse(String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[utf8]{inputenc}
\usepackage{amsmath,amssymb}
\title{On \emph{Graphs}}
\author{Ada Lovelace\thanks{Analytical Engine Ltd.} \and Alan Turing \and Grace Hopper}
\date{\today}
\keywords{graphs, heat flow; spectra}
This text in the preamble is ignored.
\begin{document}
\maketitle
\tableofcontents
\begin{abstract}
We study things.

In two paragraphs.
\end{abstract}
Body.
\end{document}
Trailing text is ignored.`);
  assert.deepEqual(codes(diags), []);
  assert.deepEqual(doc.meta.title, [T("On "), { t: "Emph", content: [T("Graphs")] }]);
  assert.equal(doc.meta.author?.length, 3);
  assert.deepEqual(doc.meta.author?.[0], [T("Ada Lovelace"), { t: "Note", blocks: [{ t: "Para", content: [T("Analytical Engine Ltd.")] }] }]);
  assert.deepEqual(doc.meta.author?.[2], [T("Grace Hopper")]);
  assert.deepEqual(doc.meta.date, [T(TODAY)]);
  assert.deepEqual(doc.meta.keywords, ["graphs", "heat flow", "spectra"]);
  assert.deepEqual(doc.meta.abstract, [
    { t: "Para", content: [T("We study things.")] },
    { t: "Para", content: [T("In two paragraphs.")] },
  ]);
  assert.deepEqual(doc.blocks, [{ t: "TOC" }, { t: "Para", content: [T("Body.")] }]);
});

test("without \\begin{document} the whole text is the body and metadata commands still work", () => {
  const { doc } = parse(String.raw`\title{Notes}
Some text.`);
  assert.deepEqual(doc.meta.title, [T("Notes")]);
  assert.deepEqual(doc.blocks, [{ t: "Para", content: [T("Some text.")] }]);
});

// ------------------------------------------------------------ 2. sectioning

test("sectioning levels, starred forms, short titles", () => {
  const bs = blocks(String.raw`\section{One}
\subsection*{Two}
\subsubsection[Short]{Three long}
\paragraph{Four}
\subparagraph{Five}`) as Extract<Block, { t: "Heading" }>[];
  assert.deepEqual(
    bs.map((b) => [b.level, b.numbered, b.id]),
    [
      [1, true, "one"],
      [2, false, "two"],
      [3, true, "three-long"],
      [4, false, "four"],
      [5, false, "five"],
    ],
  );
  assert.deepEqual(bs[2].content, [T("Three long")]);
});

test("\\chapter shifts sections down; \\part stays at level 1", () => {
  const bs = blocks(String.raw`\part{P}
\chapter{C}
\section{S}
\subsection{SS}`) as Extract<Block, { t: "Heading" }>[];
  assert.deepEqual(
    bs.map((b) => b.level),
    [1, 1, 2, 3],
  );
});

test("labels after or inside a heading set label and id; unlabeled ids are unique", () => {
  const bs = blocks(String.raw`\section{Intro}
\label{sec:intro}
\section{Results\label{sec:res}}
\section{Results}
\section{Results}`) as Extract<Block, { t: "Heading" }>[];
  assert.equal(bs.length, 4);
  assert.deepEqual([bs[0].label, bs[0].id], ["sec:intro", "sec-intro"]);
  assert.deepEqual([bs[1].label, bs[1].id], ["sec:res", "sec-res"]);
  assert.deepEqual(bs[1].content, [T("Results")]);
  assert.deepEqual([bs[2].id, bs[3].id], ["results", "results-1"]);
});

test("\\appendix marks later level-1 headings", () => {
  const bs = blocks(String.raw`\section{Main}
\appendix
\section{Proofs}
\subsection{Detail}`) as Extract<Block, { t: "Heading" }>[];
  assert.equal(bs[0].attr, undefined);
  assert.deepEqual(bs[1].attr, { classes: ["appendix"] });
  assert.equal(bs[2].attr, undefined);
});

// ------------------------------------------------------------ 3. paragraphs and text styles

test("blank lines and \\par separate paragraphs; newlines are spaces", () => {
  const bs = blocks("First line\nsame paragraph.\n\n\nSecond.\\par Third.");
  assert.deepEqual(bs, [
    { t: "Para", content: [T("First line same paragraph.")] },
    { t: "Para", content: [T("Second.")] },
    { t: "Para", content: [T("Third.")] },
  ]);
});

test("text style commands", () => {
  assert.deepEqual(para(String.raw`\emph{a} \textit{b} \textbf{c} \texttt{d\_e} \textsc{f} \underline{g} \sout{h} x\textsuperscript{2} y\textsubscript{i}`), [
    { t: "Emph", content: [T("a")] },
    T(" "),
    { t: "Emph", content: [T("b")] },
    T(" "),
    { t: "Strong", content: [T("c")] },
    T(" "),
    { t: "Code", text: "d_e" },
    T(" "),
    { t: "SmallCaps", content: [T("f")] },
    T(" "),
    { t: "Underline", content: [T("g")] },
    T(" "),
    { t: "Strike", content: [T("h")] },
    T(" x"),
    { t: "Superscript", content: [T("2")] },
    T(" y"),
    { t: "Subscript", content: [T("i")] },
  ]);
});

test("declarations apply to the rest of their group", () => {
  assert.deepEqual(para(String.raw`{\em it} {\bf bold \itshape both} \bfseries{} rest`), [
    { t: "Emph", content: [T("it")] },
    T(" "),
    { t: "Strong", content: [T("bold "), { t: "Emph", content: [T("both")] }] },
    T(" "),
    { t: "Strong", content: [T("rest")] },
  ]);
  assert.deepEqual(para(String.raw`{\ttfamily a b} c`), [{ t: "Code", text: "a b" }, T(" c")]);
});

test("size switches scale their text; pass-through commands keep theirs", () => {
  const size = (s: string, text: string): Inline => ({ t: "Span", attr: { classes: [`size-${s}`] }, content: [T(text)] });
  assert.deepEqual(para(String.raw`{\small a} \textrm{b} \mbox{c} \textnormal{d} \textcolor{red}{e} \huge f`), [
    size("small", "a"),
    T(" b c d "),
    { t: "Span", attr: { classes: ["color"], attrs: { color: "#ff0000" } }, content: [T("e")] },
    T(" "),
    size("huge", "f"),
  ]);
  assert.deepEqual(para(String.raw`{\Large\bfseries T} {\large x\normalsize y}`), [{ t: "Span", attr: { classes: ["size-Large"] }, content: [{ t: "Strong", content: [T("T")] }] }, T(" "), size("large", "x"), T("y")]);
});

test("verbatim, urls and links", () => {
  assert.deepEqual(strip(para(String.raw`\verb|a{b}%c| and \verb+x|y+`)), [{ t: "Code", text: "a{b}%c" }, T(" and "), { t: "Code", text: "x|y" }]);
  assert.deepEqual(para(String.raw`\url{https://example.com/a%20b_c} \href{https://x.org/?q=1\&r=2}{the \emph{site}}`), [
    { t: "Link", url: "https://example.com/a%20b_c", content: [T("https://example.com/a%20b_c")] },
    T(" "),
    { t: "Link", url: "https://x.org/?q=1&r=2", content: [T("the "), { t: "Emph", content: [T("site")] }] },
  ]);
});

test("footnotes hold blocks; \\footnotemark and \\footnotetext pair up", () => {
  const c = para(String.raw`Text.\footnote{First para.

Second para with $x$.} More\footnotemark{} text.\footnotetext{Later.}`);
  assert.deepEqual(c[1], {
    t: "Note",
    blocks: [
      { t: "Para", content: [T("First para.")] },
      { t: "Para", content: [T("Second para with "), { t: "Math", tex: "x" }, T(".")] },
    ],
  });
  assert.deepEqual(c[3], { t: "Note", blocks: [{ t: "Para", content: [T("Later.")] }] });
  assert.equal(c.length, 5);
});

// ------------------------------------------------------------ 4. characters

test("escaped characters and symbols", () => {
  assert.deepEqual(para(String.raw`\% \& \# \_ \$ \{ \} \textbackslash{} \textasciitilde{} \textasciicircum{}`), [T("% & # _ $ { } \\ ~ ^")]);
  assert.deepEqual(para(String.raw`\ldots{} \dots \LaTeX{} \TeX{} \LaTeXe{} \S 1 \P \copyright{} \dag \ddag \pounds \textregistered \texttrademark \textdegree`), [
    T("\u2026 \u2026LaTeX TeX LaTeX2\u03b5 \u00a71 \u00b6\u00a9 \u2020\u2021\u00a3\u00ae\u2122\u00b0"),
  ]);
});

test("spaces: ~, \\, and control space; \\@ \\/ \\- vanish", () => {
  assert.deepEqual(para(String.raw`a~b\,c\ d e\@. f\/g hy\-phen`), [T("a\u00a0b\u202fc d e. fg hyphen")]);
});

test("dash and quote ligatures", () => {
  assert.deepEqual(para("pages 1--2 --- ``double'' and `single' don't"), [T("pages 1\u20132 \u2014 \u201cdouble\u201d and \u2018single\u2019 don\u2019t")]);
});

test("accents compose with NFC", () => {
  assert.deepEqual(para(String.raw`\'e \'{e} \`a \^o \"u \~n \=a \.z \u{a} \v{s} \H{o} \c{c} \k{a} \r{a} \'{\i} na\"\i ve`), [
    T("\u00e9 \u00e9 \u00e0 \u00f4 \u00fc \u00f1 \u0101 \u017c \u0103 \u0161 \u0151 \u00e7 \u0105 \u00e5 \u00ed na\u00efve"),
  ]);
});

test("special letters", () => {
  assert.deepEqual(para(String.raw`\ss{} \o{} \O{} \aa{} \AA{} \ae{} \AE{} \oe{} \OE{} \l{} \L{}`), [
    T("\u00df \u00f8 \u00d8 \u00e5 \u00c5 \u00e6 \u00c6 \u0153 \u0152 \u0142 \u0141"),
  ]);
});

test("line breaks: \\\\ with an optional length, and \\newline", () => {
  assert.deepEqual(para(String.raw`one\\[2pt] two\newline three\\`), [T("one"), { t: "LineBreak" }, T("two"), { t: "LineBreak" }, T("three")]);
});

test("comments are removed with the newline and the next line's indentation", () => {
  assert.deepEqual(para("50\\% done % comment\nnext"), [T("50% done next")]);
  assert.deepEqual(para("foo%\n    bar"), [T("foobar")]);
  assert.deepEqual(blocks("a % c\n\nb"), [
    { t: "Para", content: [T("a")] },
    { t: "Para", content: [T("b")] },
  ]);
});

// ------------------------------------------------------------ 5. lists

test("itemize, enumerate styles and nesting", () => {
  const list = only(
    blocks(String.raw`\begin{enumerate}[label=(\alph*), start=3]
\item First
\item Second
  \begin{itemize}
    \item inner
  \end{itemize}
\end{enumerate}`),
    "List",
  );
  assert.equal(list.ordered, true);
  assert.equal(list.style, "lower-alpha");
  assert.equal(list.start, 3);
  assert.equal(list.tight, true);
  assert.deepEqual(list.items[0], [{ t: "Plain", content: [T("First")] }]);
  assert.deepEqual(list.items[1], [
    { t: "Plain", content: [T("Second")] },
    { t: "List", ordered: false, tight: true, items: [[{ t: "Plain", content: [T("inner")] }]] },
  ]);
  assert.equal(only(blocks(String.raw`\begin{enumerate}[label=\Roman*.]\item x\end{enumerate}`), "List").style, "upper-roman");
  assert.equal(only(blocks(String.raw`\begin{enumerate}[(i)]\item x\end{enumerate}`), "List").style, "lower-roman");
});

test("an item with two paragraphs makes the list loose", () => {
  const list = only(blocks("\\begin{itemize}\n\\item a\n\n b\n\\item c\n\\end{itemize}"), "List");
  assert.equal(list.tight, false);
  assert.deepEqual(list.items[0], [
    { t: "Para", content: [T("a")] },
    { t: "Para", content: [T("b")] },
  ]);
});

test("an itemize \\item[label] starts the item text", () => {
  assert.deepEqual(only(blocks(String.raw`\begin{itemize}\item[--] dash\item plain\end{itemize}`), "List").items, [[{ t: "Plain", content: [T("\u2013 dash")] }], [{ t: "Plain", content: [T("plain")] }]]);
});

test("description lists become DefList", () => {
  assert.deepEqual(only(blocks(String.raw`\begin{description}\item[Heat] flows. \item[\emph{Cold}] does not.\end{description}`), "DefList").items, [
    { term: [T("Heat")], defs: [[{ t: "Plain", content: [T("flows.")] }]] },
    { term: [{ t: "Emph", content: [T("Cold")] }], defs: [[{ t: "Plain", content: [T("does not.")] }]] },
  ]);
});

// ------------------------------------------------------------ 6. environments

test("quote, quotation, verse and layout environments", () => {
  assert.deepEqual(blocks(String.raw`\begin{quote}Q\end{quote}\begin{verse}a\\b\end{verse}\begin{center}C\end{center}`), [
    { t: "BlockQuote", blocks: [{ t: "Para", content: [T("Q")] }] },
    { t: "BlockQuote", blocks: [{ t: "Para", content: [T("a"), { t: "LineBreak" }, T("b")] }] },
    { t: "Div", attr: { classes: ["center"] }, blocks: [{ t: "Para", content: [T("C")] }] },
  ]);
});

test("verbatim-like environments keep their text literally", () => {
  const bs = blocks(String.raw`\begin{verbatim}
x = 50 % 7  \textbf{not bold} {
  indented
\end{verbatim}
\begin{lstlisting}[language=Python, caption={Fast, simple}, label=lst:fast]
print("hi")  # 100%
\end{lstlisting}
\begin{minted}{rust}
fn main() {}
\end{minted}`);
  assert.deepEqual(bs, [
    { t: "CodeBlock", text: "x = 50 % 7  \\textbf{not bold} {\n  indented" },
    { t: "CodeBlock", text: 'print("hi")  # 100%', lang: "python", attr: { id: "lst:fast", attrs: { caption: "Fast, simple" } } },
    { t: "CodeBlock", text: "fn main() {}", lang: "rust" },
  ]);
});

// ------------------------------------------------------------ 7. figures

test("figure with graphics, caption and label", () => {
  const fig = only(
    blocks(String.raw`\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.6\textwidth]{plot}
  \caption[Short]{A \emph{nice} plot.}
  \label{fig:plot}
\end{figure}`),
    "Figure",
  );
  assert.deepEqual(fig, {
    t: "Figure",
    content: [{ t: "Plain", content: [{ t: "Image", src: "plot", alt: [], width: "60%" }] }],
    caption: [T("A "), { t: "Emph", content: [T("nice")] }, T(" plot.")],
    label: "fig:plot",
    id: "fig-plot",
    numbered: true,
  });
});

test("graphics options: widths, absolute units, scale; inline images; uncaptioned figures", () => {
  const c = para(String.raw`\includegraphics[width=\linewidth]{a.png} \includegraphics[width=8cm,height=2in]{b} \includegraphics[scale=0.5,keepaspectratio]{c}`);
  assert.deepEqual(c, [
    { t: "Image", src: "a.png", alt: [], width: "100%" },
    T(" "),
    { t: "Image", src: "b", alt: [], width: "8cm", height: "2in" },
    T(" "),
    { t: "Image", src: "c", alt: [], attr: { attrs: { scale: "0.5" } } },
  ]);
  const fig = only(blocks(String.raw`\begin{figure}\includegraphics[width=.45\columnwidth]{x}\end{figure}`), "Figure");
  assert.equal(fig.numbered, false);
  assert.equal(fig.caption, undefined);
  assert.deepEqual(fig.content, [{ t: "Plain", content: [{ t: "Image", src: "x", alt: [], width: "45%" }] }]);
});

test("subfigures become nested figures", () => {
  const fig = only(
    blocks(String.raw`\begin{figure}
\begin{subfigure}[b]{0.45\textwidth}\includegraphics{a}\caption{Left}\label{fig:a}\end{subfigure}
\hfill
\begin{subfigure}[b]{0.45\textwidth}\includegraphics{b}\caption{Right}\end{subfigure}
\caption{Both}\label{fig:both}
\end{figure}`),
    "Figure",
  );
  assert.equal(fig.label, "fig:both");
  assert.equal(fig.content.length, 2);
  assert.deepEqual(fig.content[0], {
    t: "Figure",
    content: [{ t: "Plain", content: [{ t: "Image", src: "a", alt: [] }] }],
    caption: [T("Left")],
    label: "fig:a",
    id: "fig-a",
    numbered: true,
    attr: { attrs: { width: "45%" } },
  });
  assert.deepEqual((fig.content[1] as Extract<Block, { t: "Figure" }>).caption, [T("Right")]);
});

test("\\subfloat and \\lstinputlisting", () => {
  const ctx = memoryContext({ "code/run.py": "print(1)\n" }, "main.tex");
  const doc = strip(
    parseLatex(
      String.raw`\begin{figure}\subfloat[Left\label{fig:l}]{\includegraphics{l}}\caption{Pair}\end{figure}
\lstinputlisting[language=Python]{code/run.py}
\lstinputlisting{missing.py}`,
      ctx,
    ),
  );
  const fig = doc.blocks[0] as Extract<Block, { t: "Figure" }>;
  assert.deepEqual(fig.content, [{ t: "Figure", content: [{ t: "Plain", content: [{ t: "Image", src: "l", alt: [] }] }], caption: [T("Left")], label: "fig:l", id: "fig-l", numbered: true }]);
  assert.deepEqual(doc.blocks[1], { t: "CodeBlock", text: "print(1)", lang: "python" });
  assert.deepEqual(codes(ctx.diagnostics.items), ["IO002"]);
});

// ------------------------------------------------------------ 8. tables

test("booktabs table with caption, label, multicolumn and a header row", () => {
  const table = only(
    blocks(String.raw`\begin{table}[h]
\centering
\caption{Results}\label{tbl:res}
\begin{tabular}{@{}l*{2}{c}|r@{}}
\toprule
Name & \multicolumn{2}{c}{Pair} & Total \\
\midrule
a & 1 & 2 & 3 \\
b & $x & y$ & {p & q} & 4 \\
\bottomrule
\end{tabular}
\end{table}`),
    "Table",
  );
  assert.deepEqual(table.align, ["left", "center", "center", "right"]);
  assert.deepEqual(table.caption, [T("Results")]);
  assert.deepEqual([table.label, table.id], ["tbl:res", "tbl-res"]);
  assert.deepEqual(table.head, [[{ content: [T("Name")] }, { content: [T("Pair")], colspan: 2, align: "center" }, { content: [T("Total")] }]]);
  assert.equal(table.body.length, 2);
  assert.deepEqual(table.body[1], [{ content: [T("b")] }, { content: [{ t: "Math", tex: "x & y" }] }, { content: [T("p & q")] }, { content: [T("4")] }]);
  assert.equal(table.widths, undefined);
});

test("\\hline after the first row marks a header; tabular outside a float has no caption", () => {
  const table = only(blocks(String.raw`\begin{tabular}{|l|r|}\hline A & B \\ \hline 1 & 2 \\ 3 & 4 \\ \hline\end{tabular}`), "Table");
  assert.equal(table.caption, undefined);
  assert.deepEqual(table.head, [[{ content: [T("A")] }, { content: [T("B")] }]]);
  assert.equal(table.body.length, 2);
  const noHead = only(blocks(String.raw`\begin{tabular}{ll} 1 & 2 \\ 3 & 4 \end{tabular}`), "Table");
  assert.deepEqual(noHead.head, []);
  assert.equal(noHead.body.length, 2);
});

test("relative column widths, X columns and \\multirow", () => {
  const t1 = only(blocks(String.raw`\begin{tabular}{p{0.2\textwidth}p{0.6\textwidth}} a & b \end{tabular}`), "Table");
  assert.deepEqual(t1.widths, [0.25, 0.75]);
  assert.deepEqual(t1.align, ["left", "left"]);
  const t2 = only(blocks(String.raw`\begin{tabularx}{\textwidth}{lXX} a & b & c \end{tabularx}`), "Table");
  assert.deepEqual(t2.widths, [null, 0.5, 0.5]);
  const t3 = only(blocks(String.raw`\begin{tabular}{lc}\multirow{2}{*}{Both} & 1 \\ & 2 \\\end{tabular}`), "Table");
  assert.deepEqual(t3.body, [[{ content: [T("Both")], rowspan: 2 }, { content: [T("1")] }], [{ content: [T("2")] }]]);
});

test("longtable \\endhead marks header rows", () => {
  const table = only(
    blocks(String.raw`\begin{longtable}{lr}
\caption{Long}\label{tbl:long}\\
H1 & H2 \\ \hline
\endhead
a & 1 \\
\end{longtable}`),
    "Table",
  );
  assert.deepEqual(table.head, [[{ content: [T("H1")] }, { content: [T("H2")] }]]);
  assert.deepEqual(table.body, [[{ content: [T("a")] }, { content: [T("1")] }]]);
  assert.deepEqual([table.caption, table.label], [[T("Long")], "tbl:long"]);
});

// ------------------------------------------------------------ 9. math

test("inline and display math", () => {
  assert.deepEqual(para(String.raw`a $x^2$ b \(y\) c`), [T("a "), { t: "Math", tex: "x^2" }, T(" b "), { t: "Math", tex: "y" }, T(" c")]);
  assert.deepEqual(blocks(String.raw`Before $$E=mc^2$$ after \[ a \label{eq:a} \]`), [
    { t: "Para", content: [T("Before")] },
    { t: "MathBlock", tex: "E=mc^2", numbered: false },
    { t: "Para", content: [T("after")] },
    { t: "MathBlock", tex: "a \\label{eq:a}", numbered: true, label: "eq:a", id: "eq-a" },
  ]);
});

test("math environments keep their body byte for byte", () => {
  const body = String.raw`  a &= \frac{1}{2} \label{eq:one} \\
  b &= 50\% \text{ of } {\{c\}} \nonumber \\[3pt]
  d &= e \label{eq:two}`;
  const mb = only(blocks(`\\begin{align}\n${body}\n\\end{align}`), "MathBlock");
  assert.equal(mb.tex, body.trim());
  assert.equal(mb.env, "align");
  assert.equal(mb.numbered, true);
  assert.equal(mb.label, "eq:one");
  const starred = blocks(String.raw`\begin{equation*}x\end{equation*}\begin{gather}y\end{gather}\begin{multline*}z\end{multline*}\begin{alignat}{2}p&=q\end{alignat}\begin{flalign}r\end{flalign}\begin{eqnarray}s&=&t\end{eqnarray}`) as Extract<
    Block,
    { t: "MathBlock" }
  >[];
  assert.deepEqual(
    starred.map((b) => [b.env, b.numbered, b.tex]),
    [
      ["equation*", false, "x"],
      ["gather", true, "y"],
      ["multline*", false, "z"],
      // alignat keeps its {n} column count: KaTeX needs it.
      ["alignat", true, "{2}p&=q"],
      ["flalign", true, "r"],
      ["eqnarray", true, "s&=&t"],
    ],
  );
});

test("math inside text-mode commands", () => {
  assert.deepEqual(para(String.raw`\textbf{area $\pi r^2$}`), [{ t: "Strong", content: [T("area "), { t: "Math", tex: "\\pi r^2" }] }]);
});

// ------------------------------------------------------------ 10. macros

test("\\newcommand with an optional argument: expanded in text, recorded in meta.macros", () => {
  const { doc, diags } = parse(String.raw`\newcommand{\greet}[2][World]{Hello, #1 and #2!}
\newcommand*\R{\mathbb{R}}
\greet{Ann} / \greet[Bob]{Cy} in $\R$`);
  assert.deepEqual(diags, []);
  // KaTeX has no optional arguments, so the recorded macro has the default baked in.
  assert.deepEqual(doc.meta.macros, { "\\greet": "Hello, World and #1!", "\\R": "\\mathbb{R}" });
  assert.deepEqual(doc.blocks, [{ t: "Para", content: [T("Hello, World and Ann! / Hello, Bob and Cy! in "), { t: "Math", tex: "\\R" }] }]);
});

test("\\def, \\providecommand, \\renewcommand and \\DeclareMathOperator", () => {
  const { doc, diags } = parse(String.raw`\def\pair#1#2{(#1, #2)}
\newcommand{\x}{one}
\providecommand{\x}{two}
\renewcommand{\x}{three}
\DeclareMathOperator{\tr}{tr}
\DeclareMathOperator*{\argmax}{arg\,max}
\pair{a}{b} \x`);
  assert.deepEqual(doc.blocks, [{ t: "Para", content: [T("(a, b) three")] }]);
  assert.deepEqual(doc.meta.macros, { "\\pair": "(#1, #2)", "\\x": "three", "\\tr": "\\operatorname{tr}", "\\argmax": "\\operatorname*{arg\\,max}" });
  assert.deepEqual(codes(diags), [], "\renewcommand redefines on purpose: no warning");
});

test("runaway macro recursion stops with LTX005", () => {
  const { doc, diags } = parse(String.raw`\newcommand{\loop}{a\loop}
\loop`);
  assert.deepEqual(codes(diags), ["LTX005"]);
  const text = (doc.blocks[0] as Extract<Block, { t: "Para" }>).content[0] as { text: string };
  assert.equal(text.text, "a".repeat(50));
});

test("ctx.macros is shared between fragments", () => {
  const ctx = memoryContext({}, "notes.md");
  ctx.macros = {};
  latexToBlocks(String.raw`\newcommand{\name}[1]{Dr.~#1}\DeclareMathOperator{\sgn}{sgn}`, ctx);
  assert.deepEqual(ctx.macros, { "\\name": "Dr.~#1", "\\sgn": "\\operatorname{sgn}" });
  assert.deepEqual(latexToInlines(String.raw`\name{Who}`, ctx), [T("Dr.\u00a0Who")]);
});

// ------------------------------------------------------------ 11. theorems

test("theorem environments", () => {
  const bs = blocks(String.raw`\newtheorem{thm}{Theorem}[section]
\newtheorem{lem}[thm]{Lemma}
\newtheorem*{note}{Note}
\begin{thm}[Fermat]\label{thm:f} Hard. \end{thm}
\begin{lem} Easy. \end{lem}
\begin{note} Aside. \end{note}
\begin{corollary} Builtin. \end{corollary}
\begin{proof}[Sketch] Done. \end{proof}`) as Extract<Block, { t: "Theorem" }>[];
  assert.deepEqual(bs[0], {
    t: "Theorem",
    kind: "thm",
    name: "Theorem",
    counter: "thm",
    withinSection: true,
    numbered: true,
    title: [T("Fermat")],
    label: "thm:f",
    id: "thm-f",
    blocks: [{ t: "Para", content: [T("Hard.")] }],
  });
  // The lemma shares thm's counter, so it is numbered within sections too.
  assert.deepEqual([bs[1].kind, bs[1].name, bs[1].counter, bs[1].numbered, bs[1].withinSection], ["lem", "Lemma", "thm", true, true]);
  assert.deepEqual([bs[2].name, bs[2].numbered, bs[2].counter], ["Note", false, undefined]);
  assert.deepEqual([bs[3].kind, bs[3].name, bs[3].counter], ["corollary", "Corollary", "corollary"]);
  assert.deepEqual(bs[4], { t: "Theorem", kind: "proof", name: "Proof", numbered: false, title: [T("Sketch")], blocks: [{ t: "Para", content: [T("Done.")] }] });
});

// ------------------------------------------------------------ 12. references and citations

test("reference commands", () => {
  assert.deepEqual(para(String.raw`\ref{a} \eqref{b} \pageref{c} \autoref{d} \cref{e,f} \Cref{g} \nameref{h}`), [
    { t: "Ref", label: "a", style: "number" },
    T(" "),
    { t: "Ref", label: "b", style: "eq" },
    T(" "),
    { t: "Ref", label: "c", style: "page" },
    T(" "),
    { t: "Ref", label: "d", style: "auto" },
    T(" "),
    // \cref and \Cref: cleveref groups, written out after numbering.
    { t: "Span", attr: { classes: ["tw-cref"] }, content: [{ t: "Ref", label: "e", style: "number" }, { t: "Ref", label: "f", style: "number" }] },
    T(" "),
    { t: "Span", attr: { classes: ["tw-cref", "tw-cref-cap"] }, content: [{ t: "Ref", label: "g", style: "number" }] },
    T(" "),
    { t: "Ref", label: "h", style: "auto" },
  ]);
});

test("a label with nothing to attach to becomes an anchor span", () => {
  assert.deepEqual(para(String.raw`Point\label{pt:a} here.`), [T("Point"), { t: "Span", attr: { id: "pt:a" }, content: [] }, T(" here.")]);
});

test("citation commands, modes, keys and optional arguments", () => {
  const cites = para(String.raw`\cite{a} \citep{b, c} \parencite{d} \autocite{e} \citet{f} \textcite{g} \citeauthor{h} \citeyear{i} \citeyearpar{j} \nocite{*}`).filter(
    (x): x is Extract<Inline, { t: "Cite" }> => x.t === "Cite",
  );
  assert.deepEqual(
    cites.map((c) => [c.mode, c.items.map((it) => it.key).join(",")]),
    [
      ["paren", "a"],
      ["paren", "b,c"],
      ["paren", "d"],
      ["paren", "e"],
      ["text", "f"],
      ["text", "g"],
      ["author", "h"],
      ["year", "i"],
      ["year", "j"],
      ["nocite", "*"],
    ],
  );
  const opt = (src: string) => (para(src)[0] as Extract<Inline, { t: "Cite" }>).items;
  assert.deepEqual(opt(String.raw`\citep[p.~4]{doe}`), [{ key: "doe", locator: "p. 4" }]);
  assert.deepEqual(opt(String.raw`\citep[12--15]{doe}`), [{ key: "doe", locator: "12\u201315" }]);
  assert.deepEqual(opt(String.raw`\cite[and references therein]{doe}`), [{ key: "doe", suffix: "and references therein" }]);
  assert.deepEqual(opt(String.raw`\citep[see][chap.~2]{doe,roe}`), [
    { key: "doe", prefix: "see" },
    { key: "roe", locator: "chap. 2" },
  ]);
  assert.deepEqual(opt(String.raw`\citep[e.g.][]{doe}`), [{ key: "doe", prefix: "e.g." }]);
  assert.deepEqual(opt(String.raw`\nocite{a,b}`), [{ key: "a" }, { key: "b" }]);
});

// ------------------------------------------------------------ 13. bibliography

test("bibliography commands", () => {
  const { doc } = parse(String.raw`\bibliographystyle{plainnat}
Text.
\bibliography{refs,more.bib}`);
  assert.deepEqual(doc.meta.bibliography, ["refs.bib", "more.bib"]);
  assert.equal(doc.meta.citationStyle, "author-year");
  assert.deepEqual(doc.blocks[1], { t: "Bibliography" });
  const b = parse(String.raw`\addbibresource{refs.bib}\bibliographystyle{unsrtnat}\printbibliography[heading=none]`).doc;
  assert.deepEqual(b.meta.bibliography, ["refs.bib"]);
  assert.equal(b.meta.citationStyle, "numeric");
  assert.deepEqual(b.blocks, [{ t: "Bibliography" }]);
});

test("thebibliography becomes a hand-written reference list", () => {
  const { doc, diags } = parse(String.raw`\begin{thebibliography}{9}
\bibitem{a} A. Author. \emph{Title}.
\bibitem[Knu84]{knuth} D. Knuth. \newblock The TeXbook.
\end{thebibliography}`);
  assert.deepEqual(codes(diags), []);
  const bib = only(doc.blocks, "Bibliography");
  assert.deepEqual(
    bib.items?.map((it) => it.key),
    ["a", "knuth"],
  );
  assert.deepEqual(bib.items?.[0]?.content, [{ t: "Text", text: "A. Author. " }, { t: "Emph", content: [{ t: "Text", text: "Title" }] }, { t: "Text", text: "." }]);
});

// ------------------------------------------------------------ 14. includes

test("\\input splices a file in place, with positions in that file", () => {
  const files = { "sec.tex": "\\section{From file}\n\nSome \\badcmd here.\n", "chap/two.tex": "Two." };
  const { doc, diags } = parse("Start.\n\n\\input{sec}\n\\include{chap/two}\nEnd.", files);
  assert.deepEqual(doc.blocks, [
    { t: "Para", content: [T("Start.")] },
    { t: "Heading", level: 1, content: [T("From file")], numbered: true, id: "from-file" },
    { t: "Para", content: [T("Some here. Two. End.")] },
  ]);
  assert.equal(diags.length, 1);
  assert.deepEqual([diags[0].code, diags[0].file, diags[0].line, diags[0].col], ["LTX001", "sec.tex", 3, 6]);
  assert.equal(diags[0].excerpt, "Some \\badcmd here.");
});

test("missing includes and include cycles", () => {
  const missing = parse("Text\n  \\input{nothere}", {});
  assert.deepEqual(codes(missing.diags), ["IO002"]);
  assert.deepEqual([missing.diags[0].line, missing.diags[0].col, missing.diags[0].file], [2, 3, "main.tex"]);
  assert.match(missing.diags[0].message, /nothere\.tex/);
  const cycle = parse("\\input{a}", { "a.tex": "A \\input{b}", "b.tex": "B \\input{main}" });
  assert.deepEqual(codes(cycle.diags), ["IO003"]);
  assert.equal(cycle.diags[0].file, "b.tex");
  assert.match(cycle.diags[0].message, /main\.tex -> a\.tex -> b\.tex -> main\.tex/);
  assert.deepEqual(cycle.doc.blocks, [{ t: "Para", content: [T("A B")] }]);
});

// ------------------------------------------------------------ 15. page and layout

test("page breaks and quiet layout commands", () => {
  const { doc, diags } = parse(String.raw`\noindent A\vspace{1em}\hspace*{2em}B\hfill C \smallskip\medskip\bigskip
\newpage
\setlength{\parindent}{0pt}\setcounter{page}{3}\pagestyle{empty}\thispagestyle{plain}\raggedright
\clearpage\cleardoublepage\pagebreak[4]`);
  assert.deepEqual(diags, []);
  const hfill: Inline = { t: "Span", attr: { classes: ["hfill"] }, content: [] };
  const noindent: Inline = { t: "Span", attr: { classes: ["noindent"] }, content: [] };
  assert.deepEqual(doc.blocks, [{ t: "Para", content: [noindent, T("A B "), hfill, T("C")] }, { t: "PageBreak" }, { t: "PageBreak" }, { t: "PageBreak" }, { t: "PageBreak" }]);
});

// ------------------------------------------------------------ 16. unsupported input and recovery

test("an unknown command warns once per file and keeps its argument text", () => {
  const { doc, diags } = parse(String.raw`\foo{one} \foo[x]{two}
\foo{three}`);
  assert.deepEqual(codes(diags), ["LTX001"]);
  assert.deepEqual([diags[0].line, diags[0].col], [1, 1]);
  assert.deepEqual(doc.blocks, [{ t: "Para", content: [T("one two three")] }]);
});

test("an unknown environment warns and keeps its body", () => {
  const { doc, diags } = parse(String.raw`\begin{boxed}Inside \emph{it}.\end{boxed}`);
  assert.deepEqual(codes(diags), ["LTX002"]);
  assert.deepEqual(doc.blocks, [{ t: "Div", attr: { classes: ["boxed"] }, blocks: [{ t: "Para", content: [T("Inside "), { t: "Emph", content: [T("it")] }, T(".")] }] }]);
});

test("TikZ and pgfplots become drawn images; a pspicture with nothing to draw keeps LTX004 and a raw placeholder", () => {
  const { doc, diags } = parse(String.raw`\begin{figure}
\begin{tikzpicture}
  \begin{axis}\addplot {x^2};\end{axis}
\end{tikzpicture}
\caption{Drawn}
\end{figure}
Inline \tikz \draw (0,0) -- (1,1); done.

\begin{pspicture}(0,0)(2,2)\end{pspicture}`);
  assert.deepEqual(codes(diags), ["LTX004"]);
  assert.equal(diags[0].hint, "Render this figure to SVG or PNG and include it with \\includegraphics");
  const fig = doc.blocks[0] as Extract<Block, { t: "Figure" }>;
  const img = (fig.content[0] as Extract<Block, { t: "Plain" }>).content[0] as Extract<Inline, { t: "Image" }>;
  assert.equal(img.t, "Image");
  assert.match(img.src, /^data:image\/svg\+xml;base64,/);
  assert.deepEqual(img.attr?.classes, ["tw-diagram", "tikz"]);
  const para = doc.blocks[1] as Extract<Block, { t: "Para" }>;
  assert.deepEqual(para.content[0], T("Inline "));
  assert.equal(para.content[1].t, "Image");
  assert.equal(doc.blocks[2].t, "RawBlock");
  assert.match((doc.blocks[2] as { text: string }).text, /^\\begin\{pspicture\}[\s\S]*\\end\{pspicture\}$/);
});

test("an unclosed brace is reported at its position and later sections still parse", () => {
  const { doc, diags } = parse(String.raw`\section{One}
Text with \textbf{bold that never closes

\section{Two}
Fine.`);
  assert.deepEqual(codes(diags), ["LTX003"]);
  assert.deepEqual([diags[0].line, diags[0].col], [2, 18]);
  assert.deepEqual(
    doc.blocks.map((b) => b.t),
    ["Heading", "Para", "Heading", "Para"],
  );
  assert.deepEqual((doc.blocks[2] as Extract<Block, { t: "Heading" }>).content, [T("Two")]);
});

test("stray \\end, stray brace and unclosed environments", () => {
  const stray = parse("a \\end{itemize} b } c");
  assert.deepEqual(codes(stray.diags), ["LTX003", "LTX003"]);
  assert.deepEqual(stray.doc.blocks, [{ t: "Para", content: [T("a b c")] }]);
  const unclosed = parse("\\begin{quote}\nQuoted.\n\n\\section{After}");
  assert.deepEqual(codes(unclosed.diags), ["LTX003"]);
  assert.deepEqual([unclosed.diags[0].line, unclosed.diags[0].col], [1, 1]);
  assert.match(unclosed.diags[0].message, /\\begin\{quote\} is never closed/);
  const mismatch = parse("\\begin{itemize}\\item \\begin{center}x\\end{itemize} after");
  assert.deepEqual(codes(mismatch.diags), ["LTX003"]);
  assert.match(mismatch.diags[0].message, /center/);
  assert.equal(mismatch.doc.blocks[0].t, "List");
  assert.deepEqual(mismatch.doc.blocks[1], { t: "Para", content: [T("after")] });
});

test("unclosed math and \\verb are reported", () => {
  const { doc, diags } = parse("a $x + y\n\nb \\(z\n\nc \\verb|code");
  assert.deepEqual(codes(diags).sort(), ["LTX003", "LTX003", "LTX005"]);
  assert.deepEqual(doc.blocks, [
    { t: "Para", content: [T("a "), { t: "Math", tex: "x + y" }] },
    { t: "Para", content: [T("b "), { t: "Math", tex: "z" }] },
    { t: "Para", content: [T("c "), { t: "Code", text: "code" }] },
  ]);
  const missingEnd = parse("\\begin{document}\nText.");
  assert.deepEqual(codes(missingEnd.diags), ["LTX003"]);
  assert.deepEqual(missingEnd.doc.blocks, [{ t: "Para", content: [T("Text.")] }]);
});

test("\\newenvironment, \\let, braceless \\input and \\endinput", () => {
  const files = { "part.tex": "Kept. \\endinput Dropped." };
  const { doc, diags } = parse(
    String.raw`\newenvironment{note}[1][Note]{\begin{quote}\textbf{#1:}}{\end{quote}}
\let\oldemph\emph
\begin{note}Careful.\end{note}
\begin{note}[Tip]\oldemph{Easy}.\end{note}
\input part
After.`,
    files,
  );
  assert.deepEqual(diags, []);
  assert.deepEqual(doc.blocks, [
    { t: "BlockQuote", blocks: [{ t: "Para", content: [{ t: "Strong", content: [T("Note:")] }, T("Careful.")] }] },
    { t: "BlockQuote", blocks: [{ t: "Para", content: [{ t: "Strong", content: [T("Tip:")] }, { t: "Emph", content: [T("Easy")] }, T(".")] }] },
    { t: "Para", content: [T("Kept. After.")] },
  ]);
  assert.equal(doc.meta.macros?.["\\oldemph"], "\\emph");
});

test("malformed input never throws and always terminates", () => {
  const inputs = [
    "{{{{",
    "}}}}",
    "\\begin{itemize}\\item",
    "$$x",
    "\\[",
    "\\verb",
    "\\begin{tabular}{ll} a & b \\\\",
    "\\newcommand",
    "\\newcommand{\\a}[x]{y}\\a",
    "\\def\\a#1.{x}\\a.",
    "\\section",
    "\\textbf",
    "\\begin{figure}\\caption{",
    "\\end",
    "\\begin{",
    "\\input",
    "\\footnote{\\begin{itemize}\\item a}",
    "\\begin{enumerate}}\\end{enumerate}",
    "\\multicolumn{2}{c}{x} & \\\\ & \\hline",
    "\\begin{lstlisting}\nno end",
    "\\'",
    "\\",
    "\\begin{theorem}[unclosed",
    "\\cite[p.~4]",
    "\\def",
    "\\let",
    "\\newenvironment{x}{\\begin{x}}{}\\begin{x}y\\end{x}",
    "\\newcommand{\\a}{\\a\\a}\\a",
    "\\begin{document}\\begin{document}\\end{document}",
    "\\item[x] \\label{} \\ref{} \\cite{}",
    "\\textbf{\\constructor \\toString \\__proto__}",
  ];
  for (const src of inputs) {
    const ctx = memoryContext({}, "bad.tex");
    assert.doesNotThrow(() => parseLatex(src, ctx), src);
    assert.doesNotThrow(() => latexToInlines(src, memoryContext()), src);
  }
  const ctx = memoryContext({}, "bad.tex");
  parseLatex("\\newcommand{\\a}{\\a\\a}\\a", ctx);
  assert.deepEqual(codes(ctx.diagnostics.items), ["LTX005"]);
});

// ------------------------------------------------------------ 17. fragments and positions

test("searches that come up empty still report every unclosed construct where it opened", () => {
  const src = "\\label{\n\na\\cite[x\n\n\\begin{equation}\n\nb\\[\n\nc$$\n\n\\begin{tikzpicture}\n\nd\\url{e\n\nf\\lstinline[x";
  const { diags } = parse(src);
  assert.deepEqual(
    diags.map((d) => `${d.code}@${d.line}:${d.col}`),
    ["LTX005@15:2", "LTX003@1:7", "LTX005@1:1", "LTX003@5:1", "LTX003@7:2", "LTX003@9:2", "LTX003@11:1", "LTX004@11:1", "LTX003@13:6"],
  );
  const repeated = parse("\\label{a\n\n\\label{b\n\n\\label{c}");
  assert.deepEqual(codes(repeated.diags), ["LTX003", "LTX003"]);
  assert.equal(repeated.doc.blocks.length, 3);
});

test("column repeats stop at 1,000 columns", () => {
  const table = only(blocks("\\begin{tabular}{*{3}{c}|*{100}{*{100}{l}}}a\\end{tabular}"), "Table");
  assert.equal(table.align.length, 1000);
  assert.deepEqual(table.align.slice(0, 4), ["center", "center", "center", "left"]);
});

test("macro expansion that would write millions of characters stops with LTX005", () => {
  const { diags } = parse("\\newcommand\\a[1]{#1#1}" + "\\a{".repeat(15) + "x".repeat(20000) + "}".repeat(15));
  assert.ok(diags.some((d) => d.code === "LTX005" && /4,000,000 characters/.test(d.message)));
});

test("sections with the same title get numbered ids in order", () => {
  const ids = blocks("\\section{A}\\section{A}\\section{A-1}\\section{A}").map((b) => (b.t === "Heading" ? b.id : ""));
  assert.deepEqual(ids, ["a", "a-1", "a-1-1", "a-2"]);
});

test("fragments report diagnostics with the context's offsets", () => {
  const ctx = memoryContext({}, "doc.md");
  ctx.lineOffset = 10;
  ctx.colOffset = 4;
  const inl = latexToInlines(String.raw`see \unknowncmd{x} and \ref{fig:a}`, ctx);
  assert.deepEqual(strip(inl), [T("see x and "), { t: "Ref", label: "fig:a", style: "number" }]);
  const d = ctx.diagnostics.items[0];
  assert.deepEqual([d.code, d.file, d.line, d.col], ["LTX001", "doc.md", 11, 9]);
  const ref = inl[1] as Extract<Inline, { t: "Ref" }>;
  assert.deepEqual(ref.pos, { file: "doc.md", line: 11, col: 28 });
  const ctx2 = memoryContext({}, "doc.md");
  ctx2.lineOffset = 4;
  const bs = latexToBlocks("\\newcommand{\\x}{X}\n\\begin{itemize}\n\\item \\x\n\\end{itemize}\n\\badone", ctx2);
  assert.deepEqual(strip(bs), [{ t: "List", ordered: false, tight: true, items: [[{ t: "Plain", content: [T("X")] }]] }]);
  assert.deepEqual([ctx2.diagnostics.items[0].line, ctx2.diagnostics.items[0].col], [9, 1]);
});

test("node positions point at the source", () => {
  const { raw } = parse("Intro.\n\n\\section{A}\n  $x$ and \\cite{k}\n\\begin{equation}\ny\n\\end{equation}");
  assert.deepEqual(raw.blocks[0].pos, { file: "main.tex", line: 1, col: 1 });
  assert.deepEqual(raw.blocks[1].pos, { file: "main.tex", line: 3, col: 1 });
  const p = raw.blocks[2] as Extract<Block, { t: "Para" }>;
  assert.deepEqual(p.pos, { file: "main.tex", line: 4, col: 3 });
  assert.deepEqual(p.content[0].pos, { file: "main.tex", line: 4, col: 3 });
  assert.deepEqual(p.content[2].pos, { file: "main.tex", line: 4, col: 11 });
  assert.deepEqual(raw.blocks[3].pos, { file: "main.tex", line: 5, col: 1 });
});

// ------------------------------------------------------------ a realistic article

const ARTICLE = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,amsthm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[numbers]{natbib}

\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newcommand{\R}{\mathbb{R}}
\DeclareMathOperator{\tr}{tr}

\title{Heat Flow on Graphs}
\author{Ada Lovelace \and Alan Turing}
\date{October 1, 2026}

\begin{document}
\maketitle

\begin{abstract}
We study heat flow on finite graphs.
\end{abstract}

\section{Introduction}
\label{sec:intro}
Heat diffusion is classical~\citep[see][ch.~2]{doe2020}.
We follow \citet{roe2019} closely.\footnote{All graphs are simple.}

\section{Model}
\label{sec:model}
Let $G=(V,E)$ be a graph and $L$ its Laplacian on $\R^n$.
\begin{align}
  \dot u &= -L u \label{eq:heat}\\
  E(t) &= \tfrac12 \|u(t)\|^2 \label{eq:energy}
\end{align}
Equation~\eqref{eq:heat} conserves mass.

\begin{figure}[htbp]
  \centering
  \includegraphics[width=0.8\linewidth]{figures/decay}
  \caption{Energy decay over time.}
  \label{fig:decay}
\end{figure}

\begin{table}[h]
  \centering
  \caption{Results by graph size.}
  \label{tbl:results}
  \begin{tabular}{@{}lrr@{}}
    \toprule
    & \multicolumn{2}{c}{Time (s)} \\
    \cmidrule(lr){2-3}
    Graph & Exact & Approx \\
    \midrule
    Path & 1.2 & 0.9 \\
    Cycle & 2.4 & 1.1 \\
    \bottomrule
  \end{tabular}
\end{table}

\begin{theorem}[Decay]\label{thm:decay}
The energy $E(t)$ is non-increasing.
\end{theorem}
\begin{proof}
Differentiate~\eqref{eq:energy}.
\end{proof}

\section{Conclusion}
See Figure~\ref{fig:decay} and Table~\ref{tbl:results}.

\bibliographystyle{plainnat}
\bibliography{refs}
\end{document}
`;

test("a realistic article, node by node", () => {
  assert.ok(ARTICLE.split("\n").length > 60);
  const { doc, diags } = parse(ARTICLE);
  assert.deepEqual(diags, []);

  assert.deepEqual(doc.meta.title, [T("Heat Flow on Graphs")]);
  assert.deepEqual(doc.meta.author, [[T("Ada Lovelace")], [T("Alan Turing")]]);
  assert.deepEqual(doc.meta.date, [T("October 1, 2026")]);
  assert.deepEqual(doc.meta.abstract, [{ t: "Para", content: [T("We study heat flow on finite graphs.")] }]);
  assert.deepEqual(doc.meta.macros, { "\\R": "\\mathbb{R}", "\\tr": "\\operatorname{tr}" });
  assert.deepEqual(doc.meta.bibliography, ["refs.bib"]);
  // \usepackage[numbers]{natbib} wins over \bibliographystyle{plainnat}, as in LaTeX.
  assert.equal(doc.meta.citationStyle, "numeric");

  assert.deepEqual(
    doc.blocks.map((b) => b.t),
    ["Heading", "Para", "Heading", "Para", "MathBlock", "Para", "Figure", "Table", "Theorem", "Theorem", "Heading", "Para", "Bibliography"],
  );
  const [intro, introPara, , modelPara, align, eqPara, figure, table, theorem, proof, conclusion] = doc.blocks;
  assert.deepEqual(intro, { t: "Heading", level: 1, content: [T("Introduction")], numbered: true, label: "sec:intro", id: "sec-intro" });
  assert.deepEqual((introPara as Extract<Block, { t: "Para" }>).content, [
    T("Heat diffusion is classical\u00a0"),
    { t: "Cite", mode: "paren", items: [{ key: "doe2020", prefix: "see", locator: "ch. 2" }] },
    T(". We follow "),
    { t: "Cite", mode: "text", items: [{ key: "roe2019" }] },
    T(" closely."),
    { t: "Note", blocks: [{ t: "Para", content: [T("All graphs are simple.")] }] },
  ]);
  assert.deepEqual((modelPara as Extract<Block, { t: "Para" }>).content.filter((x) => x.t === "Math"), [
    { t: "Math", tex: "G=(V,E)" },
    { t: "Math", tex: "L" },
    { t: "Math", tex: "\\R^n" },
  ]);
  assert.deepEqual(align, {
    t: "MathBlock",
    tex: ["\\dot u &= -L u \\label{eq:heat}\\\\", "  E(t) &= \\tfrac12 \\|u(t)\\|^2 \\label{eq:energy}"].join("\n"),
    env: "align",
    numbered: true,
    label: "eq:heat",
    id: "eq-heat",
  });
  assert.deepEqual((eqPara as Extract<Block, { t: "Para" }>).content, [T("Equation\u00a0"), { t: "Ref", label: "eq:heat", style: "eq" }, T(" conserves mass.")]);
  assert.deepEqual(figure, {
    t: "Figure",
    content: [{ t: "Plain", content: [{ t: "Image", src: "figures/decay", alt: [], width: "80%" }] }],
    caption: [T("Energy decay over time.")],
    label: "fig:decay",
    id: "fig-decay",
    numbered: true,
  });
  assert.deepEqual(table, {
    t: "Table",
    caption: [T("Results by graph size.")],
    label: "tbl:results",
    id: "tbl-results",
    align: ["left", "right", "right"],
    head: [
      [{ content: [] }, { content: [T("Time (s)")], colspan: 2, align: "center" }],
      [{ content: [T("Graph")] }, { content: [T("Exact")] }, { content: [T("Approx")] }],
    ],
    body: [
      [{ content: [T("Path")] }, { content: [T("1.2")] }, { content: [T("0.9")] }],
      [{ content: [T("Cycle")] }, { content: [T("2.4")] }, { content: [T("1.1")] }],
    ],
    plainHead: true,
  });
  assert.deepEqual(theorem, {
    t: "Theorem",
    kind: "theorem",
    name: "Theorem",
    counter: "theorem",
    withinSection: true,
    numbered: true,
    title: [T("Decay")],
    label: "thm:decay",
    id: "thm-decay",
    blocks: [{ t: "Para", content: [T("The energy "), { t: "Math", tex: "E(t)" }, T(" is non-increasing.")] }],
  });
  assert.deepEqual(proof, {
    t: "Theorem",
    kind: "proof",
    name: "Proof",
    numbered: false,
    blocks: [{ t: "Para", content: [T("Differentiate\u00a0"), { t: "Ref", label: "eq:energy", style: "eq" }, T(".")] }],
  });
  assert.deepEqual(conclusion, { t: "Heading", level: 1, content: [T("Conclusion")], numbered: true, id: "conclusion" });
});

// ------------------------------------------------------------ classes and packages language models reach for

test("algorithm floats and algorithmic lines: keywords, depth, numbering", () => {
  const { doc, diags } = parse(String.raw`\begin{algorithm}
\caption{Search}\label{alg:s}
\begin{algorithmic}[1]
\Require a list $L$
\For{$x \in L$} \Comment{each item}
  \If{$x = t$} \State \Return $x$ \EndIf
\EndFor
\end{algorithmic}
\end{algorithm}`);
  assert.deepEqual(codes(diags), []);
  const fig = only(doc.blocks, "Figure");
  assert.deepEqual(fig.attr, { classes: ["algorithm"] });
  const alg = fig.content[0] as Extract<Block, { t: "Div" }>;
  assert.deepEqual(alg.attr.classes, ["algorithmic"]);
  assert.deepEqual(alg.attr.attrs, { numbered: "1" });
  const lines = alg.blocks.map((l) => {
    const d = l as Extract<Block, { t: "Div" }>;
    const text = JSON.stringify(d.blocks).match(/"text":"[^"]*"/g)?.map((m) => m.slice(8, -1)).join("") ?? "";
    return [d.attr.attrs?.level, d.attr.classes?.includes("alg-nonum") ?? false, text.trim()];
  });
  assert.deepEqual(lines, [
    ["0", true, "Require: a list"],
    ["0", false, "for  do  each item"],
    ["1", false, "if  then"],
    ["2", false, "return"],
    ["1", false, "end if"],
    ["0", false, "end for"],
  ]);
});

test("the letter class: address and date, recipient, opening, closing with signature", () => {
  const { doc, diags } = parse(String.raw`\documentclass{letter}
\address{1 Main St\\Springfield}\signature{Ada}\date{May 1, 2026}
\begin{document}
\begin{letter}{Dr. Turing\\Bletchley}
\opening{Dear Alan,}
Thank you.
\closing{Yours,}
\encl{CV}
\end{letter}
\end{document}`);
  assert.deepEqual(codes(diags), []);
  const letter = only(doc.blocks, "Div");
  assert.deepEqual(letter.attr.classes, ["letter"]);
  const kinds = letter.blocks.map((b) => (b.t === "Div" ? b.attr.classes![0] : b.t));
  assert.deepEqual(kinds, ["letter-from", "letter-to", "Para", "Para", "letter-closing", "Para"]);
  assert.match(JSON.stringify(letter.blocks[0]), /May 1, 2026/);
  assert.match(JSON.stringify(letter.blocks[4]), /Yours,.*Ada/);
  assert.equal(doc.meta.date, undefined, "the date moved into the letter");
});

test("the exam class: questions with points, parts, solutions only with \\printanswers, counts", () => {
  const src = (answers: boolean) => String.raw`\documentclass{exam}
${answers ? "\\printanswers" : ""}
\begin{document}
There are \numquestions\ questions worth \numpoints\ points.
\ifprintanswers Key\else Student\fi.
\begin{questions}
\question[4] First?
\begin{solution} Yes. \end{solution}
\question Second:
\begin{parts}
\part[3] a
\part[2] b
\end{parts}
\end{questions}
\end{document}`;
  const key = parse(src(true));
  assert.deepEqual(codes(key.diags), []);
  const text = JSON.stringify(key.doc.blocks);
  assert.match(text, /There are 2 questions worth 9 points\./);
  assert.match(text, /Key/);
  assert.doesNotMatch(text, /Student/);
  assert.match(text, /\(4 points\) First\?/);
  assert.match(text, /"Solution\."/);
  const parts = JSON.stringify(key.doc.blocks).match(/"delim":"\(\)"/);
  assert.ok(parts, "parts are labelled (a), (b)");
  const student = JSON.stringify(parse(src(false)).doc.blocks);
  assert.match(student, /Student/);
  assert.doesNotMatch(student, /Solution\./);
});

test("\\iffalse, \\newif and nested conditionals skip whole branches", () => {
  const { doc, diags } = parse(String.raw`\newif\ifdraft \drafttrue
\iffalse hidden \ifdraft also hidden \fi \fi
\ifdraft shown\else not shown\fi
\draftfalse \ifdraft no\else yes\fi`);
  assert.deepEqual(codes(diags), []);
  const text = JSON.stringify(doc.blocks);
  assert.doesNotMatch(text, /hidden|not shown|"no"/);
  assert.match(text, /shown/);
  assert.match(text, /yes/);
});

test("\\includesvg is an SVG image; \\hrulefill fills the line", () => {
  const img = para(String.raw`\includesvg[width=0.5\textwidth]{plots/fit}`);
  assert.deepEqual(img, [{ t: "Image", src: "plots/fit.svg", alt: [], width: "50%" }]);
  const rule = para(String.raw`Name: \hrulefill`);
  assert.deepEqual(rule[rule.length - 1], { t: "Span", attr: { classes: ["hrulefill"] }, content: [] });
});

test("\\qedhere in display math is known to the math engine; tikz-cd in text becomes display math", () => {
  const { doc, diags } = parse(String.raw`\begin{tikzcd} A \arrow[r] & B \end{tikzcd}`);
  assert.deepEqual(codes(diags), []);
  assert.equal(only(doc.blocks, "MathBlock").tex, String.raw`\begin{tikzcd} A \arrow[r] & B \end{tikzcd}`);
});

test("a stray math command in text is typeset as math, with a note", () => {
  const { doc, diags } = parse(String.raw`Angle \alpha here.`);
  assert.deepEqual(codes(diags), ["LTX006"]);
  assert.deepEqual(doc.blocks, [{ t: "Para", content: [T("Angle "), { t: "Math", tex: "\\alpha" }, T(" here.")] }]);
});

test("counters: \\newcounter, \\stepcounter, \\theX, \\arabic and \\roman; secnumdepth turns numbers off", () => {
  const { doc, diags } = parse(String.raw`\newcounter{problem}
\newcommand{\problem}{\stepcounter{problem}Problem \theproblem.}
\problem\ \problem\ \setcounter{problem}{4}\addtocounter{problem}{1}(\roman{problem}, \Alph{problem}, \arabic{problem})
\setcounter{secnumdepth}{0}`);
  assert.deepEqual(codes(diags), []);
  assert.match(JSON.stringify(doc.blocks), /Problem 1\. Problem 2\. \(v, E, 5\)/);
  assert.equal(doc.meta.numberSections, false);
});

test("\\rule, \\hrule, \\texorpdfstring and titlesec setup", () => {
  const { doc, diags } = parse(String.raw`\titleformat{\section}{\large\bfseries}{}{0em}{}[\titlerule]
\titlespacing*{\section}{0pt}{8pt}{4pt}
\section{Root \texorpdfstring{$\sqrt{2}$}{sqrt 2}}
By: \rule{6cm}{0.4pt}

\hrule`);
  assert.deepEqual(codes(diags), []);
  const [heading, sig, rule] = doc.blocks;
  assert.deepEqual((heading as Extract<Block, { t: "Heading" }>).content, [T("Root "), { t: "Math", tex: "\\sqrt{2}" }]);
  assert.deepEqual((sig as Extract<Block, { t: "Para" }>).content, [T("By: "), { t: "Span", attr: { classes: ["rule"], attrs: { width: "6cm", height: "0.4pt" } }, content: [] }]);
  assert.deepEqual(rule, { t: "Div", attr: { classes: ["hrule"] }, blocks: [] });
});

test("colours: \\textcolor, \\color switches, \\definecolor and xcolor mixes; enumitem labels", () => {
  const color = (hex: string, ...content: Inline[]): Inline => ({ t: "Span", attr: { classes: ["color"], attrs: { color: hex } }, content });
  assert.deepEqual(
    para(String.raw`\definecolor{accent}{HTML}{1F4E79}\textcolor{red}{a} \textcolor{accent}{b} {\color{blue!60!black}c} \textcolor{nosuch}{d}`),
    [color("#ff0000", T("a")), T(" "), color("#1f4e79", T("b")), T(" "), color("#000099", T("c")), T(" d")],
  );
  const list = only(blocks(String.raw`\begin{enumerate}[label=(\alph*)]\item x\end{enumerate}`), "List");
  assert.equal(list.style, "lower-alpha");
  assert.equal(list.delim, "()");
});

test("tcolorbox and \\newtcolorbox become titled, coloured boxes; \\hfill and \\parindent", () => {
  const { doc, diags } = parse(String.raw`\setlength{\parindent}{0pt}
\newtcolorbox{keybox}[1][]{colback=teal!4, colframe=teal!55!black, title={#1}}
\begin{keybox}[Bayes' theorem]
Text.
\end{keybox}
\begin{tcolorbox}
Plain.
\end{tcolorbox}
Title \hfill 2024`);
  assert.deepEqual(codes(diags), []);
  const [box, plain, line] = doc.blocks as Extract<Block, { t: "Div" }>[];
  assert.deepEqual(box!.attr, { classes: ["box"], attrs: { title: "Bayes’ theorem", background: "#f5fafa", frame: "#004646" } });
  assert.deepEqual(plain!.attr, { classes: ["box"], attrs: { title: "" } });
  assert.deepEqual((line as unknown as Extract<Block, { t: "Para" }>).content, [T("Title "), { t: "Span", attr: { classes: ["hfill"] }, content: [] }, T("2024")]);
  assert.equal(doc.meta.extra?.parindent, "0pt");
});

// ------------------------------------------------------------ packages and classes models reach for

test("lipsum and blindtext write placeholder paragraphs", () => {
  const bs = blocks(String.raw`\lipsum[1-2]

\lipsum[3][1-2]

\blindtext`);
  assert.equal(bs.length, 4);
  assert.ok(bs.every((b) => b.t === "Para" && /^[A-Z][a-z]+ /.test((b.content[0] as { text: string }).text)));
  const two = (bs[2] as Extract<Block, { t: "Para" }>).content[0] as { text: string };
  assert.equal(two.text.match(/\./g)?.length, 2);
});

test("cleveref ranges, \\subref and threeparttable notes", () => {
  const { doc, diags } = parse(String.raw`See \crefrange{a}{b} and \subref{c}.
\begin{table}
\begin{threeparttable}
\begin{tabular}{ll}
A\tnote{a} & \makecell{one\\ two} \\
\end{tabular}
\begin{tablenotes}
\item[a] A note.
\end{tablenotes}
\end{threeparttable}
\end{table}`);
  assert.deepEqual(codes(diags), []);
  const p = doc.blocks[0] as Extract<Block, { t: "Para" }>;
  assert.deepEqual(p.content.slice(1, 4), [{ t: "Ref", label: "a", style: "auto" }, T(" to "), { t: "Ref", label: "b", style: "number" }]);
  const table = doc.blocks[1] as Extract<Block, { t: "Table" }>;
  assert.deepEqual(table.body[0]![0]!.content, [T("A"), { t: "Superscript", content: [T("a")] }]);
  assert.deepEqual(table.body[0]![1]!.content, [T("one two")]);
  const notes = doc.blocks[2] as Extract<Block, { t: "Div" }>;
  assert.deepEqual(notes.attr.classes, ["tablenotes"]);
  assert.deepEqual((notes.blocks[0] as Extract<Block, { t: "Plain" }>).content, [{ t: "Superscript", content: [T("a")] }, T(" A note.")]);
});

test("algorithm2e: lines end at \\;, blocks indent, inputs are unnumbered", () => {
  const { doc, diags } = parse(String.raw`\usepackage[ruled,linesnumbered]{algorithm2e}
\begin{algorithm}
\SetAlgoLined
\SetKwFunction{Swap}{Swap}
\KwIn{array $A$}
\For{$i \gets 1$ \KwTo $n$}{
  \eIf{$A[i] > 0$}{\Swap{$i$}\;}{skip\;}
}
\Return $A$\; \tcp*{done}
\caption{Demo}\label{alg:demo}
\end{algorithm}`);
  assert.deepEqual(codes(diags), []);
  const fig = doc.blocks[0] as Extract<Block, { t: "Figure" }>;
  assert.equal(fig.label, "alg:demo");
  const alg = fig.content[0] as Extract<Block, { t: "Div" }>;
  assert.deepEqual(alg.attr, { classes: ["algorithmic"], attrs: { numbered: "1" } });
  const word = (x: Inline): string =>
    x.t === "Text" ? x.text : x.t === "Strong" ? `*${x.content.map(word).join("")}*` : x.t === "Math" ? `$${x.tex}$` : x.t === "SmallCaps" ? x.content.map(word).join("") : "";
  const lines = alg.blocks.map((b) => {
    const d = b as Extract<Block, { t: "Div" }>;
    const text = (d.blocks[0] as Extract<Block, { t: "Plain" }>).content.map(word).join("");
    return `${d.attr.attrs!.level}${d.attr.classes!.includes("alg-nonum") ? "-" : ""} ${text}`;
  });
  assert.deepEqual(lines, [
    "0- *Input:* array $A$",
    "0 *for* $i \\gets 1$ *to* $n$ *do*",
    "1 *if* $A[i] > 0$ *then*",
    "2 Swap($i$)",
    "1 *else*",
    "2 skip",
    "1 *end*",
    "0 *end*",
    "0 *return* $A$ // done",
  ]);
});

test("moderncv: name, job title, contacts and entries", () => {
  const { doc, diags } = parse(String.raw`\documentclass{moderncv}
\name{Ada}{Lovelace}
\title{Analyst}
\email{ada@example.com}
\phone[mobile]{123}
\begin{document}
\makecvtitle
\section{Experience}
\cventry{1843}{Translator}{Menabrea}{Turin}{}{Notes on the engine.}
\cvitem{Languages}{English, French}
\end{document}`);
  assert.deepEqual(codes(diags), []);
  assert.deepEqual(doc.meta.title, [T("Ada Lovelace")]);
  assert.deepEqual(doc.meta.subtitle, [T("Analyst")]);
  assert.equal(doc.meta.extra?.parindent, "0pt");
  const contact = doc.blocks[0] as Extract<Block, { t: "Div" }>;
  assert.deepEqual(contact.attr.classes, ["center"]);
  const text = JSON.stringify(doc.blocks.slice(2));
  for (const s of ["Translator", "Menabrea", "Turin", "1843", "Notes on the engine.", "Languages", "English, French"]) assert.ok(text.includes(s), s);
});

test("title pages: IEEEtran blocks, authblk keys, revtex affiliations, llncs institutes, elsarticle", () => {
  const ieee = parse(String.raw`\author{\IEEEauthorblockN{Ana}\IEEEauthorblockA{Dept. A\\ City} \and \IEEEauthorblockN{Ben}\IEEEauthorblockA{Dept. B}}`).doc.meta;
  assert.deepEqual(ieee.author, [[T("Ana")], [T("Ben")]]);
  assert.deepEqual(ieee.affiliation, [[T("Dept. A"), { t: "LineBreak" }, T("City")], [T("Dept. B")]]);
  const authblk = parse(String.raw`\author[1]{Omar}\author[1,2]{Lena}\affil[1]{Uni A}\affil[2]{Uni B}`).doc.meta;
  assert.deepEqual(authblk.affiliation, [[T("Uni A")], [T("Uni A"), { t: "LineBreak" }, T("Uni B")]]);
  const revtex = parse(String.raw`\documentclass{revtex4-2}\begin{document}\author{L. Wei}\affiliation{Inst. X}\author{R. Patel}\affiliation{Inst. Y}\email{r@y.edu}\maketitle\end{document}`);
  assert.deepEqual(codes(revtex.diags), []);
  assert.deepEqual(revtex.doc.meta.affiliation?.[0], [T("Inst. X")]);
  assert.equal(revtex.doc.meta.affiliation?.[1]?.[2]?.t, "Link");
  const llncs = parse(String.raw`\author{Ines\inst{1} \and Tom\inst{2}}\institute{Paris \and Oxford}`).doc.meta;
  assert.deepEqual(llncs.affiliation, [[T("Paris")], [T("Oxford")]]);
  const els = parse(String.raw`\author[a]{Hiro}\affiliation[a]{organization={Kyoto University}, country={Japan}}`).doc.meta;
  assert.deepEqual(els.affiliation, [[T("Kyoto University, Japan")]]);
});

test("beamer frames become headings, blocks become boxes, overlays show everything", () => {
  const { doc, diags } = parse(String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{Why graphs?}
\begin{itemize}
\item<1-> One \pause
\item<2-> Two
\end{itemize}
\begin{alertblock}{Caveat}\alert{Careful}\end{alertblock}
\end{frame}
\end{document}`);
  assert.deepEqual(codes(diags), ["LTX007"]);
  assert.deepEqual(doc.blocks[0], { t: "Heading", level: 2, numbered: false, content: [T("Why graphs?")], id: "why-graphs" });
  const list = doc.blocks[1] as Extract<Block, { t: "List" }>;
  assert.deepEqual(list.items.map((it) => (it[0] as Extract<Block, { t: "Plain" }>).content), [[T("One")], [T("Two")]]);
  assert.deepEqual((doc.blocks[2] as Extract<Block, { t: "Div" }>).attr, { classes: ["box"], attrs: { title: "Caveat", frame: "#c00000" } });
});

test("glossaries and acronyms: spelled out on first use, then short", () => {
  const { doc, diags } = parse(String.raw`\newacronym{gpu}{GPU}{graphics processing unit}
A \gls{gpu}, a \gls{gpu}, \glspl{gpu}, \acrlong{gpu}; \ac{CPU} and \ac{CPU}.
\begin{acronym}
\acro{CPU}{Central Processing Unit}
\end{acronym}`);
  assert.deepEqual(codes(diags), []);
  const p = doc.blocks[0] as Extract<Block, { t: "Para" }>;
  assert.deepEqual(p.content, [T("A graphics processing unit (GPU), a GPU, GPUs, graphics processing unit; Central Processing Unit (CPU) and CPU.")]);
  assert.equal(doc.blocks[1]!.t, "DefList");
});

test("margin notes, to-do notes, framed boxes and \\epigraph", () => {
  const { doc, diags } = parse(String.raw`Text\marginpar{Side.} more\todo{Fix.}
\todo[inline]{Rewrite.}
\begin{mdframed}[backgroundcolor=yellow, frametitle={Note}]Boxed.\end{mdframed}
\begin{framed}Framed.\end{framed}
\epigraph{Quoted.}{Someone}`);
  assert.deepEqual(codes(diags), []);
  const [p, todo, md, fr, epi] = doc.blocks;
  const content = (p as Extract<Block, { t: "Para" }>).content;
  assert.equal(content[1]!.t, "Note");
  assert.deepEqual(content[content.length - 1], { t: "Span", attr: { classes: ["color"], attrs: { color: "#b35900" } }, content: [T("[To do: Fix.]")] });
  assert.equal((todo as Extract<Block, { t: "Div" }>).attr.attrs?.title, "To do");
  assert.deepEqual((md as Extract<Block, { t: "Div" }>).attr, { classes: ["box"], attrs: { title: "Note", background: "#ffff00" } });
  assert.deepEqual((fr as Extract<Block, { t: "Div" }>).attr, { classes: ["box"], attrs: { title: "", frame: "#000000" } });
  assert.equal(epi!.t, "BlockQuote");
});

test("xparse definitions, \\ifthenelse, \\ifdefined, \\xspace and \\the\\value", () => {
  const { doc, diags } = parse(String.raw`\NewDocumentCommand{\pair}{O{x} m}{(#1, #2)}
\newcommand{\eg}{e.g.\xspace}
\newcommand{\mode}{draft}
\newcounter{n}\setcounter{n}{4}
\pair{y} \pair[z]{w} \eg here, \eg.
\ifthenelse{\equal{\mode}{draft}}{D}{F} \ifthenelse{\value{n} > 3}{big}{small} \ifthenelse{\isodd{\value{n}}}{odd}{even}
\ifdefined\eg yes\else no\fi \ifdefined\nothere yes\else no\fi \the\value{n}`);
  assert.deepEqual(codes(diags), []);
  const text = (doc.blocks[0] as Extract<Block, { t: "Para" }>).content.map((x) => (x.t === "Text" ? x.text : "")).join("");
  assert.equal(text.replace(/\s+/g, " ").trim(), "(x, y) (z, w) e.g. here, e.g.. D big even yesno4");
});

test("book matter, \\part and KOMA-Script's \\minisec", () => {
  const { doc, diags } = parse(String.raw`\documentclass{book}
\begin{document}
\frontmatter
\chapter{Preface}
\mainmatter
\part{Basics}
\chapter{Start}
\minisec{Aside}
\end{document}`);
  assert.deepEqual(codes(diags), []);
  const hs = doc.blocks.filter((b): b is Extract<Block, { t: "Heading" }> => b.t === "Heading");
  assert.deepEqual(hs.map((h) => [h.numbered, h.content.map((x) => (x as { text: string }).text).join("")]), [[false, "Preface"], [false, "Part I: Basics"], [true, "Start"]]);
  assert.equal(doc.blocks[doc.blocks.length - 1]!.t, "Para");
});

test("text symbols, dingbats, \\enquote*, white text and \\noindent", () => {
  const { doc, diags } = parse(String.raw`\noindent \textsection 2, \XeLaTeX, \ding{51} \checkmark \enquote*{a} \textcolor{white}{W}`);
  assert.deepEqual(codes(diags), []);
  const c = (doc.blocks[0] as Extract<Block, { t: "Para" }>).content;
  assert.deepEqual(c[0], { t: "Span", attr: { classes: ["noindent"] }, content: [] });
  assert.deepEqual(c[1], T("§2, XeLaTeX, "));
  assert.deepEqual(c[2], { t: "Math", tex: "\\checkmark" });
  assert.deepEqual(c.slice(-1), [T("‘a’ W")]);
});

test("chemfig chains become formulas; rings are shown as source with LTX007", () => {
  const { doc, diags } = parse(String.raw`\chemfig{H_3C-CH_2-OH} and \chemfig{*6(=-=-=-)}`);
  assert.deepEqual(codes(diags), ["LTX007"]);
  const c = (doc.blocks[0] as Extract<Block, { t: "Para" }>).content;
  assert.deepEqual(c[0], { t: "Math", tex: "\\ce{H3C-CH2-OH}" });
  assert.deepEqual(c[2], { t: "Code", text: "*6(=-=-=-)" });
});
