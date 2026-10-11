/**
 * Commands from LaTeX packages that documents use without loading anything,
 * language-model output above all: siunitx (\SI, \si, \num, \qty, \unit,
 * \ang, ranges and lists), mhchem (\ce, \pu), physics (\dv, \pdv, \dd,
 * \abs, \norm, \qty, \bra, \ket, \braket, \mqty, ...), bm, bbm, dsfont,
 * nicefrac and gensymb. Each reads its arguments as source text and
 * returns the TeX it stands for.
 *
 * They apply only to names nothing else defines: a document's own macros
 * and the engine's commands win. A few conventional shorthands that come
 * from no package (\R, \E, \argmax, ...) are read the usual way too; the
 * parser notes each one, since that reading is a guess.
 */

/** Argument access for a package command, over the expander's raw tokens. */
export interface Args {
  /** The next mandatory argument as source text (a braced group without its braces, or one token). */
  arg(): string;
  /** An optional [..] argument as source text, if one follows. */
  opt(): string | undefined;
  /** Consume a * if one follows. */
  star(): boolean;
  /** The next character or control sequence after any spaces, not consumed ("" at the end). */
  peek(): string;
  /** Consume `open`, then return the text up to the matching `close`. */
  until(open: string, close: string): string;
  /** The body of a macro the document defined (\DeclareSIUnit units among them). */
  macro(name: string): string | undefined;
}

export interface PackageCommand {
  expand(a: Args): string;
  /** Set for a conventional shorthand: the reading it was given. */
  guess?: string;
}

const PACKAGES = new Map<string, PackageCommand>();

function def(names: string, expand: (a: Args, name: string) => string): void {
  for (const n of names.split(" ")) PACKAGES.set(`\\${n}`, { expand: (a) => expand(a, n) });
}

/** The document's macros, visible to the unit parser while a package command expands. */
let documentMacros: ((name: string) => string | undefined) | undefined;

/** Expands a package command; units the document declared (\DeclareSIUnit) are looked up through `a`. */
export function expandPackage(cmd: PackageCommand, a: Args): string {
  const saved = documentMacros;
  documentMacros = (name) => a.macro(name);
  try {
    return cmd.expand(a);
  } finally {
    documentMacros = saved;
  }
}

/** The package command a name stands for, if any. */
export function packageCommand(name: string): PackageCommand | undefined {
  return PACKAGES.get(name);
}

export function packageCommandNames(): string[] {
  return [...PACKAGES.keys()];
}

// ---------------------------------------------------------------- siunitx numbers

const PLAIN_NUMBER = /^([-+]?)(\d*)(?:[.,](\d*))?(\(\d+\))?(?:\s*[eEdD]\s*([-+]?\d+))?$/;

function groupDigits(int: string, frac: string | undefined): string {
  let i = int;
  if (i.length >= 5) i = i.replace(/\B(?=(\d{3})+$)/g, "\\,");
  if (frac === undefined) return i;
  let f = frac;
  if (f.length >= 5) f = f.replace(/(\d{3})(?=\d)/g, "$1\\,");
  return `${i || "0"}.${f}`;
}

function singleNumber(src: string): string {
  const s = src.trim();
  const m = PLAIN_NUMBER.exec(s);
  if (!m || (!m[2] && m[3] === undefined && m[5] === undefined)) return s;
  const [, sign, int, frac, unc, exp] = m;
  let mant = int || frac !== undefined ? groupDigits(int!, frac) + (unc ?? "") : "";
  if (exp !== undefined) {
    const power = `10^{${exp.replace(/^\+/, "")}}`;
    mant = mant && mant !== "1" ? `${mant}\\times ${power}` : power;
  }
  return `${sign}${mant}`;
}

/** \num: digit groups, exponents as ×10^n, ± and × kept as signs. Anything that is not a number is kept as written. */
export function formatNumber(src: string): string {
  const s = src.trim().replace(/\+-/g, "\\pm ");
  const products = s.split(/\s*(?:\\times(?![A-Za-z])|(?<=[\d.)}])\s*x\s*(?=[-+\d.]))\s*/);
  return `{${products
    .map((p) =>
      p
        .split(/\s*\\pm(?![A-Za-z])\s*/)
        .map(singleNumber)
        .join("\\pm "),
    )
    .join("\\times ")}}`;
}

// ---------------------------------------------------------------- siunitx units

const PREFIXES: Record<string, string> = {
  quecto: "q",
  ronto: "r",
  yocto: "y",
  zepto: "z",
  atto: "a",
  femto: "f",
  pico: "p",
  nano: "n",
  micro: "\\mu ",
  milli: "m",
  centi: "c",
  deci: "d",
  deca: "da",
  deka: "da",
  hecto: "h",
  kilo: "k",
  mega: "M",
  giga: "G",
  tera: "T",
  peta: "P",
  exa: "E",
  zetta: "Z",
  yotta: "Y",
  ronna: "R",
  quetta: "Q",
  kibi: "Ki",
  mebi: "Mi",
  gibi: "Gi",
  tebi: "Ti",
};

const UNITS: Record<string, string> = {
  meter: "m",
  metre: "m",
  gram: "g",
  kilogram: "kg",
  second: "s",
  ampere: "A",
  kelvin: "K",
  mole: "mol",
  candela: "cd",
  hertz: "Hz",
  newton: "N",
  pascal: "Pa",
  joule: "J",
  watt: "W",
  coulomb: "C",
  volt: "V",
  farad: "F",
  ohm: "\\Omega",
  siemens: "S",
  weber: "Wb",
  tesla: "T",
  henry: "H",
  lumen: "lm",
  lux: "lx",
  becquerel: "Bq",
  gray: "Gy",
  sievert: "Sv",
  katal: "kat",
  radian: "rad",
  steradian: "sr",
  liter: "L",
  litre: "L",
  minute: "min",
  hour: "h",
  day: "d",
  year: "yr",
  electronvolt: "eV",
  dalton: "Da",
  atomicmassunit: "u",
  astronomicalunit: "au",
  hectare: "ha",
  tonne: "t",
  bar: "bar",
  bel: "B",
  decibel: "dB",
  neper: "Np",
  byte: "B",
  bit: "bit",
  barn: "b",
  knot: "kn",
  nauticalmile: "M",
  mmHg: "mmHg",
  millimetremercury: "mmHg",
  molar: "M",
  angstrom: "\\mathring{A}",
  clight: "c",
  electronmass: "m_e",
  planckbar: "\\hbar",
  elementarycharge: "e",
  bohr: "a_0",
  hartree: "E_h",
  percent: "\\%",
};

