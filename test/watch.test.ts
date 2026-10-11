/**
 * Watch mode and incremental layout: the files a render depends on, renders
 * on change (debounced, never overlapping, written atomically), and caches
 * that never change the output: after any sequence of edits a render is
 * byte for byte what a fresh process makes of the same source.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { convert } from "../src/index.js";
import { Lru, cacheStats, clearCaches, cloneBoxes, cloneTree } from "../src/typeset/cache.js";
import { trackReads } from "../src/util/reads.js";
import { type WatchRender, watchDocument } from "../src/watch.js";
import { packageRoot } from "../src/write/assets.js";

const CLI = process.env.TEXWRIGHT_CLI ?? fileURLToPath(new URL("../src/cli.js", import.meta.url));
const dirs: string[] = [];
function folder(): string {
  const d = mkdtempSync(join(tmpdir(), "tw-watch-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A w x h PNG of one colour. */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows = Buffer.alloc(h * (1 + 3 * w));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows.set(rgb, y * (1 + 3 * w) + 1 + 3 * x);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const SVG = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="${color}"/><image href="inner.png" x="10" y="10" width="20" height="20"/></svg>`;
const BIB = (title: string) => `@article{doe2020, author = {Doe, Jane}, title = {${title}}, journal = {J. Plates}, year = {2020}}\n`;

/** Starts watchDocument and collects its renders. */
function startWatch(doc: string, output: string, debounceMs = 20) {
  const renders: WatchRender[] = [];
  const lines: string[] = [];
  const waiting: (() => void)[] = [];
  const ac = new AbortController();
  const done = watchDocument(
    { input: doc, output, to: output.endsWith(".html") ? "html" : "pdf" },
    {
      debounceMs,
      diagnostics: "compact",
      handleSignals: false,
      signal: ac.signal,
      write: (t) => lines.push(t),
      onRender: (r) => {
        renders.push(r);
        for (const w of waiting.splice(0)) w();
      },
    },
  );
  const next = (n: number, ms = 20_000) =>
    new Promise<WatchRender>((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`render ${n} did not come (have ${renders.length})`)), ms);
      const check = () => {
        if (renders.length >= n) {
          clearTimeout(timer);
          ok(renders[n - 1]!);
        } else waiting.push(check);
      };
      check();
    });
  const stop = async () => {
    ac.abort();
    assert.equal(await done, 0);
  };
  return { renders, lines, next, stop };
}

// --------------------------------------------------------------------------- dependencies

describe("dependency tracking", () => {
  test("records every file a render reads or looks for", async () => {
    const dir = folder();
    writeFileSync(join(dir, "fig.png"), png(4, 4, [200, 0, 0]));
    writeFileSync(join(dir, "inner.png"), png(2, 2, [0, 200, 0]));
    writeFileSync(join(dir, "draw.svg"), SVG("#eee"));
    writeFileSync(join(dir, "refs.bib"), BIB("Heat"));
    writeFileSync(join(dir, "data.csv"), "x y\n1 2\n2 4\n3 9\n");
    writeFileSync(join(dir, "chapter.tex"), "Text from the chapter.\n");
    copyFileSync(join(packageRoot(), "fonts", "KaTeX_SansSerif-Regular.ttf"), join(dir, "Brand-Regular.ttf"));
    const tex = [
      "\\documentclass{article}",
      "\\usepackage{graphicx,pgfplots,fontspec}",
      "\\setmainfont{Brand-Regular.ttf}",
      "\\begin{document}",
      "\\input{chapter}",
      "\\includegraphics{fig.png} \\includegraphics{draw.svg} \\includegraphics{later.png}",
      "See \\cite{doe2020}.",
      "\\begin{tikzpicture}\\begin{axis}\\addplot table {data.csv};\\end{axis}\\end{tikzpicture}",
      "\\bibliographystyle{plain}\\bibliography{refs}",
      "\\end{document}",
    ].join("\n");
    writeFileSync(join(dir, "main.tex"), tex);
    const files = new Set<string>();
    await trackReads(files, () => convert({ input: join(dir, "main.tex"), to: "pdf" }));
    const names = new Set([...files].map((f) => f.slice(dir.length + 1)));
    for (const want of ["main.tex", "chapter.tex", "fig.png", "draw.svg", "inner.png", "refs.bib", "data.csv", "later.png", "Brand-Regular.ttf"]) {
      assert.ok(names.has(want), `${want} not among ${[...names].join(", ")}`);
    }
  });

  test("reads outside trackReads are not recorded, and conversions do not mix their lists", async () => {
    const dir = folder();
    writeFileSync(join(dir, "a.md"), "A\n\n![x](a.png)\n");
    writeFileSync(join(dir, "b.md"), "B\n\n![y](b.png)\n");
    const fa = new Set<string>();
    const fb = new Set<string>();
    await Promise.all([trackReads(fa, () => convert({ input: join(dir, "a.md"), to: "html" })), trackReads(fb, () => convert({ input: join(dir, "b.md"), to: "html" }))]);
    assert.ok([...fa].some((f) => f.endsWith("a.png")) && ![...fa].some((f) => f.endsWith("b.png")));
    assert.ok([...fb].some((f) => f.endsWith("b.png")) && ![...fb].some((f) => f.endsWith("a.png")));
  });
});

// --------------------------------------------------------------------------- watch

describe("watch", () => {
  before(() => {
    process.env.SOURCE_DATE_EPOCH = "1700000000";
  });

  test("renders once, then on a change to the document or any file it uses", async () => {
    const dir = folder();
    writeFileSync(join(dir, "refs.bib"), BIB("First title"));
    writeFileSync(join(dir, "draw.svg"), SVG("#eee"));
    writeFileSync(join(dir, "inner.png"), png(2, 2, [0, 0, 200]));
    const doc = join(dir, "doc.md");
    const out = join(dir, "doc.pdf");
    writeFileSync(doc, "---\nbibliography: refs.bib\n---\n\nAs shown [@doe2020].\n\n![A drawing.](draw.svg)\n");
    const w = startWatch(doc, out);
    try {
      const r1 = await w.next(1);
      assert.ok(r1.ok, JSON.stringify(r1.diagnostics));
      assert.equal(r1.output, out);
      const first = readFileSync(out);
      assert.ok(r1.files.some((f) => f.endsWith("refs.bib")) && r1.files.some((f) => f.endsWith("inner.png")));

      writeFileSync(join(dir, "refs.bib"), BIB("Second title"));
      const r2 = await w.next(2);
      assert.ok(r2.ok);
      const second = readFileSync(out);
      assert.notDeepEqual(second, first);

      // An image inside the SVG figure.
      writeFileSync(join(dir, "inner.png"), png(3, 3, [200, 200, 0]));
      await w.next(3);
      assert.notDeepEqual(readFileSync(out), second);

      // The document itself, saved the way many editors do: a new file renamed over the old one.
      writeFileSync(`${doc}.swp`, "---\nbibliography: refs.bib\n---\n\nRewritten [@doe2020].\n\n![A drawing.](draw.svg)\n");
      renameSync(`${doc}.swp`, doc);
      const r4 = await w.next(4);
      assert.ok(r4.ok);
      // The rename replaced the watched file: later edits are still seen.
      writeFileSync(doc, "---\nbibliography: refs.bib\n---\n\nOnce more [@doe2020].\n");
      await w.next(5);
      assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "no temporary file left behind");
    } finally {
      await w.stop();
    }
  });

  test("a burst of saves is one render, and unrelated files are ignored", async () => {
    const dir = folder();
    const doc = join(dir, "doc.md");
    writeFileSync(doc, "Start.\n");
    const w = startWatch(doc, join(dir, "doc.pdf"), 80);
    try {
      await w.next(1);
      for (let k = 0; k < 6; k++) writeFileSync(doc, `Edit ${k}.\n`);
      await w.next(2);
      writeFileSync(join(dir, "unrelated.txt"), "not used by the document");
      await sleep(400);
      assert.equal(w.renders.length, 2, "one render for the burst, none for the unrelated file");
    } finally {
      await w.stop();
    }
  });

  test("a deleted document keeps the last output until it comes back; a missing image is picked up when it appears", async () => {
    const dir = folder();
    const doc = join(dir, "doc.md");
    const out = join(dir, "doc.pdf");
    writeFileSync(doc, "Text.\n\n![Later.](later.png)\n");
    const w = startWatch(doc, out);
    try {
      const r1 = await w.next(1);
      assert.ok(r1.diagnostics.some((d) => d.code === "IMG001"));
      const before = readFileSync(out);
      writeFileSync(join(dir, "later.png"), png(4, 4, [10, 20, 30]));
      const r2 = await w.next(2);
      assert.ok(!r2.diagnostics.some((d) => d.code === "IMG001"), "the new image is found");
      unlinkSync(doc);
      const r3 = await w.next(3);
      assert.equal(r3.ok, false);
      assert.equal(r3.output, undefined);
      assert.ok(existsSync(out), "the last PDF stays");
      writeFileSync(doc, "Back again.\n");
      const r4 = await w.next(4);
      assert.ok(r4.ok);
      assert.notDeepEqual(readFileSync(out), before);
    } finally {
      await w.stop();
    }
  });

  test("the output is replaced atomically: a reader never sees part of a PDF", async () => {
    const dir = folder();
    const doc = join(dir, "doc.md");
    const out = join(dir, "doc.pdf");
    const long = (k: number) => Array.from({ length: 60 }, (_, j) => `Paragraph ${j} of version ${k}, with enough words to fill a line or two of the page.\n`).join("\n");
    writeFileSync(doc, long(0));
    const w = startWatch(doc, out, 5);
    let reads = 0;
    let reading = true;
    const reader = (async () => {
      while (reading) {
        if (existsSync(out)) {
          let data: Buffer | undefined;
          try {
            data = readFileSync(out);
          } catch {
            // Windows: the file is being replaced at this instant.
          }
          if (data) {
            reads++;
            assert.equal(data.subarray(0, 5).toString("latin1"), "%PDF-");
            assert.match(data.subarray(-8).toString("latin1"), /%%EOF\s*$/);
          }
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    try {
      await w.next(1);
      for (let k = 1; k <= 5; k++) {
        writeFileSync(doc, long(k));
        await w.next(k + 1);
      }
    } finally {
      reading = false;
      await reader;
      await w.stop();
    }
    // The reader only runs between the watcher's synchronous steps, so how many reads fit
    // depends on the filesystem's speed (few on WSL's /mnt drives); each one was checked above.
    assert.ok(reads > 0, "the reader saw the PDF");
  });

  test("the command line reports each render as one JSON line", { timeout: 60_000 }, async () => {
    const dir = folder();
    const doc = join(dir, "doc.md");
    writeFileSync(doc, "# Title\n\nSome $x^2$ text.\n");
    const child = spawn(process.execPath, [CLI, "watch", doc, "--diagnostics", "json", "--debounce", "10"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SOURCE_DATE_EPOCH: "1700000000" } });
    const seen: Record<string, unknown>[] = [];
    let buf = "";
    const got = (n: number) =>
      new Promise<Record<string, unknown>>((ok, fail) => {
        const timer = setTimeout(() => fail(new Error(`no render ${n}`)), 30_000);
        const poll = setInterval(() => {
          const r = seen.find((x) => x.render === n);
          if (r) {
            clearTimeout(timer);
            clearInterval(poll);
            ok(r);
          }
        }, 5);
      });
    child.stdout.on("data", (c: Buffer) => {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        seen.push(JSON.parse(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    });
    try {
      const r1 = await got(1);
      assert.equal(r1.ok, true);
      assert.equal(r1.pages, 1);
      assert.equal(typeof r1.ms, "number");
      writeFileSync(doc, "# Title\n\nSome $x^3$ text, and \\ref{nowhere}.\n");
      const r2 = await got(2);
      assert.ok(Array.isArray(r2.diagnostics));
      assert.ok((r2.diagnostics as { code: string }[]).some((d) => d.code === "REF001"));
      assert.equal(r2.output, resolve(dir, "doc.pdf"));
    } finally {
      child.kill();
    }
  });
});

// --------------------------------------------------------------------------- incremental layout

describe("incremental layout", () => {
  before(() => {
    process.env.SOURCE_DATE_EPOCH = "1700000000";
  });

  /** A render by a fresh process with every cache off: the reference. */
  function fresh(doc: string): { pdf: Buffer; diagnostics: unknown } {
    const out = `${doc}.fresh.pdf`;
    const run = spawnSync(process.execPath, [CLI, doc, "-o", out, "--diagnostics", "json"], { env: { ...process.env, TEXWRIGHT_NO_CACHE: "1", SOURCE_DATE_EPOCH: "1700000000" }, encoding: "utf8" });
    const report = JSON.parse(run.stdout);
    const pdf = readFileSync(out);
    unlinkSync(out);
    return { pdf, diagnostics: report.diagnostics };
  }

  test("after every edit of a sequence the PDF and diagnostics match a fresh render", { timeout: 180_000 }, async () => {
    const dir = folder();
    const doc = join(dir, "paper.md");
    writeFileSync(join(dir, "refs.bib"), BIB("Heat flow in thin plates"));
    writeFileSync(join(dir, "plot.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path d="M0 100 L50 40 L100 60 L200 0" stroke="black" fill="none"/></svg>`);
    const base = (o: { macro?: string; extraFig?: boolean; top?: string; tail?: string; label?: string }) => `---
title: Incremental
bibliography: refs.bib
number-sections: true
toc: true
macros:
  R: '${o.macro ?? "\\\\mathbb{R}"}'
---

${o.top ?? ""}

# Introduction {#sec:intro}

We work in $\\R^n$ and cite [@doe2020]. Figure @fig:${o.label ?? "plot"} is on page \\pageref{fig:${o.label ?? "plot"}}.

$$ \\int_0^1 f(x)\\,dx = F(1) - F(0) $$ {#eq:ftc}
${o.extraFig ? "\n![An extra figure first.](plot.svg){#fig:extra width=40%}\n" : ""}
![The plot.](plot.svg){#fig:${o.label ?? "plot"} width=60%}

By @eq:ftc and a broken formula $\\frac{1}{$ the claim follows.[^1]

[^1]: A note with $\\R$.

| A | B |
|---|---|
| 1 | $\\R$ |

\`\`\`python
def f(x):
    return x ** 2
\`\`\`

# Results

${Array.from({ length: 40 }, (_, k) => `Sentence ${k} of the results says something about $x_${k}$ in $\\R$.`).join(" ")}${o.tail ?? ""}
`;
    const steps: { name: string; text?: string; files?: Record<string, string> }[] = [
      { name: "original", text: base({}) },
      { name: "sentence appended", text: base({ tail: " One more sentence." }) },
      { name: "macro changed", text: base({ macro: "\\\\mathbf{R}", tail: " One more sentence." }) },
      { name: "figure inserted before (numbers move)", text: base({ macro: "\\\\mathbf{R}", extraFig: true }) },
      { name: "label renamed", text: base({ macro: "\\\\mathbf{R}", extraFig: true, label: "chart" }) },
      { name: "figure file changed", files: { "plot.svg": `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="90" fill="#c33"/></svg>` } },
      { name: "bibliography changed", files: { "refs.bib": BIB("A different title") } },
      { name: "text added above (everything moves down)", text: base({ macro: "\\\\mathbf{R}", extraFig: true, label: "chart", top: "A new first paragraph.\n\nAnd a second one,\nover two lines." }) },
      { name: "back to the original", text: base({}) },
    ];
    clearCaches();
    for (const step of steps) {
      if (step.text !== undefined) writeFileSync(doc, step.text);
      for (const [name, text] of Object.entries(step.files ?? {})) writeFileSync(join(dir, name), text);
      const res = await convert({ input: doc, to: "pdf" });
      const ref = fresh(doc);
      assert.ok(Buffer.from(res.data as Uint8Array).equals(ref.pdf), `PDF differs after: ${step.name}`);
      assert.deepEqual(JSON.parse(JSON.stringify(res.diagnostics)), ref.diagnostics, `diagnostics differ after: ${step.name}`);
    }
    const stats = cacheStats();
    assert.ok(stats.paragraph!.hits > 0 && stats.math!.hits > 0 && stats.shape!.hits > 0, JSON.stringify(stats));
  });

  test("a formula error moved down by an edit is reported at its new line", async () => {
    const dir = folder();
    const doc = join(dir, "doc.md");
    writeFileSync(doc, "Intro.\n\nBroken $\\frac{1}{$ here.\n");
    const a = await convert({ input: doc, to: "pdf" });
    const lineA = a.diagnostics.find((d) => d.code === "MATH001")?.line;
    writeFileSync(doc, "Intro.\n\nNew.\n\nMore.\n\nBroken $\\frac{1}{$ here.\n");
    const b = await convert({ input: doc, to: "pdf" });
    const lineB = b.diagnostics.find((d) => d.code === "MATH001")?.line;
    assert.equal(lineA, 3);
    assert.equal(lineB, 7);
  });
});

