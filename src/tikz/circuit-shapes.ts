/**
 * The geometry of circuitikz components: what each bipole, tripole and
 * monopole draws, in its own frame. Bipoles run along +x from -w/2 to
 * w/2 with "above" at +y; nodes have their anchors in the same frame.
 * Sizes follow circuitikz's defaults (pgfcirc.defines): a bipole is drawn
 * in the middle of a 1.4cm path, a resistor is 0.8 of that long and 0.3
 * high, a capacitor 0.2 by 0.6, a source circle 0.6 across, and so on.
 * Component bodies are stroked twice as thick as the wires.
 *
 * Nothing here draws: a Pen collects outlines (in points), upright signs
 * and upright text, and src/tikz/circuit.ts maps and paints them.
 */

import { type Pt, type Seg, arcCubics } from "./geom.js";

export type Mode = "stroke" | "fill" | "both" | "white";

export interface Prim {
  segs: Seg[];
  mode: Mode;
  /** Line width as a multiple of the wire's. */
  w: number;
}

export interface Sign {
  kind: "+" | "-";
  at: Pt;
  /** Half the sign's size. */
  size: number;
}

export interface Glyph {
  text: string;
  at: Pt;
  /** Font scale relative to the picture's node font. */
  scale: number;
}

/** Collects a component's drawing in its own frame. */
export class Pen {
  prims: Prim[] = [];
  signs: Sign[] = [];
  texts: Glyph[] = [];
  /** Width factor for what is drawn next. */
  w = 2;

  line(...pts: Pt[]): this {
    if (pts.length < 2) return this;
    this.prims.push({ segs: pts.map((p, i): Seg => (i ? { t: "L", p } : { t: "M", p })), mode: "stroke", w: this.w });
    return this;
  }

  poly(pts: Pt[], mode: Mode = "stroke"): this {
    if (pts.length < 2) return this;
    const segs: Seg[] = pts.map((p, i): Seg => (i ? { t: "L", p } : { t: "M", p }));
    segs.push({ t: "Z" });
    this.prims.push({ segs, mode, w: this.w });
    return this;
  }

  rect(x0: number, y0: number, x1: number, y1: number, mode: Mode = "stroke"): this {
    return this.poly(
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      mode,
    );
  }

  /** An elliptical arc (degrees, counterclockwise when a1 > a0), open. */
  arc(c: Pt, rx: number, ry: number, a0: number, a1: number, mode: Mode = "stroke"): this {
    const a = arcCubics(c, [rx, 0], [0, ry], a0, a1);
    const segs: Seg[] = [{ t: "M", p: a.start }];
    for (const s of a.segs) segs.push({ t: "C", c1: s.c1, c2: s.c2, p: s.p });
    if (mode !== "stroke") segs.push({ t: "Z" });
    this.prims.push({ segs, mode, w: this.w });
    return this;
  }

  circle(c: Pt, r: number, mode: Mode = "stroke"): this {
    return this.arc(c, r, r, 0, 360, mode === "stroke" ? "stroke" : mode);
  }

  segs(segs: Seg[], mode: Mode = "stroke"): this {
    if (segs.length) this.prims.push({ segs, mode, w: this.w });
    return this;
  }

  /** A filled triangular arrowhead with its point at `tip`, pointing along unit `u`. */
  head(tip: Pt, u: Pt, len: number, half: number): this {
    const b: Pt = [tip[0] - u[0] * len, tip[1] - u[1] * len];
    const n: Pt = [-u[1] * half, u[0] * half];
    const old = this.w;
    this.w = 0.5;
    this.poly(
      [
        tip,
        [b[0] + n[0], b[1] + n[1]],
        [b[0] - n[0], b[1] - n[1]],
      ],
      "both",
    );
    this.w = old;
    return this;
  }

