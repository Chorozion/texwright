# Contributing

Thanks for helping. A few things make reviews quick.

## Setup

```
npm install
npm test
```

`npm test` compiles with `tsc` and runs every suite in `test/` with Node's built-in runner. The PDF tests read the output back with pdf.js, a development dependency pinned to 4.10.38 so the complete suite runs on Node 20 as well as Node 22. Newer PDF.js major versions require newer Node runtimes; keep the reader compatible with the full CI matrix when updating it. A few font tests use fonts that ship with Windows and skip themselves elsewhere.

The package has no runtime dependencies, and it should stay that way: new code uses Node's standard library. Development tools (TypeScript, test helpers) are fine as `devDependencies`.

## Where things live

[DESIGN.md](DESIGN.md) describes the pipeline (parse, transform, write), the contract between the stages (the document tree in `src/ast.ts`, mirrored by the schema in `src/schema.ts`; a change to one needs the same change in the other) and the engine modules under `src/font`, `src/math`, `src/layout`, `src/svg`, `src/pdf` and `src/typeset`. `scripts/measure.mjs` times the common tasks.

## What a good change includes

- A test that fails without the change. Parser behaviour belongs in `test/markdown.test.ts` or `test/latex.test.ts`; anything that crosses stages belongs in `test/pipeline.test.ts`.
- Problems in a document are diagnostics, never exceptions. Add a code to `CODES` in `src/diagnostics.ts` only when no existing code fits; codes never change meaning once released.
- Untrusted input stays untrusted: no new way to read files outside the document folder, run scripts, or reach the network without an explicit option.
- Fuzz new syntax: add its pieces to the soups in `test/robustness.test.ts`.

## Reporting bugs

Include the smallest document that shows the problem, the command you ran, and the output of `texwright doctor`. For security issues, see [SECURITY.md](SECURITY.md).