// --------------------------------------------------------------------------- the caches

describe("caches", () => {
  test("an LRU keeps within its entry and size limits and drops the least recently used", () => {
    const c = new Lru<string>("test-lru", 3, 100);
    c.set("a", "A", 10);
    c.set("b", "B", 10);
    c.set("c", "C", 10);
    assert.equal(c.get("a"), "A");
    c.set("d", "D", 10);
    assert.equal(c.get("b"), undefined, "b was least recently used");
    assert.equal(c.size, 3);
    c.set("e", "E", 24);
    assert.ok(c.cost <= 100);
    c.set("huge", "H", 80);
    assert.equal(c.get("huge"), undefined, "an entry over a quarter of the budget is not kept");
  });

  test("cloneTree copies everything but class instances; cloneBoxes copies boxes and shares leaves", () => {
    class Font {}
    const font = new Font();
    const glyphs = { t: "glyphs", font, size: 10, gids: [1, 2], advances: [5, 5], text: ["a", "b"], width: 10, height: 7, depth: 2 };
    const line = { t: "hbox", width: 100, height: 7, depth: 2, children: [glyphs, { t: "glue", width: 3, stretch: 1, shrink: 1, stretchOrder: 0, shrinkOrder: 0 }] };
    const deep = cloneTree({ lines: [line] });
    assert.notEqual(deep.lines[0], line);
    assert.notEqual(deep.lines[0]!.children[0], glyphs);
    assert.equal((deep.lines[0]!.children[0] as typeof glyphs).font, font);
    const boxes = cloneBoxes({ lines: [line] });
    assert.notEqual(boxes.lines[0], line);
    assert.notEqual(boxes.lines[0]!.children, line.children);
    assert.equal(boxes.lines[0]!.children[0], glyphs, "leaves are shared");
    (boxes.lines[0] as { shift?: number }).shift = 12;
    assert.equal((line as { shift?: number }).shift, undefined, "adjusting the copy leaves the cached box alone");
  });
});