/** Units printed straight after the number, with no space. */
const ATTACHED: Record<string, string> = {
  degree: "{}^{\\circ}",
  arcminute: "{}^{\\prime}",
  arcsecond: "{}^{\\prime\\prime}",
};

/** Abbreviations: \kg, \MHz, \uL, ... as a prefix letter and a base unit. */
const ABBR_BASES: Record<string, string> = {
  g: "g",
  m: "m",
  s: "s",
  mol: "mol",
  A: "A",
  L: "L",
  l: "l",
  Hz: "Hz",
  N: "N",
  Pa: "Pa",
  ohm: "\\Omega",
  V: "V",
  W: "W",
  J: "J",
  eV: "eV",
  F: "F",
  K: "K",
  Wh: "Wh",
  C: "C",
  T: "T",
  dB: "dB",
  amu: "u",
};
const ABBR_PREFIXES: Record<string, string> = { a: "a", f: "f", p: "p", n: "n", u: "\\mu ", m: "m", c: "c", d: "d", k: "k", M: "M", G: "G", T: "T" };

function abbreviation(name: string): string | undefined {
  if (Object.hasOwn(ABBR_BASES, name)) return ABBR_BASES[name];
  const p = ABBR_PREFIXES[name[0]!];
  const b = name.slice(1);
  if (p !== undefined && Object.hasOwn(ABBR_BASES, b) && b !== "amu" && b !== "dB") return p + ABBR_BASES[b];
  return undefined;
}

const UNIT_KEYWORDS = new Set(["per", "square", "cubic", "squared", "cubed", "tothe", "raiseto", "of", "cancel", "highlight", "celsius", "degreeCelsius"]);

/** Replaces units the document declared with \DeclareSIUnit (\kNm as \kilo\newton\metre), a few levels deep. */
function declaredUnits(s: string): string {
  const lookup = documentMacros;
  if (!lookup || !s.includes("\\")) return s;
  let out = s;
  for (let round = 0; round < 4; round++) {
    let changed = false;
    out = out.replace(/\\([A-Za-z]+)/g, (m, name: string) => {
      if (Object.hasOwn(PREFIXES, name) || Object.hasOwn(UNITS, name) || Object.hasOwn(ATTACHED, name) || UNIT_KEYWORDS.has(name)) return m;
      const body = lookup(`\\${name}`);
      if (body === undefined || body.length > 200) return m;
      changed = true;
      return body;
    });
    if (!changed) break;
  }
  return out;
}

interface UnitPart {
  text: string;
  power: number | string;
  per: boolean;
}

function readGroup(s: string, i: number): [string, number] {
  // s[i] is "{": return the content and the index after the matching "}".
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return [s.slice(i + 1, j), j + 1];
  }
  return [s.slice(i + 1), s.length];
}

/** An argument at s[i]: a braced group or one character. */
function readArgAt(s: string, i: number): [string, number] {
  while (s[i] === " ") i++;
  if (s[i] === "{") return readGroup(s, i);
  if (s[i] === "\\") {
    const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
    if (m) return [m[0], i + m[0].length];
  }
  return [s[i] ?? "", i + 1];
}

function roman(text: string): string {
  return text ? `\\mathrm{${text}}` : "";
}

/** Output of a unit: its TeX and whether it attaches to the number with no space. */
export function formatUnit(src: string, perMode = "power"): { tex: string; attached: boolean } {
  const s = declaredUnits(src.trim());
  if (/^\\[A-Za-z]+$/.test(s) && Object.hasOwn(ATTACHED, s.slice(1))) return { tex: ATTACHED[s.slice(1)]!, attached: true };
  if (!s.includes("\\")) return { tex: literalUnit(s), attached: false };
  const parts: UnitPart[] = [];
  let prefix = "";
  let pre: number | string | undefined;
  let per = false;
  let literal = "";
  const flush = () => {
    if (literal.trim()) {
      parts.push({ text: literalUnit(literal.trim()), power: 1, per: false });
    }
    literal = "";
  };
  for (let i = 0; i < s.length; ) {
    const m = /^\\([A-Za-z]+)/.exec(s.slice(i));
    if (!m) {
      literal += s[i];
      i++;
      continue;
    }
    flush();
    const name = m[1]!;
    i += m[0].length;
    if (name === "per") per = true;
    else if (name === "square") pre = 2;
    else if (name === "cubic") pre = 3;
    else if (name === "raiseto") {
      const [a, j] = readArgAt(s, i);
      pre = a;
      i = j;
    } else if (name === "squared" || name === "cubed" || name === "tothe") {
      let p: number | string = name === "squared" ? 2 : 3;
      if (name === "tothe") {
        const [a, j] = readArgAt(s, i);
        p = a;
        i = j;
      }
      const last = parts[parts.length - 1];
      if (last) last.power = p;
    } else if (name === "of") {
      const [a, j] = readArgAt(s, i);
      const last = parts[parts.length - 1];
      if (last) last.text += `_{\\mathrm{${a}}}`;
      i = j;
    } else if (name === "cancel" || name === "highlight") {
      if (name === "highlight") i = readArgAt(s, i)[1];
    } else if (Object.hasOwn(PREFIXES, name)) prefix += PREFIXES[name];
    else {
      let text: string;
      if (Object.hasOwn(UNITS, name)) text = UNITS[name]!;
      else if (name === "celsius" || name === "degreeCelsius") text = "{}^{\\circ}C";
      else if (Object.hasOwn(ATTACHED, name)) text = ATTACHED[name]!;
      else text = abbreviation(name) ?? `\\${name} `;
      parts.push({ text: unitText(prefix + text), power: pre ?? 1, per });
      prefix = "";
      pre = undefined;
      per = false;
    }
  }
  flush();
  return { tex: joinUnits(parts, perMode), attached: false };
}

