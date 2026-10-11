/**
 * pgfplots colour maps: the built-in ones (hot, the default, hot2, jet,
 * cool, bluered, viridis and friends from the colormaps library) and maps
 * a document defines with colormap={name}{rgb255(0cm)=(...) color(1cm)=(red)}.
 * A map is a list of stops on 0..1; colours between stops are mixed
 * linearly in RGB, as pgfplots does.
 */

import { type ColorLookup, type RGB, parseColor, rgbOf, toHex } from "./color.js";

export interface Colormap {
  name: string;
  /** Positions 0..1, increasing, with their colours. */
  stops: [number, RGB][];
}

/** Evenly spaced stops from hex colours. */
function even(name: string, hex: string[]): Colormap {
  return { name, stops: hex.map((h, i) => [i / (hex.length - 1), rgbOf(h)]) };
}

/** Stops at the given positions (any scale), normalized. */
function at(name: string, pts: [number, RGB][]): Colormap {
  const lo = pts[0][0];
  const hi = pts[pts.length - 1][0];
  return { name, stops: pts.map(([p, c]) => [(p - lo) / (hi - lo || 1), c]) };
}

const BUILTIN: Record<string, Colormap> = {
  hot: even("hot", ["#0000ff", "#ffff00", "#ff8000", "#ff0000"]),
  hot2: at("hot2", [
    [0, [0, 0, 0]],
    [3, [255, 0, 0]],
    [6, [255, 255, 0]],
    [8, [255, 255, 255]],
  ]),
  jet: at("jet", [
    [0, [0, 0, 128]],
    [1, [0, 0, 255]],
    [3, [0, 255, 255]],
    [5, [255, 255, 0]],
    [7, [255, 0, 0]],
    [8, [128, 0, 0]],
  ]),
  blackwhite: even("blackwhite", ["#000000", "#ffffff"]),
  bluered: even("bluered", ["#0000b4", "#00ffff", "#64ff00", "#ffff00", "#ff0000", "#800000"]),
  cool: even("cool", ["#ffffff", "#0080ff", "#ff00ff"]),
  greenyellow: even("greenyellow", ["#008000", "#ffff00"]),
  redyellow: even("redyellow", ["#ff0000", "#ffff00"]),
  violet: even("violet", ["#19197a", "#ffffff", "#ee8cee"]),
  viridis: even("viridis", ["#440154", "#472c7a", "#3b518b", "#2c718e", "#21908d", "#27ad81", "#5cc863", "#aadc32", "#fde725"]),
  plasma: even("plasma", ["#0d0887", "#4c02a1", "#7e03a8", "#a92395", "#cc4778", "#e66c5c", "#f89540", "#fdc527", "#f0f921"]),
  inferno: even("inferno", ["#000004", "#1b0c41", "#4a0c6b", "#781c6d", "#a52c60", "#cf4446", "#ed6925", "#fb9b06", "#fcffa4"]),
  magma: even("magma", ["#000004", "#1c1044", "#4f127b", "#812581", "#b5367a", "#e55064", "#fb8761", "#fec287", "#fcfdbf"]),
  parula: even("parula", ["#352a87", "#0f5cdd", "#1481d6", "#06a4ca", "#2eb7a4", "#87bf77", "#d1bb59", "#fec832", "#f9fb0e"]),
  autumn: even("autumn", ["#ff0000", "#ffff00"]),
  spring: even("spring", ["#ff00ff", "#ffff00"]),
  summer: even("summer", ["#008066", "#ffff66"]),
  winter: even("winter", ["#0000ff", "#00ff80"]),
  bone: even("bone", ["#000000", "#545474", "#a7c7c7", "#ffffff"]),
  copper: even("copper", ["#000000", "#ffa066", "#ffc77f"]),
  gray: even("gray", ["#000000", "#ffffff"]),
  "blackwhite reversed": even("blackwhite reversed", ["#ffffff", "#000000"]),
};

/** pgfplots' default colour map. */
export const DEFAULT_COLORMAP = BUILTIN.hot;

/** A built-in map by name (`viridis`, `colormap/viridis`), or undefined. */
export function namedColormap(name: string): Colormap | undefined {
  const n = name.trim().replace(/^\/pgfplots\//, "").replace(/^colormap\//, "");
  return Object.hasOwn(BUILTIN, n) ? BUILTIN[n] : undefined;
}

/**
 * colormap={name}{spec}: the spec lists colours with optional positions,
 * rgb255(0cm)=(0,0,128) rgb(1cm)=(0,0,1) color(2cm)=(red!50) gray=(0.5),
 * separated by spaces or semicolons. Positions left out continue in steps
 * of one. Undefined when nothing could be read.
 */
export function parseColormap(value: string, local: Map<string, RGB>, lookup?: ColorLookup): Colormap | undefined {
  const m = /^\s*\{([^{}]*)\}\s*\{([^]*)\}\s*$/.exec(value);
  if (!m) return undefined;
  const name = m[1].trim();
  const pts: [number, RGB][] = [];
  const re = /(rgb255|rgb|color|gray|cmyk|HTML)\s*(?:\(\s*([^)]*)\))?\s*=\s*\(([^)]*)\)/g;
  let last = -1;
  for (let k = re.exec(m[2]); k && pts.length < 256; k = re.exec(m[2])) {
    const pos = k[2] !== undefined ? parseFloat(k[2]) : last + 1;
    if (!Number.isFinite(pos)) continue;
    const v = k[3].split(",").map((s) => Number(s.trim()));
    let c: RGB | undefined;
    if (k[1] === "rgb255" && v.length === 3 && v.every(Number.isFinite)) c = v as RGB;
    else if (k[1] === "rgb" && v.length === 3 && v.every(Number.isFinite)) c = v.map((x) => x * 255) as RGB;
    else if (k[1] === "gray" && Number.isFinite(v[0])) c = [v[0] * 255, v[0] * 255, v[0] * 255];
    else if (k[1] === "cmyk" && v.length === 4 && v.every(Number.isFinite)) c = v.slice(0, 3).map((x) => 255 * (1 - Math.min(1, x + v[3]))) as RGB;
    else if (k[1] === "HTML") c = rgbOf(`#${k[3].trim()}`);
    else if (k[1] === "color") {
      const hex = parseColor(k[3], local, lookup, "#000000");
      if (hex) c = rgbOf(hex);
    }
    if (!c) continue;
    // Positions must not go back.
    const p = Math.max(pos, last);
    pts.push([p, c.map((x) => Math.max(0, Math.min(255, x))) as RGB]);
    last = p;
  }
  if (!pts.length) return undefined;
  if (pts.length === 1) pts.push([pts[0][0] + 1, pts[0][1]]);
  return at(name, pts);
}

/** The colour at t in 0..1 (clamped) as RGB. */
export function rgbAt(map: Colormap, t: number): RGB {
  const s = map.stops;
  const x = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  for (let i = 1; i < s.length; i++) {
    if (x <= s[i][0] || i === s.length - 1) {
      const [p0, c0] = s[i - 1];
      const [p1, c1] = s[i];
      const w = p1 > p0 ? Math.max(0, Math.min(1, (x - p0) / (p1 - p0))) : 1;
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * w) as RGB;
    }
  }
  return s[0][1];
}

/** The colour at t in 0..1 as #rrggbb. */
export function colorAt(map: Colormap, t: number): string {
  return toHex(rgbAt(map, t));
}

/** Gradient stops for a colour bar. */
export function gradientStops(map: Colormap): [number, string][] {
  return map.stops.map(([p, c]) => [p, toHex(c)]);
}
