/**
 * The two function languages of pst-plot. By default \psplot takes
 * PostScript in reverse Polish notation (`x 2 exp`, `x sin 2 mul`), where
 * sin and cos work in degrees as PostScript has them; with `algebraic` it
 * takes infix (`x^2`, `sin(x)+1`), where the trigonometric functions work in
 * radians. Both are compiled once into a closure and then run for every
 * sample. Anything unknown throws RpnError, which callers turn into a
 * warning; nothing here can loop for long: every run is capped in steps.
 */

export class RpnError extends Error {}

const D = Math.PI / 180;
/** Steps one evaluation may take (procedures included). */
const MAX_STEPS = 20_000;
const MAX_STACK = 1_000;
const MAX_SRC = 4_000;

type Tok = { k: "num"; v: number } | { k: "name"; v: string } | { k: "lit"; v: string } | { k: "proc"; body: Tok[] };

function tokenize(src: string): Tok[] {
  if (src.length > MAX_SRC) throw new RpnError("function too long");
  // TeX residue: \space, \psPi, braces around the whole.
  const s = src.replace(/\\space\b/g, " ").replace(/\\ps(Pi|pi)(?![A-Za-z])/g, " Pi ").replace(/\\(?:pst|ps)?(?:Euler|psE)(?![A-Za-z])/g, " Euler ");
  const stack: Tok[][] = [[]];
  const re = /\s*(?:([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(?![A-Za-z_])|(\/[A-Za-z_][\w.]*)|([A-Za-z_][\w.]*)|(\{)|(\})|(\S))/y;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    const cur = stack[stack.length - 1];
    if (m[1] !== undefined) cur.push({ k: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) cur.push({ k: "lit", v: m[2].slice(1) });
    else if (m[3] !== undefined) cur.push({ k: "name", v: m[3] });
    else if (m[4] !== undefined) {
      if (stack.length > 40) throw new RpnError("procedures nest too deeply");
      stack.push([]);
    } else if (m[5] !== undefined) {
      if (stack.length === 1) continue;
      const body = stack.pop()!;
      stack[stack.length - 1].push({ k: "proc", body });
    } else if (m[6] !== undefined && m[6].trim()) {
      // TeX braces were handled above; other stray characters are an error.
      throw new RpnError(`cannot read "${m[6]}" in PostScript code`);
    }
    if (m[0] === "") break;
  }
  while (stack.length > 1) {
    const body = stack.pop()!;
    stack[stack.length - 1].push({ k: "proc", body });
  }
  return stack[0];
}

type Value = number | Tok[];

const OPS1: Record<string, (a: number) => number> = {
  neg: (a) => -a,
  abs: (a) => Math.abs(a),
  sqrt: (a) => Math.sqrt(a),
  sin: (a) => Math.sin(a * D),
  cos: (a) => Math.cos(a * D),
  tan: (a) => Math.tan(a * D),
  asin: (a) => Math.asin(a) / D,
  acos: (a) => Math.acos(a) / D,
  ln: (a) => Math.log(a),
  log: (a) => Math.log10(a),
  floor: (a) => Math.floor(a),
  ceiling: (a) => Math.ceil(a),
  round: (a) => Math.round(a),
  truncate: (a) => Math.trunc(a),
  cvi: (a) => Math.trunc(a),
  cvr: (a) => a,
  RadtoDeg: (a) => a / D,
  DegtoRad: (a) => a * D,
  sinh: (a) => Math.sinh(a),
  cosh: (a) => Math.cosh(a),
  tanh: (a) => Math.tanh(a),
  EXP: (a) => Math.exp(a),
  not: (a) => (a ? 0 : 1),
  // pst-math's radian functions.
  SIN: (a) => Math.sin(a),
  COS: (a) => Math.cos(a),
  TAN: (a) => Math.tan(a),
  ASIN: (a) => Math.asin(a),
  ACOS: (a) => Math.acos(a),
};

const OPS2: Record<string, (a: number, b: number) => number> = {
  add: (a, b) => a + b,
  sub: (a, b) => a - b,
  mul: (a, b) => a * b,
  div: (a, b) => a / b,
  idiv: (a, b) => Math.trunc(a / b),
  mod: (a, b) => a % b,
  exp: (a, b) => Math.pow(a, b),
  atan: (a, b) => {
    const r = Math.atan2(a, b) / D;
    return r < 0 ? r + 360 : r;
  },
  ATAN: (a, b) => Math.atan2(a, b),
  max: (a, b) => Math.max(a, b),
  min: (a, b) => Math.min(a, b),
  eq: (a, b) => (a === b ? 1 : 0),
  ne: (a, b) => (a !== b ? 1 : 0),
  gt: (a, b) => (a > b ? 1 : 0),
  lt: (a, b) => (a < b ? 1 : 0),
  ge: (a, b) => (a >= b ? 1 : 0),
  le: (a, b) => (a <= b ? 1 : 0),
  and: (a, b) => (a && b ? 1 : 0),
  or: (a, b) => (a || b ? 1 : 0),
};

const CONSTS: Record<string, number> = { Pi: Math.PI, PI: Math.PI, pi: Math.PI, Euler: Math.E, true: 1, false: 0 };

/** A compiled PostScript function: run it with the variables, get the stack back. */
export type RpnFn = (vars: Record<string, number>) => number[];

/** Compiles PostScript code. Throws RpnError for code it cannot read; unknown names are reported when run. */
export function compileRpn(src: string): RpnFn {
  const code = tokenize(src);
  return (vars) => {
    const st: Value[] = [];
    const dict = new Map<string, Value>();
    let steps = 0;
    const num = (): number => {
      const v = st.pop();
      if (v === undefined) throw new RpnError("stack underflow in PostScript code");
      if (typeof v !== "number") throw new RpnError("a procedure where a number was expected");
      return v;
    };
    const run = (toks: Tok[], depth: number): void => {
      if (depth > 40) throw new RpnError("PostScript procedures nest too deeply");
      for (const t of toks) {
        if (++steps > MAX_STEPS) throw new RpnError("PostScript code takes too many steps");
        if (st.length > MAX_STACK) throw new RpnError("PostScript stack too deep");
        if (t.k === "num") st.push(t.v);
        else if (t.k === "proc") st.push(t.body);
        else if (t.k === "lit") st.push(Number.NaN), litNames.push(t.v);
        else exec(t.v, depth);
      }
    };
    const litNames: string[] = [];
    const exec = (name: string, depth: number): void => {
      if (Object.hasOwn(vars, name)) {
        st.push(vars[name]);
        return;
      }
      if (dict.has(name)) {
        const v = dict.get(name)!;
        if (typeof v === "number") st.push(v);
        else run(v, depth + 1);
        return;
      }
      if (Object.hasOwn(OPS1, name)) {
        st.push(OPS1[name](num()));
        return;
      }
      if (Object.hasOwn(OPS2, name)) {
        const b = num();
        const a = num();
        st.push(OPS2[name](a, b));
        return;
      }
      if (Object.hasOwn(CONSTS, name)) {
        st.push(CONSTS[name]);
        return;
      }
      switch (name) {
        case "dup": {
          if (!st.length) throw new RpnError("dup on an empty stack");
          st.push(st[st.length - 1]);
          return;
        }
        case "exch": {
          if (st.length < 2) throw new RpnError("exch needs two values");
          const b = st.pop()!;
          const a = st.pop()!;
          st.push(b, a);
          return;
        }
        case "pop":
          st.pop();
          return;
        case "clear":
          st.length = 0;
          return;
        case "copy": {
          const n = Math.max(0, Math.min(st.length, Math.trunc(num())));
          st.push(...st.slice(st.length - n));
          return;
        }
        case "index": {
          const n = Math.trunc(num());
          const v = st[st.length - 1 - n];
          if (v === undefined) throw new RpnError("index past the bottom of the stack");
          st.push(v);
          return;
        }
        case "roll": {
          const j = Math.trunc(num());
          const n = Math.trunc(num());
          if (n < 0 || n > st.length) throw new RpnError("roll past the bottom of the stack");
          if (n === 0) return;
          const part = st.splice(st.length - n, n);
          const k = ((j % n) + n) % n;
          st.push(...part.slice(n - k), ...part.slice(0, n - k));
          return;
        }
        case "def": {
          const v = st.pop();
          st.pop();
          const key = litNames.pop();
          if (key === undefined || v === undefined) throw new RpnError("def needs /name and a value");
          dict.set(key, v);
          return;
        }
        case "if": {
          const p = st.pop();
          const c = num();
          if (typeof p === "number" || p === undefined) throw new RpnError("if needs a procedure");
          if (c) run(p, depth + 1);
          return;
        }
        case "ifelse": {
          const p2 = st.pop();
          const p1 = st.pop();
          const c = num();
          if (typeof p1 === "number" || typeof p2 === "number" || p1 === undefined || p2 === undefined) throw new RpnError("ifelse needs two procedures");
          run(c ? p1 : p2, depth + 1);
          return;
        }
        case "exec": {
          const p = st.pop();
          if (p !== undefined && typeof p !== "number") run(p, depth + 1);
          return;
        }
        case "rand":
          // Deterministic: the same picture always draws the same.
          st.push(1_000_000);
          return;
      }
      throw new RpnError(`unknown PostScript operator "${name}"`);
    };
    run(code, 0);
    return st.map((v) => (typeof v === "number" ? v : Number.NaN));
  };
}

// ------------------------------------------------------------ algebraic (infix)

export type AlgFn = (vars: Record<string, number>) => number;

const FN1: Record<string, (a: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  arcsin: Math.asin,
  arccos: Math.acos,
  arctan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  sgn: Math.sign,
  cot: (a) => 1 / Math.tan(a),
  sec: (a) => 1 / Math.cos(a),
  csc: (a) => 1 / Math.sin(a),
  // PostScript names work in algebraic code too; they keep degrees.
  Sin: (a) => Math.sin(a * D),
  Cos: (a) => Math.cos(a * D),
  RadtoDeg: (a) => a / D,
  DegtoRad: (a) => a * D,
};
const FN2: Record<string, (a: number, b: number) => number> = {
  atan2: Math.atan2,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  mod: (a, b) => a % b,
};
const ACONST: Record<string, number> = { Pi: Math.PI, PI: Math.PI, pi: Math.PI, E: Math.E, Euler: Math.E };

type Node = (v: Record<string, number>) => number;

/** Compiles one infix expression. Throws RpnError when it cannot be read. */
export function compileAlgebraic(src: string): AlgFn {
  if (src.length > MAX_SRC) throw new RpnError("function too long");
  const s = src
    .replace(/\\space\b/g, " ")
    .replace(/\\ps(Pi|pi)(?![A-Za-z])/g, "Pi")
    .replace(/\\(?:pi|Pi)(?![A-Za-z])/g, "Pi")
    .replace(/\\(?:left|right|cdot|times)(?![A-Za-z])/g, (m) => (m === "\\cdot" || m === "\\times" ? "*" : ""))
    .replace(/\*\*/g, "^");
  let i = 0;
  let depth = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const eat = (c: string): boolean => {
    ws();
    if (s.startsWith(c, i)) {
      i += c.length;
      return true;
    }
    return false;
  };
  const expr = (): Node => {
    if (++depth > 200) throw new RpnError("expression nests too deeply");
    let a = term();
    for (;;) {
      if (eat("+")) {
        const l = a;
        const r = term();
        a = (v) => l(v) + r(v);
      } else if (eat("-")) {
        const l = a;
        const r = term();
        a = (v) => l(v) - r(v);
      } else break;
    }
    depth--;
    return a;
  };
  const term = (): Node => {
    let a = unary();
    for (;;) {
      if (eat("*")) {
        const l = a;
        const r = unary();
        a = (v) => l(v) * r(v);
      } else if (eat("/")) {
        const l = a;
        const r = unary();
        a = (v) => l(v) / r(v);
      } else {
        // Implicit product: 2x, 2(x+1), 3sin(x).
        ws();
        const c = s[i];
        if (c !== undefined && (c === "(" || /[A-Za-z]/.test(c)) && i > 0) {
          const l = a;
          const r = unary();
          a = (v) => l(v) * r(v);
        } else break;
      }
    }
    return a;
  };
  const unary = (): Node => {
    if (eat("-")) {
      const a = unary();
      return (v) => -a(v);
    }
    if (eat("+")) return unary();
    return power();
  };
  const power = (): Node => {
    const a = primary();
    if (eat("^")) {
      const b = unary();
      return (v) => Math.pow(a(v), b(v));
    }
    return a;
  };
  const primary = (): Node => {
    ws();
    const c = s[i];
    if (c === undefined) throw new RpnError("expression ends too early");
    if (c === "(" || c === "{") {
      i++;
      const a = expr();
      if (!eat(c === "(" ? ")" : "}")) throw new RpnError(`unbalanced ${c} in ${src.trim()}`);
      return a;
    }
    const m = /^(\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i, i + 40));
    if (m) {
      i += m[0].length;
      const k = Number(m[0]);
      return () => k;
    }
    const w = /^\\?([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i, i + 40));
    if (w) {
      i += w[0].length;
      const name = w[1];
      if (Object.hasOwn(FN1, name) || Object.hasOwn(FN2, name)) {
        ws();
        if (!eat("(")) {
          // sin x: one argument without parentheses.
          if (!Object.hasOwn(FN1, name)) throw new RpnError(`${name} needs (`);
          const a = power();
          const f = FN1[name];
          return (v) => f(a(v));
        }
        const args: Node[] = [expr()];
        while (eat(",")) args.push(expr());
        if (!eat(")")) throw new RpnError(`${name}( is not closed`);
        if (Object.hasOwn(FN2, name)) {
          if (args.length !== 2) throw new RpnError(`${name} takes two arguments`);
          const f = FN2[name];
          const [a, b] = args;
          return (v) => f(a(v), b(v));
        }
        if (args.length !== 1) throw new RpnError(`${name} takes one argument`);
        const f = FN1[name];
        const [a] = args;
        return (v) => f(a(v));
      }
      if (Object.hasOwn(ACONST, name)) {
        const k = ACONST[name];
        return (v) => (Object.hasOwn(v, name) ? v[name] : k);
      }
      return (v) => {
        if (!Object.hasOwn(v, name)) throw new RpnError(`unknown name "${name}" in ${src.trim()}`);
        return v[name];
      };
    }
    throw new RpnError(`unexpected "${c}" in ${src.trim()}`);
  };
  const r = expr();
  ws();
  if (i < s.length) throw new RpnError(`cannot read "${s.slice(i, i + 12)}" in ${src.trim()}`);
  return r;
}

/** Splits algebraic code at top-level `|` (parametric x|y, 3D x|y|z). */
export function splitBar(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of src) {
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth--;
    if (c === "|" && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** A plain number from TeX text: `-3.14`, `2*Pi`, `\psPi`; undefined when it is not one. */
export function texNumber(src: string, vars: Record<string, number> = {}): number | undefined {
  const t = src.trim();
  if (!t) return undefined;
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
  try {
    const v = compileAlgebraic(t)(vars);
    return Number.isFinite(v) ? v : undefined;
  } catch {
    // PostScript code such as `Pi 2 mul`.
    try {
      const st = compileRpn(t)(vars);
      return st.length === 1 && Number.isFinite(st[0]) ? st[0] : undefined;
    } catch {
      return undefined;
    }
  }
}