/** Prefix and unit symbol in upright type; Greek and \Omega stay as commands. */
function unitText(t: string): string {
  if (t.startsWith("{}^{\\circ}")) return `{}^{\\circ}${roman(t.slice(10))}`;
  // Split into runs of letters (roman) and commands (kept).
  let out = "";
  let run = "";
  for (let i = 0; i < t.length; ) {
    const m = /^\\[A-Za-z]+ ?|^[_^]\{[^}]*\}|^[_^]./.exec(t.slice(i));
    if (m) {
      out += roman(run) + (m[0].startsWith("\\mathring") ? "" : m[0].trim());
      run = "";
      i += m[0].length;
      if (m[0].startsWith("\\mathring")) {
        out += "\\mathring{\\mathrm{A}}";
        i += 3;
      }
      continue;
    }
    run += t[i];
    i++;
  }
  return out + roman(run);
}

function powerText(p: number | string, negate: boolean): string {
  if (typeof p === "number") {
    const v = negate ? -p : p;
    return v === 1 ? "" : `^{${v}}`;
  }
  return `^{${negate ? "-" : ""}${p}}`;
}

function joinUnits(parts: UnitPart[], perMode: string): string {
  if (perMode === "symbol" || perMode === "fraction") {
    const num = parts.filter((p) => !p.per).map((p) => p.text + powerText(p.power, false));
    const den = parts.filter((p) => p.per).map((p) => p.text + powerText(p.power, false));
    if (den.length) {
      const n = num.join("\\,") || "1";
      if (perMode === "fraction") return `\\frac{${n}}{${den.join("\\,")}}`;
      return `${n}/${den.length > 1 ? `(${den.join("\\,")})` : den[0]}`;
    }
  }
  return parts.map((p) => p.text + powerText(p.power, p.per)).join("\\,");
}

/** Units written out (m/s, kg.m^2, m s^{-1}): letters upright, . and ~ as thin spaces. */
function literalUnit(s: string): string {
  let out = "";
  let run = "";
  const end = () => {
    out += roman(run);
    run = "";
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === "^" || c === "_") {
      end();
      const [a, j] = readArgAt(s, i + 1);
      out += `${c}{${a}}`;
      i = j;
    } else if (c === "." || c === "~" || c === "*" || c === " ") {
      end();
      if (!out.endsWith("\\,")) out += "\\,";
      i++;
      while (s[i] === " ") i++;
    } else if (c === "/") {
      end();
      out += "/";
      i++;
    } else if (c === "%") {
      end();
      out += "\\%";
      i++;
    } else if (c === "\\") {
      end();
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i))!;
      out += `${m[0]} `;
      i += m[0].length;
    } else {
      run += c;
      i++;
    }
  }
  end();
  return out.replace(/\\,$/, "");
}

/** siunitx key=value options; only per-mode changes the output here. */
function perModeOf(opt: string | undefined): string {
  const m = opt && /per-mode\s*=\s*([a-z-]+)/.exec(opt);
  return m ? m[1]! : "power";
}

function quantity(num: string, unit: string, opt: string | undefined): string {
  const u = formatUnit(unit, perModeOf(opt));
  return `${formatNumber(num)}${u.attached ? "" : "\\,"}${u.tex}`;
}

