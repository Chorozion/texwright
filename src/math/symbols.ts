/**
 * Symbol tables for the math typesetter: which bundled font and code point
 * every math symbol is drawn from, its TeX atom class, the Unicode text it
 * stands for (for the PDF text layer and MathML), plus the delimiter,
 * accent, big-operator and named-function tables.
 *
 * The bundled fonts are the KaTeX Computer Modern derivatives. Their layout
 * follows TeX's own families: letters from the math italic font (cmmi),
 * digits and upright symbols from the roman font (cmr), operators and
 * relations from the symbol font (here folded into Main), AMS symbols from
 * msam/msbm (AMS), and large operators and delimiters from cmex (Size1-4).
 */

import { type BundledFamily, type BundledStyle, type Font, bundledFont } from "../font/index.js";

export type Cls = "ord" | "op" | "bin" | "rel" | "open" | "close" | "punct" | "inner";

/** A bundled font face, by short key. */
export type Fam =
  | "main"
  | "mainB"
  | "mainI"
  | "mainBI"
  | "mathI"
  | "mathBI"
  | "ams"
  | "cal"
  | "calB"
  | "frak"
  | "frakB"
  | "sf"
  | "sfB"
  | "sfI"
  | "script"
  | "tt"
  | "size1"
  | "size2"
  | "size3"
  | "size4"
  | "lmr"
  | "lmrB"
  | "lmrI"
  | "lmrBI";

export const FAMS: Readonly<Record<Fam, readonly [BundledFamily, BundledStyle]>> = {
  main: ["Main", "Regular"],
  mainB: ["Main", "Bold"],
  mainI: ["Main", "Italic"],
  mainBI: ["Main", "BoldItalic"],
  mathI: ["Math", "Italic"],
  mathBI: ["Math", "BoldItalic"],
  ams: ["AMS", "Regular"],
  cal: ["Caligraphic", "Regular"],
  calB: ["Caligraphic", "Bold"],
  frak: ["Fraktur", "Regular"],
  frakB: ["Fraktur", "Bold"],
  sf: ["SansSerif", "Regular"],
  sfB: ["SansSerif", "Bold"],
  sfI: ["SansSerif", "Italic"],
  script: ["Script", "Regular"],
  tt: ["Typewriter", "Regular"],
  size1: ["Size1", "Regular"],
  size2: ["Size2", "Regular"],
  size3: ["Size3", "Regular"],
  size4: ["Size4", "Regular"],
  // Latin Modern, the body text's face: TeX takes upright math characters (digits, +, =,
  // parentheses, function names) from the text roman, so they match the words around them.
  lmr: ["LMRoman", "Regular"],
  lmrB: ["LMRoman", "Bold"],
  lmrI: ["LMRoman", "Italic"],
  lmrBI: ["LMRoman", "BoldItalic"],
};

/** Faces drawn slanted; accents over their letters are skewed to the right. */
export const SLANTED: ReadonlySet<Fam> = new Set<Fam>(["mathI", "mathBI", "mainI", "mainBI", "sfI", "lmrI", "lmrBI"]);

const fontCache = new Map<Fam, Font>();

export function famFont(fam: Fam): Font {
  let f = fontCache.get(fam);
  if (!f) {
    const [family, style] = FAMS[fam];
    f = bundledFont(family, style);
    fontCache.set(fam, f);
  }
  return f;
}

export interface SymDef {
  cls: Cls;
  fam: Fam;
  cp: number;
  /** Unicode text this symbol stands for (PDF text layer and MathML). */
  text: string;
  /** MathML token element. */
  mml: "mi" | "mn" | "mo";
  /** Changed by \mathrm, \mathbf, ... (TeX's "variable family" characters: Latin letters, digits, upper-case Greek). */
  variable?: boolean;
  /** A large operator: Size1 in text style, Size2 in display style. */
  big?: boolean;
  /** Default limit placement of an operator. */
  limits?: "display" | "nolimits";
}

/** Math-mode symbols by command name (with backslash) or by literal character. */
export const MATH_SYMBOLS = new Map<string, SymDef>();
/** Math-mode symbols by Unicode code point of their text, for characters typed directly. */
export const UNICODE_SYMBOLS = new Map<number, SymDef>();

function chr(cp: number): string {
  return String.fromCodePoint(cp);
}

function def(names: string, cls: Cls, fam: Fam, cp: number, extra: Partial<SymDef> = {}): SymDef {
  const mml = extra.mml ?? (cls === "ord" ? "mi" : "mo");
  const sym: SymDef = { cls, fam, cp, text: extra.text ?? chr(cp), mml, ...extra };
  for (const n of names.split(" ")) if (n) MATH_SYMBOLS.set(n, sym);
  const tcp = sym.text.codePointAt(0)!;
  if (sym.text.length <= 2 && !UNICODE_SYMBOLS.has(tcp) && tcp > 0x7f) UNICODE_SYMBOLS.set(tcp, sym);
  return sym;
}

function group(cls: Cls, fam: Fam, rows: readonly (readonly [string, number, string?])[], extra: Partial<SymDef> = {}): void {
  for (const [names, cp, text] of rows) def(names, cls, fam, cp, text ? { ...extra, text } : extra);
}

// ---------------------------------------------------------------- letters

for (let c = 0x61; c <= 0x7a; c++) def(chr(c), "ord", "mathI", c, { variable: true });
for (let c = 0x41; c <= 0x5a; c++) def(chr(c), "ord", "mathI", c, { variable: true });
for (let c = 0x30; c <= 0x39; c++) def(chr(c), "ord", "main", c, { variable: true, mml: "mn" });

