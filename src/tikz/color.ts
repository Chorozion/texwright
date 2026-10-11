/**
 * xcolor expressions as TikZ options use them: names (xcolor's base set,
 * dvipsnames favourites), mixes (red!50!blue, black!20 = 20% black in
 * white, blue!30!white!80!black), the complement (-red), and the current
 * colour as `.`. Colours the document defined come from a lookup the caller
 * passes in.
 */

export type RGB = [number, number, number];

/** 0..255 RGB. */
const NAMED: Record<string, RGB> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  yellow: [255, 255, 0],
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  darkgray: [64, 64, 64],
  lightgray: [191, 191, 191],
  brown: [191, 128, 64],
  lime: [191, 255, 0],
  olive: [128, 128, 0],
  orange: [255, 128, 0],
  pink: [255, 191, 191],
  purple: [191, 0, 64],
  teal: [0, 128, 128],
  violet: [128, 0, 128],
  // dvipsnames that pictures reach for.
  NavyBlue: [0, 110, 184],
  RoyalBlue: [0, 113, 188],
  MidnightBlue: [0, 103, 149],
  Cerulean: [0, 162, 227],
  CornflowerBlue: [65, 176, 228],
  SkyBlue: [70, 197, 221],
  ProcessBlue: [0, 176, 240],
  Blue: [45, 47, 146],
  ForestGreen: [0, 155, 85],
  OliveGreen: [60, 128, 49],
  PineGreen: [0, 139, 114],
  SeaGreen: [63, 188, 157],
  LimeGreen: [141, 199, 62],
  YellowGreen: [152, 204, 112],
  Emerald: [0, 169, 157],
  JungleGreen: [0, 169, 154],
  Green: [0, 166, 79],
  BrickRed: [182, 50, 28],
  Maroon: [175, 50, 53],
  RedOrange: [242, 96, 53],
  Bittersweet: [194, 48, 39],
  Red: [237, 27, 35],
  OrangeRed: [237, 19, 90],
  Orange: [245, 129, 55],
  YellowOrange: [250, 162, 26],
  Goldenrod: [255, 223, 66],
  Dandelion: [253, 188, 66],
  Yellow: [255, 242, 0],
  Apricot: [251, 185, 130],
  Peach: [247, 150, 90],
  Melon: [248, 158, 123],
  Salmon: [246, 146, 137],
  Lavender: [244, 158, 196],
  Thistle: [216, 131, 183],
  Orchid: [175, 114, 176],
  Plum: [146, 38, 143],
  Purple: [153, 71, 155],
  Violet: [88, 66, 155],
  RoyalPurple: [97, 63, 153],
  Mulberry: [169, 60, 147],
  Magenta: [236, 0, 140],
  CarnationPink: [242, 130, 180],
  Rhodamine: [239, 85, 159],
  Tan: [218, 157, 118],
  Brown: [121, 37, 0],
  Sepia: [103, 24, 0],
  RawSienna: [151, 64, 6],
  Mahogany: [169, 52, 31],
  Gray: [148, 150, 152],
  Black: [0, 0, 0],
  White: [255, 255, 255],
  Turquoise: [0, 180, 206],
  TealBlue: [0, 174, 179],
  Aquamarine: [0, 181, 190],
  BlueGreen: [0, 179, 184],
  // svgnames that come up.
  DarkBlue: [0, 0, 139],
  DarkGreen: [0, 100, 0],
  DarkRed: [139, 0, 0],
  LightBlue: [173, 216, 230],
  LightGreen: [144, 238, 144],
  Gold: [255, 215, 0],
  Crimson: [220, 20, 60],
  SteelBlue: [70, 130, 180],
  DodgerBlue: [30, 144, 255],
  Tomato: [255, 99, 71],
  Coral: [255, 127, 80],
  Navy: [0, 0, 128],
  Indigo: [75, 0, 130],
  Silver: [192, 192, 192],
};

export type ColorLookup = (name: string) => string | undefined;

