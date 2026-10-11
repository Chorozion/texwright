/**
 * pgfmath expressions, the subset pictures use: numbers with units, + - * /
 * ^, comparisons, the ternary ?: and the usual functions. Angles are in
 * degrees, as in pgfmath (sin(30) is 0.5); a postfix r reads a number as
 * radians (sin(\x r)). A number with a unit is a length in points and the
 * result says so, which is how a coordinate tells (1,2) from (1cm,2pt).
 *
 * Variables come in as a map: \x for macros, x and y for pgfplots. Anything
 * the evaluator does not know throws ExprError, which callers turn into a
 * warning.
 */

export class ExprError extends Error {}

export interface Value {
  v: number;
  /** True when a unit was involved: the value is in points. */
  dim: boolean;
}

/** Points per unit (TeX's): 1cm = 28.4528pt. em and ex are those of a 10pt font. */
export const UNITS: Record<string, number> = {
  pt: 1,
  cm: 72.27 / 2.54,
  mm: 72.27 / 25.4,
  in: 72.27,
  bp: 72.27 / 72,
  pc: 12,
  dd: 1238 / 1157,
  cc: (1238 / 1157) * 12,
  sp: 1 / 65536,
  em: 10,
  ex: 4.305,
  px: 72.27 / 96,
};

/** Lengths a picture may name (a letter page of the standard article class). */
const LENGTHS: Record<string, number> = {
  textwidth: 345,
  linewidth: 345,
  columnwidth: 345,
  textheight: 550,
  paperwidth: 614.295,
  pgflinewidth: 0.4,
  baselineskip: 12,
  parindent: 15,
};

type Fn = (args: number[]) => number;
const D = Math.PI / 180;
const FUNCS: Record<string, [number, number, Fn]> = {
  sin: [1, 1, (a) => Math.sin(a[0] * D)],
  cos: [1, 1, (a) => Math.cos(a[0] * D)],
  tan: [1, 1, (a) => Math.tan(a[0] * D)],
  sec: [1, 1, (a) => 1 / Math.cos(a[0] * D)],
  cosec: [1, 1, (a) => 1 / Math.sin(a[0] * D)],
  cot: [1, 1, (a) => 1 / Math.tan(a[0] * D)],
  asin: [1, 1, (a) => Math.asin(a[0]) / D],
  acos: [1, 1, (a) => Math.acos(a[0]) / D],
  atan: [1, 1, (a) => Math.atan(a[0]) / D],
  atan2: [2, 2, (a) => Math.atan2(a[0], a[1]) / D],
  sinh: [1, 1, (a) => Math.sinh(a[0])],
  cosh: [1, 1, (a) => Math.cosh(a[0])],
  tanh: [1, 1, (a) => Math.tanh(a[0])],
  sqrt: [1, 1, (a) => Math.sqrt(a[0])],
  exp: [1, 1, (a) => Math.exp(a[0])],
  ln: [1, 1, (a) => Math.log(a[0])],
  log: [1, 1, (a) => Math.log(a[0])],
  log10: [1, 1, (a) => Math.log10(a[0])],
  log2: [1, 1, (a) => Math.log2(a[0])],
  abs: [1, 1, (a) => Math.abs(a[0])],
  min: [1, 64, (a) => Math.min(...a)],
  max: [1, 64, (a) => Math.max(...a)],
  mod: [2, 2, (a) => a[0] % a[1]],
  Mod: [2, 2, (a) => ((a[0] % a[1]) + a[1]) % a[1]],
  floor: [1, 1, (a) => Math.floor(a[0])],
  ceil: [1, 1, (a) => Math.ceil(a[0])],
  round: [1, 1, (a) => Math.round(a[0])],
  int: [1, 1, (a) => Math.trunc(a[0])],
  trunc: [1, 1, (a) => Math.trunc(a[0])],
  frac: [1, 1, (a) => a[0] - Math.trunc(a[0])],
  sign: [1, 1, (a) => Math.sign(a[0])],
  pow: [2, 2, (a) => Math.pow(a[0], a[1])],
  deg: [1, 1, (a) => a[0] / D],
  rad: [1, 1, (a) => a[0] * D],
  veclen: [2, 2, (a) => Math.hypot(a[0], a[1])],
  factorial: [1, 1, (a) => factorial(a[0])],
  iseven: [1, 1, (a) => (Math.trunc(a[0]) % 2 === 0 ? 1 : 0)],
  isodd: [1, 1, (a) => (Math.abs(Math.trunc(a[0]) % 2) === 1 ? 1 : 0)],
  divide: [2, 2, (a) => a[0] / a[1]],
  multiply: [2, 2, (a) => a[0] * a[1]],
  add: [2, 2, (a) => a[0] + a[1]],
  subtract: [2, 2, (a) => a[0] - a[1]],
  neg: [1, 1, (a) => -a[0]],
  real: [1, 1, (a) => a[0]],
};
const TRIG_IN = new Set(["sin", "cos", "tan", "sec", "cosec", "cot"]);
const TRIG_OUT = new Set(["asin", "acos", "atan", "atan2"]);
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, true: 1, false: 0 };

