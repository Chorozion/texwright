// The document's own faces: mainfont, sansfont and monofont in front matter, and fontspec in LaTeX.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { convert } from "../src/index.js";
import { fontsDir } from "../src/font/index.js";

/** A folder with a brand family in fonts/: three KaTeX sans files stand in for a client's fonts. */
function brandFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "tw-brand-"));
  mkdirSync(join(dir, "fonts"));
  for (const s of ["Regular", "Bold", "Italic"]) copyFileSync(join(fontsDir(), `KaTeX_SansSerif-${s}.ttf`), join(dir, "fonts", `KaTeX_SansSerif-${s}.ttf`));
  return dir;
}

function pdfFonts(data: Uint8Array): string[] {
  const s = Buffer.from(data).toString("latin1");
  return [...new Set([...s.matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/\]>]+)/g)].map((m) => m[1]!))].sort();
}

describe("document fonts", () => {
  it("finds a family by name among the document's font files, with its bold and italic", async () => {
    const dir = brandFolder();
    const res = await convert({ source: "---\nmainfont: KaTeX_SansSerif\n---\n\nBody, **bold** and *italic*.\n", from: "markdown", to: "pdf", baseDir: dir });
    assert.deepEqual(res.diagnostics, []);
    const fonts = pdfFonts(res.data as Uint8Array);
    for (const f of ["KaTeX_SansSerif-Regular", "KaTeX_SansSerif-Bold", "KaTeX_SansSerif-Italic"]) assert.ok(fonts.includes(f), fonts.join());
    assert.ok(!fonts.includes("LMRoman10-Regular"), "the body no longer uses Latin Modern");
  });

  it("takes a file name and finds the bold and italic files beside it", async () => {
    const dir = brandFolder();
    const res = await convert({ source: "---\nmainfont: fonts/KaTeX_SansSerif-Regular.ttf\n---\n\n**Bold** and *italic*.\n", from: "markdown", to: "pdf", baseDir: dir });
    const fonts = pdfFonts(res.data as Uint8Array);
    assert.ok(fonts.includes("KaTeX_SansSerif-Bold") && fonts.includes("KaTeX_SansSerif-Italic"), fonts.join());
  });

  it("reads fontspec's \\setmainfont with Path and BoldFont in LaTeX", async () => {
    const dir = brandFolder();
    const src = "\\documentclass{article}\n\\usepackage{fontspec}\n\\setmainfont{KaTeX_SansSerif-Regular.ttf}[Path=fonts/, BoldFont=KaTeX_SansSerif-Bold.ttf]\n\\begin{document}\nBody and \\textbf{bold}.\n\\end{document}\n";
    const res = await convert({ source: src, from: "latex", to: "pdf", baseDir: dir });
    assert.deepEqual(res.diagnostics, []);
    const fonts = pdfFonts(res.data as Uint8Array);
    assert.ok(fonts.includes("KaTeX_SansSerif-Regular") && fonts.includes("KaTeX_SansSerif-Bold"), fonts.join());
  });

  it("keeps the theme's face with FONT002 when a font cannot be found or is outside the folder", async () => {
    const dir = brandFolder();
    const missing = await convert({ source: "---\nmainfont: No Such Brand\n---\n\nx\n", from: "markdown", to: "pdf", baseDir: dir });
    assert.deepEqual(missing.diagnostics.map((d) => [d.code, d.severity]), [["FONT002", "info"]]);
    assert.ok(pdfFonts(missing.data as Uint8Array).includes("LMRoman10-Regular"));
    const outside = await convert({ source: `---\nmainfont: ${JSON.stringify(join(fontsDir(), "KaTeX_Main-Regular.ttf"))}\n---\n\nx\n`, from: "markdown", to: "pdf", baseDir: dir });
    assert.ok(outside.diagnostics.some((d) => d.code === "FONT002" && /outside/.test(d.message)), JSON.stringify(outside.diagnostics));
  });

  it("embeds the same faces in HTML and uses them for the body", async () => {
    const dir = brandFolder();
    const html = (await convert({ source: "---\nmainfont: KaTeX_SansSerif\n---\n\nBody.\n", from: "markdown", to: "html", baseDir: dir })).data as string;
    assert.equal((html.match(/@font-face\{font-family:"tw-mainfont"/g) ?? []).length, 3, "regular, bold and italic, each once");
    assert.match(html, /body\{font-family:"tw-mainfont", "KaTeX_SansSerif", serif\}/);
  });
});
