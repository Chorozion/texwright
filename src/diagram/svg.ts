/**
 * Drawing pieces shared by the diagram types: SVG text for labels, node
 * shapes (with a point-in-shape test, so an edge can stop exactly at any
 * outline), cubic curves cut where they leave a shape, and arrowheads.
 */

import { DIAGRAM_FONT, type Label } from "./text.js";
import type { Theme } from "./theme.js";

export type Pt = [number, number];
/** A cubic Bézier: start, two controls, end. */
export type Cubic = [Pt, Pt, Pt, Pt];

export const n = (v: number): string => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A label drawn centred on (cx, cy), or left-aligned from cx when `align` is "start". */
export function labelSvg(label: Label, cx: number, cy: number, fill: string, opts: { align?: "middle" | "start" | "end"; weight?: "bold" } = {}): string {
  if (!label.lines.length) return "";
  const align = opts.align ?? "middle";
  const top = cy - label.height / 2;
  const out: string[] = [];
  label.lines.forEach((line, i) => {
    const y = top + i * label.lineHeight + label.ascent;
    const spans = line
      .map((p) => {
        const attrs = `${p.bold || opts.weight === "bold" ? ' font-weight="bold"' : ""}${p.italic ? ' font-style="italic"' : ""}`;
        return attrs ? `<tspan${attrs}>${esc(p.text)}</tspan>` : esc(p.text);
      })
      .join("");
    out.push(`<text x="${n(cx)}" y="${n(y)}" text-anchor="${align}"${opts.weight === "bold" ? ' font-weight="bold"' : ""} xml:space="preserve">${spans}</text>`);
  });
  return `<g font-family="${DIAGRAM_FONT}" font-size="${n(label.size)}" fill="${fill}">${out.join("")}</g>`;
}

// ---------------------------------------------------------------- shapes

export type ShapeKind =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "doublecircle"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "parallelogram-alt"
  | "trapezoid"
  | "trapezoid-alt"
  | "asymmetric"
  | "document"
  | "note"
  | "point"
  | "fork";

/** Box size a shape needs around a label of w x h, with its padding. */
export function shapeSize(kind: ShapeKind, w: number, h: number, padX: number, padY: number): [number, number] {
  const bw = w + 2 * padX;
  const bh = h + 2 * padY;
  switch (kind) {
    case "circle":
    case "doublecircle": {
      const d = Math.max(Math.hypot(w, h) + padY, 28) + (kind === "doublecircle" ? 8 : 0);
      return [d, d];
    }
    case "diamond": {
      // The label's box fits inside the diamond: half-diagonals add.
      const s = Math.max(w + h + 2 * padY, 40);
      return [s * 1.15, s * 0.85];
    }
    case "hexagon":
      return [bw + bh * 0.6, bh];
    case "parallelogram":
    case "parallelogram-alt":
    case "trapezoid":
    case "trapezoid-alt":
      return [bw + bh * 0.7, bh];
    case "stadium":
      return [bw + bh * 0.5, bh];
    case "subroutine":
      return [bw + 16, bh];
    case "cylinder":
      return [bw, bh + 16];
    case "asymmetric":
      return [bw + bh * 0.4, bh];
    case "document":
      return [bw, bh + 8];
    case "point":
      return [10, 10];
    case "fork":
      return [70, 8];
    default:
      return [bw, bh];
  }
}

/** The outline of a shape centred at (cx, cy), as SVG elements. */
export interface ShapeStyle {
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
  dash?: string;
  /** Opacity of the fill alone (shadows). */
  fillOpacity?: number;
  /** Draw the theme's soft shadow under the shape first. */
  shadow?: Theme["shadow"];
}

/**
 * The soft shadow for any box: an offset copy of a rectangle (or the given
 * shape) in the shadow colour, faint, with no stroke. Diagram types that
 * draw their own boxes call this before drawing them.
 */
export function shadowSvg(kind: ShapeKind, cx: number, cy: number, w: number, h: number, radius: number, shadow: Theme["shadow"]): string {
  if (!shadow || kind === "point" || kind === "fork") return "";
  return shapeSvg(kind, cx + shadow.dx, cy + shadow.dy, w, h, { fill: shadow.color, stroke: "none", strokeWidth: 0, radius, fillOpacity: shadow.opacity });
}