  /** A line from a to b with an arrowhead at b. */
  arrow(a: Pt, b: Pt, len: number, half: number): this {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const u: Pt = [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
    this.line(a, [b[0] - u[0] * len * 0.8, b[1] - u[1] * len * 0.8]);
    return this.head(b, u, len, half);
  }

  sign(kind: "+" | "-", at: Pt, size: number): this {
    this.signs.push({ kind, at, size });
    return this;
  }

  text(text: string, at: Pt, scale = 1): this {
    this.texts.push({ text, at, scale });
    return this;
  }

  /** The bounding box of the outlines: [minx, miny, maxx, maxy]. */
  box(): [number, number, number, number] {
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const grow = (p: Pt) => {
      b[0] = Math.min(b[0], p[0]);
      b[1] = Math.min(b[1], p[1]);
      b[2] = Math.max(b[2], p[0]);
      b[3] = Math.max(b[3], p[1]);
    };
    for (const pr of this.prims)
      for (const s of pr.segs) {
        if (s.t === "Z") continue;
        grow(s.p);
        if (s.t === "C") {
          grow(s.c1);
          grow(s.c2);
        }
      }
    for (const s of this.signs) {
      grow([s.at[0] - s.size, s.at[1] - s.size]);
      grow([s.at[0] + s.size, s.at[1] + s.size]);
    }
    return b;
  }
}

// ------------------------------------------------------------------ bipoles

export interface BipoleOpts {
  /** Picture-wide styles. */
  american: { voltage: boolean; current: boolean };
  /** Text drawn inside (t=, or the name of an unsupported component). */
  t?: string;
  /** Bipole length in points (for arrow and dot sizes). */
  len: number;
}

export interface BipoleDef {
  /** Width and height as fractions of the bipole length. */
  w: number;
  h: number;
  /** Which `<family>/scale` key scales it. */
  family: "resistors" | "capacitors" | "inductors" | "diodes" | "sources" | "csources" | "switches" | "other";
  /** A source: its own symbol fixes the polarity of v= (plus at the end, unless inverted). */
  source?: boolean;
  /** Draws nothing and leaves out the leads (open). */
  open?: boolean;
  draw(p: Pen, w: number, h: number, o: BipoleOpts): void;
}

const zigzag = (p: Pen, w: number, h: number) => {
  const pts: Pt[] = [[-w / 2, 0]];
  for (let k = 0; k < 6; k++) pts.push([-w / 2 + w / 12 + (k * w) / 6, k % 2 === 0 ? h / 2 : -h / 2]);
  pts.push([w / 2, 0]);
  p.line(...pts);
};

const americanInductor = (p: Pen, w: number, _h: number) => {
  const r = w / 8;
  const segs: Seg[] = [{ t: "M", p: [-w / 2, 0] }];
  for (let k = 0; k < 4; k++) {
    const a = arcCubics([-w / 2 + r + 2 * r * k, 0], [r, 0], [0, r], 180, 0);
    for (const s of a.segs) segs.push({ t: "C", c1: s.c1, c2: s.c2, p: s.p });
  }
  p.segs(segs);
};

/** circuitikz's cute inductor: a coil drawn as a prolate trochoid, four humps with small loops between. */
const cuteInductor = (p: Pen, w: number, h: number) => {
  const N = 4;
  const a = w / (2 * Math.PI * N);
  const b = 2.3 * a;
  const c = (h * 0.85) / 2;
  const pt = (t: number): Pt => [-w / 2 + a * t - b * Math.sin(t), c * (1 - Math.cos(t))];
  const dv = (t: number): Pt => [a - b * Math.cos(t), c * Math.sin(t)];
  const steps = N * 8;
  const T = 2 * Math.PI * N;
  const dt = T / steps;
  const segs: Seg[] = [{ t: "M", p: pt(0) }];
  for (let i = 0; i < steps; i++) {
    const t0 = i * dt;
    const t1 = t0 + dt;
    const p0 = pt(t0);
    const p1 = pt(t1);
    const d0 = dv(t0);
    const d1 = dv(t1);
    segs.push({ t: "C", c1: [p0[0] + (d0[0] * dt) / 3, p0[1] + (d0[1] * dt) / 3], c2: [p1[0] - (d1[0] * dt) / 3, p1[1] - (d1[1] * dt) / 3], p: p1 });
  }
  p.segs(segs);
};

const plates = (p: Pen, w: number, h: number) => {
  p.line([-w / 2, -h / 2], [-w / 2, h / 2]);
  p.line([w / 2, -h / 2], [w / 2, h / 2]);
};

const diode = (p: Pen, w: number, h: number, filled: boolean) => {
  p.poly(
    [
      [-w / 2, h / 2],
      [w / 2, 0],
      [-w / 2, -h / 2],
    ],
    filled ? "both" : "stroke",
  );
  p.line([w / 2, -h / 2], [w / 2, h / 2]);
};

/** Two small arrows leaving (led) or reaching (photodiode) the diode. */
const lightArrows = (p: Pen, w: number, h: number, out: boolean, len: number) => {
  const old = p.w;
  p.w = 1;
  for (const dx of [-0.05 * len, 0.1 * len]) {
    const a: Pt = [dx, h / 2 + 0.03 * len];
    const b: Pt = [dx + 0.14 * len, h / 2 + 0.2 * len];
    if (out) p.arrow(a, b, 0.07 * len, 0.03 * len);
    else p.arrow(b, a, 0.07 * len, 0.03 * len);
  }
  p.w = old;
  void w;
};

const sourceCircle = (p: Pen, w: number) => p.circle([0, 0], w / 2);

const diamond = (p: Pen, w: number, h: number) =>
  p.poly([
    [-w / 2, 0],
    [0, h / 2],
    [w / 2, 0],
    [0, -h / 2],
  ]);

/** The inside of a voltage source: + and - (american) or a line along the wire (european). */
const vMarks = (p: Pen, r: number, american: boolean) => {
  if (american) {
    p.sign("+", [r * 0.48, 0], r * 0.24);
    p.sign("-", [-r * 0.48, 0], r * 0.24);
  } else p.line([-r, 0], [r, 0]);
};

/** The inside of a current source: an arrow (american) or a line across the wire (european). */
const iMarks = (p: Pen, r: number, american: boolean, len: number) => {
  if (american) {
    const old = p.w;
    p.w = 1.5;
    p.arrow([-r * 0.6, 0], [r * 0.6, 0], 0.1 * len, 0.05 * len);
    p.w = old;
  } else p.line([0, -r], [0, r]);
};

const sine = (p: Pen, r: number) => {
  const segs: Seg[] = [];
  const n = 16;
  const amp = r * 0.32;
  const x0 = -r * 0.6;
  const x1 = r * 0.6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const pt: Pt = [x0 + (x1 - x0) * t, amp * Math.sin(2 * Math.PI * t)];
    segs.push(i ? { t: "L", p: pt } : { t: "M", p: pt });
  }
  const old = p.w;
  p.w = 1.5;
  p.segs(segs);
  p.w = old;
};

const box = (p: Pen, w: number, h: number) => p.rect(-w / 2, -h / 2, w / 2, h / 2);

const diagonalArrow = (p: Pen, w: number, h: number, len: number) => {
  const old = p.w;
  p.w = 1;
  p.arrow([-w * 0.4, -h * 0.9], [w * 0.4, h * 0.9], 0.08 * len, 0.035 * len);
  p.w = old;
};

const lever = (p: Pen, w: number, h: number, closedBar: boolean) => {
  p.line([-w / 2, 0], [w / 2, h]);
  if (closedBar) p.line([w / 2, 0], [w / 2, h * 1.15]);
};

const switchContacts = (p: Pen, w: number, len: number) => {
  const r = 0.035 * len;
  const old = p.w;
  p.w = 1;
  p.circle([-w / 2 + r, 0], r, "white");
  p.circle([w / 2 - r, 0], r, "white");
  p.w = old;
  return r;
};