group("ord", "mathI", [
  ["\\alpha", 0x3b1],
  ["\\beta", 0x3b2],
  ["\\gamma", 0x3b3],
  ["\\delta", 0x3b4],
  ["\\epsilon", 0x3f5],
  ["\\varepsilon", 0x3b5],
  ["\\zeta", 0x3b6],
  ["\\eta", 0x3b7],
  ["\\theta", 0x3b8],
  ["\\vartheta", 0x3d1],
  ["\\iota", 0x3b9],
  ["\\kappa", 0x3ba],
  ["\\lambda", 0x3bb],
  ["\\mu", 0x3bc],
  ["\\nu", 0x3bd],
  ["\\xi", 0x3be],
  ["\\omicron", 0x6f, "ο"],
  ["\\pi", 0x3c0],
  ["\\varpi", 0x3d6],
  ["\\rho", 0x3c1],
  ["\\varrho", 0x3f1],
  ["\\sigma", 0x3c3],
  ["\\varsigma", 0x3c2],
  ["\\tau", 0x3c4],
  ["\\upsilon", 0x3c5],
  ["\\phi", 0x3d5],
  ["\\varphi", 0x3c6],
  ["\\chi", 0x3c7],
  ["\\psi", 0x3c8],
  ["\\omega", 0x3c9],
  ["\\varGamma", 0x393],
  ["\\varDelta", 0x394],
  ["\\varTheta", 0x398],
  ["\\varLambda", 0x39b],
  ["\\varXi", 0x39e],
  ["\\varPi", 0x3a0],
  ["\\varSigma", 0x3a3],
  ["\\varUpsilon", 0x3a5],
  ["\\varPhi", 0x3a6],
  ["\\varPsi", 0x3a8],
  ["\\varOmega", 0x3a9],
  ["\\imath", 0xe131, "ı"],
  ["\\jmath", 0xe237, "ȷ"],
]);
// Unicode lower-case Greek typed directly (and the omicron, drawn as an o).
UNICODE_SYMBOLS.set(0x3bf, MATH_SYMBOLS.get("\\omicron")!);

group(
  "ord",
  "main",
  [
    ["\\Gamma", 0x393],
    ["\\Delta", 0x394],
    ["\\Theta", 0x398],
    ["\\Lambda", 0x39b],
    ["\\Xi", 0x39e],
    ["\\Pi", 0x3a0],
    ["\\Sigma", 0x3a3],
    ["\\Upsilon", 0x3a5],
    ["\\Phi", 0x3a6],
    ["\\Psi", 0x3a8],
    ["\\Omega", 0x3a9],
    ["\\Alpha", 0x41, "Α"],
    ["\\Beta", 0x42, "Β"],
    ["\\Epsilon", 0x45, "Ε"],
    ["\\Zeta", 0x5a, "Ζ"],
    ["\\Eta", 0x48, "Η"],
    ["\\Iota", 0x49, "Ι"],
    ["\\Kappa", 0x4b, "Κ"],
    ["\\Mu", 0x4d, "Μ"],
    ["\\Nu", 0x4e, "Ν"],
    ["\\Omicron", 0x4f, "Ο"],
    ["\\Rho", 0x50, "Ρ"],
    ["\\Tau", 0x54, "Τ"],
    ["\\Chi", 0x58, "Χ"],
  ],
  { variable: true },
);

// Upper-case Greek typed directly is upright, as in TeX (not the \var forms).
for (const name of ["Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega"]) {
  const s = MATH_SYMBOLS.get(`\\${name}`)!;
  UNICODE_SYMBOLS.set(s.cp, s);
}

// ---------------------------------------------------------------- ordinary symbols

group("ord", "main", [
  ["\\infty", 0x221e],
  ["\\partial", 0x2202],
  ["\\nabla", 0x2207],
  ["\\forall", 0x2200],
  ["\\exists", 0x2203],
  ["\\emptyset", 0x2205],
  ["\\top", 0x22a4],
  ["\\bot", 0x22a5],
  ["\\angle", 0x2220],
  ["\\triangle", 0x25b3],
  ["\\hbar", 0x210f],
  ["\\ell", 0x2113],
  ["\\wp", 0x2118],
  ["\\Re", 0x211c],
  ["\\Im", 0x2111],
  ["\\aleph", 0x2135],
  ["\\flat", 0x266d],
  ["\\natural", 0x266e],
  ["\\sharp", 0x266f],
  ["\\clubsuit", 0x2663],
  ["\\diamondsuit", 0x2662],
  ["\\heartsuit", 0x2661],
  ["\\spadesuit", 0x2660],
  ["\\S", 0xa7],
  ["\\P", 0xb6],
  ["\\pounds \\mathsterling", 0xa3],
  ["\\dag", 0x2020],
  ["\\ddag", 0x2021],
  ["\\vdots", 0x22ee],
  ["\\_", 0x5f],
  ["\\#", 0x23],
  ["\\$", 0x24],
  ["\\%", 0x25],
  ["\\&", 0x26],
  [".", 0x2e],
  ["@", 0x40],
  ['"', 0x201d],
  ["`", 0x2018],
  ["\\degree", 0xb0],
]);
group(
  "ord",
  "main",
  [
    ["\\neg \\lnot", 0xac],
    ["\\prime", 0x2032],
    ["\\surd", 0x221a],
    ["\\backslash", 0x5c],
    ["/", 0x2f],
    ["|", 0x2223, "|"],
    ["\\vert", 0x2223, "|"],
    ["\\| \\Vert", 0x2225, "‖"],
  ],
  { mml: "mo" },
);

