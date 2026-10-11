// Release gate: installs the exact tarball that will ship into an empty prefix and drives the
// installed CLI through every advertised diagnostic and feature. Tests run against dist/src;
// this runs against what users get. Usage: node scripts/release-check.mjs texwright-x.y.z.tgz
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tgz = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node scripts/release-check.mjs <texwright-x.y.z.tgz>");
  process.exit(2);
}
const prefix = mkdtempSync(join(tmpdir(), "tw-release-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
execFileSync(npm, ["install", "-g", "--prefix", prefix, tgz], { stdio: "pipe", shell: process.platform === "win32" });
const bin = process.platform === "win32" ? join(prefix, "texwright.cmd") : join(prefix, "bin", "texwright");
const work = mkdtempSync(join(tmpdir(), "tw-release-docs-"));
const run = (args) => spawnSync(bin, args, { cwd: work, encoding: "utf8", shell: process.platform === "win32" });
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let failed = 0;
const expect = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n     ${detail}`}`);
};
const check = (file, text) => {
  writeFileSync(join(work, file), text);
  const r = run(["check", file, "--diagnostics", "json"]);
  try {
    return { ...JSON.parse(r.stdout), status: r.status };
  } catch {
    return { diagnostics: [], status: r.status, raw: r.stdout + r.stderr };
  }
};
const codes = (r) => r.diagnostics.map((d) => d.code);

expect("version", run(["--version"]).stdout.trim() === pkg.version, run(["--version"]).stdout);
const prov = (() => { try { return JSON.parse(run(["--version", "--json"]).stdout); } catch { return {}; } })();
expect("--version --json reports the installed build", prov.version === pkg.version && /^[0-9a-f]{64}$/.test(prov.sha256 ?? "") && String(prov.packageRoot).startsWith(prefix), JSON.stringify(prov));
const listed = run(["codes"]).stdout;
for (const code of ["TBL001", "DIAG001", "DIAG002", "FONT002", "PST001", "TIKZ001", "LTX002"]) expect(`codes lists ${code}`, listed.includes(code));

expect("TBL001 Markdown extra cell", codes(check("t1.md", "| A | B |\n|---|---|\n| 1 | 2 | 3 |\n")).includes("TBL001"));
expect("TBL001 Markdown header/delimiter mismatch", codes(check("t2.md", "| A | B | C |\n|---|---|\n| 1 | 2 | 3 |\n")).includes("TBL001"));
expect("TBL001 LaTeX tabular in Markdown", codes(check("t3.md", "\\begin{tabular}{ll}\na & b & c \\\\\n\\end{tabular}\n")).includes("TBL001"));
const fence = check("f.md", "```mermad\nflowchart LR\n  a --> b\n```\n");
expect("DIAG002 misspelt fence, safe fix", fence.diagnostics.some((d) => d.code === "DIAG002" && d.fix?.new === "mermaid" && d.fix.safe));
const env = check("e.tex", "\\documentclass{article}\n\\begin{document}\n\\begin{equaton}\nx\n\\end{equaton}\n\\end{document}\n");
expect("LTX002 environment typo is an error with a fix", env.status === 1 && env.diagnostics.some((d) => d.code === "LTX002" && d.severity === "error" && d.fix?.new === "equation"));
const col = check("c.md", "Prefix $\\frq{1}{2}$.\n");
expect("math error column points at the command", col.diagnostics[0]?.col === 9, JSON.stringify(col.diagnostics[0]));

// Brand fonts: a file next to the document is embedded; a missing family is FONT002.
mkdirSync(join(work, "fonts"), { recursive: true });
copyFileSync(join(root, "fonts", "KaTeX_SansSerif-Regular.ttf"), join(work, "fonts", "Benchmark.ttf"));
writeFileSync(join(work, "b.md"), "---\nmainfont: fonts/Benchmark.ttf\n---\n\nHello.\n");
run(["b.md", "-o", "b.pdf"]);
expect("mainfont file is embedded in the PDF", readFileSync(join(work, "b.pdf"), "latin1").includes("KaTeX_SansSerif-Regular"));
expect("missing mainfont is FONT002", codes(check("m.md", "---\nmainfont: Nope Sans\n---\n\nx\n")).includes("FONT002"));

// Drawing interpreters through the installed bundle.
const draw = (file, src) => {
  writeFileSync(join(work, file), src);
  const r = run([file, "-o", file.replace(/\.\w+$/, ".html")]);
  return r.status === 0 && readFileSync(join(work, file.replace(/\.\w+$/, ".html")), "utf8").includes("tw-diagram");
};
expect("Mermaid draws", draw("d1.md", "```mermaid\nflowchart LR\n  a --> b\n```\n"));
expect("TikZ draws", draw("d2.md", "```tikz\n\\draw (0,0) -- (1,1);\n```\n"));
expect("circuitikz draws", draw("d3.tex", "\\documentclass{article}\n\\begin{document}\n\\begin{circuitikz}\\draw (0,0) to[R=$R$] (2,0);\\end{circuitikz}\n\\end{document}\n"));
expect("PSTricks draws", draw("d4.tex", "\\documentclass{article}\n\\begin{document}\n\\begin{pspicture}(0,0)(2,2)\\psline(0,0)(2,2)\\end{pspicture}\n\\end{document}\n"));

const out = run(["d1.md", "-o", "p.pdf", "--diagnostics", "json"]);
expect("CLI JSON reports placement", (() => { try { return Array.isArray(JSON.parse(out.stdout).placement); } catch { return false; } })(), out.stdout.slice(0, 200));

// Repair applies the safe fix and renders; microtype expands glyphs (Tz) unless turned off.
writeFileSync(join(work, "r.md"), "# Intro {#sec:intro}\n\nSee @sec:intr.\n");
const rep = run(["repair", "r.md", "-o", "r.pdf"]);
expect("repair fixes a label typo and renders", rep.status === 0 && readFileSync(join(work, "r.md"), "utf8").includes("@sec:intro."), rep.stdout + rep.stderr);
const para = Array.from({ length: 12 }, (_, i) => `Sentence ${i} has an ordinary length and a few longer words such as typesetting.`).join(" ");
writeFileSync(join(work, "mt1.md"), `${para}\n`);
writeFileSync(join(work, "mt0.md"), `---\nmicrotype: false\n---\n\n${para}\n`);
run(["mt1.md", "-o", "mt1.pdf"]);
run(["mt0.md", "-o", "mt0.pdf"]);
const tz = (f) => {
  const pdf = readFileSync(join(work, f));
  const text = pdf.toString("latin1");
  for (const m of text.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    try {
      if (/ Tz\b/.test(inflateSync(pdf.subarray(start, text.indexOf("endstream", start))).toString("latin1"))) return true;
    } catch {}
  }
  return false;
};
expect("microtype expands glyphs, and microtype: false does not", tz("mt1.pdf") && !tz("mt0.pdf"));

console.log(failed ? `\n${failed} check(s) failed: do not publish this tarball` : "\nall release checks passed");
process.exit(failed ? 1 : 0);
