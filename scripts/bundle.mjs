#!/usr/bin/env node
/**
 * Bundles the compiled modules under dist/src into one script,
 * dist/texwright-core.js, and writes the files that load it:
 * dist/texwright.mjs (the library API of dist/src/index.js, and the loader,
 * which compiles the script with a V8 code cache), dist/cli.mjs (the
 * package's bin) and dist/worker.mjs (runIsolated()'s worker threads).
 *
 * Node spends most of a short run (texwright --version, check) finding,
 * reading and compiling some 200 small ES modules. One file loads in a
 * fraction of that time, and a module is only evaluated once something
 * calls into it (see LAZY below), so a short command evaluates a third of
 * them or fewer.
 *
 * The compiled output is regular enough that no JavaScript parser is needed:
 * every import and export is a statement at column 0, imports are named
 * imports (or the default import of a Node built-in), and there are no
 * default exports. A small scanner that knows
 * strings, template literals, comments and regular expressions finds them;
 * anything outside that shape stops the build with an error rather than
 * producing a bundle that behaves differently.
 *
 * Each module becomes a function that receives its exports object. It first
 * defines a getter for every export (function declarations are hoisted, so
 * a module caught in an import cycle already exposes its functions), then
 * loads its dependencies depth first in the order of its import statements,
 * as ES modules are evaluated, then runs its own code. Imports become
 * destructuring assignments from the dependency's exports object. That is a
 * snapshot rather than a live binding, which is the same thing as long as no
 * module reassigns an export (there is no `export let`) and import cycles
 * only reach functions; both are checked here. Each module's import.meta.url
 * still names its file under dist/src, so the package's fonts, themes and
 * hyphenation patterns are found exactly as before.
 *
 *   node scripts/bundle.mjs [--dist dist] [--verbose]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { dist: { type: "string", default: "dist" }, verbose: { type: "boolean" } } });
const dist = resolve(values.dist);
const srcDir = join(dist, "src");
const BUNDLE = "texwright.mjs";
const CORE = "texwright-core.js";
const ENTRY_MODULE = "index.js";

function fail(message) {
  process.stderr.write(`bundle: ${message}\n`);
  process.exit(1);
}

function listModules(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listModules(full));
    else if (entry.name.endsWith(".js")) out.push(relative(srcDir, full).split(sep).join("/"));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scanner

const REGEX_AFTER_WORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const isIdStart = (c) => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
const isIdPart = (c) => /[\w$]/.test(c) || c.charCodeAt(0) > 127;

/**
 * Finds, in compiled module text, the import and export statements at the top
 * level (column 0, outside any bracket, string, template or comment), the
 * `import.meta` expressions and the dynamic `import("...")` calls.
 */