group("ord", "ams", [
  ["\\varnothing", 0x2205],
  ["\\complement", 0x2201],
  ["\\nexists", 0x2204],
  ["\\Finv", 0x2132],
  ["\\Game", 0x2141],
  ["\\mho", 0x2127],
  ["\\beth", 0x2136],
  ["\\gimel", 0x2137],
  ["\\daleth", 0x2138],
  ["\\eth", 0xf0],
  ["\\hslash", 0x210f],
  ["\\backprime", 0x2035],
  ["\\Bbbk", 0x6b, "\u{1d55c}"],
  ["\\digamma", 0x3dd],
  ["\\varkappa", 0x3f0],
  ["\\checkmark", 0x2713],
  ["\\maltese", 0x2720],
  ["\\circledR", 0xae],
  ["\\circledS", 0x24c8],
  ["\\yen", 0xa5],
  ["\\diagup", 0x2571],
  ["\\diagdown", 0x2572],
  ["\\square \\Box", 0x25a1],
  ["\\blacksquare", 0x25a0],
  ["\\lozenge \\Diamond", 0x25ca],
  ["\\blacklozenge", 0x29eb],
  ["\\bigstar", 0x2605],
  ["\\measuredangle", 0x2221],
  ["\\sphericalangle", 0x2222],
  ["\\vartriangle", 0x25b3],
  ["\\triangledown", 0x25bd],
  ["\\blacktriangle", 0x25b2],
  ["\\blacktriangledown", 0x25bc],
]);

// ---------------------------------------------------------------- binary operators

group("bin", "main", [
  ["+", 0x2b],
  ["-", 0x2212],
  ["*", 0x2217],
  ["\\pm", 0xb1],
  ["\\mp", 0x2213],
  ["\\times", 0xd7],
  ["\\div", 0xf7],
  ["\\cdot", 0x22c5],
  ["\\ast", 0x2217],
  ["\\star", 0x22c6],
  ["\\circ", 0x2218],
  ["\\bullet", 0x2219],
  ["\\cap", 0x2229],
  ["\\cup", 0x222a],
  ["\\uplus", 0x228e],
  ["\\sqcap", 0x2293],
  ["\\sqcup", 0x2294],
  ["\\vee \\lor", 0x2228],
  ["\\wedge \\land", 0x2227],
  ["\\setminus", 0x2216],
  ["\\wr", 0x2240],
  ["\\diamond", 0x22c4],
  ["\\bigtriangleup", 0x25b3],
  ["\\bigtriangledown", 0x25bd],
  ["\\triangleleft", 0x25c3],
  ["\\triangleright", 0x25b9],
  ["\\oplus", 0x2295],
  ["\\ominus", 0x2296],
  ["\\otimes", 0x2297],
  ["\\oslash", 0x2298],
  ["\\odot", 0x2299],
  ["\\bigcirc", 0x25ef],
  ["\\dagger", 0x2020],
  ["\\ddagger", 0x2021],
  ["\\amalg", 0x2a3f],
]);
group("bin", "ams", [
  ["\\dotplus", 0x2214],
  ["\\smallsetminus", 0x2216],
  ["\\Cap \\doublecap", 0x22d2],
  ["\\Cup \\doublecup", 0x22d3],
  ["\\doublebarwedge", 0x2a5e],
  ["\\boxminus", 0x229f],
  ["\\boxplus", 0x229e],
  ["\\divideontimes", 0x22c7],
  ["\\ltimes", 0x22c9],
  ["\\rtimes", 0x22ca],
  ["\\leftthreetimes", 0x22cb],
  ["\\rightthreetimes", 0x22cc],
  ["\\curlywedge", 0x22cf],
  ["\\curlyvee", 0x22ce],
  ["\\circleddash", 0x229d],
  ["\\circledast", 0x229b],
  ["\\centerdot", 0x22c5],
  ["\\intercal", 0x22ba],
  ["\\barwedge", 0x22bc],
  ["\\veebar", 0x22bb],
  ["\\boxtimes", 0x22a0],
  ["\\boxdot", 0x22a1],
  ["\\circledcirc", 0x229a],
  ["\\lhd", 0x22b2],
  ["\\rhd", 0x22b3],
  ["\\unlhd", 0x22b4],
  ["\\unrhd", 0x22b5],
]);

// ---------------------------------------------------------------- relations

