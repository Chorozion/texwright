import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pos } from "../src/ast.js";
import { Diagnostics } from "../src/diagnostics.js";
import type { Glue, Glyphs, HBox, HNode, VBox } from "../src/layout/types.js";
import type { MathOptions } from "../src/math/api.js";
import { engine, mathml, positionIn, typesetMath } from "../src/math/index.js";
import { glyphMetrics, PLAIN, SIGMA, XI } from "../src/math/metrics.js";
import { parseFormula } from "../src/math/parser.js";
import { allMappedGlyphs, famFont, MATH_SYMBOLS } from "../src/math/symbols.js";

// ---------------------------------------------------------------------------
// Helpers

interface Run {
  box: HBox;
  ok: boolean;
  diag: Diagnostics;
}

function ts(tex: string, opts: Partial<MathOptions> = {}): Run {
  const diag = opts.diagnostics ?? new Diagnostics();
  const r = typesetMath(tex, { display: false, fontSize: 10, macros: {}, diagnostics: diag, pos: { line: 1, col: 1 }, ...opts });
  return { box: r.box, ok: r.ok, diag };
}

function ml(tex: string, opts: Partial<MathOptions> = {}): { xml: string; diag: Diagnostics } {
  const diag = opts.diagnostics ?? new Diagnostics();
  const xml = mathml(tex, { display: false, macros: {}, diagnostics: diag, ...opts });
  return { xml, diag };
}

interface PGlyph {
  ch: string;
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
  node: Glyphs;
}
interface PRule {
  x: number;
  w: number;
  bottom: number;
  top: number;
}
interface Placed {
  glyphs: PGlyph[];
  rules: PRule[];
  glue: { x: number; g: Glue; y: number }[];
  boxes: { x: number; y: number; node: HBox | VBox }[];
}

/** Absolute positions (x right, y up) of everything in a box, following the box model of src/layout/types.ts. */
function place(root: HBox): Placed {
  const out: Placed = { glyphs: [], rules: [], glue: [], boxes: [] };
  const hbox = (b: HBox, x: number, y: number) => {
    out.boxes.push({ x, y, node: b });
    let cx = x;
    for (const c of b.children) cx += hnode(c, cx, y);
  };
  const vbox = (b: VBox, x: number, y: number) => {
    out.boxes.push({ x, y, node: b });
    let c = y + b.height;
    for (const k of b.children) {
      if (k.t === "kern" || k.t === "glue") c -= k.width;
      else if (k.t === "rule") {
        const h = (k.height ?? 0) + (k.depth ?? 0);
        out.rules.push({ x, w: k.width ?? b.width, top: c, bottom: c - h });
        c -= h;
      } else if (k.t === "hbox" || k.t === "vbox") {
        const base = c - k.height;
        if (k.t === "hbox") hbox(k, x + (k.shift ?? 0), base);
        else vbox(k, x + (k.shift ?? 0), base);
        c = base - k.depth;
      }
    }
  };
  const hnode = (n: HNode, x: number, y: number): number => {
    switch (n.t) {
      case "glyphs": {
        let gx = x;
        n.gids.forEach((_, i) => {
          const yo = n.yOffsets?.[i] ?? 0;
          out.glyphs.push({ ch: n.text[i]!, x: gx, y: y + yo, w: n.advances[i]!, size: n.size, font: n.font.postscriptName, node: n });
          gx += n.advances[i]!;
        });
        return n.width;
      }
      case "hbox":
        hbox(n, x, y - (n.shift ?? 0));
        return n.width;
      case "vbox":
        vbox(n, x, y - (n.shift ?? 0));
        return n.width;
      case "rule":
        out.rules.push({ x, w: n.width ?? 0, top: y + (n.height ?? 0), bottom: y - (n.depth ?? 0) });
        return n.width ?? 0;
      case "glue":
        out.glue.push({ x, g: n, y });
        return n.width;
      case "kern":
        return n.width;
      default:
        return 0;
    }
  };
  hbox(root, 0, 0);
  return out;
}

function glyph(p: Placed, ch: string, nth = 0): PGlyph {
  const all = p.glyphs.filter((g) => g.ch === ch);
  assert.ok(all[nth], `glyph ${ch} #${nth} not found in ${p.glyphs.map((g) => g.ch).join("")}`);
  return all[nth]!;
}