function hexRgb(h: string): RGB | undefined {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(h.trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as RGB : undefined;
}

export function toHex(c: RGB): string {
  return `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** Whether a word names a colour (so `red` in an option list is a colour, not an unknown key). */
export function isColorName(name: string, local: Map<string, RGB>, lookup?: ColorLookup): boolean {
  return parseColor(name, local, lookup, "#000000") !== undefined;
}

/**
 * The colour of an xcolor expression as #rrggbb, or undefined. `current` is
 * what `.` means.
 */
export function parseColor(expr: string, local: Map<string, RGB>, lookup: ColorLookup | undefined, current: string): string | undefined {
  let s = expr.trim().replace(/^\{([^]*)\}$/, "$1").trim();
  if (!s) return undefined;
  if (s === "none") return undefined;
  // {rgb,255:red,10;green,20;blue,30} and {rgb:red,1;green,2;blue,3}.
  const model = /^(rgb|RGB)\s*(?:,\s*(\d+))?\s*:\s*(.*)$/.exec(s);
  if (model) {
    const max = model[2] ? Number(model[2]) : model[1] === "RGB" ? 255 : 1;
    const parts = model[3].split(";").map((x) => x.split(","));
    const acc: RGB = [0, 0, 0];
    let total = 0;
    for (const [name, w] of parts) {
      const c = base(name, local, lookup, current);
      const k = Number(w);
      if (!c || !Number.isFinite(k)) return undefined;
      for (let i = 0; i < 3; i++) acc[i] += c[i] * k;
      total += k;
    }
    // Weights relative to their sum when given as a mix, else to the model's maximum.
    const div = model[2] ? max : total || 1;
    return toHex(acc.map((v) => v / div) as RGB);
  }
  let complement = false;
  if (s.startsWith("-")) {
    complement = true;
    s = s.slice(1);
  }
  const parts = s.split("!");
  let c = base(parts[0], local, lookup, current);
  if (!c) return undefined;
  for (let i = 1; i < parts.length; i += 2) {
    const pct = Number(parts[i]);
    if (!Number.isFinite(pct)) return undefined;
    const other = parts[i + 1] !== undefined && parts[i + 1].trim() !== "" ? base(parts[i + 1], local, lookup, current) : [255, 255, 255];
    if (!other) return undefined;
    const w = Math.max(0, Math.min(100, pct)) / 100;
    c = c.map((v, k) => v * w + other[k] * (1 - w)) as RGB;
  }
  if (complement) c = c.map((v) => 255 - v) as RGB;
  return toHex(c);
}

function base(name: string, local: Map<string, RGB>, lookup: ColorLookup | undefined, current: string): RGB | undefined {
  const n = name.trim();
  if (n === ".") return hexRgb(current);
  const l = local.get(n);
  if (l) return l;
  if (Object.hasOwn(NAMED, n)) return NAMED[n];
  if (/^#[0-9a-fA-F]{6}$/.test(n)) return hexRgb(n);
  const ext = lookup?.(n);
  return ext ? hexRgb(ext) : undefined;
}

/** \definecolor{name}{model}{spec} as RGB. */
export function colorFromModel(model: string, spec: string): RGB | undefined {
  const n = spec.split(",").map((x) => Number(x.trim()));
  switch (model.trim()) {
    case "HTML":
      return hexRgb(spec);
    case "rgb":
      return n.length === 3 && n.every((v) => v >= 0 && v <= 1) ? (n.map((v) => v * 255) as RGB) : undefined;
    case "RGB":
      return n.length === 3 && n.every((v) => v >= 0 && v <= 255) ? (n as RGB) : undefined;
    case "gray":
      return n.length === 1 && n[0] >= 0 && n[0] <= 1 ? [n[0] * 255, n[0] * 255, n[0] * 255] : undefined;
    case "cmyk": {
      if (n.length !== 4) return undefined;
      const [c, m, y, k] = n;
      return [c, m, y].map((v) => 255 * (1 - Math.min(1, v + k))) as RGB;
    }
  }
  return undefined;
}

export function rgbOf(hex: string): RGB {
  return hexRgb(hex) ?? [0, 0, 0];
}

/** `a` mixed with `b`: w of a. */
export function mix(a: string, b: string, w: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return toHex(x.map((v, i) => v * w + y[i] * (1 - w)) as RGB);
}