group("rel", "main", [
  ["=", 0x3d],
  ["<", 0x3c],
  [">", 0x3e],
  [":", 0x3a],
  ["\\lt", 0x3c],
  ["\\gt", 0x3e],
  ["\\leq \\le", 0x2264],
  ["\\geq \\ge", 0x2265],
  ["\\equiv", 0x2261],
  ["\\sim", 0x223c],
  ["\\simeq", 0x2243],
  ["\\approx", 0x2248],
  ["\\cong", 0x2245],
  ["\\asymp", 0x224d],
  ["\\doteq", 0x2250],
  ["\\propto", 0x221d],
  ["\\prec", 0x227a],
  ["\\succ", 0x227b],
  ["\\preceq", 0x2aaf],
  ["\\succeq", 0x2ab0],
  ["\\ll", 0x226a],
  ["\\gg", 0x226b],
  ["\\subset", 0x2282],
  ["\\supset", 0x2283],
  ["\\subseteq", 0x2286],
  ["\\supseteq", 0x2287],
  ["\\sqsubseteq", 0x2291],
  ["\\sqsupseteq", 0x2292],
  ["\\in", 0x2208],
  ["\\ni \\owns", 0x220b],
  ["\\vdash", 0x22a2],
  ["\\dashv", 0x22a3],
  ["\\models", 0x22a8],
  ["\\perp", 0x22a5],
  ["\\mid", 0x2223],
  ["\\parallel", 0x2225],
  ["\\smile", 0x2323],
  ["\\frown", 0x2322],
  ["\\bowtie \\Join", 0x22c8],
  ["\\leftarrow \\gets", 0x2190],
  ["\\uparrow", 0x2191],
  ["\\rightarrow \\to", 0x2192],
  ["\\downarrow", 0x2193],
  ["\\leftrightarrow", 0x2194],
  ["\\updownarrow", 0x2195],
  ["\\nwarrow", 0x2196],
  ["\\nearrow", 0x2197],
  ["\\searrow", 0x2198],
  ["\\swarrow", 0x2199],
  ["\\mapsto", 0x21a6],
  ["\\hookleftarrow", 0x21a9],
  ["\\hookrightarrow", 0x21aa],
  ["\\leftharpoonup", 0x21bc],
  ["\\leftharpoondown", 0x21bd],
  ["\\rightharpoonup", 0x21c0],
  ["\\rightharpoondown", 0x21c1],
  ["\\rightleftharpoons", 0x21cc],
  ["\\Leftarrow", 0x21d0],
  ["\\Uparrow", 0x21d1],
  ["\\Rightarrow", 0x21d2],
  ["\\Downarrow", 0x21d3],
  ["\\Leftrightarrow", 0x21d4],
  ["\\Updownarrow", 0x21d5],
  ["\\longleftarrow", 0x27f5],
  ["\\longrightarrow", 0x27f6],
  ["\\longleftrightarrow", 0x27f7],
  ["\\Longleftarrow", 0x27f8],
  ["\\Longrightarrow", 0x27f9],
  ["\\Longleftrightarrow", 0x27fa],
  ["\\longmapsto", 0x27fc],
]);
group("rel", "ams", [
  ["\\leqq", 0x2266],
  ["\\geqq", 0x2267],
  ["\\leqslant", 0x2a7d],
  ["\\geqslant", 0x2a7e],
  ["\\eqslantless", 0x2a95],
  ["\\eqslantgtr", 0x2a96],
  ["\\lesssim", 0x2272],
  ["\\gtrsim", 0x2273],
  ["\\lessapprox", 0x2a85],
  ["\\gtrapprox", 0x2a86],
  ["\\approxeq", 0x224a],
  ["\\lessgtr", 0x2276],
  ["\\gtrless", 0x2277],
  ["\\lesseqgtr", 0x22da],
  ["\\gtreqless", 0x22db],
  ["\\lesseqqgtr", 0x2a8b],
  ["\\gtreqqless", 0x2a8c],
  ["\\doteqdot \\Doteq", 0x2251],
  ["\\risingdotseq", 0x2253],
  ["\\fallingdotseq", 0x2252],
  ["\\backsim", 0x223d],
  ["\\backsimeq", 0x22cd],
  ["\\eqsim", 0x2242],
  ["\\subseteqq", 0x2ac5],
  ["\\supseteqq", 0x2ac6],
  ["\\Subset", 0x22d0],
  ["\\Supset", 0x22d1],
  ["\\sqsubset", 0x228f],
  ["\\sqsupset", 0x2290],
  ["\\preccurlyeq", 0x227c],
  ["\\succcurlyeq", 0x227d],
  ["\\curlyeqprec", 0x22de],
  ["\\curlyeqsucc", 0x22df],
  ["\\precsim", 0x227e],
  ["\\succsim", 0x227f],
  ["\\precapprox", 0x2ab7],
  ["\\succapprox", 0x2ab8],
  ["\\vartriangleleft", 0x22b2],
  ["\\vartriangleright", 0x22b3],
  ["\\trianglelefteq", 0x22b4],
  ["\\trianglerighteq", 0x22b5],
  ["\\vDash", 0x22a8],
  ["\\Vdash", 0x22a9],
  ["\\Vvdash", 0x22aa],
  ["\\smallsmile", 0x2323],
  ["\\smallfrown", 0x2322],
  ["\\bumpeq", 0x224f],
  ["\\Bumpeq", 0x224e],
  ["\\between", 0x226c],
  ["\\pitchfork", 0x22d4],
  ["\\blacktriangleleft", 0x25c0],
  ["\\blacktriangleright", 0x25b6],
  ["\\therefore", 0x2234],
  ["\\because", 0x2235],
  ["\\eqcirc", 0x2256],
  ["\\circeq", 0x2257],
  ["\\triangleq", 0x225c],
  ["\\thicksim", 0x223c],
  ["\\thickapprox", 0x2248],
  ["\\shortmid", 0x2223],
  ["\\shortparallel", 0x2225],
  ["\\backepsilon", 0x220d],
  ["\\varpropto", 0x221d],
  ["\\lll \\llless", 0x22d8],
  ["\\ggg \\gggtr", 0x22d9],
  ["\\lessdot", 0x22d6],
  ["\\gtrdot", 0x22d7],
  ["\\leftleftarrows", 0x21c7],
  ["\\rightrightarrows", 0x21c9],
  ["\\leftrightarrows", 0x21c6],
  ["\\rightleftarrows", 0x21c4],
  ["\\Lleftarrow", 0x21da],
  ["\\Rrightarrow", 0x21db],
  ["\\twoheadleftarrow", 0x219e],
  ["\\twoheadrightarrow", 0x21a0],
  ["\\leftarrowtail", 0x21a2],
  ["\\rightarrowtail", 0x21a3],
  ["\\looparrowleft", 0x21ab],
  ["\\looparrowright", 0x21ac],
  ["\\leftrightharpoons", 0x21cb],
  ["\\curvearrowleft", 0x21b6],
  ["\\curvearrowright", 0x21b7],
  ["\\circlearrowleft", 0x21ba],
  ["\\circlearrowright", 0x21bb],
  ["\\Lsh", 0x21b0],
  ["\\Rsh", 0x21b1],
  ["\\upuparrows", 0x21c8],
  ["\\downdownarrows", 0x21ca],
  ["\\upharpoonleft", 0x21bf],
  ["\\upharpoonright \\restriction", 0x21be],
  ["\\downharpoonleft", 0x21c3],
  ["\\downharpoonright", 0x21c2],
  ["\\multimap", 0x22b8],
  ["\\leftrightsquigarrow", 0x21ad],
  ["\\rightsquigarrow \\leadsto", 0x21dd],
  ["\\dashrightarrow", 0x21e2],
  ["\\dashleftarrow", 0x21e0],
  // negated relations
  ["\\nless", 0x226e],
  ["\\ngtr", 0x226f],
  ["\\nleq", 0x2270],
  ["\\ngeq", 0x2271],
  ["\\lneq", 0x2a87],
  ["\\gneq", 0x2a88],
  ["\\lneqq \\lvertneqq", 0x2268],
  ["\\gneqq \\gvertneqq", 0x2269],
  ["\\lnsim", 0x22e6],
  ["\\gnsim", 0x22e7],
  ["\\lnapprox", 0x2a89],
  ["\\gnapprox", 0x2a8a],
  ["\\nprec", 0x2280],
  ["\\nsucc", 0x2281],
  ["\\npreceq", 0x22e0],
  ["\\nsucceq", 0x22e1],
  ["\\precneqq", 0x2ab5],
  ["\\succneqq", 0x2ab6],
  ["\\precnsim", 0x22e8],
  ["\\succnsim", 0x22e9],
  ["\\precnapprox", 0x2ab9],
  ["\\succnapprox", 0x2aba],
  ["\\nsim", 0x2241],
  ["\\ncong", 0x2246],
  ["\\nmid \\nshortmid", 0x2224],
  ["\\nparallel \\nshortparallel", 0x2226],
  ["\\nvdash", 0x22ac],
  ["\\nvDash", 0x22ad],
  ["\\nVdash", 0x22ae],
  ["\\nVDash", 0x22af],
  ["\\ntriangleleft", 0x22ea],
  ["\\ntriangleright", 0x22eb],
  ["\\ntrianglelefteq", 0x22ec],
  ["\\ntrianglerighteq", 0x22ed],
  ["\\nsubseteq", 0x2288],
  ["\\nsupseteq", 0x2289],
  ["\\subsetneq \\varsubsetneq", 0x228a],
  ["\\supsetneq \\varsupsetneq", 0x228b],
  ["\\subsetneqq \\varsubsetneqq", 0x2acb],
  ["\\supsetneqq \\varsupsetneqq", 0x2acc],
  ["\\nleftarrow", 0x219a],
  ["\\nrightarrow", 0x219b],
  ["\\nLeftarrow", 0x21cd],
  ["\\nRightarrow", 0x21cf],
  ["\\nleftrightarrow", 0x21ae],
  ["\\nLeftrightarrow", 0x21ce],
]);

