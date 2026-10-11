# Security

texwright is meant to process documents written by people or programs you don't fully trust, including AI agents. By default:

- raw HTML is sanitized (no scripts, event handlers, styles, iframes or forms)
- nothing is fetched from the network: remote images are left out of PDF output, and HTML keeps remote image URLs only with `--allow-net`
- images, `\input` files and bibliographies are read only from the document's folder and folders you allow with `--allow-path`; symlinks are resolved before the check, and network (UNC) paths are refused without touching the network
- macro expansion (count and expanded size), nesting depth and JSON depth are bounded, and YAML anchors and aliases are refused outright
- SVG figures are parsed without document type declarations or custom entities, with caps on nodes, path commands, glyphs and reference depth; images inside an SVG obey the same folder rules
- font and image files are parsed defensively: sizes are checked before anything is allocated, and a corrupt file is a diagnostic, not a crash
- the MCP server reads and writes only inside its workspace root (`--root`) and runs each request in a worker thread with a time limit (`--timeout`); the CLI accepts `--timeout` too

`--unsafe-html` and `--allow-net` turn parts of this off; use them only for documents you trust.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private vulnerability reporting on this repository ("Security" tab, "Report a vulnerability"). Include the document and command that show the problem. You'll get a reply within a week.
