/**
 * Diagrams from text, drawn by texwright itself: Mermaid's syntax, our own
 * parsers, layout and look. The result is SVG, which the PDF engine draws as
 * vectors and HTML output inlines, so a diagram's labels stay text.
 *
 *   renderDiagram("flowchart LR\n  a --> b") -> { svg, width, height, errors }
 *
 * Front matter (--- title: ... config: theme: ... ---) and %%{init: {...}}%%
 * directives choose the theme and its variables, as in Mermaid. Errors carry
 * the line and column inside the diagram source; a diagram with errors is
 * still drawn as far as it could be read.
 */

import { parseYaml } from "../util/yaml.js";
import { renderClassDiagram } from "./classdiagram.js";
import { renderEr } from "./er.js";
import { renderFlowchart } from "./flowchart.js";
import { renderGantt } from "./gantt.js";
import { renderJourney } from "./journey.js";
import { renderMindmap } from "./mindmap.js";
import { renderPie } from "./pie.js";
import { renderQuadrant } from "./quadrant.js";
import { renderSequence } from "./sequence.js";
import { renderState } from "./state.js";
import { renderTimeline } from "./timeline.js";
import { renderXyChart } from "./xychart.js";
import { makeTheme } from "./theme.js";
import type { DiagramContext, DiagramError, Rendered } from "./types.js";
import { Lru, memoRender } from "../typeset/cache.js";

export type { DiagramError } from "./types.js";

export interface DiagramOptions {
  /** Theme name (default, neutral, forest, dark, base); the diagram's own settings win. */
  theme?: string;
  themeVariables?: Record<string, unknown>;
}

export interface DiagramResult extends Rendered {
  /** The diagram kind, e.g. "flowchart". */
  kind: string;
  title?: string;
  errors: DiagramError[];
}

type Renderer = (src: string, ctx: DiagramContext) => Rendered;

/** First keyword of the diagram -> renderer. */
const RENDERERS: { re: RegExp; kind: string; render: Renderer }[] = [
  { re: /^(flowchart|flowchart-elk|graph)\b/, kind: "flowchart", render: renderFlowchart },
  { re: /^sequenceDiagram\b/, kind: "sequence", render: renderSequence },
  { re: /^classDiagram(-v2)?\b/, kind: "class", render: renderClassDiagram },
  { re: /^stateDiagram(-v2)?\b/, kind: "state", render: renderState },
  { re: /^erDiagram\b/, kind: "er", render: renderEr },
  { re: /^gantt\b/, kind: "gantt", render: renderGantt },
  { re: /^pie\b/, kind: "pie", render: renderPie },
  { re: /^timeline\b/, kind: "timeline", render: renderTimeline },
  { re: /^xychart(-beta)?\b/, kind: "xychart", render: renderXyChart },
  { re: /^mindmap\b/, kind: "mindmap", render: renderMindmap },
  { re: /^journey\b/, kind: "journey", render: renderJourney },
  { re: /^quadrantChart\b/, kind: "quadrant", render: renderQuadrant },
];

export const DIAGRAM_KINDS = (): string[] => RENDERERS.map((r) => r.kind);

const diagramCache = new Lru<{ calls: [string, string, string][]; result: DiagramResult }>("diagram", 256, 300_000);

/** Draws a diagram from its Mermaid source. Never throws: problems come back as errors. Repeated diagrams come from a cache. */
export function renderDiagram(source: string, opts: DiagramOptions = {}): DiagramResult {
  return memoRender(diagramCache, source, opts, renderDiagramFresh);
}

function renderDiagramFresh(source: string, opts: DiagramOptions): DiagramResult {
  const errors: DiagramError[] = [];
  let src = source.replace(/\r\n?/g, "\n");
  let offset = 0;
  let themeName = opts.theme;
  let vars: Record<string, unknown> = { ...(opts.themeVariables ?? {}) };
  let title: string | undefined;

  // Front matter: --- ... --- at the very top.
  const fm = /^\s*---\n([^]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (fm) {
    const parsed = parseYaml(fm[1]);
    const data = parsed.value as Record<string, unknown> | null | undefined;
    if (parsed.error) errors.push({ line: 1, col: 0, message: "The diagram's front matter is not valid YAML", hint: "Front matter is --- on its own line, YAML, then --- again" });
    else if (data && typeof data === "object") {
      if (typeof data.title === "string") title = data.title;
      const cfg = data.config as Record<string, unknown> | undefined;
      if (cfg && typeof cfg === "object") {
        if (typeof cfg.theme === "string") themeName = cfg.theme;
        if (cfg.themeVariables && typeof cfg.themeVariables === "object") vars = { ...vars, ...(cfg.themeVariables as Record<string, unknown>) };
      }
    }
    offset = fm[0].split("\n").length - 1;
    src = src.slice(fm[0].length);
  }
  // %%{init: {...}}%% directives, anywhere; replaced by blank lines so positions hold.
  src = src.replace(/%%\{([^]*?)\}%%/g, (m, body: string) => {
    const json = body.replace(/^\s*(init|initialize)\s*:\s*/, "");
    try {
      const cfg = JSON.parse(json.replace(/'/g, '"')) as Record<string, unknown>;
      if (typeof cfg.theme === "string") themeName = cfg.theme;
      if (cfg.themeVariables && typeof cfg.themeVariables === "object") vars = { ...vars, ...(cfg.themeVariables as Record<string, unknown>) };
    } catch {
      // Not JSON we can read: the directive is ignored, as Mermaid would ignore unknown keys.
    }
    return m.replace(/[^\n]/g, " ");
  });

  const fmErrors = errors.length;
  const theme = makeTheme(themeName, vars);
  const ctx: DiagramContext = { theme, errors, title };
  const lines = src.split("\n");
  const first = lines.findIndex((l) => l.trim() && !l.trim().startsWith("%%"));
  if (first < 0) {
    errors.push({ line: 0, col: 0, message: "The diagram is empty", hint: "Start with a diagram type, for example: flowchart LR" });
    for (const e of errors.slice(fmErrors)) e.line += offset;
    return { svg: "", width: 0, height: 0, kind: "", errors };
  }
  const head = lines[first].trim();
  const r = RENDERERS.find((x) => x.re.test(head));
  if (!r) {
    const word = head.split(/\s/)[0];
    const kinds = DIAGRAM_KINDS();
    const close = kinds.find((k) => k.startsWith(word.slice(0, 3).toLowerCase()));
    errors.push({
      line: first,
      col: lines[first].indexOf(word),
      message: `"${word}" is not a diagram type texwright draws`,
      hint: `Supported: ${kinds.join(", ")}`,
      ...(close && close !== word ? { fix: { old: word, new: close } } : {}),
    });
    for (const e of errors.slice(fmErrors)) e.line += offset;
    return { svg: "", width: 0, height: 0, kind: "", errors };
  }
  let out: Rendered;
  try {
    out = r.render(src, ctx);
  } catch (e) {
    errors.push({ line: first, col: 0, message: `Internal error while drawing the ${r.kind}: ${(e as Error).message}` });
    for (const x of errors.slice(fmErrors)) x.line += offset;
    return { svg: "", width: 0, height: 0, kind: r.kind, errors };
  }
  // Renderers count lines from the start of what they were given; shift past the front matter.
  for (const e of errors.slice(fmErrors)) e.line += offset;
  return { ...out, kind: r.kind, title: ctx.title, errors };
}