const near = (a: number, b: number, eps = 1e-6, msg?: string) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ""} expected ${b}, got ${a}`);

function allText(b: HBox): string {
  return place(b)
    .glyphs.map((g) => g.ch)
    .join("");
}

function errors(d: Diagnostics) {
  return d.items.filter((x) => x.severity === "error");
}

/** A small XML well-formedness checker: balanced tags, quoted attributes, valid entities, one root. */
function checkXml(s: string): void {
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  const entities = (t: string) => {
    for (const m of t.matchAll(/&([^;&\s]*)(;?)/g)) {
      assert.ok(m[2] === ";" && /^(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+)$/.test(m[1]!), `bad entity ${m[0]} in ${s.slice(0, 200)}`);
    }
  };
  while (i < s.length) {
    if (s[i] === "<") {
      const close = s.indexOf(">", i);
      assert.ok(close > i, "unterminated tag");
      const tag = s.slice(i + 1, close);
      if (tag.startsWith("/")) {
        const name = tag.slice(1);
        assert.equal(stack.pop(), name, `mismatched </${name}>`);
      } else {
        const self = tag.endsWith("/");
        const body = self ? tag.slice(0, -1) : tag;
        const m = /^([A-Za-z][\w:.-]*)((?:\s+[A-Za-z][\w:.-]*="[^"<]*")*)\s*$/.exec(body);
        assert.ok(m, `bad tag <${tag}>`);
        entities(m[2]!);
        if (!stack.length) roots++;
        if (!self) stack.push(m[1]!);
      }
      i = close + 1;
    } else {
      const next = s.indexOf("<", i);
      const text = s.slice(i, next < 0 ? s.length : next);
      assert.ok(stack.length > 0, `text outside the root: ${text}`);
      entities(text);
      i = next < 0 ? s.length : next;
    }
  }
  assert.equal(stack.length, 0, "unclosed elements");
  assert.equal(roots, 1, "exactly one root element");
}

// ---------------------------------------------------------------------------
// Corpus: real-world formulas

const CORPUS: string[] = [
  // algebra
  "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
  "(a+b)^n = \\sum_{k=0}^{n} \\binom{n}{k} a^{n-k} b^k",
  "a^2 + b^2 = c^2",
  "c^2 = a^2 + b^2 - 2ab\\cos\\gamma",
  "\\frac{a}{b} \\pm \\frac{c}{d} = \\frac{ad \\pm bc}{bd}",
  "x_{1,2} = -\\frac{p}{2} \\pm \\sqrt{\\left(\\frac{p}{2}\\right)^2 - q}",
  "\\log_b(xy) = \\log_b x + \\log_b y",
  "a^{m+n} = a^m a^n",
  "\\sqrt[n]{a^m} = a^{m/n}",
  "|x - a| < \\varepsilon \\iff a - \\varepsilon < x < a + \\varepsilon",
  "\\lfloor x \\rfloor \\le x < \\lfloor x \\rfloor + 1",
  "\\lceil \\log_2 n \\rceil",
  "\\gcd(a, b) \\cdot \\operatorname{lcm}(a, b) = |ab|",
  "a \\equiv b \\pmod{m}",
  "\\phi = \\frac{1+\\sqrt{5}}{2} = 1 + \\cfrac{1}{1 + \\cfrac{1}{1 + \\cfrac{1}{1 + \\cdots}}}",
  "F_n = \\frac{\\varphi^n - \\psi^n}{\\sqrt 5}",
  "C_n = \\frac{1}{n+1}\\binom{2n}{n}",
  "\\binom{n}{k} = \\binom{n-1}{k-1} + \\binom{n-1}{k}",
  "\\sum_{k=0}^n \\binom{n}{k} = 2^n",
  "\\prod_{i=1}^{n} (1 + x_i) \\ge 1 + \\sum_{i=1}^n x_i",
  // calculus
  "f'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}",
  "\\int_a^b f(x)\\,dx = F(b) - F(a)",
  "\\frac{d}{dx}\\left( \\int_a^x f(t)\\,dt \\right) = f(x)",
  "\\int u\\,dv = uv - \\int v\\,du",
  "\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1",
  "\\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n = e",
  "e^{i\\pi} + 1 = 0",
  "e^x = \\sum_{n=0}^{\\infty} \\frac{x^n}{n!}",
  "f(x) = \\sum_{n=0}^\\infty \\frac{f^{(n)}(a)}{n!}(x-a)^n",
  "\\sin x = x - \\frac{x^3}{3!} + \\frac{x^5}{5!} - \\cdots",
  "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}",
  "\\int_0^\\infty \\frac{\\sin x}{x}\\,dx = \\frac{\\pi}{2}",
  "\\Gamma(z) = \\int_0^\\infty t^{z-1} e^{-t}\\,dt",
  "B(x,y) = \\frac{\\Gamma(x)\\Gamma(y)}{\\Gamma(x+y)}",
  "\\zeta(s) = \\sum_{n=1}^\\infty \\frac{1}{n^s} = \\prod_{p \\text{ prime}} \\frac{1}{1 - p^{-s}}",
  "\\sum_{n=1}^\\infty \\frac{1}{n^2} = \\frac{\\pi^2}{6}",
  "n! \\sim \\sqrt{2\\pi n}\\left(\\frac{n}{e}\\right)^n",
  "\\frac{\\partial^2 u}{\\partial t^2} = c^2 \\nabla^2 u",
  "\\frac{\\partial u}{\\partial t} = \\alpha \\frac{\\partial^2 u}{\\partial x^2}",
  "\\nabla^2 \\phi = \\frac{\\partial^2 \\phi}{\\partial x^2} + \\frac{\\partial^2 \\phi}{\\partial y^2} + \\frac{\\partial^2 \\phi}{\\partial z^2} = 0",
  "\\oint_C \\mathbf{F} \\cdot d\\mathbf{r} = \\iint_S (\\nabla \\times \\mathbf{F}) \\cdot d\\mathbf{S}",
  "\\iiint_V (\\nabla \\cdot \\mathbf{F})\\,dV = \\oint_{\\partial V} \\mathbf{F} \\cdot \\mathbf{n}\\,dS",
  "\\oint_\\gamma f(z)\\,dz = 2\\pi i \\sum_k \\operatorname{Res}(f, a_k)",
  "f(a) = \\frac{1}{2\\pi i} \\oint_\\gamma \\frac{f(z)}{z - a}\\,dz",
  "\\frac{\\partial \\mathcal{L}}{\\partial q} - \\frac{d}{dt} \\frac{\\partial \\mathcal{L}}{\\partial \\dot{q}} = 0",
  "\\dot{q} = \\frac{\\partial H}{\\partial p}, \\quad \\dot{p} = -\\frac{\\partial H}{\\partial q}",
  "\\{f, g\\} = \\sum_i \\left( \\frac{\\partial f}{\\partial q_i}\\frac{\\partial g}{\\partial p_i} - \\frac{\\partial f}{\\partial p_i}\\frac{\\partial g}{\\partial q_i} \\right)",
  "J = \\begin{pmatrix} \\frac{\\partial f_1}{\\partial x_1} & \\cdots & \\frac{\\partial f_1}{\\partial x_n} \\\\ \\vdots & \\ddots & \\vdots \\\\ \\frac{\\partial f_m}{\\partial x_1} & \\cdots & \\frac{\\partial f_m}{\\partial x_n} \\end{pmatrix}",
  "H(f) = \\left[ \\frac{\\partial^2 f}{\\partial x_i \\partial x_j} \\right]_{i,j=1}^{n}",
  "\\nabla f = \\left( \\frac{\\partial f}{\\partial x}, \\frac{\\partial f}{\\partial y}, \\frac{\\partial f}{\\partial z} \\right)",
  "\\frac{dy}{dx} = \\frac{dy}{du} \\cdot \\frac{du}{dx}",
  "(fg)' = f'g + fg'",
  "\\lim_{x \\to a} \\frac{f(x)}{g(x)} = \\lim_{x \\to a} \\frac{f'(x)}{g'(x)}",
  "f(b) - f(a) = f'(\\xi)(b - a)",
  "\\forall \\varepsilon > 0\\; \\exists \\delta > 0 : |x - x_0| < \\delta \\implies |f(x) - f(x_0)| < \\varepsilon",
  "\\mathcal{L}\\{f\\}(s) = \\int_0^\\infty f(t) e^{-st}\\,dt",
  "\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x)\\, e^{-2\\pi i x \\xi}\\,dx",
  "f(x) = \\frac{a_0}{2} + \\sum_{n=1}^\\infty \\left( a_n \\cos nx + b_n \\sin nx \\right)",
  "(f * g)(t) = \\int_{-\\infty}^{\\infty} f(\\tau) g(t - \\tau)\\,d\\tau",
  "\\int_{-\\infty}^\\infty \\delta(x) f(x)\\,dx = f(0)",
  "X(z) = \\sum_{n=-\\infty}^{\\infty} x[n] z^{-n}",
  "\\int \\frac{dx}{\\sqrt{a^2 - x^2}} = \\arcsin\\frac{x}{a} + C",
  "\\int_0^{2\\pi} \\int_0^{\\pi} \\sin\\theta \\, d\\theta \\, d\\varphi = 4\\pi",
  "x^2 y'' + x y' + (x^2 - \\alpha^2) y = 0",
  "P_n(x) = \\frac{1}{2^n n!} \\frac{d^n}{dx^n} (x^2 - 1)^n",
  "Y_\\ell^m(\\theta, \\varphi) = \\sqrt{\\frac{2\\ell+1}{4\\pi}\\frac{(\\ell-m)!}{(\\ell+m)!}} P_\\ell^m(\\cos\\theta) e^{im\\varphi}",
  // physics
  "\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}",
  "\\nabla \\cdot \\mathbf{B} = 0",
  "\\nabla \\times \\mathbf{E} = -\\frac{\\partial \\mathbf{B}}{\\partial t}",
  "\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}",
  "\\begin{aligned} \\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\ \\nabla \\cdot \\mathbf{B} &= 0 \\\\ \\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\ \\nabla \\times \\mathbf{B} &= \\mu_0\\left(\\mathbf{J} + \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}\\right) \\end{aligned}",
  "i\\hbar \\frac{\\partial}{\\partial t} \\Psi(\\mathbf{r}, t) = \\left[ -\\frac{\\hbar^2}{2m} \\nabla^2 + V(\\mathbf{r}, t) \\right] \\Psi(\\mathbf{r}, t)",
  "\\hat{H} |\\psi\\rangle = E |\\psi\\rangle",
  "\\langle \\phi | \\psi \\rangle = \\int \\phi^*(x) \\psi(x)\\,dx",
  "\\sigma_x \\sigma_p \\ge \\frac{\\hbar}{2}",
  "[\\hat{x}, \\hat{p}] = i\\hbar",
  "E = mc^2",
  "E^2 = (pc)^2 + (m_0 c^2)^2",
  "\\gamma = \\frac{1}{\\sqrt{1 - v^2/c^2}}",
  "t' = \\gamma \\left( t - \\frac{vx}{c^2} \\right)",
  "G_{\\mu\\nu} + \\Lambda g_{\\mu\\nu} = \\frac{8\\pi G}{c^4} T_{\\mu\\nu}",
  "R_{\\mu\\nu} - \\frac{1}{2} R g_{\\mu\\nu} = 8\\pi G T_{\\mu\\nu}",
  "\\Gamma^\\lambda_{\\mu\\nu} = \\frac{1}{2} g^{\\lambda\\sigma}\\left(\\partial_\\mu g_{\\sigma\\nu} + \\partial_\\nu g_{\\sigma\\mu} - \\partial_\\sigma g_{\\mu\\nu}\\right)",
  "\\frac{d^2 x^\\mu}{d\\tau^2} + \\Gamma^\\mu_{\\alpha\\beta} \\frac{dx^\\alpha}{d\\tau}\\frac{dx^\\beta}{d\\tau} = 0",
  "(i\\gamma^\\mu \\partial_\\mu - m)\\psi = 0",
  "\\rho\\left(\\frac{\\partial \\mathbf{u}}{\\partial t} + \\mathbf{u} \\cdot \\nabla \\mathbf{u}\\right) = -\\nabla p + \\mu \\nabla^2 \\mathbf{u} + \\mathbf{f}",
  "\\nabla \\cdot \\mathbf{u} = 0",
  "F = G \\frac{m_1 m_2}{r^2}",
  "\\mathbf{F} = m\\mathbf{a} = m\\frac{d^2\\mathbf{r}}{dt^2}",
  "B_\\nu(T) = \\frac{2h\\nu^3}{c^2} \\frac{1}{e^{h\\nu / k_B T} - 1}",
  "S = k_B \\ln \\Omega",
  "Z = \\sum_i e^{-\\beta E_i}",
  "\\langle E \\rangle = -\\frac{\\partial \\ln Z}{\\partial \\beta}",
  "dU = T\\,dS - p\\,dV",
  "PV = nRT",
  "\\lambda = \\frac{h}{p}",
  "E_n = -\\frac{13.6\\,\\text{eV}}{n^2}",
  "\\mathbf{L} = \\mathbf{r} \\times \\mathbf{p}",
  "\\tau = I\\alpha",
  "\\omega = 2\\pi f = \\frac{2\\pi}{T}",
  "V = IR, \\quad P = IV = I^2 R",
  "\\epsilon = -\\frac{d\\Phi_B}{dt}",
  "\\frac{1}{f} = \\frac{1}{d_o} + \\frac{1}{d_i}",
  "n_1 \\sin\\theta_1 = n_2 \\sin\\theta_2",
  // probability and statistics
  "P(A \\mid B) = \\frac{P(B \\mid A)\\, P(A)}{P(B)}",
  "P(A \\cup B) = P(A) + P(B) - P(A \\cap B)",
  "f(x) = \\frac{1}{\\sigma\\sqrt{2\\pi}} e^{-\\frac{1}{2}\\left(\\frac{x - \\mu}{\\sigma}\\right)^2}",
  "\\mathbb{E}[X] = \\sum_x x\\, p(x)",
  "\\operatorname{Var}(X) = \\mathbb{E}[X^2] - (\\mathbb{E}[X])^2",
  "\\operatorname{Cov}(X, Y) = \\mathbb{E}[(X - \\mu_X)(Y - \\mu_Y)]",
  "\\rho_{X,Y} = \\frac{\\operatorname{Cov}(X,Y)}{\\sigma_X \\sigma_Y}",
  "P(X = k) = \\binom{n}{k} p^k (1-p)^{n-k}",
  "P(X = k) = \\frac{\\lambda^k e^{-\\lambda}}{k!}",
  "\\Pr\\left(|X - \\mu| \\ge k\\sigma\\right) \\le \\frac{1}{k^2}",
  "\\varphi\\left(\\mathbb{E}[X]\\right) \\le \\mathbb{E}\\left[\\varphi(X)\\right]",
  "\\sqrt{n}\\left(\\bar{X}_n - \\mu\\right) \\xrightarrow{d} \\mathcal{N}(0, \\sigma^2)",
  "H(X) = -\\sum_{i} p(x_i) \\log_2 p(x_i)",
  "D_{\\mathrm{KL}}(P \\,\\|\\, Q) = \\sum_x P(x) \\log \\frac{P(x)}{Q(x)}",
  "I(X; Y) = H(X) - H(X \\mid Y)",
  "\\hat{\\beta} = (X^\\top X)^{-1} X^\\top y",
  "\\bar{x} = \\frac{1}{n}\\sum_{i=1}^n x_i, \\quad s^2 = \\frac{1}{n-1}\\sum_{i=1}^n (x_i - \\bar{x})^2",
  "L(\\theta) = \\prod_{i=1}^n f(x_i \\mid \\theta)",
  "\\hat{\\theta}_{\\mathrm{MLE}} = \\operatorname*{arg\\,max}_\\theta \\log L(\\theta)",
  "P_{ij}^{(n)} = \\Pr(X_{n} = j \\mid X_0 = i)",
  // linear algebra
  "A = U \\Sigma V^\\top",
  "A\\mathbf{v} = \\lambda \\mathbf{v}",
  "\\det(A - \\lambda I) = 0",
  "\\det \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} = ad - bc",
  "\\begin{vmatrix} a_{11} & a_{12} & a_{13} \\\\ a_{21} & a_{22} & a_{23} \\\\ a_{31} & a_{32} & a_{33} \\end{vmatrix}",
  "\\begin{bmatrix} 1 & 0 & 0 \\\\ 0 & 1 & 0 \\\\ 0 & 0 & 1 \\end{bmatrix}",
  "R(\\theta) = \\begin{bmatrix} \\cos\\theta & -\\sin\\theta \\\\ \\sin\\theta & \\cos\\theta \\end{bmatrix}",
  "\\mathbf{x}^\\top A \\mathbf{x} > 0 \\quad \\forall \\mathbf{x} \\neq \\mathbf{0}",
  "\\operatorname{tr}(AB) = \\operatorname{tr}(BA)",
  "\\langle \\mathbf{u}, \\mathbf{v} \\rangle = \\sum_{i=1}^n u_i v_i",
  "\\|\\mathbf{x}\\|_p = \\left( \\sum_{i=1}^n |x_i|^p \\right)^{1/p}",
  "\\left\\| A \\right\\|_F = \\sqrt{\\sum_{i,j} |a_{ij}|^2}",
  "|\\langle \\mathbf{u}, \\mathbf{v} \\rangle| \\le \\|\\mathbf{u}\\| \\, \\|\\mathbf{v}\\|",
  "\\|\\mathbf{x} + \\mathbf{y}\\| \\le \\|\\mathbf{x}\\| + \\|\\mathbf{y}\\|",
  "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}^{-1} = \\frac{1}{ad - bc} \\begin{pmatrix} d & -b \\\\ -c & a \\end{pmatrix}",
  "\\left(\\begin{array}{cc|c} 1 & 2 & 3 \\\\ 4 & 5 & 6 \\end{array}\\right)",
  "\\begin{Bmatrix} x \\\\ y \\end{Bmatrix} \\begin{Vmatrix} A \\end{Vmatrix} \\begin{matrix} a & b \\\\ c & d \\end{matrix}",
  "\\left(\\begin{smallmatrix} 1 & 2 \\\\ 3 & 4 \\end{smallmatrix}\\right)",
  "\\epsilon_{ijk}\\epsilon_{imn} = \\delta_{jm}\\delta_{kn} - \\delta_{jn}\\delta_{km}",
  "T^{\\mu\\nu} = \\left(\\rho + \\frac{p}{c^2}\\right) u^\\mu u^\\nu + p\\, g^{\\mu\\nu}",
  // cases and piecewise
  "|x| = \\begin{cases} x & \\text{if } x \\ge 0 \\\\ -x & \\text{if } x < 0 \\end{cases}",
  "\\operatorname{sgn}(x) = \\begin{cases} -1 & x < 0 \\\\ 0 & x = 0 \\\\ 1 & x > 0 \\end{cases}",
  "H(x) = \\begin{cases} 0, & x < 0, \\\\ 1, & x \\ge 0. \\end{cases}",
  "f(n) = \\begin{dcases} \\frac{n}{2} & n \\text{ even} \\\\ \\frac{3n+1}{2} & n \\text{ odd} \\end{dcases}",
  "\\delta_{ij} = \\begin{cases} 1 & i = j \\\\ 0 & i \\neq j \\end{cases}",
  // machine learning
  "\\sigma(z) = \\frac{1}{1 + e^{-z}}",
  "\\operatorname{softmax}(z)_i = \\frac{e^{z_i}}{\\sum_{j=1}^K e^{z_j}}",
  "\\mathcal{L} = -\\frac{1}{N}\\sum_{i=1}^N \\left[ y_i \\log \\hat{y}_i + (1 - y_i)\\log(1 - \\hat{y}_i) \\right]",
  "\\theta_{t+1} = \\theta_t - \\eta \\nabla_\\theta J(\\theta_t)",
  "m_t = \\beta_1 m_{t-1} + (1 - \\beta_1) g_t, \\quad \\hat{m}_t = \\frac{m_t}{1 - \\beta_1^t}",
  "\\operatorname{Attention}(Q, K, V) = \\operatorname{softmax}\\left( \\frac{QK^\\top}{\\sqrt{d_k}} \\right) V",
  "V^*(s) = \\max_a \\left[ R(s,a) + \\gamma \\sum_{s'} P(s' \\mid s, a) V^*(s') \\right]",
  "Q(s,a) \\leftarrow Q(s,a) + \\alpha\\left[r + \\gamma \\max_{a'} Q(s', a') - Q(s,a)\\right]",
  "\\frac{\\partial L}{\\partial w_{ij}} = \\delta_j \\, o_i",
  "\\hat{x}_{k|k} = \\hat{x}_{k|k-1} + K_k\\left(z_k - H_k \\hat{x}_{k|k-1}\\right)",
  "\\min_{w,b} \\frac{1}{2}\\|w\\|^2 \\quad \\text{s.t. } y_i(w^\\top x_i + b) \\ge 1",
  "\\mathbf{h}_t = \\tanh\\left(W_{hh}\\mathbf{h}_{t-1} + W_{xh}\\mathbf{x}_t\\right)",
  // number theory and discrete math
  "\\pi(x) \\sim \\frac{x}{\\ln x}",
  "a^{p-1} \\equiv 1 \\pmod p",
  "\\sum_{d \\mid n} \\mu(d) = [n = 1]",
  "\\varphi(n) = n \\prod_{p \\mid n} \\left(1 - \\frac{1}{p}\\right)",
  "x^n + y^n \\neq z^n \\quad (n > 2)",
  "\\frac{1}{\\pi} = \\frac{2\\sqrt{2}}{9801} \\sum_{k=0}^\\infty \\frac{(4k)!(1103+26390k)}{(k!)^4 396^{4k}}",
  "\\frac{\\pi}{2} = \\prod_{n=1}^\\infty \\frac{4n^2}{4n^2 - 1}",
  "T(n) = a\\,T\\!\\left(\\frac{n}{b}\\right) + f(n)",
  "f(n) = O(g(n)) \\iff \\exists c, n_0 : f(n) \\le c\\,g(n)\\ \\forall n \\ge n_0",
  "\\sum_{v \\in V} \\deg(v) = 2|E|",
  "\\chi(G) \\le \\Delta(G) + 1",
  "V - E + F = 2",
  "\\{ x \\in \\mathbb{R} \\mid x^2 < 2 \\}",
  "A \\subseteq B \\iff \\forall x\\,(x \\in A \\Rightarrow x \\in B)",
  "\\overline{A \\cup B} = \\overline{A} \\cap \\overline{B}",
  "\\neg(p \\land q) \\equiv \\neg p \\lor \\neg q",
  "\\mathbb{N} \\subset \\mathbb{Z} \\subset \\mathbb{Q} \\subset \\mathbb{R} \\subset \\mathbb{C}",
  "f : X \\to Y, \\quad x \\mapsto f(x)",
  "\\phi : G \\to H, \\quad \\phi(ab) = \\phi(a)\\phi(b)",
  "G / \\ker\\phi \\cong \\operatorname{im}\\phi",
  "\\mathbb{Z}/n\\mathbb{Z}",
  "|A \\times B| = |A| \\cdot |B|",
  "\\bigcup_{i=1}^\\infty A_i, \\quad \\bigcap_{i \\in I} B_i",
  "\\bigoplus_{i=1}^n V_i \\quad \\bigotimes_{j} W_j",
  "\\aleph_0 < 2^{\\aleph_0}",
  // inequalities and analysis
  "\\frac{a_1 + \\cdots + a_n}{n} \\ge \\sqrt[n]{a_1 \\cdots a_n}",
  "\\sum_{i=1}^n |x_i y_i| \\le \\left( \\sum_{i=1}^n |x_i|^p \\right)^{1/p} \\left( \\sum_{i=1}^n |y_i|^q \\right)^{1/q}",
  "ab \\le \\frac{a^p}{p} + \\frac{b^q}{q}",
  "d(Tx, Ty) \\le q\\, d(x, y)",
  "\\forall \\varepsilon > 0 \\; \\exists N : m, n \\ge N \\Rightarrow |a_m - a_n| < \\varepsilon",
  "R_n(x) = \\frac{f^{(n+1)}(\\xi)}{(n+1)!}(x-a)^{n+1}",
  "\\limsup_{n \\to \\infty} \\sqrt[n]{|a_n|} = \\frac{1}{R}",
  "\\liminf_{n\\to\\infty} a_n \\le \\limsup_{n\\to\\infty} a_n",
  "\\sup_{x \\in [0,1]} |f_n(x) - f(x)| \\to 0",
  "\\inf_{y \\in Y} \\|x - y\\|",
  "\\int_X |f|\\,d\\mu < \\infty",
  "\\|f\\|_{L^p} = \\left(\\int |f|^p \\, d\\mu\\right)^{1/p}",
  "\\int_M d\\omega = \\int_{\\partial M} \\omega",
  "\\int_M K\\,dA + \\int_{\\partial M} k_g\\,ds = 2\\pi\\chi(M)",
  // finance and misc
  "C = S_0 N(d_1) - K e^{-rT} N(d_2)",
  "d_1 = \\frac{\\ln(S_0/K) + (r + \\sigma^2/2)T}{\\sigma\\sqrt{T}}",
  "A = P\\left(1 + \\frac{r}{n}\\right)^{nt}",
  "\\mathrm{NPV} = \\sum_{t=0}^{T} \\frac{C_t}{(1+r)^t}",
  "\\frac{\\partial V}{\\partial t} + \\frac{1}{2}\\sigma^2 S^2 \\frac{\\partial^2 V}{\\partial S^2} + rS\\frac{\\partial V}{\\partial S} - rV = 0",
  // layout-heavy constructs
  "\\underbrace{1 + 1 + \\cdots + 1}_{n \\text{ times}} = n",
  "\\overbrace{x + x + \\cdots + x}^{k} = kx",
  "\\overrightarrow{AB} + \\overrightarrow{BC} = \\overrightarrow{AC}",
  "\\widehat{ABC} = 90^\\circ",
  "\\widetilde{f}(x)",
  "\\vec{F} = q(\\vec{E} + \\vec{v} \\times \\vec{B})",
  "\\stackrel{\\text{def}}{=} \\quad \\overset{?}{=} \\quad \\underset{n \\to \\infty}{\\longrightarrow}",
  "A \\xrightarrow{f} B \\xrightarrow[\\text{onto}]{g} C",
  "0 \\to A \\xrightarrow{\\alpha} B \\xrightarrow{\\beta} C \\to 0",
  "\\sum_{\\substack{1 \\le i \\le n \\\\ i \\ne j}} a_{ij}",
  "\\boxed{a^2 + b^2 = c^2}",
  "\\color{red}{x} + \\textcolor{blue}{y} = \\color{#00a000} z",
  "\\left. \\frac{\\partial f}{\\partial x} \\right|_{x = x_0}",
  "\\left\\langle \\frac{a}{b} \\middle| c \\right\\rangle",
  "\\Bigg( \\bigg( \\Big( \\big( x \\big) \\Big) \\bigg) \\Bigg)",
  "\\bigl[ a, b \\bigr) \\quad \\Bigl\\{ x \\Bigm| x > 0 \\Bigr\\}",
  "\\left\\lfloor \\frac{n}{2} \\right\\rfloor + \\left\\lceil \\frac{n}{2} \\right\\rceil = n",
  "\\not\\in \\quad \\not\\subset \\quad \\nleq \\quad \\ncong \\quad \\nmid",
  "a \\overset{\\text{(1)}}{\\le} b \\overset{\\text{(2)}}{<} c",
  "\\mathbb{R}^n, \\mathcal{O}(n \\log n), \\mathfrak{su}(2), \\mathscr{H}, \\boldsymbol{\\mu}, \\mathsf{T}, \\mathtt{x}",
  "\\alpha \\beta \\gamma \\delta \\epsilon \\zeta \\eta \\theta \\iota \\kappa \\lambda \\mu \\nu \\xi \\pi \\rho \\sigma \\tau \\upsilon \\phi \\chi \\psi \\omega",
  "\\Gamma \\Delta \\Theta \\Lambda \\Xi \\Pi \\Sigma \\Upsilon \\Phi \\Psi \\Omega",
  "\\varepsilon \\vartheta \\varpi \\varrho \\varsigma \\varphi",
  "x_1, x_2, \\ldots, x_n \\quad x_1 + x_2 + \\cdots + x_n",
  "\\begin{array}{c|c} x & f(x) \\\\ \\hline 0 & 1 \\\\ 1 & e \\end{array}",
  "\\begin{array}{|l|r|} \\hline \\text{name} & \\text{value} \\\\ \\hline a & 1 \\\\ \\hline \\end{array}",
  "\\begin{aligned} f(x) &= (x+1)^2 \\\\ &= x^2 + 2x + 1 \\end{aligned}",
  "\\begin{gathered} a = b \\\\ c = d \\end{gathered}",
  "\\begin{alignedat}{2} x &= y + z &\\quad u &= v \\\\ x' &= y' &\\quad u' &= v' \\end{alignedat}",
  "\\sqrt{1 + \\sqrt{1 + \\sqrt{1 + \\sqrt{1 + x}}}}",
  "\\sqrt[3]{\\frac{a^3 + b^3}{2}}",
  "\\frac{1}{1 + \\frac{1}{1 + \\frac{1}{1 + x}}}",
  "x^{a^{b^{c}}}",
  "{}_2F_1(a, b; c; z) = \\sum_{n=0}^\\infty \\frac{(a)_n (b)_n}{(c)_n} \\frac{z^n}{n!}",
  "\\hbar \\omega \\left(n + \\tfrac{1}{2}\\right)",
  "\\dfrac{a}{b} + \\tfrac{c}{d} + \\dbinom{n}{k} + \\tbinom{n}{k}",
  "\\phantom{x}y + \\vphantom{\\int}z + \\hphantom{w}v",
  "\\text{for all } x \\text{ in } X",
  "\\mathrm{d}s^2 = -c^2\\mathrm{d}t^2 + \\mathrm{d}x^2 + \\mathrm{d}y^2 + \\mathrm{d}z^2",
  "a \\cdot b \\times c \\div d \\pm e \\mp f \\ast g \\star h \\circ i \\bullet j",
  "a \\le b \\ge c \\ll d \\gg e \\prec f \\succ g \\preceq h \\succeq i",
  "A \\subset B \\supset C \\subseteq D \\supseteq E \\sqsubseteq F",
  "p \\to q \\leftarrow r \\leftrightarrow s \\Rightarrow t \\Leftarrow u \\Leftrightarrow v \\mapsto w",
  "x \\longrightarrow y \\Longrightarrow z \\hookrightarrow w \\rightharpoonup v",
  "\\therefore\\ a = b \\quad \\because\\ c",
  "\\angle ABC = 45^\\circ, \\quad \\triangle ABC",
  "\\infty, \\partial, \\nabla, \\forall, \\exists, \\emptyset, \\varnothing, \\hbar, \\ell, \\Re, \\Im, \\aleph",
  "\\lim_{x \\to 0^+} x \\ln x = 0",
  "\\max_{1 \\le i \\le n} |x_i| \\le \\|x\\|_2 \\le \\sqrt{n} \\max_i |x_i|",
  "\\det A = \\sum_{\\sigma \\in S_n} \\operatorname{sgn}(\\sigma) \\prod_{i=1}^n a_{i,\\sigma(i)}",
  "e^{A} = \\sum_{k=0}^\\infty \\frac{A^k}{k!}",
  "\\mathbf{a} \\times \\mathbf{b} = \\begin{vmatrix} \\mathbf{i} & \\mathbf{j} & \\mathbf{k} \\\\ a_1 & a_2 & a_3 \\\\ b_1 & b_2 & b_3 \\end{vmatrix}",
  "u(x, t) = \\frac{1}{\\sqrt{4\\pi\\alpha t}} \\int_{-\\infty}^{\\infty} e^{-\\frac{(x-y)^2}{4\\alpha t}} g(y)\\,dy",
  "\\Delta G = \\Delta H - T\\Delta S",
  "k = A e^{-E_a/(RT)}",
  "\\frac{dN}{dt} = rN\\left(1 - \\frac{N}{K}\\right)",
  "\\dot{x} = \\sigma(y - x), \\quad \\dot{y} = x(\\rho - z) - y, \\quad \\dot{z} = xy - \\beta z",
  "z_{n+1} = z_n^2 + c",
  "\\sum_{n=0}^{\\infty} \\frac{(-1)^n}{2n+1} = \\frac{\\pi}{4}",
  "\\int_0^1 x^{a-1}(1-x)^{b-1}\\,dx",
  "\\oint \\mathbf{B} \\cdot d\\boldsymbol{\\ell} = \\mu_0 I_{\\text{enc}}",
  "Q = \\int_{V} \\rho\\,dV, \\qquad \\Phi_E = \\oiint",
].filter((t) => !t.includes("\\oiint"));

// ---------------------------------------------------------------------------
// Parser

describe("math parser: every construct parses", () => {
  const constructs = [
    "a + b - c",
    "-x + (-y)",
    "\\sum_{i=1}^n i \\prod_k \\coprod_x \\int_0^1 \\iint \\iiint \\oint \\bigcup \\bigcap \\bigoplus \\bigotimes \\bigvee \\bigwedge",
    "\\lim_{x\\to0} \\limsup \\liminf \\max \\min \\sup \\inf \\det \\gcd \\Pr",
    "\\sin \\cos \\tan \\log \\ln \\exp \\arcsin \\arccos \\arctan \\sinh \\cosh \\tanh \\cot \\sec \\csc \\arg \\deg \\dim \\hom \\ker \\lg \\coth",
    "\\sum\\limits_i \\int\\nolimits_0^1 \\sum\\displaylimits_j",
    "\\frac{a}{b} \\dfrac{a}{b} \\tfrac{a}{b} \\cfrac{1}{2} \\cfrac[l]{1}{2} \\binom{n}{k} \\dbinom{n}{k} \\tbinom{n}{k}",
    "{a \\over b} {n \\choose k} {a \\atop b} {a \\above 1pt b} \\genfrac(){0pt}{1}{n}{k}",
    "\\sqrt{x} \\sqrt[3]{y} \\root 3 \\of {z}",
    "x' f'' g'^2 h_1' {x^2}^3 x^{y^z} x_i^2 x^2_i",
    "\\left( x \\right) \\left[ x \\right] \\left\\{ x \\right\\} \\left| x \\right| \\left\\| x \\right\\| \\left\\langle x \\right\\rangle \\left\\lfloor x \\right\\rfloor \\left\\lceil x \\right\\rceil \\left. x \\right/",
    "\\left( a \\middle| b \\middle\\| c \\right) \\left\\uparrow x \\right\\downarrow \\left< x \\right>",
    "\\big( \\Big[ \\bigg\\{ \\Bigg| \\bigl( \\bigr) \\Bigl[ \\Bigr] \\biggl\\{ \\biggr\\} \\Biggl\\langle \\Biggr\\rangle \\bigm| \\Bigm\\|",
    "\\hat a \\check b \\tilde c \\acute d \\grave e \\dot f \\ddot g \\breve h \\bar i \\vec j \\mathring k",
    "\\widehat{xy} \\widetilde{ab} \\overline{x} \\underline{y} \\overbrace{a+b}^{n} \\underbrace{c+d}_{m} \\overrightarrow{AB} \\overleftarrow{CD} \\overleftrightarrow{E} \\underrightarrow{F} \\underleftarrow{G}",
    "\\mathrm{a} \\mathit{b} \\mathbf{c} \\mathsf{d} \\mathtt{e} \\mathcal{F} \\mathbb{G} \\mathfrak{h} \\mathscr{I} \\boldsymbol{\\alpha} \\bm{x} \\mathnormal{y}",
    "{\\rm a} {\\bf b} {\\it c} {\\cal D} {\\sf e} {\\tt f}",
    "\\text{a b} \\textrm{c} \\textbf{d} \\textit{e} \\texttt{f} \\mbox{g} \\textsf{h} \\textnormal{i} \\emph{j} \\hbox{k}",
    "\\operatorname{rank} \\operatorname*{argmax}_x \\DeclareMathOperator{\\Ker}{Ker} \\Ker f",
    "a\\,b\\:c\\;d\\!e\\quad f\\qquad g\\enspace h\\thinspace i\\hspace{1em}j\\hspace*{2pt}k\\mkern3mu l\\kern2pt m\\mskip 3mu plus 1mu n\\medspace o\\thickspace p\\negthinspace q\\ r~s",
    "\\phantom{x} \\hphantom{y} \\vphantom{z} \\smash{w} \\smash[t]{v} \\smash[b]{u} \\mathstrut",
    "\\not= \\not\\in \\neq \\ne \\notin \\not\\equiv \\nleq \\ngeq",
    "\\stackrel{a}{=} \\overset{b}{\\to} \\underset{c}{\\sim} \\substack{a \\\\ b}",
    "\\boxed{x} \\fbox{y} \\colorbox{yellow}{z}",
    "\\color{red} x \\textcolor{blue}{y} \\color{#ff0000} z \\textcolor{#abc}{w} \\textcolor[rgb]{0,0.5,1}{v} \\textcolor[HTML]{00FF00}{u} \\color{red!50!blue} t",
    "\\tag{1} x",
    "\\tag*{A} x",
    "x \\notag",
    "x \\nonumber",
    "x \\label{eq:a}",
    "\\alpha\\beta\\gamma\\delta\\epsilon\\varepsilon\\zeta\\eta\\theta\\vartheta\\iota\\kappa\\varkappa\\lambda\\mu\\nu\\xi\\omicron\\pi\\varpi\\rho\\varrho\\sigma\\varsigma\\tau\\upsilon\\phi\\varphi\\chi\\psi\\omega\\digamma",
    "\\Gamma\\Delta\\Theta\\Lambda\\Xi\\Pi\\Sigma\\Upsilon\\Phi\\Psi\\Omega\\varGamma\\varDelta\\varTheta\\varLambda\\varXi\\varPi\\varSigma\\varUpsilon\\varPhi\\varPsi\\varOmega",
    "\\le \\ge \\equiv \\sim \\simeq \\approx \\cong \\propto \\prec \\succ \\ll \\gg \\subset \\supset \\in \\ni \\vdash \\models \\perp \\mid \\parallel \\asymp \\doteq",
    "\\leqq \\geqslant \\lesssim \\gtrapprox \\subsetneq \\supsetneqq \\nless \\ngtr \\lneqq \\vartriangleleft \\therefore \\because",
    "\\pm \\mp \\times \\div \\cdot \\ast \\star \\circ \\bullet \\cap \\cup \\uplus \\sqcap \\sqcup \\vee \\wedge \\setminus \\oplus \\otimes \\odot \\dagger \\amalg \\boxplus \\ltimes",
    "\\leftarrow \\rightarrow \\leftrightarrow \\Leftarrow \\Rightarrow \\Leftrightarrow \\longleftarrow \\longrightarrow \\Longleftrightarrow \\mapsto \\longmapsto \\hookrightarrow \\uparrow \\downarrow \\nearrow \\to \\gets \\implies \\iff \\impliedby",
    "\\xrightarrow{f} \\xleftarrow[g]{h} \\xRightarrow{a} \\xLeftarrow{b} \\xleftrightarrow{c} \\xmapsto{d} \\xhookrightarrow{e}",
    "\\ldots \\cdots \\vdots \\ddots \\dots \\dotsb \\dotsc \\dotsm \\dotsi \\dotso",
    "\\begin{matrix} a & b \\\\ c & d \\end{matrix} \\begin{pmatrix} 1 \\end{pmatrix} \\begin{bmatrix} 2 \\end{bmatrix} \\begin{Bmatrix} 3 \\end{Bmatrix} \\begin{vmatrix} 4 \\end{vmatrix} \\begin{Vmatrix} 5 \\end{Vmatrix}",
    "\\begin{smallmatrix} a & b \\\\ c & d \\end{smallmatrix}",
    "\\begin{cases} a & b \\\\ c & d \\end{cases} \\begin{dcases} a \\\\ b \\end{dcases} \\begin{rcases} a \\\\ b \\end{rcases}",
    "\\begin{array}{l|cr} a & b & c \\\\ \\hline d & e & f \\end{array} \\begin{array}[t]{@{}c@{}} x \\end{array}",
    "\\begin{aligned} a &= b \\\\ c &= d \\end{aligned} \\begin{gathered} x \\\\ y \\end{gathered} \\begin{split} a &= b \\end{split} \\begin{alignedat}{2} a &= b & c &= d \\end{alignedat}",
    "\\newcommand{\\R}{\\mathbb{R}} \\R \\renewcommand{\\R}{\\mathbb{Q}} \\R \\providecommand{\\N}{\\mathbb{N}} \\N \\def\\half{\\frac12} \\half \\let\\foo\\alpha \\foo",
    "\\mathop{\\mathrm{lcm}} \\mathbin{\\#} \\mathrel{\\sim} \\mathopen{(} \\mathclose{)} \\mathpunct{;} \\mathinner{x} \\mathord{+}",
    "\\displaystyle x \\textstyle y \\scriptstyle z \\scriptscriptstyle w",
    "\\rule{1em}{2pt} \\rule[1pt]{2pt}{3pt} \\raisebox{1em}{x}",
    "\\llap{a} \\rlap{b} \\clap{c} \\mathllap{d} \\mathrlap{e} \\mathclap{f}",
    "\\varliminf \\varlimsup \\varinjlim \\varprojlim \\injlim \\projlim",
    "a \\bmod b \\pmod n \\mod m \\pod k",
    "\\nobreak \\allowbreak \\penalty100 \\relax",
    "αβγ ∑ ∞ ≤ → ×",
  ];
  for (const tex of constructs) {
    it(tex.slice(0, 60), () => {
      for (const display of [false, true]) {
        const r = ts(tex, { display });
        if (!display && tex.includes("\\tag")) continue;
        assert.deepEqual(
          errors(r.diag).map((d) => d.message),
          [],
          tex,
        );
        assert.ok(r.ok);
      }
    });
  }

  it("parses the top-level display environments", () => {
    const envs = [
      "\\begin{equation} x \\end{equation}",
      "\\begin{equation*} x \\end{equation*}",
      "\\begin{align} a &= b \\\\ c &= d \\end{align}",
      "\\begin{align*} a &= b \\end{align*}",
      "\\begin{gather} a \\\\ b \\end{gather}",
      "\\begin{gather*} a \\end{gather*}",
      "\\begin{multline} a \\\\ b \\\\ c \\end{multline}",
      "\\begin{multline*} a \\\\ b \\end{multline*}",
      "\\begin{alignat}{2} a &= b & c &= d \\end{alignat}",
      "\\begin{alignat*}{1} a &= b \\end{alignat*}",
      "\\begin{flalign} a &= b & c &= d \\end{flalign}",
      "\\begin{flalign*} a &= b \\end{flalign*}",
      "\\begin{eqnarray} a &=& b \\\\ c &<& d \\end{eqnarray}",
      "\\begin{eqnarray*} a &=& b \\end{eqnarray*}",
      "\\begin{displaymath} x \\end{displaymath}",
    ];
    for (const tex of envs) {
      const r = ts(tex, { display: true, lineWidth: 300, tags: ["1", "2", "3"] });
      assert.deepEqual(errors(r.diag), [], tex);
      assert.equal(r.box.width, 300, tex);
    }
  });

  it("builds noads with TeX's atom classes", () => {
    const f = parseFormula("a + \\sum x = (y)", {}, false, () => {});
    const kinds = f.body.map((n) => (n.type === "sym" ? `${n.type}:${n.cls}` : n.type));
    assert.deepEqual(kinds, ["sym:ord", "sym:bin", "op", "sym:ord", "sym:rel", "sym:open", "sym:ord", "sym:close"]);
  });

  it("turns primes into superscripts, combined with a following ^", () => {
    const f = parseFormula("f''^2", {}, false, () => {});
    const n = f.body[0]!;
    assert.equal(n.type, "supsub");
    if (n.type !== "supsub") return;
    assert.deepEqual(
      n.sup?.map((s) => (s.type === "sym" ? s.sym.text : s.type)),
      ["\u2032", "\u2032", "2"],
    );
  });

  it("expands user macros with arguments", () => {
    const macros = { "\\norm": "\\left\\lVert #1 \\right\\rVert", "\\RR": "\\mathbb{R}" };
    const r = ts("\\norm{x} \\in \\RR", { macros });
    assert.deepEqual(errors(r.diag), []);
    assert.match(allText(r.box), /x/);
    assert.match(allText(r.box), /\u211d/);
  });

  it("accepts macro names without a backslash", () => {
    const r = ts("\\R^n", { macros: { R: "\\mathbb{R}" } });
    assert.deepEqual(errors(r.diag), []);
    assert.match(allText(r.box), /\u211d/);
  });

  it("keeps \\newcommand definitions for later formulas and warns about redefinitions (MATH002)", () => {
    const macros: Record<string, string> = {};
    const diag = new Diagnostics();
    ts("\\newcommand{\\vv}[1]{\\mathbf{#1}} \\vv{a}", { macros, diagnostics: diag });
    assert.equal(macros["\\vv"], "\\mathbf{#1}");
    ts("\\vv{b}", { macros, diagnostics: diag });
    assert.equal(diag.items.length, 0);
    // the same definition again is not a redefinition
    ts("\\newcommand{\\vv}[1]{\\mathbf{#1}}", { macros, diagnostics: diag });
    assert.equal(diag.items.length, 0);
    ts("\\newcommand{\\vv}[1]{\\vec{#1}}", { macros, diagnostics: diag, pos: { line: 4, col: 2 } });
    const w = diag.items.find((d) => d.code === "MATH002");
    assert.ok(w, "MATH002 reported");
    assert.equal(w!.severity, "warning");
    assert.equal(w!.line, 4);
    // \renewcommand redefines on purpose: no warning
    const d2 = new Diagnostics();
    ts("\\renewcommand{\\vv}[1]{\\hat{#1}}", { macros, diagnostics: d2 });
    assert.deepEqual(d2.items, []);
  });

  it("supports optional arguments, \\def parameters and \\DeclareMathOperator", () => {
    const macros: Record<string, string> = {};
    const r = ts("\\newcommand{\\p}[2][0]{(#1,#2)} \\p{a} \\p[b]{c} \\def\\sq#1{#1^2} \\sq{y} \\DeclareMathOperator*{\\esssup}{ess\\,sup} \\esssup_x f", { macros });
    assert.deepEqual(errors(r.diag), []);
    const text = allText(r.box);
    assert.match(text, /\(0,a\)/);
    assert.match(text, /\(b,c\)/);
    assert.match(text, /esssup/);
    // the optional default survives in the shared table for later formulas
    const r2 = ts("\\p{z}", { macros });
    assert.deepEqual(errors(r2.diag), []);
    assert.match(allText(r2.box), /\(0,z\)/);
  });

  it("chooses \\dots by context", () => {
    assert.match(allText(ts("x_1 + \\dots + x_n").box), /\u22ef/);
    assert.match(allText(ts("x_1, \\dots, x_n").box), /\u2026/);
  });
});

describe("math parser: errors", () => {
  const err = (tex: string, pos: Pos = { line: 1, col: 1 }, opts: Partial<MathOptions> = {}) => {
    const r = ts(tex, { pos, ...opts });
    const e = errors(r.diag);
    assert.ok(e.length >= 1, `expected an error for ${tex}`);
    assert.equal(e[0]!.code, "MATH001");
    assert.equal(r.ok, false);
    return e[0]!;
  };

  it("reports an undefined command at its column with a fix-it hint", () => {
    const e = err("a + \\foo", { line: 3, col: 10, file: "doc.md" });
    assert.match(e.message, /Undefined control sequence \\foo/);
    assert.equal(e.line, 3);
    assert.equal(e.col, 14);
    assert.equal(e.file, "doc.md");
    assert.match(e.hint!, /macros/);
  });

  it("suggests close spellings", () => {
    const e = err("\\alpah + \\frak{g}");
    assert.match(e.hint!, /Did you mean \\alpha/);
  });

  it("names packages the typesetter does not include", () => {
    assert.match(err("\\sout{x}").hint!, /ulem package/);
  });

  it("reports the right line and column inside multi-line math", () => {
    const e = err("a\n+ b\n  \\bad", { line: 5, col: 3 });
    assert.equal(e.line, 7);
    assert.equal(e.col, 3);
    assert.deepEqual(positionIn("ab\ncd", 4, { line: 2, col: 9 }), { line: 3, col: 2 });
  });

  it("double superscripts and subscripts", () => {
    const e = err("x^1^2");
    assert.match(e.message, /Double superscript/);
    assert.equal(e.col, 4);
    assert.match(e.hint!, /x\^\{a\^b\}/);
    assert.match(err("x_1_2").message, /Double subscript/);
    assert.match(err("x^2'").message, /Double superscript/);
  });

  it("unbalanced braces", () => {
    const e = err("\\frac{a}{b + {c}");
    assert.match(e.message, /Unclosed group/);
    assert.equal(e.col, 9);
    assert.match(e.hint!, /unbalanced/);
    const e2 = err("a + b}");
    assert.match(e2.message, /Unexpected \}/);
    assert.equal(e2.col, 6);
  });

  it("missing arguments", () => {
    assert.match(err("\\frac{a}").message, /Missing argument for \\frac/);
    assert.match(err("\\sqrt").message, /Missing argument/);
    assert.match(err("x^").message, /Missing superscript/);
    assert.match(err("x_{a}_").message, /Double subscript|Missing subscript/);
  });

  it("misplaced & and \\\\", () => {
    const e = err("a & b");
    assert.match(e.message, /Misplaced &/);
    assert.equal(e.col, 3);
    assert.match(e.hint!, /align/);
    assert.match(err("\\frac{a \\\\ b}{c}").message, /Misplaced \\\\/);
    assert.match(err("\\sqrt{a & b}").message, /Misplaced &/);
  });

  it("\\left and \\right must pair", () => {
    const e = err("x + \\left( y");
    assert.match(e.message, /\\left has no matching \\right/);
    assert.equal(e.col, 5);
    assert.match(err("x \\right)").message, /\\right without a matching \\left/);
    assert.match(err("\\left x \\right)").message, /Missing delimiter/);
  });

  it("environments", () => {
    assert.match(err("\\begin{matrix} a \\end{pmatrix}").message, /ended by \\end\{pmatrix\}/);
    assert.match(err("\\begin{foo} a \\end{foo}").message, /No such environment: foo/);
    assert.match(err("\\begin{matrix} a").message, /has no matching \\end/);
    assert.match(err("\\begin{cases} a & b & c \\end{cases}").message, /Too many columns/);
    assert.match(err("\\begin{array}{cc} a & b & c \\end{array}").message, /Too many columns/);
  });

  it("inner $ signs and \\tag in inline math", () => {
    assert.match(err("a $b$").hint!, /Remove the inner \$ signs/);
    assert.match(err("x \\tag{1}").message, /\\tag works only in display math/);
    assert.match(err("x \\tag{1} \\tag{2}", { line: 1, col: 1 }, { display: true }).message, /Multiple \\tag/);
  });

  it("limits after a non-operator", () => {
    assert.match(err("x\\limits_0").message, /must follow a math operator/);
  });

  it("unknown colors", () => {
    assert.match(err("\\color{notacolor} x").message, /Unknown color/);
  });

  it("still returns a box showing the source", () => {
    const r = ts("\\frac{a}{");
    assert.equal(r.ok, false);
    assert.ok(r.box.width > 0);
    assert.match(allText(r.box), /\\frac/);
    const { xml } = ml("\\frac{a}{");
    checkXml(xml);
    assert.match(xml, /<merror/);
  });

  it("macro bombs report MATH001 quickly", () => {
    const cases: [string, Record<string, string>][] = [
      ["\\def\\a{\\a}\\a", {}],
      ["\\def\\a#1{#1#1}\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{\\a{x}}}}}}}}}}}}}}}}}}", {}],
      ["\\x", { "\\x": "\\x\\x" }],
      ["\\y", { "\\y": "\\z".repeat(10), "\\z": "\\w".repeat(10), "\\w": "\\v".repeat(10), "\\v": "a".repeat(40) }],
      ["\\big".repeat(1) + "\\m".repeat(600), { "\\m": "x".repeat(400) }],
    ];
    for (const [tex, macros] of cases) {
      const t0 = performance.now();
      const e = err(tex, { line: 1, col: 1 }, { macros });
      assert.match(e.message, /macro expansions|expands to more than 200,000 characters|Missing delimiter/);
      assert.ok(performance.now() - t0 < 1000, "fast");
    }
    const big = err("\\m".repeat(600), { line: 1, col: 1 }, { macros: { "\\m": "x".repeat(400) } });
    assert.match(big.message, /200,000 characters/);
    assert.match(big.hint!, /defined in terms of itself/);
  });
});

// ---------------------------------------------------------------------------
// Layout

describe("math layout: Appendix G with the Computer Modern parameters", () => {
  it("places a display fraction with num1, denom1 and a rule on the axis", () => {
    const r = ts("\\frac{a}{b}", { display: true });
    const p = place(r.box);
    const a = glyph(p, "a");
    const b = glyph(p, "b");
    near(a.y, SIGMA.num1 * 10, 1e-9, "numerator shift");
    near(b.y, -SIGMA.denom1 * 10, 1e-9, "denominator shift");
    assert.equal(a.size, 10);
    assert.equal(p.rules.length, 1);
    const bar = p.rules[0]!;
    near(bar.top - bar.bottom, XI.ruleThickness * 10, 1e-9, "bar thickness");
    near((bar.top + bar.bottom) / 2, SIGMA.axisHeight * 10, 1e-9, "bar centred on the axis");
    // \nulldelimiterspace on the left
    near(bar.x, PLAIN.nullDelimiterSpace * 10, 1e-9);
  });

  it("places a text-style fraction with num2 and denom2", () => {
    const p = place(ts("\\frac{a}{b}").box);
    near(glyph(p, "a").y, SIGMA.num2 * 10, 1e-9);
    near(glyph(p, "b").y, -SIGMA.denom2 * 10, 1e-9);
    assert.equal(glyph(p, "a").size, 7);
  });

  it("separates \\atop fractions by the minimum clearance", () => {
    const p = place(ts("{a \\atop b}", { display: true }).box);
    const a = glyph(p, "a");
    const b = glyph(p, "b");
    const ma = glyphMetrics("mathI", 0x61)!;
    const mb = glyphMetrics("mathI", 0x62)!;
    const gap = a.y - ma.depth * 10 - (b.y + mb.height * 10);
    assert.ok(gap >= 7 * XI.ruleThickness * 10 - 1e-9, `clearance ${gap}`);
    assert.equal(p.rules.length, 0);
  });

  it("raises a superscript by sup1 in display style and sup2 in text style, at 70%", () => {
    const d = place(ts("x^2", { display: true }).box);
    near(glyph(d, "2").y, SIGMA.sup1 * 10, 1e-9);
    assert.equal(glyph(d, "2").size, 7);
    const t = place(ts("x^2").box);
    near(glyph(t, "2").y, SIGMA.sup2 * 10, 1e-9);
    // cramped (a denominator): sup3, relative to the base
    const c = place(ts("\\frac{1}{x^2}", { display: true }).box);
    near(glyph(c, "2").y - glyph(c, "x").y, SIGMA.sup3 * 10, 1e-9);
  });

  it("lowers a subscript by sub1, and by sub2 when there is a superscript too", () => {
    const p = place(ts("x_i").box);
    near(glyph(p, "i").y, -SIGMA.sub1 * 10, 1e-9);
    const q = place(ts("x_i^2").box);
    assert.ok(glyph(q, "i").y <= -SIGMA.sub2 * 10 + 1e-9);
    assert.equal(glyph(q, "i").size, 7);
    // scriptscript size for second-level scripts
    assert.equal(glyph(place(ts("x^{y^z}").box), "z").size, 5);
  });

  it("puts the superscript after the italic correction but tucks the subscript in", () => {
    const p = place(ts("f^2").box);
    const f = glyph(p, "f");
    const m = glyphMetrics("mathI", 0x66)!;
    assert.ok(m.italic > 0);
    near(glyph(p, "2").x, f.x + f.w + m.italic * 10, 1e-9);
    const q = place(ts("f_2").box);
    near(glyph(q, "2").x, glyph(q, "f").x + glyph(q, "f").w, 1e-9);
  });

  it("draws \\sqrt with a rule of default thickness, the clearance psi and the sign joined to the bar", () => {
    for (const display of [false, true]) {
      const p = place(ts("\\sqrt{x}", { display }).box);
      const x = glyph(p, "x");
      const bar = p.rules[0]!;
      const theta = XI.ruleThickness * 10;
      near(bar.top - bar.bottom, theta, 1e-9, "rule thickness");
      const mx = glyphMetrics("mathI", 0x78)!;
      const h = mx.height * 10;
      const dpt = mx.depth * 10;
      let psi = display ? theta + (SIGMA.xHeight * 10) / 4 : theta + theta / 4;
      // the small radical sign (Main-Regular) covers it; extra room is shared out
      const sign = glyph(p, "\u221a");
      assert.match(sign.font, /Main/);
      const ms = glyphMetrics("main", 0x221a)!;
      const ink = (ms.yMax - ms.yMin) * 10;
      const excess = ink - theta - (h + dpt + psi);
      if (excess > 0) psi += excess / 2;
      near(bar.bottom - (x.y + h), psi, 1e-9, "clearance");
      near(sign.y + ms.yMax * 10, bar.top, 1e-9, "sign top meets the rule top");
    }
  });

  it("uses a medium space around binary operators in text style and none in scripts", () => {
    const p = place(ts("a+b").box);
    const med = p.glue.filter((g) => g.y === 0);
    assert.equal(med.length, 2);
    for (const g of med) {
      near(g.g.width, (4 / 18) * 10, 1e-9);
      near(g.g.stretch, (2 / 18) * 10, 1e-9);
      near(g.g.shrink, (4 / 18) * 10, 1e-9);
    }
    const s = place(ts("x_{a+b}").box);
    assert.equal(s.glue.length, 0, "no glue in script style");
  });

  it("uses thick spaces around relations and a thin space after an operator", () => {
    const p = place(ts("a=b").box);
    assert.deepEqual(
      p.glue.map((g) => Math.round(g.g.width * 1e4) / 1e4),
      [2.7778, 2.7778],
    );
    const q = place(ts("\\sin x").box);
    near(q.glue[0]!.g.width, (3 / 18) * 10, 1e-9);
  });

  it("turns a binary operator with nothing on its left into an ordinary atom", () => {
    assert.equal(place(ts("-x").box).glue.length, 0);
    assert.equal(place(ts("a=-b").box).glue.length, 2);
    assert.equal(place(ts("(+1)").box).glue.length, 0);
  });

  it("adds break penalties after binary operators and relations in inline math", () => {
    const pens = ts("a+b=c").box.children.filter((n) => n.t === "penalty");
    assert.deepEqual(
      pens.map((n) => (n.t === "penalty" ? n.penalty : 0)),
      [700, 500],
    );
    assert.equal(ts("a+b=c", { display: true }).box.children.filter((n) => n.t === "penalty").length, 0);
  });

  it("sizes \\left( to cover a tall fraction: a Size font or an assembly, never a too-small glyph", () => {
    const cases = ["\\frac{a}{b}", "\\frac{\\frac{a}{b}}{\\frac{c}{d}}", "\\frac{\\frac{\\frac{a}{b}}{c}}{\\frac{d}{\\frac{e}{f}}}", "\\begin{matrix} 1 \\\\ 2 \\\\ 3 \\\\ 4 \\\\ 5 \\\\ 6 \\\\ 7 \\\\ 8 \\end{matrix}"];
    for (const inner of cases) {
      const p = place(ts(`\\left(${inner}\\right)`, { display: true }).box);
      const parens = p.glyphs.filter((g) => g.font.includes("Size") || g.font.includes("Main"));
      assert.ok(parens.length > 0);
      const content = place(ts(inner, { display: true }).box);
      const top = Math.max(...content.glyphs.map((g) => g.y + g.node.height));
      const bottom = Math.min(...content.glyphs.map((g) => g.y - g.node.depth));
      const a = SIGMA.axisHeight * 10;
      const delta = Math.max(top - a, a - bottom);
      const need = Math.max(2 * delta * PLAIN.delimiterFactor, 2 * delta - PLAIN.delimiterShortfall * 10);
      // the delimiter's own ink: every piece of the left parenthesis
      const left = p.glyphs.filter((g) => g.x < 1 && (g.font.includes("Size") || g.font.includes("Main")));
      const inkTop = Math.max(...left.map((g) => g.y + g.node.height));
      const inkBottom = Math.min(...left.map((g) => g.y - g.node.depth));
      assert.ok(inkTop - inkBottom >= need - 1e-6, `${inner}: delimiter ${inkTop - inkBottom} < ${need}`);
      near((inkTop + inkBottom) / 2, a, 0.05, "centred on the axis");
    }
    // a tall matrix needs the extensible pieces
    const big = place(ts("\\left(\\begin{matrix} 1 \\\\ 2 \\\\ 3 \\\\ 4 \\\\ 5 \\\\ 6 \\\\ 7 \\\\ 8 \\end{matrix}\\right)", { display: true }).box);
    assert.ok(big.glyphs.some((g) => g.font === "KaTeX_Size4-Regular" && g.node.gids.length === 1));
    assert.ok(big.glyphs.filter((g) => g.font === "KaTeX_Size4-Regular").length >= 3);
    // a small one stays the normal glyph
    const small = place(ts("\\left(x\\right)").box);
    assert.equal(glyph(small, "(").font, "KaTeX_Main-Regular");
  });

  it("sizes \\binom delimiters by delim1 and delim2", () => {
    // delim2 = 1.01em is just more than the normal parenthesis (1em): text style takes Size1
    assert.equal(glyph(place(ts("\\binom{n}{k}").box), "(").font, "KaTeX_Size1-Regular");
    // delim1 = 2.39em: display style takes Size3 (2.4em)
    assert.equal(glyph(place(ts("\\binom{n}{k}", { display: true }).box), "(").font, "KaTeX_Size3-Regular");
  });

  it("assembles tall radicals and braces from extensible pieces", () => {
    const tall = "\\begin{matrix} 1 \\\\ 2 \\\\ 3 \\\\ 4 \\\\ 5 \\\\ 6 \\\\ 7 \\\\ 8 \\\\ 9 \\end{matrix}";
    const r = place(ts(`\\sqrt{${tall}}`, { display: true }).box);
    const pieces = r.glyphs.filter((g) => g.font === "KaTeX_Size4-Regular");
    assert.ok(pieces.length >= 3, "radical built from pieces");
    const bar = r.rules[0]!;
    const top = Math.max(...pieces.map((g) => g.y + g.node.height));
    near(top, bar.top, 1e-6, "assembled sign meets the rule");
    const b = place(ts(`\\left\\{${tall}\\right.`, { display: true }).box);
    const gids = new Set(b.glyphs.filter((g) => g.font === "KaTeX_Size4-Regular").map((g) => g.node.gids[0]));
    const font = famFont("size4");
    for (const cp of [0x23a7, 0x23a8, 0x23a9, 0x23aa]) assert.ok(gids.has(font.glyphForCodePoint(cp)), `piece U+${cp.toString(16)}`);
  });

  it("picks \\big sizes from the Size1-Size4 fonts", () => {
    const p = place(ts("\\big( \\Big( \\bigg( \\Bigg(").box);
    assert.deepEqual(
      p.glyphs.map((g) => g.font),
      ["KaTeX_Size1-Regular", "KaTeX_Size2-Regular", "KaTeX_Size3-Regular", "KaTeX_Size4-Regular"],
    );
  });

  it("puts limits above and below big operators in display style and beside them inline", () => {
    const d = place(ts("\\sum_{i=1}^{n} x", { display: true }).box);
    const sum = glyph(d, "\u2211");
    assert.match(sum.font, /Size2/);
    const i = glyph(d, "i");
    const n = glyph(d, "n");
    assert.ok(i.y < sum.y - sum.node.depth, "lower limit below");
    assert.ok(n.y > sum.y + sum.node.height, "upper limit above");
    const sumCenter = sum.x + sum.w / 2;
    near(n.x + n.w / 2, sumCenter, 0.5, "upper limit centred");
    const t = place(ts("\\sum_{i=1}^{n} x").box);
    const ts1 = glyph(t, "\u2211");
    assert.match(ts1.font, /Size1/);
    assert.ok(glyph(t, "i").x >= ts1.x + ts1.w - 0.5, "subscript to the right inline");
    // \limits forces limits inline; integrals keep scripts beside in display style
    const l = place(ts("\\sum\\limits_{i}").box);
    assert.ok(glyph(l, "i").y < glyph(l, "\u2211").y - glyph(l, "\u2211").node.depth);
    const int = place(ts("\\int_0^1", { display: true }).box);
    assert.ok(glyph(int, "0").x > glyph(int, "\u222b").x + glyph(int, "\u222b").w * 0.5);
    // the spacing of the limits follows big_op_spacing
    const v = d.boxes.find((b) => b.node.t === "vbox")!;
    const top = v.node.height + v.y;
    const nTop = n.y + n.node.height;
    assert.ok(top - nTop >= XI.bigOpSpacing5 * 10 - 1e-9);
  });

  it("aligns matrix columns and spaces rows by struts", () => {
    const p = place(ts("\\begin{matrix} 1 & 222 \\\\ 33 & 4 \\end{matrix}").box);
    const one = glyph(p, "1");
    const threes = p.glyphs.filter((g) => g.ch === "3");
    const c1 = one.x + one.w / 2;
    const c33 = (threes[0]!.x + threes[1]!.x + threes[1]!.w) / 2;
    near(c1, c33, 1e-6, "column 1 centred");
    near(one.y - threes[0]!.y, (PLAIN.strutHeight + PLAIN.strutDepth) * 10, 1e-9, "rows 12pt apart");
    const two = glyph(p, "2");
    near(two.x - (threes[1]!.x + threes[1]!.w), 2 * PLAIN.arrayColSep * 10, 1e-6, "2\\arraycolsep between columns");
  });

  it("centres matrices on the axis", () => {
    const r = ts("\\begin{matrix} a \\\\ b \\\\ c \\end{matrix}");
    near((r.box.height - r.box.depth) / 2, SIGMA.axisHeight * 10, 1e-9);
  });

  it("sets align rows with per-row tags at the right margin and the relations aligned", () => {
    const r = ts("\\begin{align} a &= b + c \\\\ dd &= e \\nonumber \\\\ f &= g \\end{align}", { display: true, lineWidth: 300, tags: ["1", null, "2"] });
    assert.deepEqual(errors(r.diag), []);
    assert.equal(r.box.width, 300);
    const p = place(r.box);
    const eqs = p.glyphs.filter((g) => g.ch === "=");
    assert.equal(eqs.length, 3);
    near(eqs[0]!.x, eqs[1]!.x, 1e-9);
    near(eqs[1]!.x, eqs[2]!.x, 1e-9);
    const closes = p.glyphs.filter((g) => g.ch === ")");
    assert.equal(closes.length, 2, "two tags");
    for (const c of closes) near(c.x + c.w, 300, 1e-6, "tag at the right margin");
    assert.equal(glyph(p, "1").y, eqs[0]!.y);
    assert.equal(glyph(p, "2").y, eqs[2]!.y);
    assert.match(allText(r.box), /\(1\).*\(2\)/);
  });

  it("uses explicit \\tag and \\tag* over the caller's numbers", () => {
    const r = ts("x \\tag{A}", { display: true, lineWidth: 200, tags: "5" });
    assert.match(allText(r.box), /\(A\)/);
    assert.doesNotMatch(allText(r.box), /5/);
    const s = ts("x \\tag*{B}", { display: true, lineWidth: 200 });
    assert.match(allText(s.box), /xB$/);
  });

  it("centres a display and puts the tag at the margin, or below when it does not fit", () => {
    const r = ts("x = 1", { display: true, lineWidth: 300, tags: "1" });
    const p = place(r.box);
    const x = glyph(p, "x");
    const one = p.glyphs.filter((g) => g.ch === "1");
    const formulaW = place(ts("x = 1", { display: true }).box).glyphs.reduce((s, g) => s + g.w, 0) + 2 * (5 / 18) * 10;
    near(x.x, (300 - formulaW) / 2, 0.01, "centred");
    const tagClose = glyph(p, ")");
    near(tagClose.x + tagClose.w, 300, 1e-6);
    assert.equal(one[1]!.y, 0, "tag on the formula's baseline");
    // too wide: the tag goes on its own line below
    const w = ts("a+b+c+d+e+f+g+h+i+j+k", { display: true, lineWidth: 80, tags: "12" });
    const q = place(w.box);
    const close = glyph(q, ")");
    assert.ok(close.y < glyph(q, "a").y - 5, "tag below");
    near(close.x + close.w, 80, 1e-6);
  });

  it("puts multline's number on the last line", () => {
    const r = ts("\\begin{multline} a + b \\\\ + c \\\\ + d \\end{multline}", { display: true, lineWidth: 300, tags: "4" });
    const p = place(r.box);
    assert.equal(glyph(p, "4").y, glyph(p, "d").y);
    near(glyph(p, "a").x, PLAIN.multlineGap * 10, 1e-9, "first line indented by \\multlinegap");
  });

  it("splits top-level \\\\ in display math into centred rows", () => {
    const r = ts("a = b \\\\ c = dd", { display: true, lineWidth: 200, tags: ["1", "2"] });
    const p = place(r.box);
    assert.ok(glyph(p, "c").y < glyph(p, "a").y);
    assert.equal(p.glyphs.filter((g) => g.ch === ")").length, 2);
  });

  it("emits searchable text in glyph runs", () => {
    assert.equal(allText(ts("E=mc^2").box), "E=mc2");
    // words are separated by glue, not by space glyphs
    assert.equal(allText(ts("\\text{if } x").box), "ifx");
    assert.equal(allText(ts("\\alpha\\le\\beta").box), "\u03b1\u2264\u03b2");
    assert.match(allText(ts("\\mathbb{R}").box), /\u211d/);
    // a negated relation reads as base + combining long solidus
    assert.equal(allText(ts("a \\ne b").box).normalize("NFC"), "a\u2260b");
  });

  it("colors glyphs and rules", () => {
    const p = place(ts("\\color{red}\\frac{x}{y} + \\textcolor{blue}{z}").box);
    assert.deepEqual(glyph(p, "x").node.color, [1, 0, 0]);
    assert.deepEqual(glyph(p, "z").node.color, [0, 0, 1]);
    const r = ts("\\color{red}\\frac{x}{y}").box;
    const rule = JSON.stringify(r).match(/"t":"rule"[^}]*"color":\[1,0,0\]/);
    assert.ok(rule, "fraction bar colored");
  });

  it("chooses the fonts of the math alphabets", () => {
    const fonts = (tex: string) => place(ts(tex).box).glyphs.map((g) => g.font);
    assert.deepEqual(fonts("x"), ["KaTeX_Math-Italic"]);
    // Upright text letters and digits come from the body's Latin Modern, as TeX takes them from cmr.
    assert.deepEqual(fonts("\\mathrm{x}"), ["LMRoman10-Regular"]);
    assert.deepEqual(fonts("\\mathbf{x}"), ["LMRoman10-Bold"]);
    assert.deepEqual(fonts("\\mathit{x}"), ["LMRoman10-Italic"]);
    assert.deepEqual(fonts("\\mathsf{x}"), ["KaTeX_SansSerif-Regular"]);
    assert.deepEqual(fonts("\\mathtt{x}"), ["KaTeX_Typewriter-Regular"]);
    assert.deepEqual(fonts("\\mathcal{L}"), ["KaTeX_Caligraphic-Regular"]);
    assert.deepEqual(fonts("\\mathbb{R}"), ["KaTeX_AMS-Regular"]);
    assert.deepEqual(fonts("\\mathfrak{g}"), ["KaTeX_Fraktur-Regular"]);
    assert.deepEqual(fonts("\\mathscr{F}"), ["KaTeX_Script-Regular"]);
    assert.deepEqual(fonts("\\boldsymbol{\\alpha}"), ["KaTeX_Math-BoldItalic"]);
    assert.deepEqual(fonts("\\Gamma"), ["KaTeX_Main-Regular"]);
    assert.deepEqual(fonts("\\varGamma"), ["KaTeX_Math-Italic"]);
    assert.deepEqual(fonts("1"), ["LMRoman10-Regular"]);
    assert.deepEqual(fonts("\\mathbf{\\alpha}"), ["KaTeX_Math-Italic"], "\\mathbf leaves lower-case Greek alone, as in TeX");
  });

  it("stretches extensible arrows to their labels", () => {
    const short = ts("\\xrightarrow{f}").box.width;
    const long = ts("\\xrightarrow{\\text{a long label}}").box.width;
    assert.ok(long > short + 20);
    const p = place(ts("\\xrightarrow[b]{a}").box);
    assert.ok(glyph(p, "a").y > 0 && glyph(p, "b").y < 0);
  });

  it("puts brace labels above and below", () => {
    const p = place(ts("\\overbrace{x+y}^{n} \\underbrace{u+v}_{m}", { display: true }).box);
    assert.ok(glyph(p, "n").y > glyph(p, "x").y + 5);
    assert.ok(glyph(p, "m").y < glyph(p, "u").y - 5);
  });

  it("treats {x} and \\mathrm{x} like a single character (TeX's group simplification)", () => {
    near(glyph(place(ts("{x}^2").box), "2").y, SIGMA.sup2 * 10, 1e-9);
    near(glyph(place(ts("\\mathbf{x}^2").box), "2").y, SIGMA.sup2 * 10, 1e-9);
    // a real sub-formula uses the drop rule: u = h - sup_drop
    const p = place(ts("{(x)}^2").box);
    assert.ok(glyph(p, "2").y > SIGMA.sup2 * 10);
  });

  it("puts scripts of an accented character where they would go without the accent", () => {
    const p = place(ts("\\hat{x}^2").box);
    near(glyph(p, "2").y, SIGMA.sup2 * 10, 1e-9);
    assert.ok(glyph(p, "ˆ").y > 0, "accent raised over the x");
  });

  it("drops the italic correction inside words of a text font", () => {
    const p = place(ts("\\mathrm{ff}").box);
    const [f1, f2] = p.glyphs;
    near(f2!.x, f1!.x + f1!.w, 1e-9, "no kern between the letters");
    const m = glyphMetrics("lmr", 0x66)!; // upright letters in math come from Latin Modern
    near(ts("\\mathrm{ff}").box.width, 2 * m.width * 10 + m.italic * 10, 1e-9, "correction after the word only");
  });

  it("sizes \\middle like \\left and \\right", () => {
    const p = place(ts("\\left( \\frac{a}{b} \\middle| c \\right)").box);
    const fonts = p.glyphs.filter((g) => g.ch === "(" || g.ch === "|" || g.ch === ")").map((g) => g.font);
    assert.equal(new Set(fonts).size, 1, fonts.join());
  });

  it("aligns starred matrix columns as asked", () => {
    const p = place(ts("\\begin{pmatrix*}[r] -1 & 2 \\\\ 30 & -4 \\end{pmatrix*}").box);
    const one = glyph(p, "1");
    const zero = glyph(p, "0");
    near(one.x + one.w, zero.x + zero.w, 1e-9, "right edges aligned");
  });

  it("sets \\intertext on a line of its own inside align", () => {
    const r = ts("\\begin{align} a &= b \\\\ \\intertext{so that} cc &= d \\end{align}", { display: true, lineWidth: 300, tags: ["1", "2"] });
    assert.deepEqual(errors(r.diag), []);
    const p = place(r.box);
    const s = glyph(p, "s");
    near(s.x, 0, 1e-9, "text flush left");
    assert.ok(s.y < glyph(p, "a").y && s.y > glyph(p, "d").y);
    const eqs = p.glyphs.filter((g) => g.ch === "=");
    near(eqs[0]!.x, eqs[1]!.x, 1e-9);
    assert.equal(p.glyphs.filter((g) => g.ch === ")").length, 2);
  });

  it("returns finite boxes for the whole corpus in both modes", () => {
    for (const tex of CORPUS) {
      for (const display of [false, true]) {
        const r = ts(tex, { display, lineWidth: display ? 345 : undefined });
        assert.deepEqual(
          errors(r.diag).map((e) => e.message),
          [],
          tex,
        );
        assert.ok(Number.isFinite(r.box.width) && Number.isFinite(r.box.height) && Number.isFinite(r.box.depth), tex);
        assert.ok(r.box.height + r.box.depth > 0, tex);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Symbol table coverage

describe("math symbol table", () => {
  it("every mapped glyph exists in its bundled font", () => {
    const missing: string[] = [];
    const all = allMappedGlyphs();
    assert.ok(all.length > 600, `table has ${all.length} entries`);
    for (const { name, fam, cp } of all) {
      if (famFont(fam).glyphForCodePoint(cp) === 0) missing.push(`${name} (${fam} U+${cp.toString(16)})`);
    }
    assert.deepEqual(missing, []);
  });

  it("covers the Greek alphabet and the common operators", () => {
    for (const n of ["\\alpha", "\\omega", "\\Gamma", "\\Omega", "\\sum", "\\int", "\\leq", "\\rightarrow", "\\infty", "\\partial", "\\nabla", "\\cdot", "\\times"]) {
      assert.ok(MATH_SYMBOLS.has(n), n);
    }
  });
});

// ---------------------------------------------------------------------------
// MathML

describe("math MathML", () => {
  it("is well-formed XML for the corpus, with the TeX source as annotation", () => {
    assert.ok(CORPUS.length >= 200, `corpus has ${CORPUS.length} formulas`);
    for (const tex of CORPUS) {
      for (const display of [false, true]) {
        const { xml, diag } = ml(tex, { display });
        assert.deepEqual(errors(diag), [], tex);
        checkXml(xml);
        assert.ok(xml.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML"'), tex);
        assert.match(xml, display ? /display="block"/ : /display="inline"/);
        assert.match(xml, /<semantics>/);
        assert.match(xml, /<annotation encoding="application\/x-tex">/);
        const ann = /<annotation encoding="application\/x-tex">([\s\S]*)<\/annotation>/.exec(xml)![1]!;
        assert.equal(ann.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"), tex);
      }
    }
  });

  it("uses the MathML Core elements", () => {
    const x = (tex: string, opts: Partial<MathOptions> = {}) => ml(tex, opts).xml;
    assert.match(x("\\frac{a}{b}"), /<mfrac><mi>a<\/mi><mi>b<\/mi><\/mfrac>/);
    assert.match(x("\\binom{n}{k}"), /<mfrac linethickness="0">/);
    assert.match(x("\\sqrt{x}"), /<msqrt><mi>x<\/mi><\/msqrt>/);
    assert.match(x("\\sqrt[3]{x}"), /<mroot><mi>x<\/mi><mn>3<\/mn><\/mroot>/);
    assert.match(x("x_i^2"), /<msubsup><mi>x<\/mi><mi>i<\/mi><mn>2<\/mn><\/msubsup>/);
    assert.match(x("\\sum_{i}^{n}"), /<munderover><mo largeop="true" movablelimits="true">\u2211<\/mo>/);
    assert.match(x("\\int_0^1"), /<msubsup><mo largeop="true" movablelimits="false">\u222b<\/mo>/);
    assert.match(x("\\hat{x}"), /<mover accent="true"><mi>x<\/mi><mo stretchy="false">\^<\/mo><\/mover>/);
    assert.match(x("\\left( x \\right)"), /<mo fence="true" form="prefix" stretchy="true">\(<\/mo>/);
    assert.match(x("\\begin{pmatrix} 1 & 2 \\end{pmatrix}"), /<mtable columnalign="center center">/);
    assert.match(x("\\text{if } x"), /<mtext>if\u00a0<\/mtext>/);
    assert.match(x("a\\,b"), /<mspace width="0.1667em"\/>/);
    assert.match(x("\\phantom{x}"), /<mphantom>/);
    assert.match(x("\\displaystyle x"), /<mstyle displaystyle="true" scriptlevel="0">/);
    assert.match(x("3.14"), /<mn>3.14<\/mn>/);
    assert.match(x("\\sin x"), /<mi>sin<\/mi><mo>\u2061<\/mo>/);
    assert.match(x("\\lim_{x\\to 0}"), /<munder><mo form="prefix" movablelimits="true">lim<\/mo>/);
    assert.match(x("\\mathbb{R}"), /<mi>\u211d<\/mi>/);
    assert.match(x("\\mathbf{x}"), /<mi>\u{1d431}<\/mi>/u);
    assert.match(x("\\mathrm{d}"), /<mi mathvariant="normal">d<\/mi>/);
    assert.match(x("\\Gamma"), /<mi mathvariant="normal">\u0393<\/mi>/);
    assert.match(x("\\neq"), /<mo>\u2260<\/mo>/);
    assert.match(x("\\color{red} x"), /<mstyle mathcolor="#ff0000"><mi>x<\/mi><\/mstyle>/);
    assert.match(x("\\boxed{x}"), /<mrow style="border:0.04em solid;padding:0.3em">/);
    assert.match(x("\\big("), /minsize="1.2em"/);
    assert.match(x("x", { display: true }), /display="block"/);
  });

  it("puts equation tags in a right-aligned column of cells classed tw-tag", () => {
    const TAG = '<mtd class="tw-tag" columnalign="right" style="text-align:right">';
    // a single tag on the whole formula: a one-row table [formula | tag]
    const one = ml("E = mc^2", { display: true, tags: "3" }).xml;
    checkXml(one);
    assert.ok(
      one.includes(`<semantics><mrow><mtable columnalign="center right" displaystyle="true"><mtr><mtd columnalign="center"><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></mtd>${TAG}<mtext>(3)</mtext></mtd></mtr></mtable></mrow><annotation`),
      one,
    );
    // \tag and a single caller tag on an equation environment take the same shape
    for (const xml of [ml("x \\tag{A}", { display: true }).xml, ml("\\begin{equation} x \\end{equation}", { display: true, tags: "7" }).xml]) {
      checkXml(xml);
      assert.match(xml, /<mtable columnalign="center right" displaystyle="true"><mtr><mtd columnalign="center">/);
      assert.equal((xml.match(/class="tw-tag"/g) ?? []).length, 1);
    }
    assert.ok(ml("x \\tag{A}", { display: true }).xml.includes(`${TAG}<mrow><mtext>(</mtext><mtext>A</mtext><mtext>)</mtext></mrow></mtd>`));
    // per-row tags: every row gets a tag cell, empty for unnumbered rows
    const rows = ml("\\begin{align} a &= b \\\\ c &= d \\nonumber \\\\ e &= f \\end{align}", { display: true, tags: ["1", null, "2"] }).xml;
    checkXml(rows);
    assert.equal((rows.match(/<mtr>/g) ?? []).length, 3);
    assert.match(rows, /columnalign="right left right"/);
    assert.equal((rows.match(/class="tw-tag"/g) ?? []).length, 3);
    assert.ok(rows.includes(`${TAG}<mtext>(1)</mtext></mtd></mtr>`));
    assert.ok(rows.includes(`${TAG}</mtd></mtr>`), "untagged row has an empty tag cell");
    assert.ok(rows.includes(`${TAG}<mtext>(2)</mtext></mtd></mtr>`));
    assert.doesNotMatch(rows, /mlabeledtr/);
    // gather and top-level \\ rows get the same per-row cells
    const g = ml("a \\\\ b", { display: true, tags: ["1", "2"] }).xml;
    assert.equal((g.match(/class="tw-tag"/g) ?? []).length, 2);
    // no tags at all: no tag column, no table around a single formula
    assert.doesNotMatch(ml("x", { display: true }).xml, /tw-tag|mtable/);
    assert.doesNotMatch(ml("\\begin{align*} a &= b \\end{align*}", { display: true }).xml, /tw-tag/);
    // inline math never carries tags
    assert.doesNotMatch(ml("x", { tags: "1" }).xml, /tw-tag/);
  });

  it("escapes everything", () => {
    const { xml } = ml("a < b > c \\& d \\text{\"q\" & 'p' <tag>}");
    checkXml(xml);
    assert.match(xml, /&lt;/);
    assert.match(xml, /&amp;/);
    const bad = ml("\\frac{<script>}{").xml;
    checkXml(bad);
    assert.doesNotMatch(bad, /<script>/);
  });
});

// ---------------------------------------------------------------------------
// Robustness and performance

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("math robustness", () => {
  const TOKENS = [
    "x", "y", "1", "2", "+", "-", "=", "(", ")", "[", "]", "{", "}", "^", "_", "'", "&", "\\\\", " ", ",",
    "\\frac", "\\sqrt", "\\left(", "\\right)", "\\left.", "\\middle|", "\\sum", "\\int", "\\limits", "\\nolimits",
    "\\begin{matrix}", "\\end{matrix}", "\\begin{aligned}", "\\end{aligned}", "\\begin{cases}", "\\end{cases}",
    "\\text{a", "\\mathbf", "\\hat", "\\overbrace", "\\underbrace", "\\not", "\\over", "\\choose", "\\big(", "\\alpha",
    "\\newcommand", "\\def", "#1", "\\color{red}", "$", "%", "\\", "\\tag{1}", "\\hline", "\\begin{array}{c}", "\\end{array}",
    "\\xrightarrow", "\\operatorname", "\\mathrm{d}", "\\displaystyle", "\\label{x}", "~", "\\,", "\\!", "\\kern", "1em", "\\hspace",
  ];

  it("never throws on random token soup", () => {
    const r = rng(12345);
    for (let k = 0; k < 1500; k++) {
      const n = 1 + Math.floor(r() * 25);
      let tex = "";
      for (let j = 0; j < n; j++) tex += TOKENS[Math.floor(r() * TOKENS.length)]!;
      for (const display of [false, true]) {
        const d = new Diagnostics();
        const res = typesetMath(tex, { display, fontSize: 10, macros: {}, diagnostics: d, pos: { line: 1, col: 1 }, lineWidth: 300, tags: ["1"] });
        assert.ok(Number.isFinite(res.box.width), tex);
        checkXml(mathml(tex, { display, macros: {}, diagnostics: d, pos: { line: 1, col: 1 } }));
        for (const item of d.items) {
          assert.ok(item.code === "MATH001" || item.code === "MATH002", `${item.code} for ${tex}`);
          assert.ok(item.line === 1 && item.col !== undefined && item.col >= 1 && item.col <= tex.length + 1, `position ${item.col} for ${tex}`);
        }
      }
    }
  });

  it("parses and typesets hostile input in linear time", () => {
    const N = 100_000;
    const inputs: Record<string, string> = {
      braces: "{".repeat(N),
      closes: "}".repeat(N),
      carets: `x${"^".repeat(N)}`,
      lefts: "\\left(".repeat(N / 6),
      amps: `\\begin{matrix}${"&".repeat(N)}\\end{matrix}`,
      ampsTop: "&".repeat(N),
      rows: `\\begin{matrix}${"a\\\\".repeat(N / 3)}\\end{matrix}`,
      rowsTop: "a\\\\".repeat(N / 3),
      fracs: "\\frac{".repeat(N / 6),
      primes: `x${"'".repeat(N)}`,
      long: "a+b=c,".repeat(N / 6),
      nots: "\\not".repeat(N / 4),
      bfs: "\\bf ".repeat(N / 4),
      styles: "\\displaystyle x".repeat(N / 15),
      text: `\\text{${"ab ".repeat(N / 3)}}`,
    };
    for (const [name, tex] of Object.entries(inputs)) {
      const t0 = performance.now();
      const d = new Diagnostics();
      typesetMath(tex, { display: true, fontSize: 10, macros: {}, diagnostics: d, lineWidth: 300 });
      mathml(tex, { display: false, macros: {}, diagnostics: d });
      const ms = performance.now() - t0;
      assert.ok(ms < 2500, `${name} took ${Math.round(ms)} ms`);
    }
  });

  it("reports deep nesting instead of overflowing the stack", () => {
    const r = ts("{".repeat(500) + "x" + "}".repeat(500));
    assert.match(errors(r.diag)[0]!.message, /nested more than/);
    const ok = ts("{".repeat(50) + "x" + "}".repeat(50));
    assert.deepEqual(errors(ok.diag), []);
  });
});

describe("math performance", () => {
  it("typesets 1,000 typical inline formulas in under a second", () => {
    const formulas = CORPUS.slice(0, 1000);
    while (formulas.length < 1000) formulas.push(...CORPUS.slice(0, 1000 - formulas.length));
    // warm up (fonts load on first use)
    for (const f of CORPUS.slice(0, 20)) ts(f);
    const t0 = performance.now();
    for (const f of formulas) ts(f);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `1000 formulas took ${Math.round(ms)} ms`);
  });

  it("exposes the engine object of the API", () => {
    assert.equal(typeof engine.typesetMath, "function");
    assert.equal(typeof engine.mathml, "function");
  });
});

describe("math: cancel, cases*, braket, prescript and units", () => {
  it("\\cancel, \\bcancel, \\xcancel and \\cancelto typeset and give menclose", () => {
    for (const tex of ["\\cancel{x+1}", "\\bcancel{y}", "\\xcancel{z}", "\\cancelto{0}{x-x}", "\\frac{\\cancel{3}x}{\\cancel{3}y}"]) {
      const r = ts(tex);
      assert.ok(r.ok, tex);
      assert.equal(r.diag.items.length, 0, tex);
    }
    const plain = ts("x").box.width;
    // A strike adds rules but no width.
    assert.ok(Math.abs(ts("\\cancel{x}").box.width - plain) < 0.01);
    assert.match(ml("\\cancel{x}").xml, /<menclose notation="updiagonalstrike">/);
    assert.match(ml("\\xcancel{x}").xml, /notation="updiagonalstrike downdiagonalstrike"/);
    assert.match(ml("\\bcancel{x}").xml, /notation="downdiagonalstrike"/);
  });

  it("cases* and dcases* set the second column as text", () => {
    const r = ts("f(x) = \\begin{cases*} x & if $x > 0$ \\\\ 0 & otherwise \\end{cases*}", { display: true });
    assert.ok(r.ok);
    assert.match(ml("\\begin{dcases*} 1 & when it rains \\end{dcases*}").xml, /<mtext>when\sit\srains<\/mtext>/);
  });

  it("braket, prescript, units and esint commands expand", () => {
    for (const tex of ["\\Braket{\\phi | A | \\psi}", "\\Set{x | x > 0}", "\\set{1, 2}", "\\prescript{14}{6}{C}", "\\unitfrac[5]{m}{s}", "\\unit[5]{kg}", "\\oiint_S F", "\\Bra{a}\\Ket{b}"]) {
      const r = ts(tex);
      assert.ok(r.ok, tex);
      assert.equal(r.diag.items.length, 0, tex);
    }
  });
});