// ---------------------------------------------------------------- fences and punctuation

group("open", "main", [
  ["(", 0x28],
  ["[", 0x5b],
  ["\\{ \\lbrace", 0x7b],
  ["\\langle", 0x27e8],
  ["\\lfloor", 0x230a],
  ["\\lceil", 0x2308],
  ["\\lgroup", 0x27ee],
  ["\\lmoustache", 0x23b0],
  ["\\lbrack", 0x5b],
  ["\\lvert", 0x2223, "|"],
  ["\\lVert", 0x2225, "‖"],
]);
group("open", "ams", [
  ["\\ulcorner", 0x250c],
  ["\\llcorner", 0x2514],
]);
group("close", "main", [
  [")", 0x29],
  ["]", 0x5d],
  ["\\} \\rbrace", 0x7d],
  ["\\rangle", 0x27e9],
  ["\\rfloor", 0x230b],
  ["\\rceil", 0x2309],
  ["\\rgroup", 0x27ef],
  ["\\rmoustache", 0x23b1],
  ["\\rbrack", 0x5d],
  ["\\rvert", 0x2223, "|"],
  ["\\rVert", 0x2225, "‖"],
  ["!", 0x21],
  ["?", 0x3f],
]);
group("close", "ams", [
  ["\\urcorner", 0x2510],
  ["\\lrcorner", 0x2518],
]);
group("punct", "main", [
  [",", 0x2c],
  [";", 0x3b],
  ["\\colon", 0x3a],
  ["\\ldotp", 0x2e],
  ["\\cdotp", 0x22c5],
]);
group("inner", "main", [
  ["\\ldots \\mathellipsis", 0x2026],
  ["\\cdots", 0x22ef],
  ["\\ddots", 0x22f1],
]);

UNICODE_SYMBOLS.set(0xb7, MATH_SYMBOLS.get("\\cdot")!);

// ---------------------------------------------------------------- large operators

