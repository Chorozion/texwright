/**
 * Smart typography for text: dashes, ellipses, (c) and friends, and curly
 * quotes. Code, math, raw LaTeX and HTML are never touched, and neither is
 * text that came from a backslash escape or a character reference (so `\--`
 * stays two hyphens and `&quot;` a straight quote).
 */

/** Whether any shorthand below can apply; most text has none and is returned untouched. */
function mayNeedReplacing(text: string): boolean {
  return (
    text.includes("--") ||
    text.includes("..") ||
    text.includes("+-") ||
    text.includes(",,") ||
    text.includes("????") ||
    text.includes("!!!!") ||
    /\((?:c|tm|r)\)/i.test(text)
  );
}

const SYMBOLS: Record<string, string> = { c: "©", r: "®", tm: "™" };

/** "(c)", "(r)" and "(tm)" in any letter case. */
function symbols(s: string): string {
  if (!s.includes("(")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") {
      const two = s.slice(i + 1, i + 3).toLowerCase();
      const three = s.slice(i + 1, i + 4).toLowerCase();
      if (three === "tm)") {
        out += SYMBOLS.tm;
        i += 3;
        continue;
      }
      if (two === "c)" || two === "r)") {
        out += SYMBOLS[two[0]!];
        i += 2;
        continue;
      }
    }
    out += s[i];
  }
  return out;
}

/** Maximal runs of characters passing `isRunChar`, at least `min` long, each replaced by what `fn` makes of it. */
function mapRuns(s: string, isRunChar: (c: string) => boolean, min: number, fn: (run: string) => string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (!isRunChar(s[i]!)) {
      out += s[i++];
      continue;
    }
    let j = i;
    while (j < s.length && isRunChar(s[j]!)) j++;
    const run = s.slice(i, j);
    out += run.length >= min ? fn(run) : run;
    i = j;
  }
  return out;
}

const LINE_BREAKS = "\n\r  ";
const isBlank = (c: string): boolean => /\s/.test(c);

/** Dashes, ellipses and symbol shorthands in one run of text. */
export function replaceTypography(text: string): string {
  if (!mayNeedReplacing(text)) return text;
  let s = symbols(text);
  s = s.split("+-").join("±");
  s = mapRuns(s, (c) => c === ".", 2, () => "…");
  // An ellipsis right after "?" or "!" is written as two dots ("?.." rather than "?…").
  let t = "";
  for (let i = 0; i < s.length; i++) {
    if ((s[i] === "?" || s[i] === "!") && s[i + 1] === "…") {
      t += `${s[i]}..`;
      i++;
    } else t += s[i];
  }
  // Four or more "?" and "!" in a row shrink to three copies of the last one.
  s = mapRuns(t, (c) => c === "?" || c === "!", 4, (run) => run[run.length - 1]!.repeat(3));
  s = mapRuns(s, (c) => c === ",", 2, () => ",");
  return dashRuns(s);
}

/**
 * Hyphen runs: exactly three become an em dash. Exactly two become an en dash when the sides agree,
 * blank on both sides ("a -- b") or text on both ("1--2"), with the start or end of a line
 * counting as either; "a --b" keeps its hyphens. Longer runs are left alone.
 */
function dashRuns(s: string): string {
  if (!s.includes("--")) return s;
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s[i] !== "-") {
      out += s[i++];
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === "-") j++;
    const len = j - i;
    if (len === 3) out += "—";
    else if (len === 2) {
      const before = i === 0 || LINE_BREAKS.includes(s[i - 1]!) ? "edge" : isBlank(s[i - 1]!) ? "blank" : "text";
      const after = j === s.length || LINE_BREAKS.includes(s[j]!) ? "edge" : isBlank(s[j]!) ? "blank" : "text";
      const spaced = before !== "text" && after !== "text";
      const joined = before !== "blank" && after !== "blank";
      out += spaced || joined ? "–" : "--";
    } else out += s.slice(i, j);
    i = j;
  }
  return out;
}

/** One piece of a paragraph's text as the quote pass sees it. */
export interface QuoteAtom {
  /** Text that quotes may be changed in; other atoms only give context. */
  editable: boolean;
  text: string;
  /** Nesting depth (emphasis, links): quotes pair only at the same depth. */
  level: number;
  /** A line break: the text on either side counts as separated by blank space. */
  breaks?: boolean;
  set?(text: string): void;
}