function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= Math.min(170, Math.trunc(n)); i++) r *= i;
  return r;
}

const MAX_LEN = 4000;

/** Evaluates `src`. `vars` maps names (without backslash for \x, as given for x) to numbers. */
export function evaluate(src: string, vars: Record<string, number> = {}, radians = false): Value {
  if (src.length > MAX_LEN) throw new ExprError("expression too long");
  const p = new P(src, vars, radians);
  const r = p.ternary();
  p.ws();
  if (p.i < p.s.length) throw new ExprError(`cannot read "${p.s.slice(p.i, p.i + 12)}" in ${src.trim()}`);
  if (!Number.isFinite(r.v)) throw new ExprError(`${src.trim()} is not a finite number`);
  return r;
}

/** A number, or undefined when the text is not an expression. */
export function num(src: string, vars?: Record<string, number>): number | undefined {
  try {
    return evaluate(src, vars).v;
  } catch {
    return undefined;
  }
}

/** A length in points: unitless values are in `unit` points each (1 for pt, 28.45 for cm). */
export function length(src: string, unit = 1, vars?: Record<string, number>): number | undefined {
  try {
    const r = evaluate(src, vars);
    return r.dim ? r.v : r.v * unit;
  } catch {
    return undefined;
  }
}

class P {
  i = 0;
  depth = 0;
  constructor(
    readonly s: string,
    readonly vars: Record<string, number>,
    readonly radians = false,
  ) {}

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  eat(tok: string): boolean {
    this.ws();
    if (this.s.startsWith(tok, this.i)) {
      this.i += tok.length;
      return true;
    }
    return false;
  }

  ternary(): Value {
    if (++this.depth > 200) throw new ExprError("expression nests too deeply");
    const c = this.or();
    if (this.eat("?")) {
      const a = this.ternary();
      if (!this.eat(":")) throw new ExprError("? without :");
      const b = this.ternary();
      this.depth--;
      return c.v ? a : b;
    }
    this.depth--;
    return c;
  }

  or(): Value {
    let a = this.and();
    while (this.eat("||")) {
      const b = this.and();
      a = { v: a.v || b.v ? 1 : 0, dim: false };
    }
    return a;
  }

  and(): Value {
    let a = this.cmp();
    while (this.eat("&&")) {
      const b = this.cmp();
      a = { v: a.v && b.v ? 1 : 0, dim: false };
    }
    return a;
  }

  cmp(): Value {
    const a = this.add();
    for (const op of ["<=", ">=", "==", "!=", "<", ">"]) {
      if (this.eat(op)) {
        const b = this.add();
        const r = op === "<=" ? a.v <= b.v : op === ">=" ? a.v >= b.v : op === "==" ? a.v === b.v : op === "!=" ? a.v !== b.v : op === "<" ? a.v < b.v : a.v > b.v;
        return { v: r ? 1 : 0, dim: false };
      }
    }
    return a;
  }

  add(): Value {
    let a = this.mul();
    for (;;) {
      if (this.eat("+")) {
        const b = this.mul();
        a = { v: a.v + b.v, dim: a.dim || b.dim };
      } else if (this.peekMinus()) {
        this.i++;
        const b = this.mul();
        a = { v: a.v - b.v, dim: a.dim || b.dim };
      } else return a;
    }
  }

  private peekMinus(): boolean {
    this.ws();
    return this.s[this.i] === "-";
  }

  mul(): Value {
    let a = this.unary();
    for (;;) {
      if (this.eat("*")) {
        const b = this.unary();
        a = { v: a.v * b.v, dim: a.dim || b.dim };
      } else if (this.eat("/")) {
        const b = this.unary();
        // 2cm/1cm is a plain number.
        a = { v: a.v / b.v, dim: a.dim !== b.dim };
      } else return a;
    }
  }

  unary(): Value {
    if (this.eat("-")) {
      const a = this.unary();
      return { v: -a.v, dim: a.dim };
    }
    if (this.eat("+")) return this.unary();
    if (this.s[this.i] === "!" && this.s[this.i + 1] !== "=") {
      this.i++;
      const a = this.unary();
      return { v: a.v ? 0 : 1, dim: false };
    }
    return this.pow();
  }

