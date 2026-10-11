/**
 * Reading TikZ source: a cursor over the picture's text with the balanced
 * group readers the grammar needs, and the splitting of option lists into
 * keys and values. Comments are blanked (not removed) before reading, so
 * offsets still point into the source the user wrote.
 */

export function stripComments(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) {
      out += c + s[i + 1];
      i += 2;
      continue;
    }
    if (c === "%") {
      const nl = s.indexOf("\n", i);
      const end = nl < 0 ? s.length : nl;
      out += " ".repeat(end - i);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const CLOSE: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

/**
 * Index of the bracket closing the one at `i` (which must be { [ or (), or -1.
 * Braces nest inside any kind; [ and ( count only their own kind, inside braces nothing but braces counts.
 */
export function matchClose(s: string, i: number): number {
  const open = s[i];
  const close = CLOSE[open];
  if (!close) return -1;
  let depth = 0;
  let brace = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      k++;
      continue;
    }
    if (open !== "{") {
      if (c === "{") {
        brace++;
        continue;
      }
      if (c === "}") {
        if (brace > 0) brace--;
        continue;
      }
      if (brace > 0) continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Splits at `sep` outside braces, brackets and parentheses. */
export function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      cur += c + (s[k + 1] ?? "");
      k++;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && s.startsWith(sep, k)) {
      out.push(cur);
      cur = "";
      k += sep.length - 1;
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Drops one pair of braces around the whole of `s`. */
export function unbrace(s: string): string {
  const t = s.trim();
  if (t.startsWith("{") && matchClose(t, 0) === t.length - 1) return t.slice(1, -1).trim();
  return t;
}

export interface KV {
  key: string;
  value: string | undefined;
}

/** An option list `a, b=c, d={e,f}` as keys and values (values unbraced). */
export function parseOptions(s: string): KV[] {
  const out: KV[] = [];
  for (const part of splitTop(s, ",")) {
    const t = part.trim();
    if (!t) continue;
    // The = of key=value, outside groups.
    let depth = 0;
    let eq = -1;
    for (let k = 0; k < t.length; k++) {
      const c = t[k];
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") depth--;
      else if (c === "=" && depth === 0) {
        eq = k;
        break;
      }
    }
    if (eq < 0) out.push({ key: t.replace(/\s+/g, " "), value: undefined });
    else out.push({ key: t.slice(0, eq).trim().replace(/\s+/g, " "), value: unbrace(t.slice(eq + 1)) });
  }
  return out;
}

/** A cursor over picture text. */
export class Scanner {
  i = 0;
  constructor(readonly s: string) {}

  get done(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  peek(): string {
    this.ws();
    return this.s[this.i] ?? "";
  }

  /** True (and consumed) when the text continues with `word`, not followed by a letter when it ends in one. */
  word(w: string): boolean {
    this.ws();
    if (!this.s.startsWith(w, this.i)) return false;
    const next = this.s[this.i + w.length] ?? "";
    if (/[A-Za-z]$/.test(w) && /[A-Za-z]/.test(next)) return false;
    this.i += w.length;
    return true;
  }

  startsWith(w: string): boolean {
    this.ws();
    return this.s.startsWith(w, this.i);
  }

  /** A balanced group starting here ({...}, [...] or (...)): its inside, or undefined. Advances past it. */
  group(open: "{" | "[" | "("): string | undefined {
    this.ws();
    if (this.s[this.i] !== open) return undefined;
    const e = matchClose(this.s, this.i);
    if (e < 0) {
      const inner = this.s.slice(this.i + 1);
      this.i = this.s.length;
      return inner;
    }
    const inner = this.s.slice(this.i + 1, e);
    this.i = e + 1;
    return inner;
  }

  /** Optional [options]. */
  options(): string | undefined {
    return this.group("[");
  }

  /** A control word here (\draw), without consuming, or undefined. */
  peekCommand(): string | undefined {
    this.ws();
    const m = /^\\([A-Za-z@]+\*?|.)/.exec(this.s.slice(this.i, this.i + 40));
    return m ? m[1] : undefined;
  }

  /** A word of letters and spaces up to a delimiter (for keywords like `controls`). */
  ident(): string {
    this.ws();
    const m = /^[A-Za-z]+/.exec(this.s.slice(this.i, this.i + 40));
    return m ? m[0] : "";
  }

  /** Text to the next `;` outside groups (the `;` is consumed, not returned). */
  statement(): string {
    const start = this.i;
    let depth = 0;
    for (let k = this.i; k < this.s.length; k++) {
      const c = this.s[k];
      if (c === "\\") {
        k++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) {
          // A closing brace of an enclosing group ends the statement too.
          this.i = k;
          return this.s.slice(start, k);
        }
        depth--;
      } else if (c === ";" && depth === 0) {
        this.i = k + 1;
        return this.s.slice(start, k);
      }
    }
    this.i = this.s.length;
    return this.s.slice(start);
  }
}
