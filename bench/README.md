# Benchmark: documents language models write

texwright is meant to take what a language model writes when someone asks it for a PDF, and turn it into the PDF on the first try. This folder measures that.

`corpus/` holds sets of 20 documents. Each was written by a model given only a one-line request ("Write me homework solutions for a linear algebra problem set, I'll turn it into a PDF") and told to write as it would for pandoc or a normal LaTeX installation, without running any converter. Every set mixes Markdown and LaTeX and covers papers, homework, lecture notes, reports, CVs, letters, exams, handouts, proposals and more, with the bibliographies and SVG figures the documents use. `manifest.json` in each set records the file, its kind, its format and the request.

Run it with

```
npm run bench
node bench/run.mjs --sets d --verbose
```

For each document the runner records whether it renders with no errors, whether it is clean (no errors and no warnings; info notes allowed), and whether the safe automatic fixes (`texwright check --fix`) make it clean. Documents are never modified: fixes are tried on copies under `bench/out/`.

## How the sets were used

- **A and C** were the development sets. Their failures drove the work: package commands models use without loading them (siunitx, mhchem, physics), `thebibliography`, `algorithmic`, `\qedhere`, the `letter` and `exam` classes, `\includesvg`, `tikzcd`, pandoc's habit of ending with an empty `# References` heading, and a PDF writer bug that drew the slash of `\neq` beside the equals sign.
- **B** was held out until A and C were clean, then run once. Its author's report had already named some of its packages, so it was not fully blind.
- **D** was written after that, by an agent told to report nothing about its contents, and run once at the end.

## Results

| Set | Role | Clean on the first try | Renders without errors |
|---|---|---|---|
| A + C | development, first run (package commands already in) | 29/40 (73%) | 37/40 (93%) |
| A + C | development, after the work | 40/40 | 40/40 |
| B | held out, first run | 15/20 (75%) | 19/20 (95%) |
| D | held out, first run | 12/20 (60%) | 16/20 (80%) |
| A to D | all 80, after fixing what B and D showed | 79/80 | 79/80 |

Markdown did better than LaTeX throughout. On first runs, 26 of 29 Markdown documents in A and C, all 14 in B and 9 of 10 in D were clean, against 3 of 11, 1 of 6 and 3 of 10 LaTeX documents: models writing LaTeX reach for whole document classes and packages (exam, letter, tcolorbox, physics, siunitx's own unit declarations). The one document still failing draws a figure with TikZ, which texwright does not render.

The held-out numbers are the ones to quote: 75% and 60% clean on the first try, 95% and 80% without errors. Every set's failures also led to fixes, so a fresh set written today would likely do better than D did, but only a new held-out set can show that.

Diagnostics do not catch everything that looks wrong, so every page of A, B and C was also looked at with `texwright preview`. That found problems no diagnostic reported: a siunitx `S` table column read as several columns, the `\neq` slash drawn beside the equals sign, `$` amounts of money read as math, `\paragraph` headings numbered and set apart, `\hfill` ignored, and a tabularx column running into the margin. All are fixed.

The corpus documents were written by Claude models. Results on other models' writing may differ; the runner works on any folder laid out the same way.
