/**
 * circuitikz: electrical circuits drawn the way the circuitikz package
 * draws them. A path segment `to[R=$R_1$, i=$i$, *-o] (2,0)` becomes a
 * bipole: wires from both ends join the path, the component sits in the
 * middle at its circuitikz size (a 1.4cm bipole length by default), and
 * labels, voltages (+/- or arrows), currents, flows and poles go where
 * circuitikz puts them. Nodes such as `op amp`, `npn`, `nmos`, `ground`
 * and the logic ports are shapes with their circuitikz anchors (.+ .out
 * .B .C .E .G .D .S .in 1 ...).
 *
 * The interpreter (interp.ts) calls in through CircuitHooks; settings
 * (\ctikzset, the american/european styles, package options) live on the
 * graphic state as `g.circuit`, replaced rather than changed so scopes
 * keep their own. Components circuitikz has and texwright does not are
 * drawn as a labelled box with a TIKZ001 warning; the wire is never lost.
 */

import { BIPOLES, type BipoleDef, NODE_SHAPES, type NodeDraw, type NodeOpts, Pen, type Prim } from "./circuit-shapes.js";
import { type Pt, type Seg, add, angleOf, dist, rotation, scale, sub, unit } from "./geom.js";
import type { Interp, NodeInfo, PendingNode } from "./interp.js";
import { type OptionHost, applyKey } from "./options.js";
import { length, num } from "./expr.js";
import { parseOptions } from "./scan.js";
import { CM, type GS, cloneGS, nodeGS } from "./state.js";

export interface CircuitSettings {
  /** Bipole length, pt. */
  len: number;
  voltage: "american" | "european";
  current: "american" | "european";
  resistor: "american" | "european";
  inductor: "american" | "european" | "cute";
  ports: "american" | "european" | "ieee";
  /** <family>/scale. */
  scales: Record<string, number>;
  /** Pole and dot radius as a fraction of the bipole length. */
  dot: number;
  /** Component line width relative to the wire. */
  thickness: number;
  // Node keys (only on a node's own state).
  noinvUp?: boolean;
  trCircle?: boolean;
  inputs?: number;
  /** Flips from xscale=-1 / yscale=-1, multiplied up through the scopes. */
  fx: number;
  fy: number;
}

export const CIRCUIT_DEFAULTS: CircuitSettings = {
  len: 1.4 * CM,
  voltage: "european",
  current: "european",
  resistor: "american",
  inductor: "cute",
  ports: "american",
  scales: {},
  dot: 0.04,
  thickness: 2,
  fx: 1,
  fy: 1,
};

const settings = (g: GS): CircuitSettings => g.circuit ?? CIRCUIT_DEFAULTS;

function update(g: GS, patch: Partial<CircuitSettings>): void {
  g.circuit = { ...settings(g), ...patch };
}

// ------------------------------------------------------------------ styles and \ctikzset

const STYLE_KEYS: Record<string, Partial<CircuitSettings>> = {
  american: { voltage: "american", current: "american", resistor: "american", inductor: "american", ports: "american" },
  european: { voltage: "european", current: "european", resistor: "european", inductor: "european", ports: "european" },
  "american voltages": { voltage: "american" },
  "european voltages": { voltage: "european" },
  "american currents": { current: "american" },
  "european currents": { current: "european" },
  "american resistors": { resistor: "american" },
  "european resistors": { resistor: "european" },
  "american inductors": { inductor: "american" },
  "european inductors": { inductor: "european" },
  "cute inductors": { inductor: "cute" },
  "american ports": { ports: "american" },
  "european ports": { ports: "european" },
  "ieee ports": { ports: "ieee" },
  "IEEE ports": { ports: "ieee" },
};

/** Package options and styles that change nothing texwright draws differently. */
const QUIET_STYLES = new Set([
  "siunitx", "nosiunitx", "straight voltages", "curved voltages", "raised voltages", "RPvoltages", "EFvoltages", "oldvoltagedirection",
  "nooldvoltagedirection", "betterproportions", "smartlabels", "straightlabels", "rotatelabels", "arrowmos", "noarrowmos", "fetbodydiode",
  "nofetbodydiode", "fetsolderdot", "nofetsolderdot", "americangfsurgearrester", "europeangfsurgearrester", "compatibility", "legacytransistorstext",
  "nolegacytransistorstext", "dvipsnames", "svgnames", "x11names", "l2 halign", "voltage dir", "voltage shift", "label/align", "bodydiode",
  "nobodydiode", "solderdot", "nosolderdot", "emptycircle", "fullcircle", "nocircle", "boxed", "invert", "mirror", "no inputs leads",
  "american light bulb", "european light bulb", "inner sep circuit", "tripoles/mos style", "use fpu reciprocal", "cuteswitches", "noinv output up",
  "noinv output down", "nobase", "nogate", "nodrain", "nosource", "nocollector", "noemitter", "nobulk", "photo", "schottky base", "solderdot",
  "europeanvoltages", "americanvoltages", "europeancurrents", "americancurrents", "europeanresistors", "americanresistors", "europeaninductors",
  "americaninductors", "cuteinductors", "europeanports", "americanports",
]);