export const BIPOLES: Record<string, BipoleDef> = {
  "american resistor": { w: 0.8, h: 0.3, family: "resistors", draw: (p, w, h) => zigzag(p, w, h) },
  "european resistor": { w: 0.8, h: 0.3, family: "resistors", draw: (p, w, h) => box(p, w, h) },
  generic: { w: 0.8, h: 0.3, family: "resistors", draw: (p, w, h) => box(p, w, h) },
  tgeneric: {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h, o) => {
      box(p, w, h);
      if (o.t) p.text(o.t, [0, 0], 0.8);
    },
  },
  twoport: {
    w: 0.7,
    h: 0.5,
    family: "other",
    draw: (p, w, h, o) => {
      box(p, w, h);
      if (o.t) p.text(o.t, [0, 0]);
    },
  },
  "variable american resistor": {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h, o) => {
      zigzag(p, w, h);
      diagonalArrow(p, w, h, o.len);
    },
  },
  "variable european resistor": {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h, o) => {
      box(p, w, h);
      diagonalArrow(p, w, h, o.len);
    },
  },
  "american potentiometer": {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h, o) => {
      zigzag(p, w, h);
      const old = p.w;
      p.w = 1;
      p.arrow([0, h / 2 + 0.3 * o.len], [0, h / 2 + 0.02 * o.len], 0.09 * o.len, 0.04 * o.len);
      p.w = old;
    },
  },
  "european potentiometer": {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h, o) => {
      box(p, w, h);
      const old = p.w;
      p.w = 1;
      p.arrow([0, h / 2 + 0.3 * o.len], [0, h / 2 + 0.02 * o.len], 0.09 * o.len, 0.04 * o.len);
      p.w = old;
    },
  },
  thermistor: {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h) => {
      box(p, w, h);
      const old = p.w;
      p.w = 1;
      p.line([-w * 0.55, -h * 0.85], [-w * 0.35, -h * 0.85], [w * 0.35, h * 0.85]);
      p.w = old;
    },
  },
  varistor: {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h) => {
      box(p, w, h);
      const old = p.w;
      p.w = 1;
      p.line([-w * 0.4, -h * 0.85], [-w * 0.25, -h * 0.85], [w * 0.25, h * 0.85], [w * 0.4, h * 0.85]);
      p.w = old;
    },
  },
  photoresistor: {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h, o) => {
      box(p, w, h);
      lightArrows(p, w, h, false, o.len);
    },
  },
  memristor: {
    w: 0.8,
    h: 0.3,
    family: "resistors",
    draw: (p, w, h) => {
      box(p, w, h);
      const old = p.w;
      p.w = 1;
      const s = w / 10;
      p.line([-w / 2, 0], [-3 * s, 0], [-3 * s, h / 4], [-s, h / 4], [-s, -h / 4], [s, -h / 4], [s, h / 4], [3 * s, h / 4], [3 * s, 0], [w / 2 - 0.12 * w, 0]);
      p.w = old;
      p.rect(w / 2 - 0.12 * w, -h / 2, w / 2, h / 2, "both");
    },
  },
  capacitor: { w: 0.2, h: 0.6, family: "capacitors", draw: (p, w, h) => plates(p, w, h) },
  "polar capacitor": {
    w: 0.2,
    h: 0.6,
    family: "capacitors",
    draw: (p, w, h) => {
      p.line([-w / 2, -h / 2], [-w / 2, h / 2]);
      p.segs([
        { t: "M", p: [w / 2 + w * 0.5, h / 2] },
        { t: "C", c1: [w / 2 - w * 0.1, h / 4], c2: [w / 2 - w * 0.1, -h / 4], p: [w / 2 + w * 0.5, -h / 2] },
      ]);
      p.sign("+", [-w / 2 - h * 0.22, h * 0.32], h * 0.08);
    },
  },
  "electrolytic capacitor": {
    w: 0.2,
    h: 0.6,
    family: "capacitors",
    draw: (p, w, h) => {
      p.rect(-w / 2, -h / 2, -w / 2 + w * 0.3, h / 2);
      p.rect(w / 2 - w * 0.3, -h / 2, w / 2, h / 2, "both");
      p.sign("+", [-w / 2 - h * 0.22, h * 0.32], h * 0.08);
    },
  },
  "variable capacitor": {
    w: 0.2,
    h: 0.6,
    family: "capacitors",
    draw: (p, w, h, o) => {
      plates(p, w, h);
      diagonalArrow(p, w * 3, h * 0.6, o.len);
    },
  },
  "american inductor": { w: 0.8, h: 0.3, family: "inductors", draw: (p, w, h) => americanInductor(p, w, h) },
  "cute inductor": { w: 0.8, h: 0.3, family: "inductors", draw: (p, w, h) => cuteInductor(p, w, h) },
  "european inductor": { w: 0.8, h: 0.3, family: "inductors", draw: (p, w, h) => p.rect(-w / 2, -h / 2, w / 2, h / 2, "both") },
  "empty diode": { w: 0.3, h: 0.4, family: "diodes", draw: (p, w, h) => diode(p, w, h, false) },
  "full diode": { w: 0.3, h: 0.4, family: "diodes", draw: (p, w, h) => diode(p, w, h, true) },
  "empty zener diode": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h) => {
      diode(p, w, h, false);
      p.line([w / 2, h / 2], [w / 2 - 0.15 * h, h / 2]);
      p.line([w / 2, -h / 2], [w / 2 + 0.15 * h, -h / 2]);
    },
  },
  "full zener diode": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h) => {
      diode(p, w, h, true);
      p.line([w / 2, h / 2], [w / 2 - 0.15 * h, h / 2]);
      p.line([w / 2, -h / 2], [w / 2 + 0.15 * h, -h / 2]);
    },
  },
  "empty Schottky diode": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h) => {
      diode(p, w, h, false);
      const k = 0.14 * h;
      p.line([w / 2, h / 2], [w / 2 + k, h / 2], [w / 2 + k, h / 2 - k]);
      p.line([w / 2, -h / 2], [w / 2 - k, -h / 2], [w / 2 - k, -h / 2 + k]);
    },
  },
  "full Schottky diode": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h) => {
      diode(p, w, h, true);
      const k = 0.14 * h;
      p.line([w / 2, h / 2], [w / 2 + k, h / 2], [w / 2 + k, h / 2 - k]);
      p.line([w / 2, -h / 2], [w / 2 - k, -h / 2], [w / 2 - k, -h / 2 + k]);
    },
  },
  "empty tunnel diode": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h) => {
      diode(p, w, h, false);
      p.line([w / 2, h / 2], [w / 2 - 0.15 * h, h / 2]);
      p.line([w / 2, -h / 2], [w / 2 - 0.15 * h, -h / 2]);
    },
  },
  "empty led": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h, o) => {
      diode(p, w, h, false);
      lightArrows(p, w, h, true, o.len);
    },
  },
  "full led": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h, o) => {
      diode(p, w, h, true);
      lightArrows(p, w, h, true, o.len);
    },
  },
  "empty photodiode": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h, o) => {
      diode(p, w, h, false);
      lightArrows(p, w, h, false, o.len);
    },
  },
  "full photodiode": {
    w: 0.3,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h, o) => {
      diode(p, w, h, true);
      lightArrows(p, w, h, false, o.len);
    },
  },
  varactor: {
    w: 0.4,
    h: 0.4,
    family: "diodes",
    draw: (p, w, h) => {
      diode(p, w * 0.75, h, false);
      p.line([w / 2, -h / 2], [w / 2, h / 2]);
    },
  },
  "american voltage source": { w: 0.6, h: 0.6, family: "sources", source: true, draw: (p, w) => (sourceCircle(p, w), vMarks(p, w / 2, true)) },
  "european voltage source": { w: 0.6, h: 0.6, family: "sources", source: true, draw: (p, w) => (sourceCircle(p, w), vMarks(p, w / 2, false)) },
  "american current source": { w: 0.6, h: 0.6, family: "sources", source: true, draw: (p, w, _h, o) => (sourceCircle(p, w), iMarks(p, w / 2, true, o.len)) },
  "european current source": { w: 0.6, h: 0.6, family: "sources", source: true, draw: (p, w, _h, o) => (sourceCircle(p, w), iMarks(p, w / 2, false, o.len)) },
  "sinusoidal voltage source": { w: 0.6, h: 0.6, family: "sources", source: true, draw: (p, w) => (sourceCircle(p, w), sine(p, w / 2)) },
  "sinusoidal current source": {
    w: 0.6,
    h: 0.6,
    family: "sources",
    source: true,
    draw: (p, w) => {
      sourceCircle(p, w);
      p.circle([0, 0], w * 0.42);
      sine(p, w * 0.42);
    },
  },
  "square voltage source": {
    w: 0.6,
    h: 0.6,
    family: "sources",
    source: true,
    draw: (p, w) => {
      sourceCircle(p, w);
      const r = w / 2;
      const old = p.w;
      p.w = 1.5;
      p.line([-r * 0.6, 0], [-r * 0.6, r * 0.3], [0, r * 0.3], [0, -r * 0.3], [r * 0.6, -r * 0.3], [r * 0.6, 0]);
      p.w = old;
    },
  },
  "dc voltage source": {
    w: 0.6,
    h: 0.6,
    family: "sources",
    source: true,
    draw: (p, w) => {
      sourceCircle(p, w);
      vMarks(p, w / 2, true);
    },
  },
  "american controlled voltage source": { w: 0.6, h: 0.6, family: "csources", source: true, draw: (p, w, h) => (diamond(p, w, h), vMarks(p, w / 2, true)) },
  "european controlled voltage source": { w: 0.6, h: 0.6, family: "csources", source: true, draw: (p, w, h) => (diamond(p, w, h), vMarks(p, w / 2, false)) },
  "american controlled current source": { w: 0.6, h: 0.6, family: "csources", source: true, draw: (p, w, h, o) => (diamond(p, w, h), iMarks(p, w / 2, true, o.len)) },
  "european controlled current source": { w: 0.6, h: 0.6, family: "csources", source: true, draw: (p, w, h, o) => (diamond(p, w, h), iMarks(p, w / 2, false, o.len)) },
  battery1: {
    w: 0.15,
    h: 0.6,
    family: "sources",
    source: true,
    draw: (p, w, h) => {
      p.line([-w / 2, -h / 2], [-w / 2, h / 2]);
      p.w = 4;
      p.line([w / 2, -h / 4], [w / 2, h / 4]);
      p.w = 2;
    },
  },
  battery2: {
    w: 0.15,
    h: 0.6,
    family: "sources",
    source: true,
    draw: (p, w, h) => {
      p.line([-w / 2, -h / 2], [-w / 2, h / 2]);
      p.rect(w / 2 - w * 0.25, -h / 4, w / 2, h / 4, "both");
    },
  },
  battery: {
    w: 0.4,
    h: 0.6,
    family: "sources",
    source: true,
    draw: (p, w, h) => {
      const xs = [-w / 2, -w / 6, w / 6, w / 2];
      xs.forEach((x, i) => {
        p.w = i % 2 ? 4 : 2;
        p.line([x, i % 2 ? -h / 4 : -h / 2], [x, i % 2 ? h / 4 : h / 2]);
      });
      p.w = 1;
      p.line([-w / 6, 0], [w / 6, 0]);
      p.w = 2;
    },
  },
  lamp: {
    w: 0.6,
    h: 0.6,
    family: "other",
    draw: (p, w) => {
      const r = w / 2;
      p.circle([0, 0], r);
      const k = r * Math.SQRT1_2;
      p.line([-k, -k], [k, k]);
      p.line([-k, k], [k, -k]);
    },
  },
  bulb: {
    w: 0.6,
    h: 0.6,
    family: "other",
    draw: (p, w) => {
      const r = w / 2;
      p.circle([0, 0], r);
      const old = p.w;
      p.w = 1;
      p.segs([
        { t: "M", p: [-r, 0] },
        { t: "L", p: [-r * 0.35, 0] },
        { t: "C", c1: [-r * 0.35, r * 0.7], c2: [r * 0.35, r * 0.7], p: [r * 0.35, 0] },
        { t: "L", p: [r, 0] },
      ]);
      p.w = old;
    },
  },
  fuse: {
    w: 0.6,
    h: 0.2,
    family: "other",
    draw: (p, w, h) => {
      box(p, w, h);
      p.w = 1;
      p.line([-w / 2, 0], [w / 2, 0]);
      p.w = 2;
    },
  },
  "asymmetric fuse": {
    w: 0.6,
    h: 0.2,
    family: "other",
    draw: (p, w, h) => {
      box(p, w, h);
      p.rect(w / 2 - w * 0.15, -h / 2, w / 2, h / 2, "both");
      p.w = 1;
      p.line([-w / 2, 0], [w / 2, 0]);
      p.w = 2;
    },
  },
  ammeter: { w: 0.6, h: 0.6, family: "other", draw: (p, w) => (p.circle([0, 0], w / 2), p.text("A", [0, 0])) },
  voltmeter: { w: 0.6, h: 0.6, family: "other", draw: (p, w) => (p.circle([0, 0], w / 2), p.text("V", [0, 0])) },
  ohmmeter: { w: 0.6, h: 0.6, family: "other", draw: (p, w) => (p.circle([0, 0], w / 2), p.text("$\\Omega$", [0, 0])) },
  wattmeter: { w: 0.6, h: 0.6, family: "other", draw: (p, w) => (p.circle([0, 0], w / 2), p.text("W", [0, 0])) },
  rmeter: {
    w: 0.6,
    h: 0.6,
    family: "other",
    draw: (p, w, _h, o) => {
      p.circle([0, 0], w / 2);
      const old = p.w;
      p.w = 1;
      p.arrow([-w * 0.3, -w * 0.3], [w * 0.3, w * 0.3], 0.08 * o.len, 0.035 * o.len);
      p.w = old;
    },
  },
  oscilloscope: {
    w: 0.6,
    h: 0.6,
    family: "other",
    draw: (p, w) => {
      p.circle([0, 0], w / 2);
      sine(p, w / 2);
    },
  },
  crystal: {
    w: 0.4,
    h: 0.6,
    family: "other",
    draw: (p, w, h) => {
      p.line([-w / 2, -h * 0.35], [-w / 2, h * 0.35]);
      p.line([w / 2, -h * 0.35], [w / 2, h * 0.35]);
      p.rect(-w / 4, -h / 2, w / 4, h / 2);
    },
  },
  "normal open switch": { w: 0.6, h: 0.3, family: "switches", draw: (p, w, h) => lever(p, w, h * 0.9, false) },
  "normal closed switch": {
    w: 0.6,
    h: 0.3,
    family: "switches",
    draw: (p, w, h) => {
      // The lever rests on the post of the right contact.
      p.line([-w / 2, 0], [w / 2 + 0.08 * w, h * 0.55]);
      p.line([w / 2, 0], [w / 2, h * 0.5]);
    },
  },
  "single pole switch": {
    w: 0.6,
    h: 0.3,
    family: "switches",
    draw: (p, w, h, o) => {
      const r = switchContacts(p, w, o.len);
      p.line([-w / 2 + 2 * r, r * 0.3], [w / 2 - r, h * 1.0]);
    },
  },
  "closing switch": {
    w: 0.6,
    h: 0.3,
    family: "switches",
    draw: (p, w, h, o) => {
      const r = switchContacts(p, w, o.len);
      p.line([-w / 2 + 2 * r, r * 0.3], [w / 2 - r, h * 1.0]);
      const old = p.w;
      p.w = 1;
      const a = arcCubics([-w / 2, 0], [w * 0.75, 0], [0, w * 0.75], 15, 40);
      const segs: Seg[] = [{ t: "M", p: a.start }];
      for (const s of a.segs) segs.push({ t: "C", c1: s.c1, c2: s.c2, p: s.p });
      p.segs(segs);
      const end = a.segs[a.segs.length - 1].p;
      p.head(end, [-0.6, 0.8], 0.07 * o.len, 0.03 * o.len);
      p.w = old;
    },
  },
  "opening switch": {
    w: 0.6,
    h: 0.3,
    family: "switches",
    draw: (p, w, h, o) => {
      const r = switchContacts(p, w, o.len);
      p.line([-w / 2 + 2 * r, r * 0.3], [w / 2 - r, h * 1.0]);
      const old = p.w;
      p.w = 1;
      const a = arcCubics([-w / 2, 0], [w * 0.75, 0], [0, w * 0.75], 40, 15);
      const segs: Seg[] = [{ t: "M", p: a.start }];
      for (const s of a.segs) segs.push({ t: "C", c1: s.c1, c2: s.c2, p: s.p });
      p.segs(segs);
      const end = a.segs[a.segs.length - 1].p;
      p.head(end, [0.6, -0.8], 0.07 * o.len, 0.03 * o.len);
      p.w = old;
    },
  },
  "push button": {
    w: 0.6,
    h: 0.3,
    family: "switches",
    draw: (p, w, h, o) => {
      switchContacts(p, w, o.len);
      p.line([-w / 2, h * 0.6], [w / 2, h * 0.6]);
      p.line([0, h * 0.6], [0, h * 1.4]);
      p.line([-w * 0.15, h * 1.4], [w * 0.15, h * 1.4]);
    },
  },
  short: { w: 0, h: 0, family: "other", draw: () => undefined },
  open: { w: 0.8, h: 0, family: "other", open: true, draw: () => undefined },
};