  pow(): Value {
    const a = this.postfix();
    if (this.eat("^")) {
      const b = this.unary();
      return { v: Math.pow(a.v, b.v), dim: a.dim };
    }
    return a;
  }

  postfix(): Value {
    let a = this.primary();
    for (;;) {
      const save = this.i;
      this.ws();
      // 30r: radians to degrees; `r` must stand alone.
      if (this.s[this.i] === "r" && !/[A-Za-z]/.test(this.s[this.i + 1] ?? "")) {
        this.i++;
        a = { v: a.v / D, dim: a.dim };
        continue;
      }
      if (this.s[this.i] === "!" && this.s[this.i + 1] !== "=") {
        this.i++;
        a = { v: factorial(a.v), dim: false };
        continue;
      }
      this.i = save;
      return a;
    }
  }

  primary(): Value {
    this.ws();
    const c = this.s[this.i];
    if (c === undefined) throw new ExprError("expression ends too early");
    if (c === "(" || c === "{") {
      this.i++;
      const v = this.ternary();
      if (!this.eat(c === "(" ? ")" : "}")) throw new ExprError(`unbalanced ${c}`);
      return this.unit(v);
    }
    const m = /^(\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(this.s.slice(this.i, this.i + 64));
    if (m) {
      this.i += m[0].length;
      return this.unit({ v: Number(m[0]), dim: false });
    }
    if (c === "\\") {
      const w = /^\\([A-Za-z@]+)/.exec(this.s.slice(this.i, this.i + 64));
      if (!w) throw new ExprError("stray backslash");
      this.i += w[0].length;
      const name = w[1];
      if (Object.hasOwn(this.vars, name)) return this.unit({ v: this.vars[name], dim: false });
      if (Object.hasOwn(LENGTHS, name)) return { v: LENGTHS[name], dim: true };
      if (Object.hasOwn(FUNCS, name) || Object.hasOwn(CONSTS, name)) return this.named(name);
      throw new ExprError(`unknown macro \\${name}`);
    }
    const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i, this.i + 64));
    if (w) {
      this.i += w[0].length;
      return this.named(w[0]);
    }
    throw new ExprError(`unexpected "${c}"`);
  }

  private named(name: string): Value {
    if (Object.hasOwn(FUNCS, name)) {
      const [lo, hi, f] = FUNCS[name];
      this.ws();
      const args: number[] = [];
      if (this.eat("(")) {
        if (!this.eat(")")) {
          do args.push(this.ternary().v);
          while (this.eat(","));
          if (!this.eat(")")) throw new ExprError(`${name}( is not closed`);
        }
      } else if (lo === 1) {
        // pgfmath allows sin 30 for single arguments.
        args.push(this.postfix().v);
      }
      if (args.length < lo || args.length > hi) throw new ExprError(`${name} takes ${lo === hi ? lo : `${lo} to ${hi}`} argument${hi > 1 ? "s" : ""}`);
      // trig format=rad: angles in and out of the trigonometric functions are radians.
      if (this.radians && TRIG_IN.has(name)) return { v: f([args[0] / D, ...args.slice(1)]), dim: false };
      if (this.radians && TRIG_OUT.has(name)) return { v: f(args) * D, dim: false };
      return { v: f(args), dim: false };
    }
    if (Object.hasOwn(this.vars, name)) return this.unit({ v: this.vars[name], dim: false });
    if (Object.hasOwn(CONSTS, name)) {
      // pi() is accepted too.
      if (this.s.startsWith("()", this.i)) this.i += 2;
      return { v: CONSTS[name], dim: false };
    }
    throw new ExprError(`unknown function or name "${name}"`);
  }

  /** A unit after a number: 2cm, 3 pt, 0.5\textwidth. */
  private unit(v: Value): Value {
    const save = this.i;
    this.ws();
    const m = /^(pt|cm|mm|in|bp|pc|dd|cc|sp|em|ex|px)(?![A-Za-z])/.exec(this.s.slice(this.i, this.i + 4));
    if (m && !v.dim) {
      this.i += m[0].length;
      return { v: v.v * UNITS[m[1]], dim: true };
    }
    const l = /^\\([A-Za-z]+)/.exec(this.s.slice(this.i, this.i + 32));
    if (l && Object.hasOwn(LENGTHS, l[1]) && !v.dim) {
      this.i += l[0].length;
      return { v: v.v * LENGTHS[l[1]], dim: true };
    }
    this.i = save;
    return v;
  }
}

/** A number as pgfmath prints it into a macro: integers bare, others with up to 5 decimals. */
export function fmt(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const r = Math.round(v * 1e5) / 1e5;
  return Object.is(r, -0) ? "0" : String(r);
}
