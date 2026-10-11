import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check, convert, preview, documentJsonSchema } from "../dist/src/index.js";
import { createMcpServer } from "../dist/src/mcp.js";
import { renderDiagram } from "../dist/src/diagram/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
process.env.SOURCE_DATE_EPOCH ??= "1791676800";
const checkOnly = process.argv.includes("--check");
const names = ["overview", "agent-guide", "cookbook"];
const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
};
let failures = 0;
function inspect(label, result) {
  const issues = result.diagnostics.filter(d => d.severity !== "info");
  for (const d of issues) console.error(label + ": " + d.code + " " + d.message);
  if (!result.ok || issues.length) failures++;
}
for (const name of names) {
  const input = "docs/" + name + ".md";
  inspect(input, await check({ input }));
  const pdf = await convert({ input, to: "pdf", ...(checkOnly ? {} : { output: "docs/" + name + ".pdf" }) });
  inspect(input + " PDF", pdf);
  if (!checkOnly) {
    inspect(input + " HTML", await convert({ input, to: "html", output: "docs/" + name + ".html" }));
    const images = preview({ input, dpi: 90 });
    if (images.ok && existsSync("docs/previews")) {
      const expected = new Set(images.pages.map(p => name + "-p" + p.page + ".png"));
      for (const file of readdirSync("docs/previews")) {
        if (file.startsWith(name + "-p") && file.endsWith(".png") && !expected.has(file)) unlinkSync("docs/previews/" + file);
      }
    }
    inspect(input + " previews", images);
    for (const page of images.pages) write("docs/previews/" + name + "-p" + page.page + ".png", page.png);
    console.log(name + ": " + images.pageCount + " pages; PDF, HTML, and PNG previews");
  }
}
const server = createMcpServer({ root });
await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "docs-build", version: "1" } } });
const listed = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
if (listed.error || !listed.result?.tools) throw new Error("MCP tools/list failed");
const tools = { version: JSON.parse(readFileSync("package.json", "utf8")).version, ...listed.result };
if (!checkOnly) {
  write("docs/reference/mcp-tools.json", JSON.stringify(tools, null, 2) + "\n");
  write("docs/reference/document.schema.json", JSON.stringify(documentJsonSchema(), null, 2) + "\n");
  const diagram = renderDiagram("flowchart LR\n  source[Markdown / LaTeX / JSON] --> check[Check and repair]\n  check --> engine[Typeset]\n  engine --> pdf[PDF]\n  engine --> html[HTML]\n");
  if (!diagram.svg || diagram.errors.length) throw new Error("Pipeline diagram failed");
  write("docs/images/pipeline.svg", diagram.svg);
}
// Check repository-local Markdown links, including the raw URLs in the LLM index.
for (const file of ["README.md", "llms.txt", "docs/README.md", ...names.map(n => "docs/" + n + ".md")]) {
  const text = readFileSync(file, "utf8").replace(/~~~[\s\S]*?~~~/g, "").replace(new RegExp(String.fromCharCode(96).repeat(3) + "[\\s\\S]*?" + String.fromCharCode(96).repeat(3), "g"), "");
  for (const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let href = match[1];
    if (href.startsWith("https://raw.githubusercontent.com/Chorozion/texwright/main/") || href.startsWith("https://github.com/Chorozion/texwright/blob/main/")) href = "../".repeat(file.split("/").length - 1) + href.split("/main/")[1];
    else if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const target = resolve(dirname(file), decodeURIComponent(href.split("#")[0]));
    if (!existsSync(target)) { console.error(file + ": missing link target " + href); failures++; }
  }
}
if (checkOnly) {
  if (JSON.stringify(JSON.parse(readFileSync("docs/reference/document.schema.json", "utf8"))) !== JSON.stringify(documentJsonSchema())) {
    console.error("Document schema is stale; run npm run docs");
    failures++;
  }
  if (JSON.stringify(JSON.parse(readFileSync("docs/reference/mcp-tools.json", "utf8"))) !== JSON.stringify(tools)) {
    console.error("MCP tool catalog is stale; run npm run docs");
    failures++;
  }
}
if (failures) process.exitCode = 1;
else console.log("Documentation checks passed.");