// ------------------------------------------------------------------ nodes

export interface NodeDraw {
  pen: Pen;
  /** Anchors in the node's frame (points). */
  anchors: Map<string, Pt>;
  /** Where the node's text goes, and the side of the text facing that point. */
  text?: { at: Pt; anchor: string };
  /** Lines to the node end at its centre (grounds, supplies) or at a circle around it (dots); default its box. */
  border?: "point" | "circle";
}

export interface NodeOpts {
  /** One unit of the node drawings (circuitikz's 1.4cm divided by 1.4). */
  u: number;
  len: number;
  noinvUp: boolean;
  inputs: number;
  circle: boolean;
  /** european, american or ieee logic ports. */
  ports: string;
  /** Dot radius. */
  dot: number;
}

type NodeFn = (o: NodeOpts) => NodeDraw;

const anchorsOf = (o: NodeOpts, list: [string, number, number][]): Map<string, Pt> => new Map(list.map(([k, x, y]) => [k, [x * o.u, y * o.u]]));

function opAmp(o: NodeOpts, plain: boolean): NodeDraw {
  const u = o.u;
  const p = new Pen();
  const tx = 0.84 * u;
  const th = 0.84 * u;
  p.poly([
    [-tx, th],
    [tx, 0],
    [-tx, -th],
  ]);
  p.w = 1;
  const inv = o.noinvUp ? -0.49 : 0.49;
  if (plain) {
    p.line([-1.19 * u, 0], [-tx, 0]);
    p.line([tx, 0], [1.19 * u, 0]);
    return { pen: p, anchors: anchorsOf(o, [["in", -1.19, 0], ["out", 1.19, 0], ["up", 0, 0.42], ["down", 0, -0.42], ["center", 0, 0]]), text: { at: [-0.2 * u, 0], anchor: "center" } };
  }
  p.line([-1.19 * u, 0.49 * u], [-tx, 0.49 * u]);
  p.line([-1.19 * u, -0.49 * u], [-tx, -0.49 * u]);
  p.line([tx, 0], [1.19 * u, 0]);
  p.sign("-", [-tx + 0.2 * u, inv * u], 0.09 * u);
  p.sign("+", [-tx + 0.2 * u, -inv * u], 0.09 * u);
  return {
    pen: p,
    anchors: anchorsOf(o, [
      ["-", -1.19, inv],
      ["+", -1.19, -inv],
      ["in -", -1.19, inv],
      ["in +", -1.19, -inv],
      ["out", 1.19, 0],
      ["up", 0, 0.42],
      ["down", 0, -0.42],
    ]),
    text: { at: [-0.15 * u, 0], anchor: "center" },
  };
}