const isAsciiPunctCode = (c: number): boolean => (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
const PUNCT = /[\p{P}\p{S}]/u;
const isPunctCode = (c: number): boolean => isAsciiPunctCode(c) || (c >= 128 && PUNCT.test(String.fromCharCode(c)));
const isSpaceCode = (c: number): boolean =>
  c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;

interface Opener {
  atom: number;
  at: number;
  single: boolean;
  level: number;
}

/**
 * Curly quotes. A quote can open when what follows is not blank space (and,
 * if it is punctuation, what precedes is blank or punctuation too), and can
 * close in the mirror case. A closer pairs with the nearest opener of the
 * same kind at the same depth; a single quote inside a word is an
 * apostrophe.
 */
export function smartQuotes(atoms: QuoteAtom[]): void {
  const stack: Opener[] = [];
  const texts = atoms.map((a) => a.text);
  for (let i = 0; i < atoms.length; i++) {
    const atom = atoms[i];
    if (!atom.editable) continue;
    const level = atom.level;
    while (stack.length && stack[stack.length - 1].level > level) stack.pop();
    let text = texts[i];
    let from = 0;
    outer: for (;;) {
      const q = findQuote(text, from);
      if (q < 0) break;
      from = q + 1;
      const single = text[q] === "'";
      const last = q > 0 ? text.charCodeAt(q - 1) : charBefore(atoms, texts, i);
      const next = q + 1 < text.length ? text.charCodeAt(q + 1) : charAfter(atoms, texts, i);
      const lastPunct = isPunctCode(last);
      const nextPunct = isPunctCode(next);
      const lastSpace = isSpaceCode(last);
      const nextSpace = isSpaceCode(next);
      let canOpen = true;
      let canClose = true;
      if (nextSpace) canOpen = false;
      else if (nextPunct && !(lastSpace || lastPunct)) canOpen = false;
      if (lastSpace) canClose = false;
      else if (lastPunct && !(nextSpace || nextPunct)) canClose = false;
      // 1"" : the first quote is an inch mark.
      if (next === 34 && !single && last >= 48 && last <= 57) canOpen = canClose = false;
      if (canOpen && canClose) {
        // Inside a run of punctuation quotes may turn; inside a word they do not.
        canOpen = lastPunct;
        canClose = nextPunct;
      }
      if (!canOpen && !canClose) {
        if (single) text = setChar(text, q, "’");
        continue;
      }
      if (canClose) {
        for (let j = stack.length - 1; j >= 0; j--) {
          const o = stack[j];
          if (o.level < level) break;
          if (o.single === single && o.level === level) {
            const open = single ? "‘" : "“";
            const close = single ? "’" : "”";
            if (o.atom === i) text = setChar(text, o.at, open);
            else texts[o.atom] = setChar(texts[o.atom], o.at, open);
            text = setChar(text, q, close);
            stack.length = j;
            continue outer;
          }
        }
      }
      if (canOpen) stack.push({ atom: i, at: q, single, level });
      else if (canClose && single) text = setChar(text, q, "’");
    }
    texts[i] = text;
  }
  atoms.forEach((a, i) => {
    if (a.editable && texts[i] !== a.text) a.set?.(texts[i]);
  });
}

function findQuote(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 39) return i;
  }
  return -1;
}

function setChar(s: string, at: number, ch: string): string {
  return s.slice(0, at) + ch + s.slice(at + 1);
}

/** The character before atom `i`, looking back over atoms without text; a line break counts as a space. */
function charBefore(atoms: QuoteAtom[], texts: string[], i: number): number {
  for (let j = i - 1; j >= 0; j--) {
    if (atoms[j].breaks) return 0x20;
    const t = texts[j];
    if (t) return t.charCodeAt(t.length - 1);
  }
  return 0x20;
}

function charAfter(atoms: QuoteAtom[], texts: string[], i: number): number {
  for (let j = i + 1; j < atoms.length; j++) {
    if (atoms[j].breaks) return 0x20;
    const t = texts[j];
    if (t) return t.charCodeAt(0);
  }
  return 0x20;
}