export function shapeSvg(kind: ShapeKind, cx: number, cy: number, w: number, h: number, style: ShapeStyle): string {
  if (style.shadow) return shadowSvg(kind, cx, cy, w, h, style.radius, style.shadow) + shapeSvg(kind, cx, cy, w, h, { ...style, shadow: undefined });
  const x = cx - w / 2;
  const y = cy - h / 2;
  const a = `fill="${style.fill}"${style.fillOpacity !== undefined ? ` fill-opacity="${n(style.fillOpacity)}"` : ""} stroke="${style.stroke}" stroke-width="${n(style.strokeWidth)}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}`;
  const poly = (pts: Pt[]) => `<polygon points="${pts.map((p) => `${n(p[0])},${n(p[1])}`).join(" ")}" ${a} stroke-linejoin="round"/>`;
  switch (kind) {
    case "round":
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(Math.min(12, h / 3))}" ${a}/>`;
    case "stadium":
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" ${a}/>`;
    case "subroutine":
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ${a}/><path d="M${n(x + 8)} ${n(y)}V${n(y + h)}M${n(x + w - 8)} ${n(y)}V${n(y + h)}" fill="none" stroke="${style.stroke}" stroke-width="${n(style.strokeWidth)}"/>`;
    case "cylinder": {
      const ry = Math.min(8, h / 6);
      return (
        `<path d="M${n(x)} ${n(y + ry)}A${n(w / 2)} ${n(ry)} 0 0 1 ${n(x + w)} ${n(y + ry)}V${n(y + h - ry)}A${n(w / 2)} ${n(ry)} 0 0 1 ${n(x)} ${n(y + h - ry)}Z" ${a}/>` +
        `<path d="M${n(x)} ${n(y + ry)}A${n(w / 2)} ${n(ry)} 0 0 0 ${n(x + w)} ${n(y + ry)}" fill="none" stroke="${style.stroke}" stroke-width="${n(style.strokeWidth)}"/>`
      );
    }
    case "circle":
      return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(w / 2)}" ${a}/>`;
    case "doublecircle":
      return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(w / 2)}" ${a}/><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(w / 2 - 4)}" fill="none" stroke="${style.stroke}" stroke-width="${n(style.strokeWidth)}"/>`;
    case "diamond":
      return poly([
        [cx, y],
        [x + w, cy],
        [cx, y + h],
        [x, cy],
      ]);
    case "hexagon": {
      const d = h * 0.3;
      return poly([
        [x + d, y],
        [x + w - d, y],
        [x + w, cy],
        [x + w - d, y + h],
        [x + d, y + h],
        [x, cy],
      ]);
    }
    case "parallelogram":
    case "parallelogram-alt": {
      const d = h * 0.35 * (kind === "parallelogram" ? 1 : -1);
      return poly([
        [x + Math.max(0, d), y],
        [x + w + Math.min(0, d), y],
        [x + w - Math.max(0, d), y + h],
        [x - Math.min(0, d), y + h],
      ]);
    }
    case "trapezoid":
    case "trapezoid-alt": {
      const d = h * 0.35;
      return kind === "trapezoid"
        ? poly([
            [x + d, y],
            [x + w - d, y],
            [x + w, y + h],
            [x, y + h],
          ])
        : poly([
            [x, y],
            [x + w, y],
            [x + w - d, y + h],
            [x + d, y + h],
          ]);
    }
    case "asymmetric": {
      const d = h * 0.3;
      return poly([
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
        [x + d, cy],
      ]);
    }
    case "document": {
      const wave = Math.min(8, h / 5);
      return `<path d="M${n(x)} ${n(y)}H${n(x + w)}V${n(y + h - wave)}C${n(x + w * 0.75)} ${n(y + h - 2.2 * wave)} ${n(x + w * 0.25)} ${n(y + h + 0.8 * wave)} ${n(x)} ${n(y + h - wave)}Z" ${a}/>`;
    }
    case "note": {
      const f = 9;
      return `<path d="M${n(x)} ${n(y)}H${n(x + w - f)}L${n(x + w)} ${n(y + f)}V${n(y + h)}H${n(x)}Z" ${a}/><path d="M${n(x + w - f)} ${n(y)}V${n(y + f)}H${n(x + w)}" fill="none" stroke="${style.stroke}" stroke-width="${n(style.strokeWidth)}"/>`;
    }
    case "point":
      return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(w / 2)}" fill="${style.stroke}" stroke="none"/>`;
    case "fork":
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="2" fill="${style.stroke}" stroke="none"/>`;
    default:
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(style.radius)}" ${a}/>`;
  }
}