function bjt(o: NodeOpts, pnp: boolean): NodeDraw {
  const u = o.u;
  const p = new Pen();
  const bx = -0.42 * u;
  p.line([bx, -0.3 * u], [bx, 0.3 * u]);
  p.w = 1;
  p.line([-0.84 * u, 0], [bx, 0]);
  // Upper and lower legs: npn has the collector up, pnp the emitter.
  const up: Pt = [0, 0.4 * u];
  const dn: Pt = [0, -0.4 * u];
  p.line([bx, 0.14 * u], up, [0, 0.77 * u]);
  p.line([bx, -0.14 * u], dn, [0, -0.77 * u]);
  const len = 0.13 * u;
  const half = 0.055 * u;
  if (!pnp) {
    // Emitter arrow points out, along the lower leg.
    const d: Pt = [dn[0] - bx, dn[1] + 0.14 * u];
    const l = Math.hypot(d[0], d[1]);
    const v: Pt = [d[0] / l, d[1] / l];
    p.head([bx + v[0] * l * 0.85, -0.14 * u + v[1] * l * 0.85], v, len, half);
  } else {
    // Emitter on top, arrow pointing in towards the base.
    const d: Pt = [bx - up[0], 0.14 * u - up[1]];
    const l = Math.hypot(d[0], d[1]);
    const v: Pt = [d[0] / l, d[1] / l];
    p.head([up[0] + v[0] * l * 0.7, up[1] + v[1] * l * 0.7], v, len, half);
  }
  if (o.circle) {
    p.w = 1;
    p.circle([-0.2 * u, 0], 0.55 * u);
  }
  const c = pnp ? -0.77 : 0.77;
  return {
    pen: p,
    anchors: anchorsOf(o, [
      ["B", -0.84, 0],
      ["base", -0.84, 0],
      ["C", 0, c],
      ["collector", 0, c],
      ["E", 0, -c],
      ["emitter", 0, -c],
    ]),
    text: { at: [0.15 * u, 0], anchor: "west" },
  };
}