group(
  "op",
  "size1",
  [
    ["\\sum", 0x2211],
    ["\\prod", 0x220f],
    ["\\coprod", 0x2210],
    ["\\bigcup", 0x22c3],
    ["\\bigcap", 0x22c2],
    ["\\bigvee", 0x22c1],
    ["\\bigwedge", 0x22c0],
    ["\\bigodot", 0x2a00],
    ["\\bigoplus", 0x2a01],
    ["\\bigotimes", 0x2a02],
    ["\\biguplus", 0x2a04],
    ["\\bigsqcup", 0x2a06],
  ],
  { big: true, limits: "display" },
);
group(
  "op",
  "size1",
  [
    ["\\int", 0x222b],
    ["\\iint", 0x222c],
    ["\\iiint", 0x222d],
    ["\\oint", 0x222e],
  ],
  { big: true, limits: "nolimits" },
);
def("\\intop", "op", "size1", 0x222b, { big: true, limits: "display" });
def("\\smallint", "op", "main", 0x222b, { limits: "nolimits" });
// Characters typed directly map to the default (\int) behaviour.
UNICODE_SYMBOLS.set(0x222b, MATH_SYMBOLS.get("\\int")!);

// ---------------------------------------------------------------- text-mode symbols

/** Text-mode commands that stand for one character. */
export const TEXT_SYMBOLS: ReadonlyMap<string, string> = new Map<string, string>([
  ["\\textbackslash", "\\"],
  ["\\textasciitilde", "~"],
  ["\\textasciicircum", "^"],
  ["\\textunderscore", "_"],
  ["\\textbar", "|"],
  ["\\textless", "<"],
  ["\\textgreater", ">"],
  ["\\textendash", "–"],
  ["\\textemdash", "—"],
  ["\\textquoteleft", "‘"],
  ["\\textquoteright", "’"],
  ["\\textquotedblleft", "“"],
  ["\\textquotedblright", "”"],
  ["\\dag", "†"],
  ["\\textdagger", "†"],
  ["\\ddag", "‡"],
  ["\\textdaggerdbl", "‡"],
  ["\\S", "§"],
  ["\\textsection", "§"],
  ["\\P", "¶"],
  ["\\textparagraph", "¶"],
  ["\\pounds", "£"],
  ["\\textsterling", "£"],
  ["\\copyright", "©"],
  ["\\textcopyright", "©"],
  ["\\textregistered", "®"],
  ["\\ss", "ß"],
  ["\\ae", "æ"],
  ["\\AE", "Æ"],
  ["\\o", "ø"],
  ["\\O", "Ø"],
  ["\\oe", "œ"],
  ["\\OE", "Œ"],
  ["\\i", "ı"],
  ["\\j", "ȷ"],
  ["\\ldots", "…"],
  ["\\dots", "…"],
  ["\\textellipsis", "…"],
  ["\\textdegree", "°"],
  ["\\textbullet", "•"],
  ["\\$", "$"],
  ["\\%", "%"],
  ["\\&", "&"],
  ["\\#", "#"],
  ["\\_", "_"],
  ["\\{", "{"],
  ["\\}", "}"],
]);

/** Text accents: command -> [spacing accent code point in Main, combining mark, below?]. */
export const TEXT_ACCENTS: ReadonlyMap<string, readonly [number, string, boolean]> = new Map<string, readonly [number, string, boolean]>([
  ["\\'", [0x2ca, "́", false]],
  ["\\`", [0x2cb, "̀", false]],
  ["\\^", [0x2c6, "̂", false]],
  ['\\"', [0xa8, "̈", false]],
  ["\\~", [0x2dc, "̃", false]],
  ["\\=", [0x2c9, "̄", false]],
  ["\\.", [0x2d9, "̇", false]],
  ["\\u", [0x2d8, "̆", false]],
  ["\\v", [0x2c7, "̌", false]],
  ["\\H", [0x2dd, "̋", false]],
  ["\\r", [0x2da, "̊", false]],
  ["\\c", [0xb8, "̧", true]],
]);

// ---------------------------------------------------------------- accents

export interface AccentDef {
  /** Accent glyph in Main-Regular. */
  cp: number;
  /** MathML accent character. */
  mml: string;
  /** Wide accents choose among the Size1-4 successors to cover their base. */
  wide?: boolean;
}

export const ACCENTS: ReadonlyMap<string, AccentDef> = new Map<string, AccentDef>([
  ["\\hat", { cp: 0x2c6, mml: "^" }],
  ["\\check", { cp: 0x2c7, mml: "ˇ" }],
  ["\\tilde", { cp: 0x2dc, mml: "~" }],
  ["\\acute", { cp: 0x2ca, mml: "´" }],
  ["\\grave", { cp: 0x2cb, mml: "`" }],
  ["\\dot", { cp: 0x2d9, mml: "˙" }],
  ["\\ddot", { cp: 0xa8, mml: "¨" }],
  ["\\breve", { cp: 0x2d8, mml: "˘" }],
  ["\\bar", { cp: 0x2c9, mml: "¯" }],
  ["\\vec", { cp: 0x20d7, mml: "→" }],
  ["\\mathring", { cp: 0x2da, mml: "˚" }],
  ["\\widehat", { cp: 0x2c6, mml: "^", wide: true }],
  ["\\widetilde", { cp: 0x2dc, mml: "~", wide: true }],
  ["\\widecheck", { cp: 0x2c7, mml: "ˇ" }],
]);

// ---------------------------------------------------------------- delimiters

export interface ExtRecipe {
  fam: Fam;
  top?: number;
  mid?: number;
  bot?: number;
  rep: number;
}

export interface DelimDef {
  /** Larger variants: the same code point in Size1..Size4 (as many as exist). */
  sizes: number;
  /** Extensible recipe used past the largest variant. */
  ext?: ExtRecipe;
}

const PAREN_L: ExtRecipe = { fam: "size4", top: 0x239b, rep: 0x239c, bot: 0x239d };
const PAREN_R: ExtRecipe = { fam: "size4", top: 0x239e, rep: 0x239f, bot: 0x23a0 };

