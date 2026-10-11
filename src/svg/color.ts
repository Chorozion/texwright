/**
 * CSS colours: all named colours, #rgb, #rgba, #rrggbb, #rrggbbaa,
 * rgb()/rgba() with numbers or percentages (comma or space syntax),
 * hsl()/hsla(), `transparent` and `currentColor`.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** Alpha 0..1. */
  a: number;
}

const NAMED_SRC =
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 " +
  "blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 " +
  "chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b " +
  "darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b " +
  "darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a " +
  "darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 " +
  "darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff " +
  "firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff " +
  "gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f grey 808080 honeydew f0fff0 " +
  "hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 " +
  "lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff " +
  "lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 " +
  "lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 " +
  "lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 " +
  "mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 " +
  "mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585 " +
  "midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 " +
  "oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 " +
  "palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 " +
  "peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 " +
  "red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 " +
  "seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 " +
  "slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 " +
  "tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 " +
  "yellowgreen 9acd32";

const NAMED = new Map<string, string>();
{
  const parts = NAMED_SRC.split(" ");
  for (let i = 0; i + 1 < parts.length; i += 2) NAMED.set(parts[i], parts[i + 1]);
}

/** Number of named colours known (for tests). */
export const NAMED_COLOR_COUNT = NAMED.size;

function hex(h: string): Rgba | undefined {
  if (!/^[0-9a-fA-F]+$/.test(h)) return undefined;
  const d = (i: number, len: number) => {
    const v = parseInt(h.substr(i, len), 16);
    return len === 1 ? (v * 17) / 255 : v / 255;
  };
  switch (h.length) {
    case 3:
      return { r: d(0, 1), g: d(1, 1), b: d(2, 1), a: 1 };
    case 4:
      return { r: d(0, 1), g: d(1, 1), b: d(2, 1), a: d(3, 1) };
    case 6:
      return { r: d(0, 2), g: d(2, 2), b: d(4, 2), a: 1 };
    case 8:
      return { r: d(0, 2), g: d(2, 2), b: d(4, 2), a: d(6, 2) };
    default:
      return undefined;
  }
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** One functional-notation argument: a number or a percentage. */
function arg(s: string): { v: number; pct: boolean } | undefined {
  const t = s.trim();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(%|deg|rad|grad|turn)?$/.exec(t);
  if (!m) return undefined;
  let v = Number(m[1]);
  const unit = m[2];
  if (unit === "rad") v = (v * 180) / Math.PI;
  else if (unit === "grad") v *= 0.9;
  else if (unit === "turn") v *= 360;
  return { v, pct: unit === "%" };
}

function args(body: string): { v: number; pct: boolean }[] | undefined {
  // Both "1, 2, 3, 0.5" and "1 2 3 / 0.5".
  let parts: string[];
  if (body.includes(",")) parts = body.split(",");
  else {
    const [main, alpha] = body.split("/");
    parts = main.trim().split(/\s+/);
    if (alpha !== undefined) parts.push(alpha);
  }
  const out: { v: number; pct: boolean }[] = [];
  for (const p of parts) {
    const a = arg(p);
    if (!a) return undefined;
    out.push(a);
  }
  return out;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return s === 0 ? [l, l, l] : [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/**
 * Parses a CSS colour. Returns "currentColor" for that keyword and
 * undefined for anything that is not a colour (including `none`).
 */
export function parseColor(input: string): Rgba | "currentColor" | undefined {
  const s = input.trim();
  if (!s || s.length > 200) return undefined;
  if (s[0] === "#") return hex(s.slice(1));
  const lower = s.toLowerCase();
  if (lower === "currentcolor") return "currentColor";
  if (lower === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED.get(lower);
  if (named) return hex(named);
  const m = /^(rgba?|hsla?)\(\s*([^()]*)\)$/.exec(lower);
  if (!m) return undefined;
  const a = args(m[2]);
  if (!a || (a.length !== 3 && a.length !== 4)) return undefined;
  const alpha = a.length === 4 ? clamp01(a[3].pct ? a[3].v / 100 : a[3].v) : 1;
  if (m[1].startsWith("rgb")) {
    const c = (x: { v: number; pct: boolean }) => clamp01(x.pct ? x.v / 100 : x.v / 255);
    return { r: c(a[0]), g: c(a[1]), b: c(a[2]), a: alpha };
  }
  const [r, g, b] = hslToRgb(a[0].v, clamp01(a[1].v / 100), clamp01(a[2].v / 100));
  return { r, g, b, a: alpha };
}