function mosfet(o: NodeOpts, kind: "n" | "p", style: "mos" | "fet" | "igfete" | "igfetd" | "jfet"): NodeDraw {
  const u = o.u;
  const p = new Pen();
  const gx = -0.42 * u;
  const cx = -0.3 * u;
  const pmos = kind === "p";
  // Drain up for n channels; source up for p channels.
  const top = pmos ? "S" : "D";
  const bot = pmos ? "D" : "S";
  if (style === "jfet") {
    p.line([cx, -0.35 * u], [cx, 0.35 * u]);
    p.w = 1;
    p.line([-0.84 * u, pmos ? 0.3 * u : -0.3 * u], [cx, pmos ? 0.3 * u : -0.3 * u]);
    const y = pmos ? 0.3 * u : -0.3 * u;
    p.head(pmos ? [-0.6 * u, y] : [cx, y], pmos ? [-1, 0] : [1, 0], 0.13 * u, 0.055 * u);
  } else {
    p.line([gx, -0.3 * u], [gx, 0.3 * u]);
    if (style === "igfete" || style === "fet") {
      for (const [a, b] of [
        [0.18, 0.38],
        [-0.1, 0.1],
        [-0.38, -0.18],
      ])
        p.line([cx, a * u], [cx, b * u]);
    } else p.line([cx, -0.38 * u], [cx, 0.38 * u]);
    p.w = 1;
    if (pmos && style === "mos") {
      const r = 0.07 * u;
      p.circle([gx - r, 0], r);
      p.line([-0.84 * u, 0], [gx - 2 * r, 0]);
    } else p.line([-0.84 * u, 0], [gx, 0]);
    if (style !== "mos") {
      // The bulk: joined to the source, with the arrow showing the channel type.
      const sy = pmos ? 0.28 : -0.28;
      p.line([cx, 0], [0, 0], [0, sy * u]);
      p.head(pmos ? [-0.02 * u, 0] : [cx, 0], pmos ? [1, 0] : [-1, 0], 0.13 * u, 0.055 * u);
    }
  }
  p.w = 1;
  p.line([cx, 0.28 * u], [0, 0.28 * u], [0, 0.77 * u]);
  p.line([cx, -0.28 * u], [0, -0.28 * u], [0, -0.77 * u]);
  const names: Record<string, string> = { D: "drain", S: "source" };
  return {
    pen: p,
    anchors: anchorsOf(o, [
      ["G", -0.84, style === "jfet" ? (pmos ? 0.3 : -0.3) : 0],
      ["gate", -0.84, style === "jfet" ? (pmos ? 0.3 : -0.3) : 0],
      [top, 0, 0.77],
      [names[top], 0, 0.77],
      [bot, 0, -0.77],
      [names[bot], 0, -0.77],
      ["B", 0, 0],
      ["bulk", 0, 0],
    ]),
    text: { at: [0.15 * u, 0], anchor: "west" },
  };
}

function transformer(o: NodeOpts, core: boolean): NodeDraw {
  const u = o.u;
  const p = new Pen();
  // Coils of four bumps (radius r) at x = +-cx, terminals at x = +-ax, y = +-ay.
  const r = 0.175;
  const cx = 0.35;
  const ch = 4 * r;
  const ax = 0.84;
  const ay = 1.05;
  const coil = (side: number) => {
    const x = side * cx * u;
    const segs: Seg[] = [{ t: "M", p: [x, ch * u] }];
    for (let k = 0; k < 4; k++) {
      const cy = (ch - r - 2 * r * k) * u;
      const a = side < 0 ? arcCubics([x, cy], [0, r * u], [r * u, 0], 0, 180) : arcCubics([x, cy], [0, r * u], [-r * u, 0], 0, 180);
      for (const s of a.segs) segs.push({ t: "C", c1: s.c1, c2: s.c2, p: s.p });
    }
    p.w = 2;
    p.segs(segs);
    p.w = 1;
    p.line([x, ch * u], [x, ay * u], [side * ax * u, ay * u]);
    p.line([x, -ch * u], [x, -ay * u], [side * ax * u, -ay * u]);
  };
  coil(-1);
  coil(1);
  if (core) {
    p.w = 2;
    p.line([-0.06 * u, -ch * u], [-0.06 * u, ch * u]);
    p.line([0.06 * u, -ch * u], [0.06 * u, ch * u]);
  }
  return {
    pen: p,
    anchors: anchorsOf(o, [
      ["A1", -ax, ay],
      ["A2", -ax, -ay],
      ["B1", ax, ay],
      ["B2", ax, -ay],
      ["inner dot A1", -cx + 0.3, ch - 0.1],
      ["inner dot A2", -cx + 0.3, -ch + 0.1],
      ["inner dot B1", cx - 0.3, ch - 0.1],
      ["inner dot B2", cx - 0.3, -ch + 0.1],
      ["outer dot A1", -cx - 0.3, ch - 0.1],
      ["outer dot A2", -cx - 0.3, -ch + 0.1],
      ["outer dot B1", cx + 0.3, ch - 0.1],
      ["outer dot B2", cx + 0.3, -ch + 0.1],
    ]),
    text: { at: [0, 0], anchor: "center" },
  };
}