/** Is (px, py) inside the shape centred at (cx, cy)? Used to cut edges at the outline. */
export function insideShape(kind: ShapeKind, cx: number, cy: number, w: number, h: number, px: number, py: number): boolean {
  const dx = px - cx;
  const dy = py - cy;
  switch (kind) {
    case "circle":
    case "doublecircle":
    case "point":
      return dx * dx + dy * dy <= (w / 2) * (w / 2);
    case "diamond":
      return Math.abs(dx) / (w / 2) + Math.abs(dy) / (h / 2) <= 1;
    case "hexagon": {
      if (Math.abs(dy) > h / 2) return false;
      const d = h * 0.3;
      return Math.abs(dx) <= w / 2 - d * (Math.abs(dy) / (h / 2));
    }
    case "stadium": {
      if (Math.abs(dy) > h / 2 || Math.abs(dx) > w / 2) return false;
      const r = h / 2;
      const ex = Math.abs(dx) - (w / 2 - r);
      return ex <= 0 || ex * ex + dy * dy <= r * r;
    }
    default:
      return Math.abs(dx) <= w / 2 && Math.abs(dy) <= h / 2;
  }
}

// ---------------------------------------------------------------- curves

export function bez(c: Cubic, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}

/** The part of a cubic from t to 1 (or 0 to t when `head`). */
export function splitCubic(c: Cubic, t: number, head = false): Cubic {
  const lerp = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const p01 = lerp(c[0], c[1]);
  const p12 = lerp(c[1], c[2]);
  const p23 = lerp(c[2], c[3]);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const m = lerp(p012, p123);
  return head ? [c[0], p01, p012, m] : [m, p123, p23, c[3]];
}

/** The t where a curve starting inside `inside` first leaves it (bisection after coarse steps). */
export function exitT(c: Cubic, inside: (p: Pt) => boolean): number {
  if (!inside(c[0])) return 0;
  let lo = 0;
  let hi = 1;
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (!inside(bez(c, t))) {
      hi = t;
      lo = (i - 1) / steps;
      break;
    }
    if (i === steps) return 1;
  }
  for (let k = 0; k < 20; k++) {
    const m = (lo + hi) / 2;
    if (inside(bez(c, m))) lo = m;
    else hi = m;
  }
  return hi;
}

export function reverse(c: Cubic): Cubic {
  return [c[3], c[2], c[1], c[0]];
}

export function pathData(cs: Cubic[]): string {
  if (!cs.length) return "";
  let d = `M${n(cs[0][0][0])} ${n(cs[0][0][1])}`;
  for (const c of cs) d += `C${n(c[1][0])} ${n(c[1][1])} ${n(c[2][0])} ${n(c[2][1])} ${n(c[3][0])} ${n(c[3][1])}`;
  return d;
}

// ---------------------------------------------------------------- ends

export type EndKind = "arrow" | "open" | "cross" | "circle" | "diamond" | "diamond-filled" | "triangle" | "none" | "one" | "many" | "zero-one" | "zero-many" | "one-many";

/** How far an end marker reaches back along the line (the line stops there so it does not show through). */
export function endInset(kind: EndKind, lw: number): number {
  switch (kind) {
    case "arrow":
      return 7 + lw * 2;
    case "triangle":
      return 12;
    case "circle":
      return 8;
    case "diamond":
    case "diamond-filled":
      return 16;
    default:
      return 0;
  }
}

/**
 * The marker at an end point (tip at `tip`, line arriving from direction
 * `from`). `bg` fills hollow markers.
 */
