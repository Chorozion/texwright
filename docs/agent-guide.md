---
title: "The texwright agent guide"
subtitle: "A practical contract for reliable document generation"
author: [Sophia, Xe5, Thomas Garren]
date: "Version 0.3.4"
theme: modern
papersize: a4
page-numbers: right
geometry: margin=2cm
fontsize: 10pt
number-sections: true
header: "texwright / Agent integration"
footer: "SOPHIA XT LLC"
diagram-theme: neutral
---

# Write, validate, repair, inspect {#sec:loop}

Read the writing guide once, then start from a template. Prefer Markdown for prose with mathematics; use LaTeX for existing sources and JSON when your application already has a structured document tree.

## A reproducible first run

From a built repository:

~~~sh
node dist/cli.mjs new paper -o work/paper.md
node dist/cli.mjs check work/paper.md --diagnostics json
node dist/cli.mjs repair work/paper.md -o work/paper.pdf
node dist/cli.mjs outline work/paper.md --json
node dist/cli.mjs preview work/paper.md --page 1
~~~

Create the work folder first if needed. The paper template writes its sample bibliography beside the document.

## Interpret results deliberately

The check command runs parsing, numbering, mathematics, references, and citations, but not page layout. The repair command applies safe fixes until none remains and renders when the document has no errors. Review suggestions that are not marked safe. Set a retry budget and stop for review if the same diagnostic repeats.

~~~{.mermaid #fig:decision caption="A bounded validation loop."}
flowchart LR
  draft[Draft] --> check[Check]
  check --> clean{Errors remain?}
  clean -->|Yes| fix[Fix source]
  fix --> check
  clean -->|No| render[Render]
  render --> preview[Review pages]
~~~

A best-effort PDF can be written even when rendering fails. Treat the ok field and the CLI exit status as authoritative. Inspect warnings and actual pages before delivering a final document.

\newpage

# Connect through MCP {#sec:mcp}

Build the repository, then point your MCP client at the local bundle using absolute paths. This JSON illustrates the common mcpServers configuration shape; the enclosing configuration depends on the client.

~~~json
{
  "mcpServers": {
    "texwright": {
      "command": "node",
      "args": [
        "/absolute/path/to/texwright/dist/cli.mjs",
        "mcp", "--root", "/absolute/path/to/documents"
      ]
    }
  }
}
~~~

On Windows use forward slashes in JSON paths, such as D:/texwright/dist/cli.mjs. The server uses stdio. Keep standard output reserved for the protocol.

| Tool | When to use it |
|:--|:--|
| get_guide | Read supported syntax; short: true gives a short guide |
| new_document | Get a starter document and its companion assets |
| check_document | Validate source without page layout |
| fix_document | Apply safe fixes to an existing file |
| repair_document | Apply safe fixes repeatedly, then render |
| outline_document | Locate headings and numbered objects by source line |
| render_document | Write PDF, HTML, or JSON output |
| preview_page | Inspect selected pages as PNG images |
| get_schema | Obtain the structured document JSON Schema |

Table: All nine MCP tools in version 0.3.4. {#tbl:tools}

The generated [MCP tool catalog](https://github.com/Chorozion/texwright/blob/main/docs/reference/mcp-tools.json) records the actual names, descriptions, argument schemas, and annotations returned by the built server. Clients should also request tools/list from the running version.

Requests run in worker threads with a configurable time limit. Workspace paths must stay within the configured root; give explicit output paths when your application needs a predictable result location.

\newpage

# Use exact arguments {#sec:arguments}

The following objects are tool arguments, not a client-specific transport wrapper. For an existing report.md under the server root:

~~~json
{"path":"report.md","compact":true}
~~~

Pass that object to check_document. To render a PDF, use render_document:

~~~json
{
  "path": "report.md",
  "to": "pdf",
  "output_path": "report.pdf"
}
~~~

Then inspect the first page with preview_page:

~~~json
{"path":"report.md","pages":[1],"dpi":100}
~~~

Page numbers are one-based; MCP returns at most four page images per call. For in-memory text, use source and format; set base_dir to resolve accompanying assets. Some tools write source files: fix_document and repair_document require a path.

## Diagnose by code

| Code | Meaning | Next action |
|:--|:--|:--|
| REF001 | Undefined reference | Check the suggested existing label |
| CITE001 | Unknown citation key | Inspect the bibliography |
| MATH001 | Formula parse failure | Read the hint; check braces and macros |
| IMG001 | Missing or disallowed image | Use a file beside the document |
| LAY001 | Content exceeds a line | Shorten or break the content |
| DIAG001 | Diagram could not be parsed | Repair the diagram source |
| TIKZ001 / PST001 | Drawing feature approximated | Review the rendered figure |

Table: Common diagnostics and a useful response. {#tbl:diagnostics}

## Reproducibility and security

Keep source, figures, and bibliography together. Record the output of texwright --version --json to identify the exact build. Set SOURCE_DATE_EPOCH for reproducible PDF timestamps.

Leave raw HTML sanitization enabled for untrusted documents. Keep the MCP root narrow. Use local assets and review any explicit expansion of file or network access. A successful render does not validate the factual content of a document.