function ground(o: NodeOpts, kind: string): NodeDraw {
  const u = o.u;
  const p = new Pen();
  p.w = 1;
  const stem = 0.14 * u;
  p.line([0, 0], [0, -stem]);
  p.w = 2;
  switch (kind) {
    case "rground":
    case "eground":
      p.w = 3;
      p.line([-0.21 * u, -stem], [0.21 * u, -stem]);
      break;
    case "sground":
      p.poly([
        [-0.21 * u, -stem],
        [0.21 * u, -stem],
        [0, -stem - 0.24 * u],
      ]);
      break;
    case "tground":
      p.w = 4;
      p.line([-0.21 * u, -stem], [0.21 * u, -stem]);
      break;
    case "cground":
      p.line([-0.21 * u, -stem], [0.21 * u, -stem]);
      p.w = 1;
      for (const x of [-0.21, 0, 0.21]) p.line([x * u, -stem], [(x - 0.1) * u, -stem - 0.14 * u]);
      break;
    default:
      p.line([-0.21 * u, -stem], [0.21 * u, -stem]);
      p.line([-0.13 * u, -stem - 0.08 * u], [0.13 * u, -stem - 0.08 * u]);
      p.line([-0.05 * u, -stem - 0.16 * u], [0.05 * u, -stem - 0.16 * u]);
  }
  return { pen: p, anchors: new Map(), text: { at: [0, -stem - 0.3 * u], anchor: "north" }, border: "point" };
}

function supply(o: NodeOpts, kind: string): NodeDraw {
  const u = o.u;
  const p = new Pen();
  const s = kind === "vee" || kind === "vss" ? -1 : 1;
  const top = 0.42 * u * s;
  p.w = 1;
  p.line([0, 0], [0, top]);
  p.w = 2;
  if (kind === "vcc" || kind === "vee") p.line([-0.12 * u, top - 0.14 * u * s], [0, top], [0.12 * u, top - 0.14 * u * s]);
  else p.line([-0.2 * u, top], [0.2 * u, top]);
  return { pen: p, anchors: new Map(), text: { at: [0, top + 0.03 * u * s], anchor: s > 0 ? "south" : "north" }, border: "point" };
}

function antenna(o: NodeOpts): NodeDraw {
  const u = o.u;
  const p = new Pen();
  p.w = 1;
  p.line([0, 0], [0, 0.6 * u]);
  p.w = 2;
  p.line([-0.25 * u, 0.6 * u], [0, 0.3 * u], [0.25 * u, 0.6 * u]);
  return { pen: p, anchors: new Map(), text: { at: [0, 0.65 * u], anchor: "south" }, border: "point" };
}

function speaker(o: NodeOpts): NodeDraw {
  const u = o.u;
  const p = new Pen();
  p.rect(0, -0.2 * u, 0.2 * u, 0.2 * u);
  p.poly([
    [0.2 * u, 0.2 * u],
    [0.5 * u, 0.5 * u],
    [0.5 * u, -0.5 * u],
    [0.2 * u, -0.2 * u],
  ]);
  p.w = 1;
  p.line([-0.3 * u, 0.1 * u], [0, 0.1 * u]);
  p.line([-0.3 * u, -0.1 * u], [0, -0.1 * u]);
  return {
    pen: p,
    anchors: anchorsOf(o, [
      ["in 1", -0.3, 0.1],
      ["in 2", -0.3, -0.1],
    ]),
    text: { at: [0.6 * u, 0], anchor: "west" },
  };
}

/** The x where a port's input lead meets its body, for the curved backs of or gates. */
function orBack(y: number, h: number, x0: number, depth: number): number {
  const t = Math.min(1, Math.abs(y) / h);
  return x0 + depth * (1 - t * t);
}

function port(o: NodeOpts, kind: string): NodeDraw {
  const u = o.u;
  const p = new Pen();
  const not = /^n(and|or)$|^xnor$|^not$/.test(kind);
  const base = kind.replace(/^n(and|or)$/, "$1").replace(/^xnor$/, "xor");
  const single = kind === "not" || kind === "buffer";
  const n = single ? 1 : Math.max(2, Math.min(16, o.inputs));
  // Two inputs 0.56 apart, more inputs closer; the body grows when they need room.
  const step = n > 1 ? Math.max(0.25, Math.min(0.56, 0.8 / (n - 1))) : 0;
  const H = Math.max(0.5, ((n - 1) * step) / 2 + 0.15) * u;
  const xl = -0.55 * u;
  const xr = 0.5 * u;
  const r = 0.07 * u;
  const ys: number[] = [];
  for (let k = 0; k < n; k++) ys.push(((n - 1) / 2 - k) * step * u);
  let ends: number[] = ys.map(() => xl);
  let outX = xr;
  if (o.ports === "european") {
    const hh = Math.max(H, 0.5 * u);
    p.rect(xl, -hh, xr, hh);
    const sym: Record<string, string> = { and: "\\&", or: "$\\geq 1$", xor: "$=1$", not: "1", buffer: "1" };
    p.text(sym[base] ?? "", [0, 0.2 * u], 0.9);
  } else if (single) {
    p.poly([
      [xl, 0.4 * u],
      [0.3 * u, 0],
      [xl, -0.4 * u],
    ]);
    outX = 0.3 * u;
  } else if (base === "and") {
    const segs: Seg[] = [{ t: "M", p: [0, -H] }, { t: "L", p: [xl, -H] }, { t: "L", p: [xl, H] }, { t: "L", p: [0, H] }];
    const a = arcCubics([0, 0], [xr, 0], [0, H], 90, -90);
    for (const s of a.segs) segs.push({ t: "C", c1: s.c1, c2: s.c2, p: s.p });
    segs.push({ t: "Z" });
    p.segs(segs);
  } else {
    // or, xor: a concave back and two arcs meeting at the point.
    const depth = 0.2 * u;
    const segs: Seg[] = [
      { t: "M", p: [xl, H] },
      { t: "C", c1: [xl + depth * 1.33, H * 0.5], c2: [xl + depth * 1.33, -H * 0.5], p: [xl, -H] },
      { t: "C", c1: [0, -H], c2: [xr * 0.75, -H * 0.6], p: [xr + 0.05 * u, 0] },
      { t: "C", c1: [xr * 0.75, H * 0.6], c2: [0, H], p: [xl, H] },
      { t: "Z" },
    ];
    p.segs(segs);
    outX = xr + 0.05 * u;
    ends = ys.map((y) => orBack(y, H, xl, depth));
    if (base === "xor") {
      const dx = -0.12 * u;
      p.segs([{ t: "M", p: [xl + dx, H] }, { t: "C", c1: [xl + dx + depth * 1.33, H * 0.5], c2: [xl + dx + depth * 1.33, -H * 0.5], p: [xl + dx, -H] }]);
      ends = ys.map((y) => orBack(y, H, xl + dx, depth));
    }
  }
  p.w = 1;
  if (not) {
    p.w = 2;
    p.circle([outX + r, 0], r);
    p.w = 1;
    outX += 2 * r;
  }
  const inX = xl - 0.42 * u;
  ys.forEach((y, i) => p.line([inX, y], [ends[i], y]));
  const outEnd = Math.max(xr, outX) + 0.42 * u;
  p.line([outX, 0], [outEnd, 0]);
  const anchors = new Map<string, Pt>([
    ["out", [outEnd, 0]],
    ["bout", [outX, 0]],
  ]);
  ys.forEach((y, i) => {
    anchors.set(`in ${i + 1}`, [inX, y]);
    anchors.set(`bin ${i + 1}`, [ends[i], y]);
  });
  if (single) anchors.set("in", [inX, 0]);
  return { pen: p, anchors, text: { at: [0, 0], anchor: "center" } };
}