/** Delimiter variants keyed by the code point of the Main-Regular (small) glyph. */
export const DELIMS: ReadonlyMap<number, DelimDef> = new Map<number, DelimDef>([
  [0x28, { sizes: 4, ext: PAREN_L }],
  [0x29, { sizes: 4, ext: PAREN_R }],
  [0x5b, { sizes: 4, ext: { fam: "size4", top: 0x23a1, rep: 0x23a2, bot: 0x23a3 } }],
  [0x5d, { sizes: 4, ext: { fam: "size4", top: 0x23a4, rep: 0x23a5, bot: 0x23a6 } }],
  [0x7b, { sizes: 4, ext: { fam: "size4", top: 0x23a7, mid: 0x23a8, bot: 0x23a9, rep: 0x23aa } }],
  [0x7d, { sizes: 4, ext: { fam: "size4", top: 0x23ab, mid: 0x23ac, bot: 0x23ad, rep: 0x23aa } }],
  [0x230a, { sizes: 4, ext: { fam: "size4", rep: 0x23a2, bot: 0x23a3 } }],
  [0x230b, { sizes: 4, ext: { fam: "size4", rep: 0x23a5, bot: 0x23a6 } }],
  [0x2308, { sizes: 4, ext: { fam: "size4", top: 0x23a1, rep: 0x23a2 } }],
  [0x2309, { sizes: 4, ext: { fam: "size4", top: 0x23a4, rep: 0x23a5 } }],
  [0x27e8, { sizes: 4 }],
  [0x27e9, { sizes: 4 }],
  [0x2f, { sizes: 4 }],
  [0x5c, { sizes: 4 }],
  [0x2223, { sizes: 0, ext: { fam: "size1", rep: 0x2223 } }],
  [0x2225, { sizes: 0, ext: { fam: "size1", rep: 0x2225 } }],
  [0x2191, { sizes: 0, ext: { fam: "size1", top: 0x2191, rep: 0x23d0 } }],
  [0x2193, { sizes: 0, ext: { fam: "size1", rep: 0x23d0, bot: 0x2193 } }],
  [0x2195, { sizes: 0, ext: { fam: "size1", top: 0x2191, rep: 0x23d0, bot: 0x2193 } }],
  [0x21d1, { sizes: 0, ext: { fam: "size1", top: 0x21d1, rep: 0x2016 } }],
  [0x21d3, { sizes: 0, ext: { fam: "size1", rep: 0x2016, bot: 0x21d3 } }],
  [0x21d5, { sizes: 0, ext: { fam: "size1", top: 0x21d1, rep: 0x2016, bot: 0x21d3 } }],
  [0x27ee, { sizes: 0, ext: { fam: "size4", top: 0x23a7, rep: 0x23aa, bot: 0x23a9 } }],
  [0x27ef, { sizes: 0, ext: { fam: "size4", top: 0x23ab, rep: 0x23aa, bot: 0x23ad } }],
  [0x23b0, { sizes: 0, ext: { fam: "size4", top: 0x23a7, rep: 0x23aa, bot: 0x23ad } }],
  [0x23b1, { sizes: 0, ext: { fam: "size4", top: 0x23ab, rep: 0x23aa, bot: 0x23a9 } }],
  [0x221a, { sizes: 4, ext: { fam: "size4", top: 0xe001, rep: 0xe000, bot: 0x23b7 } }],
]);

/** Names accepted after \left, \right, \middle and \big: name -> symbol. "." is the null delimiter. */
export const DELIM_NAMES: ReadonlyMap<string, string> = new Map<string, string>([
  ["(", "("],
  [")", ")"],
  ["[", "["],
  ["]", "]"],
  ["\\{", "\\{"],
  ["\\}", "\\}"],
  ["\\lbrace", "\\{"],
  ["\\rbrace", "\\}"],
  ["\\lbrack", "["],
  ["\\rbrack", "]"],
  ["<", "\\langle"],
  [">", "\\rangle"],
  ["\\langle", "\\langle"],
  ["\\rangle", "\\rangle"],
  ["\\lfloor", "\\lfloor"],
  ["\\rfloor", "\\rfloor"],
  ["\\lceil", "\\lceil"],
  ["\\rceil", "\\rceil"],
  ["|", "|"],
  ["\\vert", "|"],
  ["\\lvert", "|"],
  ["\\rvert", "|"],
  ["\\|", "\\|"],
  ["\\Vert", "\\|"],
  ["\\lVert", "\\|"],
  ["\\rVert", "\\|"],
  ["/", "/"],
  ["\\backslash", "\\backslash"],
  ["\\uparrow", "\\uparrow"],
  ["\\downarrow", "\\downarrow"],
  ["\\updownarrow", "\\updownarrow"],
  ["\\Uparrow", "\\Uparrow"],
  ["\\Downarrow", "\\Downarrow"],
  ["\\Updownarrow", "\\Updownarrow"],
  ["\\lgroup", "\\lgroup"],
  ["\\rgroup", "\\rgroup"],
  ["\\lmoustache", "\\lmoustache"],
  ["\\rmoustache", "\\rmoustache"],
  ["\\ulcorner", "\\ulcorner"],
  ["\\urcorner", "\\urcorner"],
  ["\\llcorner", "\\llcorner"],
  ["\\lrcorner", "\\lrcorner"],
  [".", "."],
]);

// ---------------------------------------------------------------- named operators