export function endSvg(kind: EndKind, tip: Pt, from: Pt, color: string, lw: number, bg: string): string {
  let ux = tip[0] - from[0];
  let uy = tip[1] - from[1];
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  const px = -uy;
  const py = ux;
  const at = (back: number, side: number): string => `${n(tip[0] - ux * back + px * side)},${n(tip[1] - uy * back + py * side)}`;
  const line = (b1: number, s1: number, b2: number, s2: number) => `<path d="M${at(b1, s1).replace(",", " ")}L${at(b2, s2).replace(",", " ")}" stroke="${color}" stroke-width="${n(lw)}" fill="none"/>`;
  switch (kind) {
    case "arrow": {
      const L = 7 + lw * 2;
      const W = 3.4 + lw;
      return `<path d="M${at(0, 0).replace(",", " ")}L${at(L, W).replace(",", " ")}Q${at(L * 0.72, 0).replace(",", " ")} ${at(L, -W).replace(",", " ")}Z" fill="${color}" stroke="${color}" stroke-width="${n(lw * 0.6)}" stroke-linejoin="round"/>`;
    }
    case "open":
      return `<path d="M${at(9, 5).replace(",", " ")}L${at(0, 0).replace(",", " ")}L${at(9, -5).replace(",", " ")}" fill="none" stroke="${color}" stroke-width="${n(lw)}" stroke-linejoin="round" stroke-linecap="round"/>`;
    case "triangle":
      return `<polygon points="${at(0, 0)} ${at(12, 7)} ${at(12, -7)}" fill="${bg}" stroke="${color}" stroke-width="${n(lw)}" stroke-linejoin="round"/>`;
    case "cross":
      return line(2, 5, 12, -5) + line(2, -5, 12, 5);
    case "circle":
      return `<circle cx="${at(4, 0).split(",")[0]}" cy="${at(4, 0).split(",")[1]}" r="4" fill="${bg}" stroke="${color}" stroke-width="${n(lw)}"/>`;
    case "diamond":
    case "diamond-filled":
      return `<polygon points="${at(0, 0)} ${at(8, 5)} ${at(16, 0)} ${at(8, -5)}" fill="${kind === "diamond" ? bg : color}" stroke="${color}" stroke-width="${n(lw)}" stroke-linejoin="round"/>`;
    case "one":
      return line(6, 6, 6, -6) + line(10, 6, 10, -6);
    case "zero-one":
      return line(6, 6, 6, -6) + `<circle cx="${at(14, 0).split(",")[0]}" cy="${at(14, 0).split(",")[1]}" r="4" fill="${bg}" stroke="${color}" stroke-width="${n(lw)}"/>`;
    case "many":
    case "one-many":
    case "zero-many": {
      const crow = `<path d="M${at(0, 7).replace(",", " ")}L${at(10, 0).replace(",", " ")}L${at(0, -7).replace(",", " ")}" fill="none" stroke="${color}" stroke-width="${n(lw)}"/>`;
      if (kind === "one-many") return crow + line(13, 6, 13, -6);
      if (kind === "zero-many") return crow + `<circle cx="${at(16, 0).split(",")[0]}" cy="${at(16, 0).split(",")[1]}" r="4" fill="${bg}" stroke="${color}" stroke-width="${n(lw)}"/>`;
      return crow;
    }
    default:
      return "";
  }
}

/** The SVG document around drawn content. */
export function svgDocument(width: number, height: number, body: string, theme: Theme, title?: string): string {
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const bg = theme.background !== "transparent" ? `<rect width="${w}" height="${h}" fill="${theme.background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"${title ? ` aria-label="${esc(title)}"` : ""}>${title ? `<title>${esc(title)}</title>` : ""}${bg}${body}</svg>`;
}

/**
 * A smooth curve through points: it leaves the first and enters the last
 * along the main axis (down for vertical layouts, across otherwise), and
 * passes through the bends in between with Catmull-Rom tangents, so long
 * edges bend once instead of wobbling at every rank.
 */
export function smoothPath(pts: Pt[], vertical: boolean): Cubic[] {
  const k = pts.length;
  if (k < 2) return [];
  const axis = (a: Pt, b: Pt): Pt => (vertical ? [0, (b[1] - a[1]) * 1.5] : [(b[0] - a[0]) * 1.5, 0]);
  const tan: Pt[] = pts.map((p, i) => {
    if (i === 0) return axis(p, pts[1]);
    if (i === k - 1) return axis(pts[k - 2], p);
    return [(pts[i + 1][0] - pts[i - 1][0]) / 2, (pts[i + 1][1] - pts[i - 1][1]) / 2];
  });
  const out: Cubic[] = [];
  for (let i = 0; i + 1 < k; i++) {
    const p = pts[i];
    const q = pts[i + 1];
    out.push([p, [p[0] + tan[i][0] / 3, p[1] + tan[i][1] / 3], [q[0] - tan[i + 1][0] / 3, q[1] - tan[i + 1][1] / 3], q]);
  }
  return out;
}