function flipflop(o: NodeOpts, kind: string): NodeDraw {
  const u = o.u;
  const p = new Pen();
  const w = 0.6 * u;
  const h = 0.8 * u;
  p.rect(-w, -h, w, h);
  p.w = 1;
  const pins: Record<string, [string, string, string, string, string, string]> = {
    D: ["D", "", ">", "$\\overline{Q}$", "", "Q"],
    T: ["T", "", ">", "$\\overline{Q}$", "", "Q"],
    JK: ["J", ">", "K", "$\\overline{Q}$", "", "Q"],
    SR: ["S", "", "R", "$\\overline{Q}$", "", "Q"],
    "": ["", "", "", "", "", ""],
  };
  const names = pins[kind] ?? pins[""];
  const anchors = new Map<string, Pt>();
  const ys = [0.5, 0, -0.5];
  for (let i = 0; i < 6; i++) {
    const left = i < 3;
    const y = (left ? ys[i] : ys[2 - (i - 3)]) * u;
    const x = left ? -w : w;
    const x2 = left ? -w - 0.3 * u : w + 0.3 * u;
    const lbl = names[i];
    const used = kind === "" || lbl !== "";
    if (used) p.line([x, y], [x2, y]);
    anchors.set(`pin ${i + 1}`, [x2, y]);
    anchors.set(`bpin ${i + 1}`, [x, y]);
    if (lbl === ">") {
      p.line([x, y + 0.1 * u], [x + 0.14 * u, y], [x, y - 0.1 * u]);
    } else if (lbl) p.text(lbl, [left ? x + 0.18 * u : x - 0.18 * u, y], 0.8);
  }
  return { pen: p, anchors, text: { at: [0, h + 0.05 * u], anchor: "south" } };
}

function twoportNode(o: NodeOpts): NodeDraw {
  const u = o.u;
  const p = new Pen();
  p.rect(-0.5 * u, -0.5 * u, 0.5 * u, 0.5 * u);
  return {
    pen: p,
    anchors: anchorsOf(o, [
      ["in", -0.5, 0],
      ["out", 0.5, 0],
    ]),
    text: { at: [0, 0], anchor: "center" },
  };
}

function dot(o: NodeOpts, mode: Mode): NodeDraw {
  const p = new Pen();
  p.w = 1;
  p.circle([0, 0], o.dot, mode);
  return { pen: p, anchors: new Map(), text: { at: [o.dot * 0.7, o.dot * 0.7], anchor: "south west" }, border: "circle" };
}

export const NODE_SHAPES: Record<string, NodeFn> = {
  "op amp": (o) => opAmp(o, false),
  amp: (o) => opAmp(o, true),
  "plain amp": (o) => opAmp(o, true),
  buffer: (o) => opAmp(o, true),
  npn: (o) => bjt(o, false),
  pnp: (o) => bjt(o, true),
  nmos: (o) => mosfet(o, "n", "mos"),
  pmos: (o) => mosfet(o, "p", "mos"),
  nfet: (o) => mosfet(o, "n", "fet"),
  pfet: (o) => mosfet(o, "p", "fet"),
  nigfete: (o) => mosfet(o, "n", "igfete"),
  pigfete: (o) => mosfet(o, "p", "igfete"),
  nigfetd: (o) => mosfet(o, "n", "igfetd"),
  pigfetd: (o) => mosfet(o, "p", "igfetd"),
  nigfetebulk: (o) => mosfet(o, "n", "igfete"),
  pigfetebulk: (o) => mosfet(o, "p", "igfete"),
  njfet: (o) => mosfet(o, "n", "jfet"),
  pjfet: (o) => mosfet(o, "p", "jfet"),
  transformer: (o) => transformer(o, false),
  "transformer core": (o) => transformer(o, true),
  ground: (o) => ground(o, "ground"),
  rground: (o) => ground(o, "rground"),
  sground: (o) => ground(o, "sground"),
  tground: (o) => ground(o, "tground"),
  nground: (o) => ground(o, "ground"),
  pground: (o) => ground(o, "ground"),
  cground: (o) => ground(o, "cground"),
  eground: (o) => ground(o, "eground"),
  eground2: (o) => ground(o, "eground"),
  vcc: (o) => supply(o, "vcc"),
  vdd: (o) => supply(o, "vdd"),
  vee: (o) => supply(o, "vee"),
  vss: (o) => supply(o, "vss"),
  antenna: (o) => antenna(o),
  rxantenna: (o) => antenna(o),
  txantenna: (o) => antenna(o),
  loudspeaker: (o) => speaker(o),
  speaker: (o) => speaker(o),
  "and port": (o) => port(o, "and"),
  "or port": (o) => port(o, "or"),
  "not port": (o) => port(o, "not"),
  "nand port": (o) => port(o, "nand"),
  "nor port": (o) => port(o, "nor"),
  "xor port": (o) => port(o, "xor"),
  "xnor port": (o) => port(o, "xnor"),
  "buffer port": (o) => port(o, "buffer"),
  "flipflop D": (o) => flipflop(o, "D"),
  "flipflop T": (o) => flipflop(o, "T"),
  "flipflop JK": (o) => flipflop(o, "JK"),
  "flipflop SR": (o) => flipflop(o, "SR"),
  flipflop: (o) => flipflop(o, ""),
  twoportshape: (o) => twoportNode(o),
  circ: (o) => dot(o, "both"),
  ocirc: (o) => dot(o, "white"),
  diamondpole: (o) => dot(o, "both"),
  squarepole: (o) => dot(o, "both"),
  odiamondpole: (o) => dot(o, "white"),
  osquarepole: (o) => dot(o, "white"),
};