function scan(src, file) {
  const top = []; // { start, end, text } statements beginning with import/export
  const metas = []; // start offsets of "import.meta"
  const dynamic = []; // { start, end, spec }
  const comments = []; // { start, end }
  const literals = []; // { start, end, tag? } text of strings, template literals (tag: the word before a tagged one) and regular expressions
  const tags = []; // for each open template literal, the word that tags it ("" for none)
  const stack = []; // open brackets; "t" marks a template literal's ${
  let last = ""; // the last significant token: a word, "num", or a punctuation character
  let open = -1; // start of a top-level statement whose ";" has not been seen
  let i = 0;
  const n = src.length;
  const where = (pos) => `${file}:${src.slice(0, pos).split("\n").length}`;

  // Scans a template literal's text from i (just after ` or }) to its end or next ${.
  const template = () => {
    const from = i;
    const tag = tags[tags.length - 1];
    for (;;) {
      if (i >= n) fail(`${where(i)}: unterminated template literal`);
      const c = src[i];
      if (c === "\\") i += 2;
      else if (c === "`") {
        literals.push({ start: from, end: i, tag });
        tags.pop();
        i++;
        last = "str";
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        literals.push({ start: from, end: i, tag });
        i += 2;
        stack.push("t");
        last = "{";
        return;
      } else i++;
    }
  };

  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      comments.push({ start: i, end: nl < 0 ? n : nl });
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) fail(`${where(i)}: unterminated comment`);
      comments.push({ start: i, end: end + 2 });
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (src[j] === "\n") fail(`${where(i)}: unterminated string`);
        j++;
      }
      literals.push({ start: i, end: j });
      i = j + 1;
      last = "str";
      continue;
    }
    if (c === "`") {
      // Tagged when it follows a value (a name, or a closing bracket) rather than an operator or keyword.
      tags.push((isIdPart(last[0] ?? "") && !["num", "str", "regex"].includes(last) && !REGEX_AFTER_WORD.has(last)) || (last.length === 1 && ")]".includes(last)) ? last : "");
      i++;
      template();
      continue;
    }
    if (c === "/") {
      const regex = last === "" || (last.length === 1 && !")]}".includes(last) && !isIdPart(last)) || REGEX_AFTER_WORD.has(last);
      if (regex) {
        let j = i + 1;
        let cls = false;
        for (; j < n; j++) {
          const d = src[j];
          if (d === "\\") j++;
          else if (d === "\n") fail(`${where(i)}: unterminated regular expression`);
          else if (cls) cls = d !== "]";
          else if (d === "[") cls = true;
          else if (d === "/") break;
        }
        literals.push({ start: i, end: j });
        i = j + 1;
        while (i < n && isIdPart(src[i])) i++;
        last = "regex";
        continue;
      }
      i++;
      last = "/";
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      while (i < n && (isIdPart(src[i]) || src[i] === ".")) i++;
      last = "num";
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < n && isIdPart(src[j])) j++;
      const word = src.slice(i, j);
      const afterDot = last === ".";
      if (word === "import" && !afterDot) {
        const rest = src.slice(j);
        if (/^\s*\.\s*meta\b/.test(rest)) {
          metas.push({ start: i, end: j + /^\s*\.\s*meta/.exec(rest)[0].length });
        } else if (/^\s*\(/.test(rest)) {
          const m = /^import\(\s*(["'])([^"'\n]+)\1\s*\)/.exec(src.slice(i));
          if (!m) fail(`${where(i)}: dynamic import() needs a string literal`);
          dynamic.push({ start: i, end: i + m[0].length, spec: m[2] });
        }
      }
      if ((word === "import" || word === "export") && !afterDot && stack.length === 0 && (i === 0 || src[i - 1] === "\n") && open < 0) {
        const rest = src.slice(j);
        if (!/^\s*[.(]/.test(rest)) open = i;
      }
      i = j;
      last = word;
      continue;
    }
    // Punctuation.
    if (c === "{" || c === "(" || c === "[") stack.push(c);
    else if (c === "}" || c === ")" || c === "]") {
      const want = c === "}" ? "{" : c === ")" ? "(" : "[";
      const got = stack.pop();
      if (got === "t" && c === "}") {
        i++;
        template();
        continue;
      }
      if (got !== want) fail(`${where(i)}: unbalanced "${c}"`);
    } else if (c === ";" && stack.length === 0 && open >= 0) {
      top.push({ start: open, end: i + 1, text: src.slice(open, i + 1) });
      open = -1;
    }
    // A declaration ("export function f() {", "export class C {") has no ";"
    // of its own: close it as soon as its first bracket opens.
    if (open >= 0 && stack.length === 1 && (c === "{" || c === "(") && /^export\s+(async\s+)?(function|class)\b/.test(src.slice(open, i))) {
      top.push({ start: open, end: open, text: src.slice(open, i) });
      open = -1;
    }
    last = c;
    i++;
  }
  if (stack.length) fail(`${file}: unbalanced brackets at end of file`);
  if (open >= 0) fail(`${where(open)}: statement without ";"`);
  return { top, metas, dynamic, comments, literals };
}

// ---------------------------------------------------------------------------
// Module analysis

const IDENT = "[A-Za-z_$][\\w$]*";
const BUILTINS = new Set(builtinModules);

/** "a, b as c," -> [["a", "a"], ["b", "c"]] (imported or exported name, local name). */
function specifiers(list, where) {
  const out = [];
  for (const part of list.split(",")) {
    const s = part.trim();
    if (!s) continue;
    const m = new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`).exec(s);
    if (!m) fail(`${where}: cannot read "${s}"`);
    if (m[1] === "default" || m[2] === "default") fail(`${where}: default imports and exports are not supported`);
    out.push([m[1], m[2] ?? m[1]]);
  }
  return out;
}

function analyse(file, raw) {
  // The shebang and the source map comment are dropped; everything else is kept.
  const src = raw.replace(/^#!.*\n/, "").replace(/\n\/\/# sourceMappingURL=\S*\s*$/, "\n");
  const where = (pos) => `${file}:${src.slice(0, pos).split("\n").length}`;
  if (/\b__tw_/.test(src)) fail(`${file}: uses the prefix __tw_ that the bundle reserves`);
  const { top, metas, dynamic, comments, literals } = scan(src, file);
  const mod = {
    file,
    src,
    edits: [], // [start, end, replacement]
    deps: [], // in statement order: { spec, names: [[imported, local]] | null, namespace?: string }
    locals: new Map(), // exported name -> { local, kind }
    reexports: new Map(), // exported name -> { spec, name }
    stars: [], // specs of export * from
    dynamic,
    metas,
    comments,
    literals,
  };
  const resolveSpec = (spec, pos) => {
    if (spec.startsWith("./") || spec.startsWith("../")) {
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      return target;
    }
    const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
    if (BUILTINS.has(bare)) return `node:${bare}`;
    fail(`${where(pos)}: "${spec}" is neither a relative path nor a Node built-in`);
  };
  for (const st of top) {
    const at = where(st.start);
    const text = st.text.replace(/\s+/g, " ").trim();
    let m;
    if ((m = new RegExp(`^export (async function\\*?|function\\*?|class|const) (${IDENT})`).exec(text))) {
      if (m[1] === "const" && !new RegExp(`^export const ${IDENT} =`).test(text)) fail(`${at}: only "export const name = ..." is supported`);
      mod.edits.push([st.start, st.start + "export ".length, ""]);
      mod.locals.set(m[2], { local: m[2], kind: m[1].includes("function") ? "function" : m[1] });
    } else if (/^export (let|var|default)\b/.test(text)) {
      fail(`${at}: "${text.slice(0, 20)}..." is not supported (exports must not be reassigned)`);
    } else if ((m = /^import \{([^}]*)\} from (["'])([^"']+)\2 ?;$/.exec(text))) {
      mod.deps.push({ spec: resolveSpec(m[3], st.start), names: specifiers(m[1], at) });
      mod.edits.push([st.start, st.end, ""]);
    } else if ((m = new RegExp(`^import \\* as (${IDENT}) from (["'])([^"']+)\\2 ?;$`).exec(text))) {
      mod.deps.push({ spec: resolveSpec(m[3], st.start), names: null, namespace: m[1] });
      mod.edits.push([st.start, st.end, ""]);
    } else if ((m = new RegExp(`^import (${IDENT}) from (["'])(node:[^"']+)\\2 ?;$`).exec(text))) {
      // The default export of a Node built-in is the module itself.
      mod.deps.push({ spec: resolveSpec(m[3], st.start), names: null, namespace: m[1] });
      mod.edits.push([st.start, st.end, ""]);
    } else if ((m = /^import (["'])([^"']+)\1 ?;$/.exec(text))) {
      mod.deps.push({ spec: resolveSpec(m[2], st.start), names: [] });
      mod.edits.push([st.start, st.end, ""]);
    } else if ((m = /^export \{([^}]*)\} from (["'])([^"']+)\2 ?;$/.exec(text))) {
      const spec = resolveSpec(m[3], st.start);
      mod.deps.push({ spec, names: [] });
      for (const [name, as] of specifiers(m[1], at)) mod.reexports.set(as, { spec, name });
      mod.edits.push([st.start, st.end, ""]);
    } else if ((m = /^export \* from (["'])([^"']+)\1 ?;$/.exec(text))) {
      const spec = resolveSpec(m[2], st.start);
      mod.deps.push({ spec, names: [] });
      mod.stars.push(spec);
      mod.edits.push([st.start, st.end, ""]);
    } else if ((m = /^export \{([^}]*)\} ?;$/.exec(text))) {
      for (const [local, as] of specifiers(m[1], at)) mod.locals.set(as, { local, kind: "binding" });
      mod.edits.push([st.start, st.end, ""]);
    } else {
      fail(`${at}: unsupported statement "${text.slice(0, 60)}"`);
    }
  }
  for (const d of dynamic) d.target = resolveSpec(d.spec, d.start);
  return mod;
}

// ---------------------------------------------------------------------------
// Bundle

const files = listModules(srcDir).sort();
const mods = new Map(files.map((f) => [f, analyse(f, readFileSync(join(srcDir, f), "utf8"))]));
const index = new Map(files.map((f, k) => [f, k]));
for (const mod of mods.values()) {
  for (const d of [...mod.deps, ...mod.dynamic.map((x) => ({ spec: x.target }))]) {
    if (!d.spec.startsWith("node:") && !mods.has(d.spec)) fail(`${mod.file}: imports missing module "${d.spec}"`);
  }
}

/** Every name a module exports, with where it finally comes from. */
const exportCache = new Map();
function exportsOf(file, seen = new Set()) {
  if (exportCache.has(file)) return exportCache.get(file);
  if (seen.has(file)) fail(`export * cycle through ${file}`);
  seen.add(file);
  const mod = mods.get(file);
  const out = new Map(); // name -> { file, local, kind } for local declarations, or { via: spec, name }
  for (const [name, l] of mod.locals) out.set(name, { file, ...l });
  for (const [name, r] of mod.reexports) out.set(name, { via: r.spec, name: r.name });
  const fromStars = new Map();
  for (const spec of mod.stars) {
    for (const [name] of exportsOf(spec, seen)) {
      if (out.has(name)) continue;
      if (fromStars.has(name) && fromStars.get(name) !== spec) fail(`${file}: "${name}" comes from two export * statements`);
      fromStars.set(name, spec);
    }
  }
  for (const [name, spec] of fromStars) out.set(name, { via: spec, name });
  seen.delete(file);
  exportCache.set(file, out);
  return out;
}

/** The declaration an exported name refers to, following re-exports. */
function origin(file, name) {
  for (let k = 0; k < 50; k++) {
    const e = exportsOf(file).get(name);
    if (!e) return undefined;
    if (!e.via) return e;
    file = e.via;
    name = e.name;
  }
  fail(`re-export chain too long for ${name}`);
}

for (const mod of mods.values()) {
  for (const d of mod.deps) {
    if (d.spec.startsWith("node:") || !d.names) continue;
    for (const [name] of d.names) if (!exportsOf(d.spec).has(name)) fail(`${mod.file}: "${d.spec}" does not export ${name}`);
  }
}

// Import cycles (strongly connected components of the static import graph).
// A module reached again while it is still being evaluated has its functions
// ready (they are hoisted) but not its constants and classes. Imports of those
// across a cycle are therefore bound once the other module has finished:
// before that they read undefined where an ES module would throw, and no
// module here reads them during evaluation.
{
  const order = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const component = new Map();
  let counter = 0;
  const visit = (f) => {
    order.set(f, counter);
    low.set(f, counter++);
    stack.push(f);
    onStack.add(f);
    for (const d of mods.get(f).deps) {
      if (d.spec.startsWith("node:")) continue;
      if (!order.has(d.spec)) {
        visit(d.spec);
        low.set(f, Math.min(low.get(f), low.get(d.spec)));
      } else if (onStack.has(d.spec)) low.set(f, Math.min(low.get(f), order.get(d.spec)));
    }
    if (low.get(f) === order.get(f)) {
      const members = [];
      let g;
      do {
        g = stack.pop();
        onStack.delete(g);
        members.push(g);
      } while (g !== f);
      for (const m of members) component.set(m, members);
    }
  };
  for (const f of files) if (!order.has(f)) visit(f);
  for (const mod of mods.values()) {
    const members = component.get(mod.file);
    if (members.length < 2) continue;
    for (const d of mod.deps) {
      if (!members.includes(d.spec)) continue;
      if (!d.names) fail(`${mod.file}: namespace import inside an import cycle`);
      d.deferred = d.names.filter(([name]) => origin(d.spec, name).kind !== "function");
      d.names = d.names.filter(([name]) => origin(d.spec, name).kind === "function");
    }
  }
}

// Lazy evaluation. Most commands use a fraction of the code: a check of a
// short Markdown file needs no PDF writer, TikZ, Mermaid or rasterizer. An
// import into one of the units below from outside that unit is therefore not
// evaluated with the importing module but on the first call through it, when
// every name it imports is a function that the importer only ever calls. The
// imported name starts as a stand-in that loads the module, replaces itself
// with the real function and forwards the call, so later calls go straight
// to the function. Within a unit, and for imports of anything else (classes,
// constants, a name also used as a value), modules load as before. Modules
// in these units have no top-level side effects outside their own unit.
const LAZY = [
  "index.js",
  "isolate.js",
  "mcp.js",
  "cite/",
  "diagram/",
  "font/",
  "layout/",
  "math/",
  "parse/latex",
  "pdf/",
  "pstricks/",
  "raster/",
  "svg/",
  "tikz/",
  "typeset/",
  "util/highlight.js",
  "util/yaml.js",
];
const lazyUnit = (file) => LAZY.find((prefix) => file.startsWith(prefix));

/** The declaration behind an exported name, also through `export { name }` of an imported binding, with the name its module exports it under. */
function declaration(file, name) {
  for (let k = 0; k < 50; k++) {
    let e = origin(file, name);
    if (!e) return e;
    // origin() follows re-exports: find the name under which the declaring module exports it.
    const own = [...exportsOf(e.file)].find(([, x]) => !x.via && x.local === e.local)?.[0] ?? name;
    e = { ...e, name: own };
    if (e.kind !== "binding") return e;
    const dep = mods.get(e.file).deps.find((d) => d.names?.some(([, local]) => local === e.local));
    if (!dep || dep.spec.startsWith("node:")) return e;
    file = dep.spec;
    name = dep.names.find(([, local]) => local === e.local)[0];
  }
  fail(`re-export chain too long for ${name}`);
}

/** Whether every use of name in a module's code, outside literals, comments and its import statements, is a call. */
function onlyCalled(mod, name) {
  const skip = [...mod.literals, ...mod.comments, ...mod.edits.filter(([start, end]) => end > start).map(([start, end]) => ({ start, end }))];
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, "\\$")}(?![\\w$])`, "g");
  for (const m of mod.src.matchAll(re)) {
    if (skip.some((r) => m.index >= r.start && m.index < r.end)) continue;
    if (!/^\s*\(/.test(mod.src.slice(m.index + name.length, m.index + name.length + 40))) return false;
    if (/\bnew\s*$/.test(mod.src.slice(Math.max(0, m.index - 20), m.index))) return false;
  }
  return true;
}

const eagerEdges = []; // imports into a lazy unit that load eagerly, and why
for (const mod of mods.values()) {
  for (const d of mod.deps) {
    const unit = d.spec.startsWith("node:") ? undefined : lazyUnit(d.spec);
    if (!unit || lazyUnit(mod.file) === unit) continue;
    const why = !d.names
      ? "namespace import"
      : !d.names.length
        ? "import or re-export without names"
        : d.deferred?.length
          ? "import cycle"
          : (d.names.find(([name]) => declaration(d.spec, name)?.kind !== "function")?.[0] ?? d.names.find(([, local]) => !onlyCalled(mod, local))?.[1]);
    if (why) eagerEdges.push(`${mod.file} -> ${d.spec}: ${why}`);
    else d.lazy = true;
  }
}

const builtins = new Set();
const jsString = (s) => JSON.stringify(s);
const pattern = (names) => `{ ${names.map(([a, b]) => (a === b ? a : `${a}: ${b}`)).join(", ")} }`;
/** A stand-in for a lazily imported function: loads module k, puts the function in its place and calls it. */
const standIn = (k, name, local) => `let ${local} = function () { ${local} = __tw_load(${k}).${name}; return ${local}.apply(this, arguments); };`;

/** \uXXXX for each UTF-16 unit of a text. */
const unicodeEscape = (ch) => Array.from({ length: ch.length }, (_, k) => `\\u${ch.charCodeAt(k).toString(16).padStart(4, "0")}`).join("");

/**
 * Edits that spell every character beyond ASCII as an escape. Node decodes a
 * source file that is all ASCII several times faster, and V8 keeps it as a
 * one-byte string. In a raw template literal (String.raw) the character
 * becomes a substitution instead, which reads the same.
 */
function asciiEdits(mod, taken) {
  const edits = [];
  for (let p = 0; p < mod.src.length; p++) {
    if (mod.src.charCodeAt(p) < 128) continue;
    const ch = String.fromCodePoint(mod.src.codePointAt(p));
    const at = p;
    p += ch.length - 1;
    if (taken.some(([start, end]) => at >= start && at < end)) continue;
    const lit = mod.literals.find((l) => at >= l.start && at < l.end);
    if (lit?.tag) {
      if (lit.tag !== "raw") fail(`${mod.file}: a character beyond ASCII in a template literal tagged ${lit.tag}`);
      edits.push([at, at + ch.length, `\${"${unicodeEscape(ch)}"}`]);
      continue;
    }
    let slashes = 0;
    while (mod.src[at - 1 - slashes] === "\\") slashes++;
    // A character after a backslash means the character itself, in strings and regular expressions alike.
    edits.push(slashes % 2 ? [at - 1, at + ch.length, unicodeEscape(ch)] : [at, at + ch.length, unicodeEscape(ch)]);
  }
  return edits;
}

function emitModule(mod) {
  const k = index.get(mod.file);
  const head = [];
  const names = [...exportsOf(mod.file).keys()].sort();
  if (names.length) {
    const getters = names.map((name) => {
      const e = exportsOf(mod.file).get(name);
      const get = e.via ? `() => __tw_ex[${index.get(e.via)}].${e.name}` : `() => ${e.local}`;
      return `${jsString(name)}, ${get}`;
    });
    head.push(`__tw_define(__tw_exports, [${getters.join(", ")}]);`);
  }
  // Stand-ins first: a module that an eager import below loads may call back into this one.
  for (const d of mod.deps) if (d.lazy) for (const [name, local] of d.names) head.push(standIn(index.get(d.spec), name, local));
  for (const d of mod.deps) {
    if (d.lazy) continue;
    if (d.spec.startsWith("node:")) {
      builtins.add(d.spec);
      if (d.namespace) head.push(`const ${d.namespace} = __tw_require(${jsString(d.spec)});`);
      else if (d.names.length) head.push(`const ${pattern(d.names)} = __tw_require(${jsString(d.spec)});`);
      continue;
    }
    const dep = index.get(d.spec);
    const load = `__tw_load(${dep})`;
    if (d.namespace) head.push(`const ${d.namespace} = ${load};`);
    else if (d.names.length) head.push(`const ${pattern(d.names)} = ${load};`);
    else head.push(`${load};`);
    if (d.deferred?.length) {
      head.push(`let ${d.deferred.map(([, b]) => b).join(", ")};`);
      head.push(`__tw_bind(${dep}, () => (${pattern(d.deferred)} = __tw_ex[${dep}]));`);
    }
  }
  if (mod.metas.length) head.push(`const __tw_meta = { url: new URL(${jsString(`./src/${mod.file}`)}, __tw_url).href, texwrightWorker: __tw_worker };`);

  // Comments go: the bundle is for running, and dist/src keeps them. A comment
  // on lines of its own goes with its line breaks.
  const removed = mod.edits.filter(([start, end]) => end > start);
  const comments = mod.comments
    .filter((c) => !removed.some(([start, end]) => c.start >= start && c.end <= end))
    .map((c) => {
      const lineStart = mod.src.lastIndexOf("\n", c.start - 1) + 1;
      const eol = mod.src.startsWith("\r\n", c.end) ? 2 : mod.src[c.end] === "\n" ? 1 : c.end === mod.src.length ? 0 : -1;
      if (eol >= 0 && /^[ \t]*$/.test(mod.src.slice(lineStart, c.start))) return [lineStart, c.end + eol, ""];
      return [c.start, c.end, mod.src[c.start + 1] === "*" ? " " : ""];
    });
  const edits = [
    ...mod.edits,
    ...comments,
    ...mod.metas.map((m) => [m.start, m.end, "__tw_meta"]),
    ...mod.dynamic.map((d) => [d.start, d.end, `__tw_import(${index.get(d.target)})`]),
  ];
  edits.push(...asciiEdits(mod, edits));
  edits.sort((a, b) => a[0] - b[0]);
  let body = "";
  let at = 0;
  for (const [start, end, text] of edits) {
    if (start < at) fail(`${mod.file}: overlapping edits`);
    body += mod.src.slice(at, start) + text;
    at = end;
  }
  body += mod.src.slice(at);
  body = body.replace(/^\n+/, "").replace(/\s+$/, "");
  return `// ${mod.file}\n__tw_fns[${k}] = function (__tw_exports) {\n${head.join("\n")}\n${body}\n};\n`;
}

const bodies = files.map((f) => emitModule(mods.get(f)));

// The bundle is a classic script rather than an ES module: texwright.mjs compiles it with a V8 code
// cache made after a run, so later runs skip compiling every function that run used (Node's own
// compile cache keeps only what is compiled before the code runs, the outermost function).
const core = [
  "// texwright, every module of dist/src in one script, run by texwright.mjs next to it. Generated by scripts/bundle.mjs; do not edit.",
  "(function (__tw_url, __tw_createRequire) {",
  '"use strict";',
  "// Node's built-in modules load when a module that uses them is evaluated, as CommonJS: an ES import of",
  "// one first reads every export (node:crypto then sets up Web Crypto), and some cost milliseconds to load.",
  'const __tw_require = typeof process.getBuiltinModule === "function" ? (id) => process.getBuiltinModule(id) : __tw_createRequire(__tw_url);',
  "",
  `const __tw_paths = ${JSON.stringify(Object.fromEntries(files.map((f, k) => [f, k])))};`,
  `const __tw_fns = new Array(${files.length});`,
  `const __tw_ex = Array.from({ length: ${files.length} }, () => Object.create(null, { [Symbol.toStringTag]: { value: "Module" } }));`,
  `const __tw_state = new Array(${files.length}).fill(0);`,
  "const __tw_errors = [];",
  "const __tw_pending = [];",
  "/** Runs bind now if module k has been evaluated, or else as soon as it has (imports across an import cycle). */",
  "function __tw_bind(k, bind) {",
  "  if (__tw_state[k] === 2) bind();",
  "  else (__tw_pending[k] ??= []).push(bind);",
  "}",
  'const __tw_worker = new URL("./worker.mjs", __tw_url).href;',
  "function __tw_define(target, pairs) {",
  "  for (let k = 0; k < pairs.length; k += 2) Object.defineProperty(target, pairs[k], { get: pairs[k + 1], enumerable: true });",
  "}",
  "/** Evaluates a module once, like an ES module import; a module already being evaluated (a cycle) is returned as it stands. */",
  "function __tw_load(k) {",
  "  const state = __tw_state[k];",
  "  if (state === 3) throw __tw_errors[k];",
  "  if (state === 0) {",
  "    __tw_state[k] = 1;",
  "    try {",
  "      __tw_fns[k](__tw_ex[k]);",
  "    } catch (e) {",
  "      __tw_state[k] = 3;",
  "      __tw_errors[k] = e;",
  "      throw e;",
  "    }",
  "    __tw_state[k] = 2;",
  "    if (__tw_pending[k]) for (const bind of __tw_pending[k]) bind();",
  "  }",
  "  return __tw_ex[k];",
  "}",
  "const __tw_import = (k) => Promise.resolve().then(() => __tw_load(k));",
  "",
  ...bodies,
  "return {",
  "  /** The exports of a module of dist/src by its path there, e.g. \"cli.js\". */",
  "  module(path) {",
  "    const k = __tw_paths[path];",
  '    if (k === undefined) throw new Error(`texwright bundle: no module ${path}`);',
  "    return __tw_load(k);",
  "  },",
  "  /** The modules evaluated so far. */",
  "  loaded: () => Object.keys(__tw_paths).filter((path) => __tw_state[__tw_paths[path]] === 2),",
  "};",
  "})",
  "",
].join("\n");
if (/[^\x00-\x7f]/.test(core)) fail("the bundle is not all ASCII");
// Caches are keyed by the package version and a hash of the bundle, so nothing compiled for another
// version or build is ever reused.
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const buildId = `${VERSION}-${createHash("sha256").update(core).digest("hex").slice(0, 12)}`;

/** The library API: a function loads its module on its first call and then takes the place of its stand-in. */
function apiExports() {
  const lines = [];
  for (const name of [...exportsOf(ENTRY_MODULE).keys()].sort()) {
    const d = declaration(ENTRY_MODULE, name);
    const from = `__tw_core.module(${jsString(d?.file ?? ENTRY_MODULE)})`;
    if (d?.kind === "function") lines.push(`export let ${name} = function () { ${name} = ${from}.${d.name}; return ${name}.apply(this, arguments); };`);
    else lines.push(`export const ${name} = ${from}.${d?.name ?? name};`);
  }
  return lines;
}

// The code cache lives in the user's own cache folder (not the shared temp folder: another user could
// plant code there), one file per bundle build, V8 version and architecture. It is only used when an
// entry asks for it, and only the command line writes it: at exit, when there was none, V8 turned it
// down, or the run loaded modules that the cache does not cover yet, in runs shorter than a minute
// (a long-running server's code is no guide to a short command's). NODE_DISABLE_COMPILE_CACHE=1
// turns it off.
const loader = `// texwright, the library API over the single-file bundle texwright-core.js. Generated by scripts/bundle.mjs; do not edit.
import { createRequire } from "node:module";

const builtin = typeof process.getBuiltinModule === "function" ? (id) => process.getBuiltinModule(id) : createRequire(import.meta.url);
const BUILD = ${jsString(buildId)};

/** The code cache file, or undefined when the entry did not ask for one. */
function cacheFile(path, os) {
  const mode = globalThis[Symbol.for("texwright.codeCache")];
  if (!mode || process.env.NODE_DISABLE_COMPILE_CACHE) return undefined;
  const env = process.env;
  const dir =
    process.platform === "win32"
      ? path.join(env.LOCALAPPDATA || os.tmpdir(), "texwright", "cache")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Caches", "texwright")
        : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "texwright");
  return { mode, dir, file: path.join(dir, \`\${BUILD}-\${process.arch}-v8-\${process.versions.v8}.bin\`) };
}

function loadCore() {
  const fs = builtin("node:fs");
  const path = builtin("node:path");
  const url = new URL("./texwright-core.js", import.meta.url);
  const filename = builtin("node:url").fileURLToPath(url);
  // All ASCII (scripts/bundle.mjs makes sure), which reads several times faster as latin1 than as UTF-8.
  const source = fs.readFileSync(filename, "latin1");
  const cache = cacheFile(path, builtin("node:os"));
  let cachedData;
  let covered = [];
  if (cache) {
    try {
      // A line of JSON (the modules the cache covers), then V8's data.
      const buf = fs.readFileSync(cache.file);
      const nl = buf.indexOf(10);
      covered = JSON.parse(buf.subarray(0, nl).toString());
      cachedData = buf.subarray(nl + 1);
    } catch {
      cachedData = undefined;
    }
  }
  const script = new (builtin("node:vm").Script)(source, { filename, cachedData });
  const core = script.runInThisContext()(import.meta.url, createRequire);
  if (cache?.mode === "write") {
    process.once("exit", () => {
      const loaded = core.loaded();
      const stale = !cachedData || script.cachedDataRejected || loaded.some((m) => !covered.includes(m));
      if (!stale || process.uptime() > 60) return;
      try {
        const modules = [...new Set([...covered, ...loaded])].sort();
        fs.mkdirSync(cache.dir, { recursive: true, mode: 0o700 });
        const tmp = \`\${cache.file}.\${process.pid}.tmp\`;
        fs.writeFileSync(tmp, Buffer.concat([Buffer.from(\`\${JSON.stringify(modules)}\\n\`), script.createCachedData()]), { mode: 0o600 });
        fs.renameSync(tmp, cache.file);
      } catch {
        // No cache: only slower.
      }
    });
  }
  return core;
}

const __tw_core = loadCore();
/** The exports of a module of dist/src by its path there, e.g. "cli.js"; for the entry files next to this one. */
export const __texwrightModule = (path) => __tw_core.module(path);
/** The modules of dist/src evaluated so far, for tests and scripts/startup-profile.mjs. */
export const __texwrightLoaded = () => __tw_core.loaded();
${apiExports().join("\n")}
`;

// The entries turn on Node's compile cache (Node 22.1+) for the small ES modules, in a folder of this
// build's own; ask texwright.mjs for the code cache of the bundle; and load it. Only the command line
// writes the code cache. NODE_DISABLE_COMPILE_CACHE=1 turns both off.
const entry = (comment, module, shebang, mode) => `${shebang ? "#!/usr/bin/env node\n" : ""}// ${comment} Generated by scripts/bundle.mjs.
import nodeModule from "node:module";
if (nodeModule.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    const require = nodeModule.createRequire(import.meta.url);
    nodeModule.enableCompileCache(require("node:path").join(require("node:os").tmpdir(), "texwright-compile-cache", ${jsString(buildId)}));
  } catch {
    // No cache: only slower.
  }
}
globalThis[Symbol.for("texwright.codeCache")] = ${jsString(mode)};
const { __texwrightModule } = await import("./${BUNDLE}");
__texwrightModule(${jsString(module)});
`;

writeFileSync(join(dist, CORE), core);
writeFileSync(join(dist, BUNDLE), loader);
writeFileSync(join(dist, "cli.mjs"), entry("The texwright command line, loaded from the single-file bundle.", "cli.js", true, "write"));
writeFileSync(join(dist, "worker.mjs"), entry("Worker thread entry for runIsolated(), loaded from the single-file bundle.", "worker.js", false, "read"));

for (const file of [CORE, BUNDLE]) {
  const syntax = spawnSync(process.execPath, ["--check", join(dist, file)], { encoding: "utf8" });
  if (syntax.status !== 0) fail(`${file} does not parse:\n${syntax.stderr}`);
}
if (values.verbose) for (const e of eagerEdges) process.stdout.write(`eager: ${e}\n`);
process.stdout.write(`bundle: ${files.length} modules -> ${relative(process.cwd(), join(dist, CORE))} (${Math.round(core.length / 1024)} KB)\n`);
