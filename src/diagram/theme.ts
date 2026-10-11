/**
 * The look of diagrams. One designed default rather than Mermaid's: quiet
 * fills, hairline strokes in a single ink, a measured palette for things that
 * need telling apart (pie slices, gantt sections, classes), and type in the
 * document's sans face. Diagrams are printed on white pages as often as they
 * are read on screens, so every pairing holds contrast in greyscale too.
 *
 * Mermaid's theme names (default, neutral, forest, dark, base) select
 * variants, and its themeVariables (primaryColor, lineColor, fontSize, ...)
 * override single values, so a diagram written for Mermaid keeps its intent.
 */

export interface Theme {
  name: string;
  background: string;
  fontSize: number;
  text: string;
  mutedText: string;
  /** Nodes. */
  nodeFill: string;
  nodeStroke: string;
  /** Decision (diamond) nodes and other emphasis. */
  accentFill: string;
  accentStroke: string;
  /** Edges and arrowheads. */
  line: string;
  lineWidth: number;
  edgeLabelBg: string;
  /** Subgraphs, packages, alt/loop boxes. */
  clusterFill: string;
  clusterStroke: string;
  clusterText: string;
  /** Notes. */
  noteFill: string;
  noteStroke: string;
  /** Series colours, in order: pie slices, gantt sections, actor accents. */
  palette: string[];
  /** Corner radius of plain boxes. */
  radius: number;
  /**
   * The soft shadow under boxes, texwright's signature: a faint offset copy
   * of the shape that lifts it off the page. Undefined draws none.
   */
  shadow?: { color: string; opacity: number; dx: number; dy: number };
}

const INK = "#1f2937";

export const THEMES: Record<string, Theme> = {
  default: {
    name: "default",
    background: "transparent",
    fontSize: 14,
    text: INK,
    mutedText: "#4b5563",
    nodeFill: "#eef3fb",
    nodeStroke: "#47618f",
    accentFill: "#fdf3e1",
    accentStroke: "#a8762c",
    line: "#46505e",
    lineWidth: 1.4,
    edgeLabelBg: "#ffffff",
    clusterFill: "#f6f8fb",
    clusterStroke: "#b8c3d4",
    clusterText: "#3c4a5f",
    noteFill: "#fff8d6",
    noteStroke: "#c7ab4a",
    palette: ["#4e79a7", "#e8a33d", "#59a14f", "#d4635e", "#76b7b2", "#9c6fb0", "#b6894f", "#e58fac", "#8c8c8c", "#c9b33c"],
    radius: 5,
    shadow: { color: "#1e2a44", opacity: 0.17, dx: 2, dy: 3 },
  },
  neutral: {
    name: "neutral",
    background: "transparent",
    fontSize: 14,
    text: "#1a1a1a",
    mutedText: "#4d4d4d",
    nodeFill: "#f2f2f2",
    nodeStroke: "#505050",
    accentFill: "#e4e4e4",
    accentStroke: "#3c3c3c",
    line: "#3c3c3c",
    lineWidth: 1.3,
    edgeLabelBg: "#ffffff",
    clusterFill: "#fafafa",
    clusterStroke: "#a6a6a6",
    clusterText: "#333333",
    noteFill: "#f5f5f5",
    noteStroke: "#8c8c8c",
    palette: ["#3d3d3d", "#7a7a7a", "#a8a8a8", "#5c5c5c", "#c4c4c4", "#2b2b2b", "#919191", "#d6d6d6"],
    radius: 4,
  },
  forest: {
    name: "forest",
    background: "transparent",
    fontSize: 14,
    text: "#1d2b1f",
    mutedText: "#3f5242",
    nodeFill: "#e9f3e6",
    nodeStroke: "#4f7a4c",
    accentFill: "#f6f0d8",
    accentStroke: "#8a7a34",
    line: "#3d4f3f",
    lineWidth: 1.4,
    edgeLabelBg: "#ffffff",
    clusterFill: "#f4f8f2",
    clusterStroke: "#a9c2a4",
    clusterText: "#36503a",
    noteFill: "#fbf6dc",
    noteStroke: "#b8a24a",
    palette: ["#4f7a4c", "#c39b3a", "#7aa6c2", "#b0625a", "#8fb87d", "#6f6aa8", "#a6845e", "#5e9c8f"],
    radius: 5,
    shadow: { color: "#1f3320", opacity: 0.17, dx: 2, dy: 3 },
  },
  dark: {
    name: "dark",
    background: "#111827",
    fontSize: 14,
    text: "#e5e7eb",
    mutedText: "#9ca3af",
    nodeFill: "#1f2a3d",
    nodeStroke: "#7aa2d6",
    accentFill: "#3a2e18",
    accentStroke: "#d6a34f",
    line: "#a6b0bf",
    lineWidth: 1.4,
    edgeLabelBg: "#111827",
    clusterFill: "#161f2e",
    clusterStroke: "#3f4c61",
    clusterText: "#c7d0dc",
    noteFill: "#3b3520",
    noteStroke: "#a8924a",
    palette: ["#7aa2d6", "#e3b25c", "#7cc47a", "#e07a73", "#82cfc8", "#b897d4", "#d1a774", "#ef9fbc"],
    radius: 5,
    shadow: { color: "#000000", opacity: 0.4, dx: 2, dy: 3 },
  },
};
THEMES.base = THEMES.default;

const VARIABLES: Record<string, keyof Theme> = {
  primarycolor: "nodeFill",
  primarybordercolor: "nodeStroke",
  primarytextcolor: "text",
  textcolor: "text",
  nodetextcolor: "text",
  mainbkg: "nodeFill",
  nodebordercolor: "nodeStroke",
  secondarycolor: "accentFill",
  secondarybordercolor: "accentStroke",
  tertiarycolor: "clusterFill",
  clusterbkg: "clusterFill",
  clusterborder: "clusterStroke",
  linecolor: "line",
  defaultlinkcolor: "line",
  edgelabelbackground: "edgeLabelBg",
  notebkgcolor: "noteFill",
  notebordercolor: "noteStroke",
  background: "background",
};

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|[a-z]{3,20}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/i;

/** A theme by Mermaid name, with themeVariables applied (unknown or unsafe values are ignored). */
export function makeTheme(name: string | undefined, vars: Record<string, unknown> = {}): Theme {
  const base = (name && Object.hasOwn(THEMES, name.toLowerCase()) ? THEMES[name.toLowerCase()] : THEMES.default) as Theme;
  const t: Theme = { ...base, palette: [...base.palette] };
  for (const [k, v] of Object.entries(vars)) {
    const key = k.toLowerCase();
    if (key === "fontsize") {
      const n = parseFloat(String(v));
      if (n >= 6 && n <= 40) t.fontSize = n;
      continue;
    }
    const pie = /^pie(\d+)$/.exec(key) ?? /^csection?bkgcolor(\d+)$/.exec(key);
    if (pie && typeof v === "string" && SAFE_COLOR.test(v.trim())) {
      const i = Number(pie[1]) - (key.startsWith("pie") ? 1 : 0);
      if (i >= 0 && i < 24) t.palette[i] = v.trim();
      continue;
    }
    const field = VARIABLES[key];
    if (field && typeof v === "string" && SAFE_COLOR.test(v.trim())) (t as unknown as Record<string, unknown>)[field] = v.trim();
  }
  return t;
}

/** A colour safe to write into an SVG attribute, or undefined. */
export function safeColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  return SAFE_COLOR.test(t) ? t : undefined;
}