/** The no-space package option names. */
const PACKAGE_ALIASES: Record<string, string> = {
  americanvoltages: "american voltages",
  europeanvoltages: "european voltages",
  americancurrents: "american currents",
  europeancurrents: "european currents",
  americanresistors: "american resistors",
  europeanresistors: "european resistors",
  americaninductors: "american inductors",
  europeaninductors: "european inductors",
  cuteinductors: "cute inductors",
  americanports: "american ports",
  europeanports: "european ports",
};

const FAMILIES = new Set(["resistors", "capacitors", "inductors", "diodes", "sources", "csources", "switches", "amplifiers", "transistors", "logic ports", "grounds", "power supplies", "tripoles", "flipflops"]);

/** A \ctikzset key (or a package option). True when it was understood. */
function ctikzKey(g: GS, rawKey: string, v: string | undefined): boolean {
  const key = rawKey.replace(/^\/?(tikz\/)?circuitikz\//, "").trim();
  const style = STYLE_KEYS[PACKAGE_ALIASES[key] ?? key];
  if (style) {
    update(g, style);
    return true;
  }
  const famScale = /^(.+?)\/scale$/.exec(key);
  if (famScale && FAMILIES.has(famScale[1])) {
    const s = num(v ?? "1");
    if (s !== undefined && s > 0 && s < 20) update(g, { scales: { ...settings(g).scales, [famScale[1]]: s } });
    return true;
  }
  switch (key) {
    case "bipoles/length": {
      const l = length(v ?? "", CM);
      if (l !== undefined && l > 1 && l < 40 * CM) update(g, { len: l });
      return true;
    }
    case "nodes width": {
      const d = num(v ?? "");
      if (d !== undefined && d > 0 && d < 1) update(g, { dot: d });
      return true;
    }
    case "bipoles/thickness": {
      const t = num(v ?? "");
      if (t !== undefined && t > 0 && t < 20) update(g, { thickness: t });
      return true;
    }
    case "voltage":
      if (v === "american" || v === "european") update(g, { voltage: v });
      return true;
    case "current":
      if (v === "american" || v === "european") update(g, { current: v });
      return true;
    case "resistor":
      if (v === "american" || v === "european") update(g, { resistor: v });
      return true;
    case "inductor":
      if (v === "american" || v === "european" || v === "cute") update(g, { inductor: v });
      return true;
    case "logic ports":
      if (v === "american" || v === "european") update(g, { ports: v });
      else if (v && /^ieee/i.test(v)) update(g, { ports: "ieee" });
      return true;
  }
  return QUIET_STYLES.has(key) || /^(bipoles|tripoles|monopoles|quadpoles|multipoles|voltage|current|flow|label|annotation|amplifiers|logic ports|resistors|capacitors|inductors|diodes|sources|csources|switches|transistors|nodes|color|power supplies|blocks|graphic|instruments|chips|muxdemuxes|flipflops|misc)\b/.test(key);
}

/** Runs \ctikzset{...}. */
export function ctikzset(it: Interp, text: string, g: GS): void {
  // Any \ctikzset (or \usepackage{circuitikz}) puts the pictures in circuit mode.
  if (!g.circuit) g.circuit = CIRCUIT_DEFAULTS;
  for (const { key, value } of parseOptions(text)) {
    if (!ctikzKey(g, key, value)) it.warnOnce(`ctikz:${key}`, `circuitikz setting "${key}" is not supported and was ignored`);
  }
}

// ------------------------------------------------------------------ node shapes and keys

/** The shape a node key names, with the port style it implies. */
function nodeShape(key: string): { shape: string; ports?: CircuitSettings["ports"] } | undefined {
  if (Object.hasOwn(NODE_SHAPES, key)) return { shape: key };
  const m = /^(american |european |ieeestd |IEEE )?(and|or|not|nand|nor|xor|xnor|buffer)( IEEE)? port$/.exec(key);
  if (m) {
    const style = m[1]?.trim().toLowerCase();
    return { shape: `${m[2]} port`, ...(style === "american" || style === "european" ? { ports: style } : style || m[3] ? { ports: "ieee" as const } : {}) };
  }
  const alias: Record<string, string> = { opamp: "op amp", "op-amp": "op amp", "fd op amp": "op amp", "inst amp": "op amp", "en amp": "op amp", nmosd: "nmos", pmosd: "pmos", "isfet": "nmos", hemt: "nmos" };
  if (Object.hasOwn(alias, key)) return { shape: alias[key] };
  return undefined;
}

/**
 * The option hook (OptionHost.extra) for every option list: node shapes,
 * node keys, the american/european styles and circuitikz/... keys.
 * xscale/yscale are noted (for flipping circuit nodes) and passed on.
 */
export function circuitKey(key: string, value: string | undefined, g: GS): boolean {
  if (value === undefined) {
    const s = nodeShape(key);
    if (s) {
      g.shape = s.shape;
      if (s.ports) update(g, { ports: s.ports });
      return true;
    }
  }
  switch (key) {
    case "xscale":
    case "yscale": {
      const v = num(value ?? "1");
      if (v !== undefined && v < 0) update(g, key === "xscale" ? { fx: -settings(g).fx } : { fy: -settings(g).fy });
      return false;
    }
    case "noinv input up":
      update(g, { noinvUp: true });
      return true;
    case "noinv input down":
      update(g, { noinvUp: false });
      return true;
    case "tr circle":
      update(g, { trCircle: value !== "false" });
      return true;
    case "number inputs": {
      const n = num(value ?? "2");
      if (n !== undefined) update(g, { inputs: Math.max(1, Math.min(16, Math.round(n))) });
      return true;
    }
  }
  if (STYLE_KEYS[PACKAGE_ALIASES[key] ?? key] || (QUIET_STYLES.has(key) && key !== "invert" && key !== "mirror")) return ctikzKey(g, key, value);
  if (/^\/?(tikz\/)?circuitikz\//.test(key)) return ctikzKey(g, key, value) || true;
  return false;
}

// ------------------------------------------------------------------ to[...] options

interface Lbl {
  text: string;
  /** +1 above (left of the direction of travel), -1 below. */
  side: number;
}

interface Arrowish extends Lbl {
  /** Against the direction of travel. */
  back: boolean;
  /** On the lead before the component. */
  before: boolean;
}

export interface Bipole {
  /** The component as written (R, C, european resistor ...). */
  name: string;
  /** Unsupported: drawn as a box with its name. */
  unknown?: boolean;
  l?: Lbl;
  a?: Lbl;
  v?: Arrowish;
  i?: Arrowish;
  f?: Arrowish;
  poles: [string, string];
  id?: string;
  invert: boolean;
  mirror: boolean;
  t?: string;
}

/** Component names (as circuitikz spells them) to their drawing, given the styles in force. */
function resolve(name: string, st: CircuitSettings): string | undefined {
  const r = st.resistor;
  const vs = st.voltage;
  const cs = st.current;
  switch (name) {
    case "R":
    case "resistor":
      return `${r} resistor`;
    case "vR":
    case "variable resistor":
      return `variable ${r} resistor`;
    case "variable american resistor":
    case "variable european resistor":
      return name;
    case "pR":
    case "potentiometer":
      return `${r} potentiometer`;
    case "american potentiometer":
    case "european potentiometer":
      return name;
    case "thR":
    case "thRp":
    case "thRn":
    case "thermistor":
    case "thermistor ptc":
    case "thermistor ntc":
      return "thermistor";
    case "phR":
    case "ldR":
    case "photoresistor":
      return "photoresistor";
    case "Mr":
    case "memristor":
      return "memristor";
    case "C":
    case "capacitor":
    case "ceramic capacitor":
    case "cC":
      return "capacitor";
    case "pC":
    case "polar capacitor":
    case "curved capacitor":
      return "polar capacitor";
    case "eC":
    case "electrolytic capacitor":
      return "electrolytic capacitor";
    case "vC":
    case "variable capacitor":
      return "variable capacitor";
    case "L":
    case "inductor":
    case "vL":
    case "variable inductor":
      return `${st.inductor} inductor`;
    case "cuteL":
    case "cute inductor":
      return "cute inductor";
    case "american inductor":
    case "european inductor":
      return name;
    case "D":
    case "diode":
    case "empty diode":
      return "empty diode";
    case "D*":
    case "full diode":
      return "full diode";
    case "led":
    case "leD":
    case "empty led":
      return "empty led";
    case "leD*":
    case "full led":
      return "full led";
    case "pD":
    case "photodiode":
    case "empty photodiode":
      return "empty photodiode";
    case "pD*":
    case "full photodiode":
      return "full photodiode";
    case "zD":
    case "zzD":
    case "zener diode":
    case "empty zener diode":
      return "empty zener diode";
    case "zD*":
    case "zzD*":
    case "full zener diode":
      return "full zener diode";
    case "sD":
    case "schottky diode":
    case "Schottky diode":
    case "empty Schottky diode":
      return "empty Schottky diode";
    case "sD*":
    case "full Schottky diode":
      return "full Schottky diode";
    case "tD":
    case "tD*":
    case "tunnel diode":
      return "empty tunnel diode";
    case "VC":
    case "varcap":
    case "varcap diode":
      return "varactor";
    case "V":
    case "vsource":
    case "voltage source":
      return `${vs} voltage source`;
    case "american voltage source":
    case "vsourceAM":
      return "american voltage source";
    case "european voltage source":
      return "european voltage source";
    case "I":
    case "isource":
    case "current source":
      return `${cs} current source`;
    case "american current source":
    case "isourceAM":
      return "american current source";
    case "european current source":
      return "european current source";
    case "sV":
    case "vsourcesin":
    case "sinusoidal voltage source":
    case "ac source":
    case "vsourceN":
      return "sinusoidal voltage source";
    case "sI":
    case "isourcesin":
    case "sinusoidal current source":
      return "sinusoidal current source";
    case "sqV":
    case "vsourcesquare":
    case "square voltage source":
      return "square voltage source";
    case "dcvsource":
    case "dc voltage source":
      return "dc voltage source";
    case "dcisource":
    case "dc current source":
      return "american current source";
    case "cV":
    case "cvsource":
    case "controlled voltage source":
      return `${vs} controlled voltage source`;
    case "american controlled voltage source":
    case "cvsourceAM":
      return "american controlled voltage source";
    case "european controlled voltage source":
      return "european controlled voltage source";
    case "cI":
    case "cisource":
    case "controlled current source":
      return `${cs} controlled current source`;
    case "american controlled current source":
    case "cisourceAM":
      return "american controlled current source";
    case "european controlled current source":
      return "european controlled current source";
    case "battery":
    case "battery1":
    case "battery2":
      return name;
    case "lamp":
    case "bulb":
    case "fuse":
    case "ammeter":
    case "voltmeter":
    case "ohmmeter":
    case "wattmeter":
    case "rmeter":
    case "crystal":
    case "generic":
    case "tgeneric":
    case "twoport":
    case "short":
    case "open":
    case "varistor":
      return name;
    case "afuse":
    case "asymmetric fuse":
      return "asymmetric fuse";
    case "oscope":
    case "oscilloscope":
      return "oscilloscope";
    case "piezoelectric":
    case "quartz":
      return "crystal";
    case "fullgeneric":
    case "ageneric":
      return "generic";
    case "switch":
    case "nos":
    case "normal open switch":
    case "toggle switch":
    case "normally open switch":
      return "normal open switch";
    case "ncs":
    case "normal closed switch":
    case "normally closed switch":
      return "normal closed switch";
    case "spst":
    case "cute open switch":
    case "cosw":
      return "single pole switch";
    case "cspst":
    case "closing switch":
    case "cute closing switch":
    case "ccsw":
      return "closing switch";
    case "ospst":
    case "opening switch":
    case "cute opening switch":
    case "cosw2":
      return "opening switch";
    case "push button":
    case "normally open push button":
    case "nopb":
    case "ncpb":
      return "push button";
    case "european resistor":
    case "american resistor":
      return name;
  }
  return undefined;
}

/** Turns circuitikz's siunitx shorthand, 1<\kilo\ohm>, into \SI{1}{\kilo\ohm}. */
function labelText(v: string): string {
  const t = v.trim();
  const m = /^([^$<>]*)<([^<>$]*)>$/.exec(t);
  if (m) return `$\\SI{${m[1].trim()}}{${m[2].trim()}}$`;
  // l=\SI{10}{\kilo\ohm} outside math: the units are typeset as math.
  if (!t.includes("$")) return t.replace(/\\(?:SI|qty)\s*\{[^{}]*\}\s*\{[^{}]*\}|\\(?:si|unit|num|ang)\s*\{[^{}]*\}/g, (s) => `$${s}$`);
  return t;
}

function arrowish(mods: string, text: string, defaultSide: number): Arrowish {
  const sideCh = /[\^_]/.exec(mods)?.[0];
  const dirCh = /[<>]/.exec(mods)?.[0];
  const side = sideCh === "_" ? -1 : sideCh === "^" ? 1 : defaultSide;
  const before = !!dirCh && !!sideCh && mods.indexOf(dirCh) < mods.indexOf(sideCh);
  return { text: labelText(text), side, back: dirCh === "<", before };
}

/** Does TikZ itself understand this key? (A probe on a scratch copy of the state.) */
function tikzKnows(it: Interp, g: GS, key: string, value: string | undefined): boolean {
  if (g.styles.has(key)) return true;
  let unknown = false;
  const probe: OptionHost = {
    unknown: () => {
      unknown = true;
    },
    warn: () => undefined,
    colors: it.colors,
    ...(it.lookup ? { lookup: it.lookup } : {}),
    coordOffset: (t, gg) => it.coordOffset(t, gg),
  };
  try {
    applyKey(cloneGS(g), key, value, "path", probe, 0);
  } catch {
    return false;
  }
  return !unknown;
}

/**
 * Splits the circuitikz keys out of a to[...] option list. Returns the
 * TikZ keys left over, and the bipole when there is one.
 */
export function toOptions(it: Interp, opts: string, g: GS): { rest: string; bipole?: Bipole } {
  const kvs = parseOptions(opts);
  const rest: string[] = [];
  const b: Bipole = { name: "", poles: ["", ""], invert: false, mirror: false };
  let circuit = false;
  const pending: { key: string; value: string | undefined; raw: string }[] = [];
  for (const { key, value } of kvs) {
    const raw = value === undefined ? key : `${key}={${value}}`;
    const k = key.replace(/^\/?(tikz\/)?circuitikz\//, "");
    const poles = /^([*od|s]?)-([*od|s]?)$/.exec(k);
    if (poles && k.length > 1 && value === undefined) {
      b.poles = [poles[1], poles[2]];
      circuit = true;
      continue;
    }
    const lab = /^([la])([\^_]?)2?$/.exec(k);
    if (lab && value !== undefined) {
      const side = lab[2] === "_" ? -1 : lab[2] === "^" ? 1 : lab[1] === "a" ? -1 : 1;
      b[lab[1] as "l" | "a"] = { text: labelText(value), side };
      circuit = true;
      continue;
    }
    const arr = /^([vif])([<>^_]{0,2})$/.exec(k);
    if (arr && value !== undefined) {
      const kind = arr[1] as "v" | "i" | "f";
      b[kind] = arrowish(arr[2], value, kind === "v" ? -1 : 1);
      circuit = true;
      continue;
    }
    if ((k === "name" || k === "n") && value !== undefined) {
      b.id = value.trim();
      continue;
    }
    if (k === "t" && value !== undefined) {
      b.t = labelText(value);
      continue;
    }
    if (k === "invert" || k === "mirror") {
      if (value === undefined || value === "true") b[k] = true;
      circuit = true;
      continue;
    }
    if (resolve(k, CIRCUIT_DEFAULTS)) {
      b.name = k;
      if (value !== undefined && value.trim()) b.l = { text: labelText(value), side: b.l?.side ?? 1 };
      circuit = true;
      continue;
    }
    pending.push({ key: k, value, raw });
  }
  // What is left is TikZ's, unless it names a component texwright does not draw.
  const inCircuit = circuit || !!g.circuit;
  for (const p of pending) {
    if (!b.name && inCircuit && /^[A-Za-z][A-Za-z0-9 *]*$/.test(p.key) && !tikzKnows(it, g, p.key, p.value)) {
      b.name = p.key;
      b.unknown = true;
      if (p.value !== undefined && p.value.trim()) b.l = { text: labelText(p.value), side: b.l?.side ?? 1 };
      circuit = true;
      continue;
    }
    rest.push(p.raw);
  }
  if (!circuit) return { rest: opts };
  if (!b.name) b.name = "short";
  return { rest: rest.join(","), bipole: b };
}

// ------------------------------------------------------------------ painting

function strokeColor(g: GS): string {
  return g.drawColor ?? g.color;
}

/** Paints a pen's drawing through a point map, with upright signs and text. */
function paintPen(it: Interp, g: GS, pen: Pen, map: (p: Pt) => Pt, st: CircuitSettings): void {
  const color = strokeColor(g);
  const base = it.paint(g, true, false);
  const k = st.thickness / 2;
  const mapSegs = (segs: Seg[]): Seg[] =>
    segs.map((s): Seg => {
      if (s.t === "Z") return s;
      if (s.t === "C") return { t: "C", c1: map(s.c1), c2: map(s.c2), p: map(s.p) };
      return { t: s.t, p: map(s.p) } as Seg;
    });
  const paintPrim = (pr: Prim) => {
    const lw = Math.max(0.05, g.lw * pr.w * (pr.w > 1 ? k : 1));
    const segs = mapSegs(pr.segs);
    const style = { ...base, lineWidth: lw, dash: undefined };
    if (pr.mode === "stroke") it.scene.path(segs, { ...style, fill: undefined }, g.clips, g.layer);
    else if (pr.mode === "fill") it.scene.path(segs, { ...style, stroke: undefined, fill: color }, g.clips, g.layer);
    else if (pr.mode === "both") it.scene.path(segs, { ...style, stroke: color, fill: color }, g.clips, g.layer);
    else it.scene.path(segs, { ...style, stroke: color, fill: "#ffffff" }, g.clips, g.layer);
  };
  for (const pr of pen.prims) paintPrim(pr);
  for (const s of pen.signs) {
    const c = map(s.at);
    const segs: Seg[] = [
      { t: "M", p: [c[0] - s.size, c[1]] },
      { t: "L", p: [c[0] + s.size, c[1]] },
    ];
    if (s.kind === "+") segs.push({ t: "M", p: [c[0], c[1] - s.size] }, { t: "L", p: [c[0], c[1] + s.size] });
    it.scene.path(segs, { ...base, dash: undefined, fill: undefined, lineWidth: g.lw * 1.5 }, g.clips, g.layer);
  }
  for (const t of pen.texts) textAt(it, g, t.text, map(t.at), "center", t.scale, 0);
  it.drawn++;
}

/** Upright text at a point, the side `anchor` of its box there. */
function textAt(it: Interp, g: GS, text: string, at: Pt, anchor: string, k = 1, sep?: number): NodeInfo | undefined {
  if (!text.trim()) return undefined;
  const lg = nodeGS(g);
  lg.shape = "rectangle";
  lg.anchor = anchor;
  lg.place = undefined;
  lg.textWidth = undefined;
  lg.minW = lg.minH = 1;
  lg.fit = undefined;
  lg.pos = undefined;
  lg.circuit = undefined;
  if (sep !== undefined) lg.ix = lg.iy = sep;
  if (k !== 1) lg.font = { ...lg.font, size: lg.font.size * k };
  const pn: PendingNode = { text, g: lg, off: it.off, onNext: false };
  return it.node(pn, { point: at }, g);
}

/** The compass anchor of a box that faces back along direction d (for text beside a component). */
function facing(d: Pt): string {
  const a = ((angleOf([-d[0], -d[1]]) % 360) + 360) % 360;
  const names = ["east", "north east", "north", "north west", "west", "south west", "south", "south east"];
  // Near the axes the side is used, as circuitikz does; only clear diagonals get a corner.
  const near = (t: number) => Math.abs(((a - t + 540) % 360) - 180) < 30;
  if (near(0)) return "east";
  if (near(90)) return "north";
  if (near(180)) return "west";
  if (near(270)) return "south";
  return names[Math.round(a / 45) % 8];
}

function pole(it: Interp, g: GS, kind: string, at: Pt, st: CircuitSettings): void {
  if (!kind) return;
  const r = st.dot * st.len;
  const p = new Pen();
  p.w = 1;
  if (kind === "d")
    p.poly(
      [
        [-r * 1.3, 0],
        [0, r * 1.3],
        [r * 1.3, 0],
        [0, -r * 1.3],
      ],
      "both",
    );
  else if (kind === "s") p.rect(-r, -r, r, r, "both");
  else if (kind === "|") p.line([0, -r * 2], [0, r * 2]);
  else p.circle([0, 0], r, kind === "o" ? "white" : "both");
  paintPen(it, g, p, (q) => add(at, q), st);
}

// ------------------------------------------------------------------ bipoles

export interface BipoleResult {
  /** The wires, for the path. */
  segs: Seg[];
  /** Draws the component, its labels and poles (after the path). */
  draw: () => void;
}

/** Lays out the bipole from a to b. */
export function bipole(it: Interp, bip: Bipole, a: Pt, b: Pt, g: GS): BipoleResult {
  const st0 = settings(g);
  // Components keep their size when the picture is scaled, unless with transform shape.
  const st = g.transformShape ? { ...st0, len: st0.len * Math.sqrt(Math.abs(g.T[0] * g.T[3] - g.T[1] * g.T[2])) } : st0;
  let kind = bip.unknown ? undefined : resolve(bip.name, st);
  let t = bip.t;
  if (!kind) {
    if (bip.name && bip.name !== "short") it.warnOnce(`circ:${bip.name}`, `circuitikz component "${bip.name}" is not supported; it was drawn as a labelled box`, "Use a supported component, or draw it with generic and a label");
    kind = "tgeneric";
    t = t ?? `\\scriptsize ${bip.name.replace(/[\\{}$&#^_%~]/g, "")}`;
  }
  const def: BipoleDef = BIPOLES[kind];
  const len = st.len;
  const sc = st.scales[def.family] ?? 1;
  const L = dist(a, b);
  const u: Pt = L > 1e-9 ? unit(sub(b, a)) : [1, 0];
  const n: Pt = [-u[1], u[0]];
  const W = def.w * len * sc;
  const H = def.h * len * sc;
  const c: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const half = Math.min(W / 2, L / 2);
  const p1 = sub(c, scale(u, half));
  const p2 = add(c, scale(u, half));
  const segs: Seg[] = [];
  if (def.open) segs.push({ t: "M", p: a }, { t: "M", p: b });
  else if (W <= 0) segs.push({ t: "M", p: a }, { t: "L", p: b });
  else {
    segs.push({ t: "M", p: a });
    if (dist(a, p1) > 1e-6) segs.push({ t: "L", p: p1 });
    segs.push({ t: "M", p: p2 });
    if (dist(p2, b) > 1e-6) segs.push({ t: "L", p: b });
  }
  const sx = bip.invert ? -1 : 1;
  const sy = bip.mirror ? -1 : 1;
  const map = (q: Pt): Pt => add(c, add(scale(u, q[0] * sx), scale(n, q[1] * sy)));
  const pen = new Pen();
  def.draw(pen, W, H, { american: { voltage: st.voltage === "american", current: st.current === "american" }, ...(t ? { t } : {}), len });
  const box = pen.box();
  const okBox = box[0] <= box[2];
  // How far the drawing reaches to each side of the wire (at least half its nominal height).
  const reachUp = Math.max(H / 2, okBox ? (sy > 0 ? box[3] : -box[1]) : 0);
  const reachDown = Math.max(H / 2, okBox ? (sy > 0 ? -box[1] : box[3]) : 0);
  const reach = (side: number) => (side > 0 ? reachUp : reachDown);
  const gap = 1;
  if (bip.id) {
    const hw = Math.max(Math.abs(u[0]) * W / 2 + Math.abs(n[0]) * Math.max(reachUp, reachDown), 0.5);
    const hh = Math.max(Math.abs(u[1]) * W / 2 + Math.abs(n[1]) * Math.max(reachUp, reachDown), 0.5);
    const anchors = new Map<string, Pt>([
      ["left", sub(p1, c)],
      ["right", sub(p2, c)],
      ["start", sub(a, c)],
      ["end", sub(b, c)],
      ["label", scale(n, reachUp + gap)],
      ["annotation", scale(n, -(reachDown + gap))],
      ["wiper", scale(n, sy * (H / 2 + 0.3 * len))],
      ["mid", [0, 0]],
    ]);
    it.nodes.set(bip.id, { name: bip.id, center: c, shape: "rectangle", hw, hh, rot: 0, baseDy: 0, anchors });
  }
  const draw = () => {
    const dg = cloneGS(g);
    dg.arrows = undefined;
    if (!def.open && W > 0) paintPen(it, dg, pen, map, st);
    // Labels: l above, a below (or as asked).
    // How far out each side is taken: a voltage on the side of a label goes beyond it.
    const used = new Map<number, number>([
      [1, reach(1)],
      [-1, reach(-1)],
    ]);
    const occupy = (info: NodeInfo | undefined, side: number) => {
      if (!info) return;
      const d = scale(n, side);
      const r = d[0] * (info.center[0] - c[0]) + d[1] * (info.center[1] - c[1]) + Math.abs(d[0]) * info.hw + Math.abs(d[1]) * info.hh;
      used.set(side, Math.max(used.get(side) ?? 0, r - 2));
    };
    const place = (lbl: Lbl | undefined) => {
      if (!lbl) return;
      const d = scale(n, lbl.side);
      occupy(textAt(it, dg, lbl.text, add(c, scale(d, (used.get(lbl.side) ?? 0) + gap)), facing(d)), lbl.side);
    };
    place(bip.l);
    place(bip.a);
    // Voltage: + and - (american) or an arrow (european), on the v side.
    if (bip.v) {
      const v = bip.v;
      const d = scale(n, v.side);
      // A source's own symbol has its plus at the end (at the start when inverted); other bipoles take v at the start.
      let plusAtStart = def.source ? bip.invert : true;
      if (v.back) plusAtStart = !plusAtStart;
      // The signs (or the arrow's ends) sit near the component's ends, at least 0.35 of the bipole length out.
      const along = Math.max(0, Math.min(Math.max(W / 2, 0.35 * len), L / 2 - 3));
      const off = (used.get(v.side) ?? 0) + gap;
      const sPlus = add(c, scale(u, plusAtStart ? -along : along));
      const sMinus = add(c, scale(u, plusAtStart ? along : -along));
      if (st.voltage === "american") {
        textAt(it, dg, "$+$", add(sPlus, scale(d, off + 5)), "center", 1, 0);
        textAt(it, dg, "$-$", add(sMinus, scale(d, off + 5)), "center", 1, 0);
        textAt(it, dg, v.text, add(c, scale(d, off)), facing(d));
      } else {
        const ao = off + 3;
        const p = new Pen();
        p.w = 1;
        const from = add(sPlus, scale(d, ao));
        const to = add(sMinus, scale(d, ao));
        const shrink = scale(unit(sub(to, from)), Math.min(2, dist(from, to) / 4));
        p.arrow(add(from, shrink), sub(to, shrink), 0.1 * len, 0.04 * len);
        paintPen(it, dg, p, (q) => q, { ...st, thickness: 2 });
        textAt(it, dg, v.text, add(c, scale(d, ao + 1)), facing(d));
      }
    }
    // Current: an arrowhead on the wire, its label beside it.
    if (bip.i) {
      const i = bip.i;
      const lead = Math.max(0, L / 2 - half);
      let at: Pt;
      if (lead > 0.12 * len) at = i.before ? add(a, scale(u, lead / 2)) : sub(b, scale(u, lead / 2));
      else at = W > 0 ? add(c, scale(u, (i.before ? -1 : 1) * (half + 0.08 * len))) : c;
      const dirv = i.back ? scale(u, -1) : u;
      const al = 0.1 * len;
      const p = new Pen();
      p.head(add(at, scale(dirv, al / 2)), dirv, al, 0.045 * len);
      paintPen(it, dg, p, (q) => q, st);
      const d = scale(n, i.side);
      textAt(it, dg, i.text, add(at, scale(d, 0.04 * len + gap)), facing(d));
    }
    // Flow: an arrow beside the wire.
    if (bip.f) {
      const f = bip.f;
      const lead = Math.max(0, L / 2 - half);
      const mid = lead > 0.25 * len ? (f.before ? add(a, scale(u, lead / 2)) : sub(b, scale(u, lead / 2))) : c;
      const d = scale(n, f.side);
      const off = lead > 0.25 * len ? 0.1 * len : reach(f.side) + 0.1 * len;
      const dirv = f.back ? scale(u, -1) : u;
      const fl = Math.min(0.3 * len, Math.max(lead, 0.2 * len) * 0.8);
      const p = new Pen();
      p.w = 1;
      const m = add(mid, scale(d, off));
      p.arrow(sub(m, scale(dirv, fl / 2)), add(m, scale(dirv, fl / 2)), 0.1 * len, 0.04 * len);
      paintPen(it, dg, p, (q) => q, { ...st, thickness: 2 });
      textAt(it, dg, f.text, add(m, scale(d, gap)), facing(d));
    }
    pole(it, dg, bip.poles[0], a, st);
    pole(it, dg, bip.poles[1], b, st);
  };
  return { segs, draw };
}

// ------------------------------------------------------------------ nodes

interface NodeLayout {
  info: NodeInfo;
  draw: NodeDraw;
  /** Local (node frame, points) to the picture. */
  M: [number, number, number, number];
}

function nodeOptsFor(g: GS): NodeOpts {
  const st = settings(g);
  const famScale = (fam: string) => st.scales[fam] ?? 1;
  const fam = /port$/.test(g.shape) ? "logic ports" : g.shape === "op amp" || /amp$/.test(g.shape) ? "amplifiers" : /ground$/.test(g.shape) ? "grounds" : /^(npn|pnp|n|p)/.test(g.shape) ? "transistors" : "tripoles";
  const u = (st.len / 1.4) * famScale(fam);
  return {
    u,
    len: st.len,
    noinvUp: !!st.noinvUp,
    inputs: st.inputs ?? 2,
    circle: !!st.trCircle,
    ports: st.ports,
    dot: st.dot * st.len,
  };
}

/** Where a circuit node goes and what it draws; undefined when the shape is not a circuit shape. */
function layoutNode(pn: PendingNode, where: { point: Pt } | undefined, pathGS: GS): NodeLayout | undefined {
  const g = pn.g;
  if (!Object.hasOwn(NODE_SHAPES, g.shape)) return undefined;
  const d = NODE_SHAPES[g.shape](nodeOptsFor(g));
  const st = settings(g);
  const outer = settings(pathGS);
  // The node's own flips, rotation and scale (circuitikz shapes follow them); the picture's scale does not apply.
  const fx = st.fx * outer.fx;
  const fy = st.fy * outer.fy;
  const R = rotation(g.nrot);
  const s = g.nscale * (g.transformShape ? Math.sqrt(Math.abs(g.T[0] * g.T[3] - g.T[1] * g.T[2])) : 1);
  const M: [number, number, number, number] = [R[0] * fx * s, R[1] * fx * s, R[2] * fy * s, R[3] * fy * s];
  const lin = (q: Pt): Pt => [M[0] * q[0] + M[2] * q[1], M[1] * q[0] + M[3] * q[1]];
  const point = pn.at?.p ?? where?.point ?? [g.T[4], g.T[5]];
  // Size: the drawing and its anchors, around the node's origin.
  const b = d.pen.box();
  const corners: Pt[] = b[0] <= b[2] ? [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]] : [[0, 0]];
  for (const p of d.anchors.values()) corners.push(p);
  let hw = 0.5;
  let hh = 0.5;
  for (const q of corners) {
    const m = lin(q);
    hw = Math.max(hw, Math.abs(m[0]));
    hh = Math.max(hh, Math.abs(m[1]));
  }
  const anchors = new Map<string, Pt>();
  for (const [k, p] of d.anchors) anchors.set(k, lin(p));
  if (d.text) anchors.set("text", lin(d.text.at));
  // anchor=...: one of the shape's own anchors, or a compass point of its box.
  let off: Pt = [0, 0];
  const an = g.anchor?.trim();
  if (an && an !== "center") {
    const own = anchors.get(an);
    if (own) off = own;
    else {
      const cv: Record<string, Pt> = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0], "north east": [1, 1], "north west": [-1, 1], "south east": [1, -1], "south west": [-1, -1] };
      const v = cv[an];
      if (v) off = [v[0] * hw, v[1] * hh];
    }
  }
  const center = add(sub(point, off), g.nshift);
  let shape = "rectangle";
  if (d.border === "point") shape = "coordinate";
  else if (d.border === "circle") {
    shape = "circle";
    hw = hh = Math.max(0.1, Math.abs(lin([b[2], 0])[0]), Math.abs(lin([0, b[3]])[1]));
  }
  const info: NodeInfo = { name: pn.name ?? "", center, shape, hw, hh, rot: 0, baseDy: 0, anchors };
  return { info, draw: d, M };
}

