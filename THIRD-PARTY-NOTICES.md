# Third-party material

texwright is licensed under the MIT License (see `LICENSE`) and has no runtime dependencies. Its code was written for the project; the Markdown reader, for example, was written from the CommonMark and GitHub Flavored Markdown specifications. The repository and the npm package also carry the following material by others, each under its own licence.

## Shipped in the npm package

**Latin Modern fonts** (`fonts/lmroman10-*.otf`, `fonts/lmmono10-regular.otf`). Latin Modern by Bogusław Jackowski and Janusz M. Nowacki, continuing Donald E. Knuth's Computer Modern: "Copyright 2003, 2009 B. Jackowski and J. M. Nowacki (on behalf of TeX users groups)". The font files are version 2.004, copied unchanged from release 2.005 (2021) of the `lm` package on CTAN. Licensed under the GUST Font License, version 1.0, which is the LaTeX Project Public License 1.3c or later with a request (not a requirement) that modified versions be renamed. Licence: `fonts/GUST-FONT-LICENSE.TXT`; description and manifest: `fonts/README-Latin-Modern.TXT`.

**KaTeX fonts** (`fonts/KaTeX_*.ttf`). "Copyright (c) 2009-2010, Design Science, Inc. (www.mathjax.org); Copyright (c) 2014-2018 Khan Academy (www.khanacademy.org)", with Reserved Font Names KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur, KaTeX_Main, KaTeX_Math, KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1 to KaTeX_Size4 and KaTeX_Typewriter. Derivatives of Computer Modern and the AMS fonts, copied unchanged from the `katex` npm package, version 0.19.0. Licensed under the SIL Open Font License 1.1, as each font file states: `fonts/OFL-KaTeX.txt`. The package ships them unchanged; texwright embeds subsets of them in the PDFs it writes, and the unchanged fonts, wrapped as WOFF, in HTML. `fonts/LICENSE-KaTeX.txt` is KaTeX's own MIT licence, kept for reference; it covers KaTeX's code, which texwright does not use.

**US English hyphenation patterns** (`hyphenation/en-us.json`). Copyright (C) 1990, 2004, 2005 Gerard D.C. Kuiken; the patterns include Donald E. Knuth's original `hyphen.tex`. From the `hyph-utf8` package on CTAN (`hyph-en-us.pat.txt` and `hyph-en-us.hyp.txt`, version 2005-05-30), converted to JSON with the patterns unchanged. Licence, kept in the file: "Copying and distribution of this file, with or without modification, are permitted in any medium without royalty provided the copyright notice and this notice are preserved."

## In the repository only (tests)

**CommonMark and GFM spec examples** (`test/commonmark.test.ts`). The test inputs are adapted from the examples of the CommonMark Spec, version 0.31.2, by John MacFarlane (https://spec.commonmark.org/0.31.2/), and of the GitHub Flavored Markdown Spec, version 0.29-gfm, by GitHub, Inc. (https://github.github.com/gfm/). Both are licensed under the Creative Commons Attribution-ShareAlike 4.0 International licence (https://creativecommons.org/licenses/by-sa/4.0/), and so is that test file. It is not part of the npm package.

## Development tools (not shipped)

TypeScript (Apache-2.0) compiles the code. The tests use the MCP SDK (MIT) to check that the MCP server works with the official client, and pdf.js (Apache-2.0) to read generated PDFs back. They are `devDependencies` and are not installed with texwright.

## Specifications and algorithms

texwright implements published methods from their descriptions: the Knuth–Plass line-breaking algorithm, Liang's hyphenation algorithm, the mathematics layout rules of *The TeXbook* (Appendix G), the CommonMark specification, ISO 32000 (PDF), the OpenType and CFF specifications, and the SVG specification. The paper in `paper/` cites them.
