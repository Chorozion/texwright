# Bundled fonts

## Latin Modern (text)

`lmroman10-regular.otf`, `lmroman10-bold.otf`, `lmroman10-italic.otf`, `lmroman10-bolditalic.otf` and `lmmono10-regular.otf` are Latin Modern (font files version 2.004), copied unchanged from release 2.005 of the `lm` package on CTAN (`fonts/lm/fonts/opentype/public/lm/`). Latin Modern is the GUST e-foundry's OpenType continuation of Donald Knuth's Computer Modern, the face LaTeX documents are set in. It is distributed under the GUST Font License (`GUST-FONT-LICENSE.TXT`, based on the LaTeX Project Public License); `README-Latin-Modern.TXT` is the package's own description. The files are OpenType with CFF outlines and have ligatures (GSUB), kerning (GPOS) and accented letters. texwright uses them as the `LMRoman` and `LMMono` families for body text and code in the article theme, and subsets them when embedding.

## KaTeX fonts (mathematics)

These 20 TrueType files are the KaTeX fonts, copied unchanged from the `katex` npm package (version 0.19.0, `node_modules/katex/dist/fonts/*.ttf`). They are derivatives of Donald Knuth's Computer Modern and the AMS fonts, copyright Design Science, Inc. (2009-2010) and Khan Academy (2014-2018). Each font file states that it is licensed under the SIL Open Font License 1.1, with its family name (KaTeX_Main and so on) reserved; the licence and the copyright notice are in `OFL-KaTeX.txt`. `LICENSE-KaTeX.txt` is the MIT licence of KaTeX's code, which texwright does not use.

texwright's font engine loads them with `bundledFont(family, style)` from `src/font/registry.ts`. They need no installed TeX and no network.

| Family | Styles | Used for |
| --- | --- | --- |
| Main | Regular, Bold, Italic, BoldItalic | Upright math symbols, digits, operators, capital Greek; HTML body text; a fallback for text |
| Math | Italic, BoldItalic | Math italic letters and lowercase Greek |
| AMS | Regular | AMS symbols (blackboard bold, extra relations and arrows) |
| Caligraphic | Regular, Bold | `\mathcal` |
| Fraktur | Regular, Bold | `\mathfrak` |
| SansSerif | Regular, Bold, Italic | `\mathsf` and sans-serif text |
| Script | Regular | `\mathscr` |
| Typewriter | Regular | `\mathtt`; monospaced text in HTML |
| Size1, Size2, Size3, Size4 | Regular | Successively larger delimiters, radicals, integrals and big operators |

The files have no GSUB or kern tables, so they carry no ligatures and no kerning; TeX's own ligature and kerning data for Computer Modern is not part of them. KaTeX_Main-Regular has no glyphs for the fi/fl ligatures and no precomposed accented letters beyond Æ, Ø, ß, æ, ø, Œ and œ. Accents are built from the spacing accent characters it does have (U+02C6 and neighbours, U+00A8, U+00B8), or text falls back to an installed font.