/** Geometry only, for a name used later in the same path. */
export function nodeLayout(_it: Interp, pn: PendingNode, where: { point: Pt } | undefined, pathGS: GS): NodeInfo | undefined {
  return layoutNode(pn, where, pathGS)?.info;
}

/** Draws a circuit node; undefined when the node is not a circuit shape. */
export function circuitNode(it: Interp, pn: PendingNode, where: { point: Pt } | undefined, pathGS: GS): NodeInfo | undefined {
  const lay = layoutNode(pn, where, pathGS);
  if (!lay) return undefined;
  const g = pn.g;
  const { info, draw, M } = lay;
  if (pn.name) it.nodes.set(pn.name, info);
  if (g.alias) it.nodes.set(g.alias, info);
  const st = settings(g);
  const map = (q: Pt): Pt => add(info.center, [M[0] * q[0] + M[2] * q[1], M[1] * q[0] + M[3] * q[1]]);
  const dg = cloneGS(g);
  dg.arrows = undefined;
  dg.dash = undefined;
  dg.dashPattern = undefined;
  const pen = draw.pen;
  // Nodes keep text upright; signs inside an op amp follow its flips.
  paintPen(it, dg, pen, map, st);
  if (draw.text && pn.text.trim()) {
    const at = map(draw.text.at);
    const anchor = draw.text.anchor;
    // A mirrored transistor has its text on the other side.
    const flipX = M[0] < 0 && (anchor === "west" || anchor === "east");
    textAt(it, dg, pn.text, at, flipX ? (anchor === "west" ? "east" : "west") : rotatedAnchor(anchor, M), 1);
  }
  for (const l of g.labels) it.label(info, l, g);

  return info;
}

/** A text anchor turned with the node (south of a ground drawn upside down is north). */
function rotatedAnchor(anchor: string, M: [number, number, number, number]): string {
  const v: Record<string, Pt> = { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] };
  const d = v[anchor];
  if (!d) return anchor;
  const m: Pt = [M[0] * d[0] + M[2] * d[1], M[1] * d[0] + M[3] * d[1]];
  const a = ((angleOf(m) % 360) + 360) % 360;
  return a < 45 || a >= 315 ? "east" : a < 135 ? "north" : a < 225 ? "west" : "south";
}

// ------------------------------------------------------------------ the hooks

export interface CircuitHooks {
  toOptions: typeof toOptions;
  bipole: typeof bipole;
  node: typeof circuitNode;
  layout: typeof nodeLayout;
  ctikzset: typeof ctikzset;
}

export const CIRCUIT: CircuitHooks = { toOptions, bipole, node: circuitNode, layout: nodeLayout, ctikzset };