function listItems(src: string): string[] {
  return src
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]}\\text{ and }${items[1]}`;
  return `${items.slice(0, -1).join(",\\ ")}\\text{ and }${items[items.length - 1]}`;
}

def("num", (a) => {
  a.opt();
  return formatNumber(a.arg());
});
def("si unit", (a) => {
  const opt = a.opt();
  return `{${formatUnit(a.arg(), perModeOf(opt)).tex}}`;
});
def("SI", (a) => {
  const opt = a.opt();
  const n = a.arg();
  const before = a.opt();
  const u = a.arg();
  return `{${before ? `${formatUnit(before).tex}\\,` : ""}${quantity(n, u, opt)}}`;
});
def("ang", (a) => {
  a.opt();
  const parts = a.arg().split(";");
  const marks = ["{}^{\\circ}", "{}^{\\prime}", "{}^{\\prime\\prime}"];
  return `{${parts
    .map((p, k) => (p.trim() ? formatNumber(p) + marks[k]! : ""))
    .join("")}}`;
});
def("numrange", (a) => {
  a.opt();
  const x = a.arg();
  return `{${formatNumber(x)}\\text{ to }${formatNumber(a.arg())}}`;
});
def("SIrange qtyrange", (a) => {
  const opt = a.opt();
  const x = a.arg();
  const y = a.arg();
  const u = a.arg();
  return `{${quantity(x, u, opt)}\\text{ to }${quantity(y, u, opt)}}`;
});
def("numlist", (a) => {
  a.opt();
  return `{${joinList(listItems(a.arg()).map(formatNumber))}}`;
});
def("SIlist qtylist", (a) => {
  const opt = a.opt();
  const xs = listItems(a.arg());
  const u = a.arg();
  return `{${joinList(xs.map((x) => quantity(x, u, opt)))}}`;
});
def("tablenum", (a) => {
  a.opt();
  return formatNumber(a.arg());
});

// \qty is siunitx's quantity when two groups follow, otherwise physics' auto-sized brackets.
def("qty", (a) => {
  a.star();
  const c = a.peek();
  if (c === "(") return `\\left(${a.until("(", ")")}\\right)`;
  if (c === "[" ) {
    const body = a.until("[", "]");
    if (a.peek() === "{") {
      // siunitx \qty[options]{n}{unit}
      const n = a.arg();
      return `{${quantity(n, a.arg(), body)}}`;
    }
    return `\\left[${body}\\right]`;
  }
  if (c === "|") return `\\left|${a.until("|", "|")}\\right|`;
  const first = a.arg();
  if (a.peek() === "{") return `{${quantity(first, a.arg(), undefined)}}`;
  return `\\left\\{${first}\\right\\}`;
});

// ---------------------------------------------------------------- mhchem

const ARROWS: [string, string, string][] = [
  // source, plain, labelled (A above, B below)
  ["<=>>", "\\rightleftharpoons", "\\overset{A}{\\underset{B}{\\rightleftharpoons}}"],
  ["<<=>", "\\rightleftharpoons", "\\overset{A}{\\underset{B}{\\rightleftharpoons}}"],
  ["<-->", "\\rightleftarrows", "\\overset{A}{\\underset{B}{\\rightleftarrows}}"],
  ["<=>", "\\rightleftharpoons", "\\overset{A}{\\underset{B}{\\rightleftharpoons}}"],
  ["<->", "\\longleftrightarrow", "\\xleftrightarrow[B]{A}"],
  ["->", "\\longrightarrow", "\\xrightarrow[B]{A}"],
  ["<-", "\\longleftarrow", "\\xleftarrow[B]{A}"],
];

const STATES = /^(s|l|g|aq|sol|cr|ads|conc|dil|am|lc|v|c)$/;

/** Index of the ] that closes the [ at s[i], or -1. */
function closeBracket(s: string, i: number, open = "[", close = "]"): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "{" || c === open) depth++;
    else if (c === "}" || c === close) {
      depth--;
      if (depth === 0) return c === close ? j : -1;
    }
  }
  return -1;
}

interface CeItem {
  kind: "formula" | "op" | "arrow";
  tex: string;
}

/** \ce: formulas, charges, states, coefficients and reaction arrows. */
export function chem(src: string): string {
  const s = src.trim();
  const items: CeItem[] = [];
  let word = "";
  const flushWord = () => {
    if (word) items.push({ kind: "formula", tex: formula(word) });
    word = "";
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === "$") {
      const end = s.indexOf("$", i + 1);
      const j = end < 0 ? s.length : end + 1;
      word += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === "{") {
      const [, j] = readGroup(s, i);
      word += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i))!;
      word += m[0];
      i += m[0].length;
      continue;
    }
    if (/\s/.test(c)) {
      flushWord();
      i++;
      continue;
    }
    const arrow = ARROWS.find(([a]) => s.startsWith(a, i));
    if (arrow) {
      flushWord();
      let j = i + arrow[0].length;
      const labels: string[] = [];
      while (labels.length < 2 && s[j] === "[") {
        const close = closeBracket(s, j);
        if (close < 0) break;
        labels.push(s.slice(j + 1, close));
        j = close + 1;
      }
      if (!labels.some((l) => l.trim())) items.push({ kind: "arrow", tex: arrow[1] });
      else {
        const above = labels[0] ? chemLabel(labels[0]) : "";
        const below = labels[1] ? chemLabel(labels[1]) : "";
        items.push({ kind: "arrow", tex: arrow[2].replace("A", above).replace("B", below) });
      }
      i = j;
      continue;
    }
    if ((c === "+" || c === "=") && !word && (i + 1 >= s.length || /\s/.test(s[i + 1]!))) {
      items.push({ kind: "op", tex: c });
      i++;
      continue;
    }
    word += c;
    i++;
  }
  flushWord();
  // A lone v or ^ is a precipitate or gas arrow.
  return items
    .map((it) => {
      if (it.kind === "formula" && it.tex === "\\mathrm{v}") return "\\downarrow";
      if (it.kind === "formula" && it.tex === "{}^{}") return "\\uparrow";
      return it.tex;
    })
    .join(" ");
}

function chemLabel(src: string): string {
  const t = src.trim();
  if (/^\$.*\$$/s.test(t)) return t.slice(1, -1);
  // Words in a label are separated by real spaces.
  return t
    .split(/\s+/)
    .map((w) => (/^[a-z]{2,}[,.;:]?$/.test(w) ? `\\text{${w}}` : chem(w)))
    .join("\\ ");
}

function chargeText(c: string): string {
  // Oxidation states and other letters stay upright.
  return c.replace(/[A-Za-z]+/g, (w) => `\\mathrm{${w}}`);
}

/** One formula word: 2H2O, SO4^2-, Fe^{3+}, [Cu(NH3)4]^2+, CuSO4*5H2O, H2O(l), ^{14}_{6}C. */
function formula(w: string): string {
  let out = "";
  let run = "";
  let i = 0;
  // After a coefficient position: digits here are a count, not a subscript.
  let atStart = true;
  const end = () => {
    if (run) out += `\\mathrm{${run}}`;
    run = "";
  };
  const attachable = () => run !== "" || /[)\]}]$/.test(out);
  if (w === "v") return "\\mathrm{v}";
  if (w === "^") return "{}^{}";
  while (i < w.length) {
    const c = w[i]!;
    const rest = w.slice(i);
    if (atStart) {
      const coef = /^(\d+\/\d+|\d+(?:\.\d+)?)(?=[A-Z([a-z]|$|\\|\{)/.exec(rest) ?? (/^[a-z](?=[A-Z(])/.exec(rest) && !/^e(?=-)/.test(rest) ? /^[a-z]/.exec(rest) : null);
      if (coef) {
        const v = coef[0];
        out += /\//.test(v) ? `\\tfrac{${v.split("/")[0]}}{${v.split("/")[1]}}` : /[a-z]/.test(v) ? `${v}\\,` : v;
        i += v.length;
        atStart = false;
        continue;
      }
      if (c === "^" || c === "_") {
        // Isotope prescripts: ^{14}_{6}C
        let sup = "";
        let sub = "";
        while (w[i] === "^" || w[i] === "_") {
          const [a, j] = readArgAt(w, i + 1);
          if (w[i] === "^") sup = a;
          else sub = a;
          i = j;
        }
        out += `{}^{${sup}}_{${sub}}`;
        atStart = false;
        continue;
      }
      atStart = false;
    }
    if (c === "$") {
      end();
      const close = w.indexOf("$", i + 1);
      const j = close < 0 ? w.length : close;
      out += w.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === "\\") {
      end();
      const m = /^\\([A-Za-z]+|.)/.exec(rest)!;
      out += m[0];
      i += m[0].length;
      if (w[i] === "{") {
        const [, j] = readGroup(w, i);
        out += w.slice(i, j);
        i = j;
      } else if (/^[A-Za-z]/.test(w[i] ?? "")) out += " ";
      continue;
    }
    if (c === "{") {
      end();
      const [a, j] = readGroup(w, i);
      out += `{${a}}`;
      i = j;
      continue;
    }
    if (/[A-Z]/.test(c)) {
      const m = /^[A-Z][a-z]*/.exec(rest)!;
      run += m[0];
      i += m[0].length;
      continue;
    }
    if (/[a-z]/.test(c)) {
      const m = /^[a-z]+/.exec(rest)!;
      run += m[0];
      i += m[0].length;
      continue;
    }
    if (/\d/.test(c) && attachable()) {
      const m = /^\d+/.exec(rest)!;
      end();
      out += `_{${m[0]}}`;
      i += m[0].length;
      continue;
    }
    if (c === "(" || c === "[") {
      const close = closeBracket(w, i, c, c === "(" ? ")" : "]");
      if (close > 0) {
        const inner = w.slice(i + 1, close);
        end();
        if (c === "(" && STATES.test(inner)) out += `\\,(\\mathrm{${inner}})`;
        else out += `${c === "(" ? "(" : "["}${formula(inner)}${c === "(" ? ")" : "]"}`;
        i = close + 1;
        continue;
      }
    }
    if (c === "^") {
      end();
      let a: string;
      let j: number;
      if (w[i + 1] === "{") [a, j] = readGroup(w, i + 1);
      else {
        const m = /^(\d*[-+]|[-+]|\d+|[A-Za-z]+|.)/.exec(w.slice(i + 1));
        a = m ? m[0] : "";
        j = i + 1 + a.length;
      }
      out += `^{${chargeText(a)}}`;
      i = j;
      continue;
    }
    if (c === "_") {
      end();
      const [a, j] = readArgAt(w, i + 1);
      out += `_{${a}}`;
      i = j;
      continue;
    }
    if ((c === "+" || c === "-") && i === w.length - 1 && (attachable() || /\}$/.test(out))) {
      end();
      out += `^{${c}}`;
      i++;
      continue;
    }
    if ((c === "+" || c === "-") && /^[-+]+$/.test(rest) && attachable()) {
      // NH4++ is not real chemistry, but a trailing run of signs is a charge.
      end();
      out += `^{${rest}}`;
      i = w.length;
      continue;
    }
    if (c === "*" || c === ".") {
      end();
      out += "\\cdot ";
      i++;
      atStart = true;
      continue;
    }
    end();
    if (c === "-") out += "\\text{-}";
    else if (c === "=") out += "{=}";
    else if (c === "#") out += "{\\equiv}";
    else if (c === "~") out += "\\,";
    else if (c === "%") out += "\\%";
    else if (c === "&") out += "\\&";
    else out += c;
    i++;
  }
  end();
  return out;
}

def("ce", (a) => `{${chem(a.arg())}}`);

def("pu", (a) => {
  const s = a.arg().trim();
  const m = /^([-+]?[\d.,]+(?:\s*[eE]\s*[-+]?\d+)?)\s*(.*)$/.exec(s);
  if (!m) return `{${literalUnit(s)}}`;
  return m[2] ? `{${formatNumber(m[1]!)}\\,${literalUnit(m[2])}}` : formatNumber(m[1]!);
});

// ---------------------------------------------------------------- physics

def("abs", (a) => {
  const plain = a.star();
  const x = a.arg();
  return plain ? `\\lvert ${x}\\rvert ` : `\\left\\lvert ${x}\\right\\rvert `;
});
def("norm", (a) => {
  const plain = a.star();
  const x = a.arg();
  return plain ? `\\lVert ${x}\\rVert ` : `\\left\\lVert ${x}\\right\\rVert `;
});

/** d/dx with an optional order; one argument gives the bare operator. */
function derivative(a: Args, d: string): string {
  a.star();
  const n = a.opt();
  const f = a.arg();
  const sup = n ? `^{${n}}` : "";
  if (a.peek() !== "{") return `\\frac{${d}${sup}}{${d} ${f}${sup}}`;
  const vars = [a.arg()];
  if (d === "\\partial" && a.peek() === "{") vars.push(a.arg());
  if (vars.length === 2) return `\\frac{${d}^{2} ${f}}{${d} ${vars[0]}\\,${d} ${vars[1]}}`;
  return `\\frac{${d}${sup} ${f}}{${d} ${vars[0]}${sup}}`;
}
def("dv", (a) => derivative(a, "\\mathrm{d}"));
def("pdv", (a) => derivative(a, "\\partial"));
def("fdv", (a) => derivative(a, "\\delta"));
def("dd", (a) => {
  const n = a.opt();
  const sup = n ? `^{${n}}` : "";
  if (a.peek() === "{") return `\\mathop{}\\!\\mathrm{d}${sup}${a.arg()}`;
  if (a.peek() === "(") return `\\mathop{}\\!\\mathrm{d}${sup}\\left(${a.until("(", ")")}\\right)`;
  return `\\mathop{}\\!\\mathrm{d}${sup}`;
});
def("bra", (a) => `\\left\\langle ${a.arg()}\\right\\rvert `);
def("ket", (a) => `\\left\\lvert ${a.arg()}\\right\\rangle `);
def("braket", (a) => {
  const x = a.arg();
  if (a.peek() === "{") return `\\left\\langle ${x}\\middle\\vert ${a.arg()}\\right\\rangle `;
  // braket package style: \braket{a|b}; physics style: \braket{a} is <a|a>.
  if (/\|/.test(x)) return `\\left\\langle ${x.replace(/\|/g, "\\middle\\vert ")}\\right\\rangle `;
  return `\\left\\langle ${x}\\middle\\vert ${x}\\right\\rangle `;
});
def("ketbra dyad outerproduct", (a) => {
  const x = a.arg();
  const y = a.peek() === "{" ? a.arg() : x;
  return `\\left\\lvert ${x}\\right\\rangle\\!\\left\\langle ${y}\\right\\rvert `;
});
def("expval ev", (a) => {
  const x = a.arg();
  if (a.peek() === "{") {
    const psi = a.arg();
    return `\\left\\langle ${psi}\\middle\\vert ${x}\\middle\\vert ${psi}\\right\\rangle `;
  }
  return `\\left\\langle ${x}\\right\\rangle `;
});
def("mel matrixel", (a) => {
  const x = a.arg();
  const op = a.arg();
  const y = a.arg();
  return `\\left\\langle ${x}\\middle\\vert ${op}\\middle\\vert ${y}\\right\\rangle `;
});
def("comm commutator", (a) => {
  const x = a.arg();
  return `\\left[${x},${a.arg()}\\right]`;
});
def("acomm anticommutator pb poissonbracket", (a) => {
  const x = a.arg();
  return `\\left\\{${x},${a.arg()}\\right\\}`;
});
def("vb vectorbold", (a) => (a.star() ? `\\boldsymbol{${a.arg()}}` : `\\mathbf{${a.arg()}}`));
def("va vectorarrow", (a) => (a.star() ? `\\vec{${a.arg()}}` : `\\vec{\\mathrm{${a.arg()}}}`));
def("vu vectorunit", (a) => (a.star() ? `\\hat{\\boldsymbol{${a.arg()}}}` : `\\hat{\\mathbf{${a.arg()}}}`));
def("grad gradient", () => "\\nabla ");
def("vdot dotproduct", () => "\\mathbin{\\boldsymbol{\\cdot}}");
def("cross crossproduct cp", () => "\\mathbin{\\boldsymbol{\\times}}");
def("curl", () => "\\nabla\\times ");
def("divergence", () => "\\nabla\\cdot ");
def("laplacian", () => "\\nabla^{2}");
def("order", (a) => (a.peek() === "{" ? `\\mathcal{O}\\left(${a.arg()}\\right)` : "\\mathcal{O}"));
def("eval evaluated", (a) => {
  a.star();
  const c = a.peek();
  if (c === "(") return `\\left(${a.until("(", ")")}\\right\\rvert `;
  if (c === "[") return `\\left[${a.until("[", "]")}\\right\\rvert `;
  return `\\left.${a.arg()}\\right\\rvert `;
});
for (const [name, env] of [
  ["pmqty", "pmatrix"],
  ["Pmqty", "pmatrix"],
  ["bmqty", "bmatrix"],
  ["vmqty", "vmatrix"],
  ["Bmqty", "Bmatrix"],
] as const) {
  def(name, (a) => `\\begin{${env}}${a.arg()}\\end{${env}}`);
}
def("mqty matrixquantity", (a) => {
  a.star();
  const c = a.peek();
  if (c === "(") return `\\begin{pmatrix}${a.until("(", ")")}\\end{pmatrix}`;
  if (c === "[") return `\\begin{bmatrix}${a.until("[", "]")}\\end{bmatrix}`;
  if (c === "|") return `\\begin{vmatrix}${a.until("|", "|")}\\end{vmatrix}`;
  return `\\begin{matrix}${a.arg()}\\end{matrix}`;
});
/** Matrix entries row by row, for \imat and friends (bounded so a typo cannot ask for a million cells). */
function matrixRows(m: number, n: number, cell: (i: number, j: number) => string): string {
  const rows = Math.max(1, Math.min(m, 20));
  const cols = Math.max(1, Math.min(n, 20));
  const out: string[] = [];
  for (let i = 1; i <= rows; i++) {
    const r: string[] = [];
    for (let j = 1; j <= cols; j++) r.push(cell(i, j));
    out.push(r.join(" & "));
  }
  return out.join(" \\\\ ");
}
const size = (s: string) => Number.parseInt(s.trim(), 10) || 1;
def("imat identitymatrix", (a) => {
  const n = size(a.arg());
  return matrixRows(n, n, (i, j) => (i === j ? "1" : "0"));
});
def("zmat zeromatrix", (a) => {
  const m = size(a.arg());
  const n = a.peek() === "{" ? size(a.arg()) : m;
  return matrixRows(m, n, () => "0");
});
def("xmat xmatrix", (a) => {
  const star = a.star();
  const x = a.arg();
  const m = size(a.arg());
  const n = size(a.arg());
  // \xmat*{a}{2}{2}: a_{11} ... ; without the star a single row or column gets one index.
  return matrixRows(m, n, (i, j) => (star || (m > 1 && n > 1) ? `${x}_{${i}${j}}` : `${x}_{${m > 1 ? i : j}}`));
});
def("dmat diagonalmatrix", (a) => {
  const items = a.arg().split(",").map((x) => x.trim());
  return matrixRows(items.length, items.length, (i, j) => (i === j ? items[i - 1]! : ""));
});

def("smqty", (a) => {
  const c = a.peek();
  if (c === "(") return `\\left(\\begin{smallmatrix}${a.until("(", ")")}\\end{smallmatrix}\\right)`;
  if (c === "[") return `\\left[\\begin{smallmatrix}${a.until("[", "]")}\\end{smallmatrix}\\right]`;
  return `\\begin{smallmatrix}${a.arg()}\\end{smallmatrix}`;
});
for (const op of ["tr", "Tr", "rank", "erf", "Res"]) {
  def(op, () => `\\operatorname{${op}}`);
}

// ---------------------------------------------------------------- other small packages

/**
 * mathtools' \DeclarePairedDelimiter\abs{\lvert}{\rvert} defines \abs as
 * \twpaired{\lvert}{\rvert}, which reads the call's own arguments:
 * \abs{x} at normal size, \abs*{x} sized to fit, \abs[\big]{x} at a set size.
 */
def("twpaired", (a) => {
  const l = a.arg();
  const r = a.arg();
  if (a.star()) return `\\left${l} ${a.arg()}\\right${r} `;
  const size = a.opt()?.trim();
  const x = a.arg();
  if (size && /^\\(big|Big|bigg|Bigg)$/.test(size)) return `${size}l${l} ${x}${size}r${r} `;
  return `\\mathopen{${l}}${x}\\mathclose{${r}}`;
});

/** \twpairedx{n}{L}{R}{template}: \DeclarePairedDelimiterX's macros, with n arguments filling the template. */
def("twpairedx", (a) => {
  const n = Math.max(0, Math.min(9, Number.parseInt(a.arg(), 10) || 0));
  const l = a.arg();
  const r = a.arg();
  const template = a.arg();
  const star = a.star();
  const size = star ? undefined : a.opt()?.trim();
  const args: string[] = [];
  for (let k = 0; k < n; k++) args.push(a.arg());
  const body = template.replace(/#(\d)/g, (_, d: string) => args[Number(d) - 1] ?? "");
  if (star) return `\\left${l} ${body}\\right${r} `;
  if (size && /^\\(big|Big|bigg|Bigg)$/.test(size)) return `${size}l${l} ${body}${size}r${r} `;
  return `\\mathopen{${l}}${body}\\mathclose{${r}}`;
});

def("bm boldsymbol", (a) => `\\boldsymbol{${a.arg()}}`);
def("mathbbm mathds", (a) => `\\mathbb{${a.arg()}}`);
def("nicefrac sfrac", (a) => {
  const x = a.arg();
  return `{}^{${x}}\\!/\\!{}_{${a.arg()}}`;
});
def("celsius degreeCelsius", () => "{}^{\\circ}\\mathrm{C}");
def("ohm", () => "\\Omega ");
def("micro", () => "\\mu ");
def("unit", (a) => {
  const opt = a.opt();
  // The units package's \unit[5]{kg}: a value before the unit, where siunitx has options.
  if (opt !== undefined && /^\s*[-+]?[\d.,]+\s*$/.test(opt)) return `${opt.trim()}\\,{${formatUnit(a.arg(), "power").tex}}`;
  return `{${formatUnit(a.arg(), perModeOf(opt)).tex}}`;
});
/** units: \unitfrac[5]{m}{s} as a slanted unit fraction after the value. */
def("unitfrac", (a) => {
  const value = a.opt();
  const num = a.arg();
  const den = a.arg();
  return `${value !== undefined ? `${value.trim()}\\,` : ""}{}^{\\mathrm{${num}}}\\!/\\!{}_{\\mathrm{${den}}}`;
});
/** mathtools' \prescript{sup}{sub}{base}: scripts on the left. */
def("prescript", (a) => {
  const sup = a.arg();
  const sub = a.arg();
  return `{}^{${sup}}_{${sub}}{${a.arg()}}`;
});
/** The braket package: \Braket{a|b} with growing bars, \Set{x | x > 0} and \set{...}. */
def("Braket", (a) => `\\left\\langle ${a.arg().replace(/\|\|/g, "\\middle\\Vert ").replace(/\|/g, "\\middle\\vert ")}\\right\\rangle `);
def("Bra", (a) => `\\left\\langle ${a.arg()}\\right\\rvert `);
def("Ket", (a) => `\\left\\lvert ${a.arg()}\\right\\rangle `);
def("Set", (a) => `\\left\\{ ${a.arg().replace(/\|/, "\\;\\middle\\vert\\; ")}\\right\\} `);
def("set", (a) => `\\{ ${a.arg().replace(/\|/, "\\mid ")}\\} `);
/** esint's surface integral: the double integral with a ring over it. */
def("oiint", () => "\\mathop{\\mathrlap{\\iint}\\mkern1.5mu\\vcenter{\\hbox{$\\bigcirc$}}}\\nolimits ");
// \boldsymbol is the engine's own; the entry above only serves \bm.
PACKAGES.delete("\\boldsymbol");

// ---------------------------------------------------------------- tikz-cd

/** Splits at a separator outside braces, brackets and quotes. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\") {
      if (depth === 0 && !quoted && s.startsWith(sep, i)) {
        out.push(s.slice(start, i));
        start = i + sep.length;
        i += sep.length - 1;
        continue;
      }
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "{" || c === "[")) depth++;
    else if (!quoted && (c === "}" || c === "]")) depth--;
    else if (depth === 0 && !quoted && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

interface CdArrow {
  dr: number;
  dc: number;
  labels: { text: string; swap: boolean }[];
  style: string;
}

/** \arrow[r, "f"'] and \ar{r}{f} in a cell: the arrows, and the cell without them. */
function cellArrows(cell: string): { content: string; arrows: CdArrow[] } {
  const arrows: CdArrow[] = [];
  let content = "";
  for (let i = 0; i < cell.length; ) {
    const m = /^\\(arrow|ar)(?![A-Za-z])\s*/.exec(cell.slice(i));
    if (!m) {
      content += cell[i];
      i++;
      continue;
    }
    i += m[0].length;
    let opts = "";
    if (cell[i] === "[") {
      const close = closeBracket(cell, i);
      opts = cell.slice(i + 1, close < 0 ? cell.length : close);
      i = close < 0 ? cell.length : close + 1;
    } else if (cell[i] === "{") {
      // Old syntax: \arrow{r}{label}
      const [dir, j] = readGroup(cell, i);
      opts = dir;
      i = j;
      while (cell[i] === " ") i++;
      if (cell[i] === "{") {
        const [label, k] = readGroup(cell, i);
        opts += `, "${label}"`;
        i = k;
      }
    }
    const a: CdArrow = { dr: 0, dc: 0, labels: [], style: "" };
    for (const raw of splitTop(opts, ",")) {
      const o = raw.trim();
      if (/^[rlud]+$/.test(o)) {
        for (const ch of o) {
          if (ch === "r") a.dc++;
          else if (ch === "l") a.dc--;
          else if (ch === "d") a.dr++;
          else a.dr--;
        }
      } else if (o.startsWith('"')) {
        const end = o.indexOf('"', 1);
        const text = o.slice(1, end < 0 ? o.length : end);
        a.labels.push({ text, swap: end >= 0 && o.slice(end + 1).trimStart().startsWith("'") });
      } else if (o) a.style += ` ${o}`;
    }
    if (a.dr || a.dc) arrows.push(a);
  }
  return { content: content.trim(), arrows };
}

function sideLabels(a: CdArrow, leftIsFirst: boolean): [string, string] {
  // tikz-cd puts a label on the left of the direction of travel, or the right with '.
  let left = "";
  let right = "";
  for (const l of a.labels) {
    if (l.swap) right += l.text;
    else left += l.text;
  }
  return leftIsFirst ? [left, right] : [right, left];
}

function cdArrowTex(a: CdArrow): string {
  const st = a.style;
  const double = /Rightarrow|Leftarrow|Leftrightarrow/.test(st);
  const equal = /\bequals?\b|(^|\s)-(\s|$)|\bno head\b/.test(st);
  if (a.dr === 0) {
    const right = a.dc > 0;
    const [above, below] = sideLabels(a, right);
    if (equal) return `\\overset{${above}}{\\underset{${below}}{=\\!=}}`;
    if (/two heads/.test(st) || /dashed/.test(st)) {
      const sym = /two heads/.test(st) ? (right ? "\\twoheadrightarrow" : "\\twoheadleftarrow") : right ? "\\dashrightarrow" : "\\dashleftarrow";
      return `\\overset{${above}}{\\underset{${below}}{${sym}}}`;
    }
    const x = /hook/.test(st) ? (right ? "\\xhookrightarrow" : "\\xhookleftarrow") : /mapsto/.test(st) ? "\\xmapsto" : double ? (right ? "\\xRightarrow" : "\\xLeftarrow") : right ? "\\xrightarrow" : "\\xleftarrow";
    // tikz-cd arrows are long: pad the labels so a bare arrow spans a couple of ems.
    return `${x}[\\quad ${below}\\quad]{\\quad ${above}\\quad}`;
  }
  if (a.dc === 0) {
    const down = a.dr > 0;
    // Facing down, the left of travel is the right of the page.
    const [east, west] = sideLabels(a, down);
    const sym = equal ? "\\Vert" : double ? (down ? "\\Downarrow" : "\\Uparrow") : down ? "\\downarrow" : "\\uparrow";
    return `${west ? `\\mathllap{\\scriptstyle ${west}\\,}` : ""}\\Bigg${sym}${east ? `\\mathrlap{\\,\\scriptstyle ${east}}` : ""}`;
  }
  const sym = a.dr < 0 ? (a.dc > 0 ? "\\nearrow" : "\\nwarrow") : a.dc > 0 ? "\\searrow" : "\\swarrow";
  const [above, below] = sideLabels(a, a.dc > 0);
  return `${sym}${above ? `^{${above}}` : ""}${below ? `_{${below}}` : ""}`;
}

/**
 * A tikz-cd diagram as an array: objects in the even rows and columns, each
 * arrow drawn straight in the cell between its ends (\xrightarrow, \Big\downarrow,
 * \nearrow), labels on the sides tikz-cd would put them.
 */
export function tikzcd(body: string): string {
  const rows = splitTop(body.trim().replace(/\\\\\s*$/, ""), "\\\\").map((r) => splitTop(r, "&").map(cellArrows));
  const R = rows.length;
  const C = Math.max(1, ...rows.map((r) => r.length));
  const grid: string[][] = Array.from({ length: 2 * R - 1 }, () => Array<string>(2 * C - 1).fill(""));
  const put = (r: number, c: number, tex: string) => {
    if (r < 0 || c < 0 || r >= grid.length || c >= grid[0]!.length) return;
    grid[r]![c] = grid[r]![c] ? `${grid[r]![c]}\\;${tex}` : tex;
  };
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.content) put(2 * r, 2 * c, cell.content);
      for (const a of cell.arrows) put(2 * r + a.dr, 2 * c + a.dc, cdArrowTex(a));
    }),
  );
  const cols = "c".repeat(grid[0]!.length);
  return `\\begin{array}{${cols}}${grid.map((r) => r.join(" & ")).join(" \\\\[1ex] ")}\\end{array}`;
}

// ---------------------------------------------------------------- conventional shorthands

const GUESSES: Record<string, string> = {
  R: "\\mathbb{R}",
  N: "\\mathbb{N}",
  Z: "\\mathbb{Z}",
  Q: "\\mathbb{Q}",
  C: "\\mathbb{C}",
  E: "\\mathbb{E}",
  Var: "\\operatorname{Var}",
  Cov: "\\operatorname{Cov}",
  Corr: "\\operatorname{Corr}",
  argmax: "\\operatorname*{arg\\,max}",
  argmin: "\\operatorname*{arg\\,min}",
  Span: "\\operatorname{span}",
  supp: "\\operatorname{supp}",
  softmax: "\\operatorname{softmax}",
  KL: "\\mathrm{KL}",
  given: "\\mid ",
  sgn: "\\operatorname{sgn}",
  diag: "\\operatorname{diag}",
};
for (const [name, tex] of Object.entries(GUESSES)) {
  PACKAGES.set(`\\${name}`, { expand: () => tex, guess: tex });
}

// ---------------------------------------------------------------- algorithms in formulas

// algpseudocode's \Call{Name}{args} and \textproc, written inside $...$ in a \State line:
// the procedure name upright, as an operator name, then its arguments.
def("Call", (a) => {
  const name = a.arg();
  const args = a.arg();
  return `\\operatorname{${name}}(${args})`;
});
def("textproc", (a) => `\\operatorname{${a.arg()}}`);