/** \sin-style operators: name -> [text, limits]. */
export const NAMED_OPS: ReadonlyMap<string, readonly [string, "display" | "nolimits"]> = new Map<string, readonly [string, "display" | "nolimits"]>([
  ...(
    [
      "arccos",
      "arcsin",
      "arctan",
      "arg",
      "cos",
      "cosh",
      "cot",
      "coth",
      "csc",
      "deg",
      "dim",
      "exp",
      "hom",
      "ker",
      "lg",
      "ln",
      "log",
      "sec",
      "sin",
      "sinh",
      "tan",
      "tanh",
      "sh",
      "ch",
      "th",
      "cosec",
      "cotg",
      "ctg",
      "tg",
      "arcctg",
      "arctg",
    ] as const
  ).map((n) => [`\\${n}`, [n, "nolimits"]] as const),
  ...(["det", "gcd", "inf", "lim", "max", "min", "Pr", "sup"] as const).map((n) => [`\\${n}`, [n, "display"]] as const),
  ["\\liminf", ["lim inf", "display"]],
  ["\\limsup", ["lim sup", "display"]],
  ["\\injlim", ["inj lim", "display"]],
  ["\\projlim", ["proj lim", "display"]],
]);

/** Extensible arrows for \xrightarrow and friends, and the over/under arrows. */
export interface ArrowDef {
  /** Glyph at the left end (Main), or 0 for a plain shaft end. */
  left: number;
  /** Glyph at the right end (Main), or 0. */
  right: number;
  /** Two shafts (double arrows). */
  double?: boolean;
  /** Vertical bar at the left end (\xmapsto). */
  bar?: boolean;
  /** MathML / text character. */
  text: string;
}

export const ARROWS: ReadonlyMap<string, ArrowDef> = new Map<string, ArrowDef>([
  ["\\xrightarrow", { left: 0, right: 0x2192, text: "→" }],
  ["\\xleftarrow", { left: 0x2190, right: 0, text: "←" }],
  ["\\xleftrightarrow", { left: 0x2190, right: 0x2192, text: "↔" }],
  ["\\xRightarrow", { left: 0, right: 0x21d2, double: true, text: "⇒" }],
  ["\\xLeftarrow", { left: 0x21d0, right: 0, double: true, text: "⇐" }],
  ["\\xLeftrightarrow", { left: 0x21d0, right: 0x21d2, double: true, text: "⇔" }],
  ["\\xmapsto", { left: 0, right: 0x2192, bar: true, text: "↦" }],
  ["\\xhookrightarrow", { left: 0, right: 0x21aa, text: "↪" }],
  ["\\xhookleftarrow", { left: 0x21a9, right: 0, text: "↩" }],
  ["\\xrightharpoonup", { left: 0, right: 0x21c0, text: "⇀" }],
  ["\\xrightharpoondown", { left: 0, right: 0x21c1, text: "⇁" }],
  ["\\xleftharpoonup", { left: 0x21bc, right: 0, text: "↼" }],
  ["\\xleftharpoondown", { left: 0x21bd, right: 0, text: "↽" }],
  ["\\overrightarrow", { left: 0, right: 0x2192, text: "→" }],
  ["\\overleftarrow", { left: 0x2190, right: 0, text: "←" }],
  ["\\overleftrightarrow", { left: 0x2190, right: 0x2192, text: "↔" }],
  ["\\underrightarrow", { left: 0, right: 0x2192, text: "→" }],
  ["\\underleftarrow", { left: 0x2190, right: 0, text: "←" }],
  ["\\underleftrightarrow", { left: 0x2190, right: 0x2192, text: "↔" }],
  ["\\overrightharpoon", { left: 0, right: 0x21c0, text: "⇀" }],
  ["\\overleftharpoon", { left: 0x21bc, right: 0, text: "↼" }],
]);

/** Every (face, code point) pair the tables above can draw, for the coverage test. */
export function allMappedGlyphs(): { name: string; fam: Fam; cp: number }[] {
  const out: { name: string; fam: Fam; cp: number }[] = [];
  for (const [name, s] of MATH_SYMBOLS) {
    out.push({ name, fam: s.fam, cp: s.cp });
    if (s.big) out.push({ name: `${name} (display)`, fam: "size2", cp: s.cp });
  }
  for (const [name, a] of ACCENTS) {
    out.push({ name, fam: "main", cp: a.cp });
    if (a.wide) for (const fam of ["size1", "size2", "size3", "size4"] as const) out.push({ name: `${name} (${fam})`, fam, cp: a.cp });
  }
  for (const [cp, d] of DELIMS) {
    out.push({ name: `delimiter U+${cp.toString(16)}`, fam: "main", cp });
    const sizes = ["size1", "size2", "size3", "size4"] as const;
    for (let k = 0; k < d.sizes; k++) out.push({ name: `delimiter U+${cp.toString(16)} ${sizes[k]}`, fam: sizes[k]!, cp });
    if (d.ext) {
      for (const piece of [d.ext.top, d.ext.mid, d.ext.bot, d.ext.rep]) {
        if (piece !== undefined) out.push({ name: `delimiter U+${cp.toString(16)} piece U+${piece.toString(16)}`, fam: d.ext.fam, cp: piece });
      }
    }
  }
  for (const [name, [cp]] of TEXT_ACCENTS) out.push({ name, fam: "main", cp });
  for (const [name, a] of ARROWS) {
    if (a.left) out.push({ name, fam: "main", cp: a.left });
    if (a.right) out.push({ name, fam: "main", cp: a.right });
  }
  for (const cp of [0xe150, 0xe151, 0xe152, 0xe153, 0xe154]) out.push({ name: `brace piece U+${cp.toString(16)}`, fam: "size4", cp });
  out.push({ name: "\\not", fam: "main", cp: 0xe020 });
  out.push({ name: "minus (arrow shaft)", fam: "main", cp: 0x2212 });
  out.push({ name: "equals (double shaft)", fam: "main", cp: 0x3d });
  return out;
}
