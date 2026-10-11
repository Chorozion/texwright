/**
 * texwright watch: render a document, then render it again whenever it or
 * a file it uses changes, in the same warm process.
 *
 * The files to watch are the ones the last render actually read (or looked
 * for and did not find): the document, \input and \include files, images
 * and the images inside SVG figures, bibliographies, brand fonts, data
 * files of plots and stylesheets (src/util/reads.ts). Their folders are
 * watched rather than the files, so editors that save by writing a new
 * file and renaming it over the old one, deleted files and files created
 * later are all seen. A burst of events is coalesced (debounce), renders
 * never overlap, and an event that changed nothing (same size and time) is
 * ignored. Output is written to a temporary file and renamed over the
 * target, so a viewer never sees half a PDF. Layout caches
 * (src/typeset/cache.ts) make each render after the first redo only what
 * the edit touched; after each render, entries the last two renders did not
 * use are dropped, so a long session holds about one document's worth.
 */

import { type FSWatcher, existsSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type Diagnostic, Diagnostics, formatCompact } from "./diagnostics.js";
import { type ConvertOptions, convert } from "./index.js";
import { sweepCaches } from "./util/lru.js";
import { trackReads } from "./util/reads.js";

export interface WatchOptions {
  /** How each render is reported: pretty (stderr), compact (one line per problem) or json (one object per line). */
  diagnostics?: "pretty" | "compact" | "json";
  /** Quiet time after the last change before rendering, in ms (default 30). */
  debounceMs?: number;
  /** Only report renders with problems. */
  quiet?: boolean;
  /** Where report lines go (default stdout, stderr for pretty). */
  write?: (text: string) => void;
  /** Called after every render (tests, embedding). */
  onRender?: (r: WatchRender) => void;
  /** Stops watching when aborted (besides Ctrl+C). */
  signal?: AbortSignal;
  /** Stop on Ctrl+C / SIGTERM (default true). */
  handleSignals?: boolean;
}

/** One render, as reported. */
export interface WatchRender {
  /** 1 for the first render. */
  n: number;
  /** Milliseconds from the start of the render to the output being in place. */
  ms: number;
  ok: boolean;
  pages?: number;
  errors: number;
  warnings: number;
  /** The output path, when it was written. */
  output?: string;
  diagnostics: Diagnostic[];
  /** Files the render read, the document first. */
  files: string[];
}

const MAX_DIRS = 256;
const caseless = process.platform === "win32" || process.platform === "darwin";
const norm = (p: string): string => (caseless ? resolve(p).toLowerCase() : resolve(p));

/** A file's size and change time, or "missing". */
function stamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}:${st.isDirectory() ? "d" : "f"}`;
  } catch {
    return "missing";
  }
}

/**
 * Watches and re-renders until stopped; resolves with the exit status (0)
 * when Ctrl+C, SIGTERM or `signal` stops it.
 */
export function watchDocument(opts: ConvertOptions & { input: string; output: string }, w: WatchOptions = {}): Promise<number> {
  const input = resolve(opts.input);
  const output = resolve(opts.output);
  const tmp = join(dirname(output), `.${basename(output)}.${process.pid}.tmp`);
  const mode = w.diagnostics ?? "compact";
  const debounce = Math.max(0, Math.min(w.debounceMs ?? 30, 10_000));
  const out = w.write ?? ((text: string) => (mode === "pretty" ? process.stderr : process.stdout).write(text));

  /** Normalized path -> the path, and its stamp when the last render started. */
  let deps = new Map<string, { path: string; stamp: string }>();
  const watchers = new Map<string, FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  let firstEvent = 0;
  let running = false;
  let pending = false;
  let stopped = false;
  let renders = 0;
  let resolveDone: (code: number) => void = () => {};
  const done = new Promise<number>((r) => (resolveDone = r));

  const say = (text: string) => {
    try {
      out(text);
    } catch {
      // A closed pipe must not stop the watch.
    }
  };

  /** Writes the output under a temporary name and renames it into place, retrying while a viewer holds the file. */
  const writeAtomic = async (data: string | Uint8Array): Promise<string | undefined> => {
    try {
      writeFileSync(tmp, data);
    } catch (e) {
      return `cannot write ${tmp}: ${(e as Error).message}`;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, output);
        return undefined;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (attempt >= 10 || stopped || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
          try {
            unlinkSync(tmp);
          } catch {
            // Already gone.
          }
          return `cannot replace ${output} (${code ?? (e as Error).message}); is it open in a program that locks it?`;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  };

  const report = (r: WatchRender, problem?: string) => {
    w.onRender?.(r);
    if (mode === "json") {
      // Memory in MB, to keep an eye on a long session.
      const mem = process.memoryUsage();
      const memory = { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576) };
      say(`${JSON.stringify({ render: r.n, time: new Date().toISOString(), ms: Math.round(r.ms), ok: r.ok, pages: r.pages, errors: r.errors, warnings: r.warnings, output: r.output, files: r.files.length, memory, ...(problem ? { problem } : {}), diagnostics: r.diagnostics })}\n`);
      return;
    }
    if (w.quiet && r.ok && !r.diagnostics.length && !problem) return;
    const time = new Date().toTimeString().slice(0, 8);
    const pages = r.pages !== undefined ? `, ${r.pages} page${r.pages === 1 ? "" : "s"}` : "";
    const counts = `${r.errors} error${r.errors === 1 ? "" : "s"}, ${r.warnings} warning${r.warnings === 1 ? "" : "s"}`;
    const what = r.output ? `${r.output} in ${Math.round(r.ms)} ms` : `not written (${Math.round(r.ms)} ms)`;
    let text = `[${time}] ${what}${pages}, ${counts}\n`;
    if (problem) text += `  ${problem}\n`;
    if (mode === "pretty") {
      const bag = new Diagnostics();
      bag.items.push(...r.diagnostics);
      const pretty = bag.format(!!process.stderr.isTTY);
      if (pretty) text += `${pretty}\n`;
    } else {
      const lines = formatCompact(r.diagnostics);
      if (lines) text += `${lines}\n`;
    }
    say(text);
  };

  const render = async () => {
    running = true;
    pending = false;
    const t0 = performance.now();
    const n = ++renders;
    const read = new Set<string>();
    let r: WatchRender;
    let problem: string | undefined;
    try {
      if (!existsSync(input)) {
        // Deleted, or renamed away mid-save: keep the last output and wait for it to come back.
        r = { n, ms: 0, ok: false, errors: 1, warnings: 0, diagnostics: [{ code: "IO001", severity: "error", message: `Cannot read input file: ${opts.input}`, file: opts.input }], files: [input] };
        read.add(input);
        deps.set(norm(input), { path: input, stamp: "missing" });
      } else {
        // Stamps first: a change made while this render runs is seen as a change afterwards.
        const before = new Map<string, string>();
        for (const [k, d] of deps) before.set(k, stamp(d.path));
        const res = await trackReads(read, () => convert({ ...opts, output: undefined }));
        read.add(input);
        problem = res.data !== undefined ? await writeAtomic(res.data) : undefined;
        const errors = res.diagnostics.filter((d) => d.severity === "error").length;
        const warnings = res.diagnostics.filter((d) => d.severity === "warning").length;
        r = {
          n,
          ms: performance.now() - t0,
          ok: res.ok && !problem,
          ...(res.stats.pages !== undefined ? { pages: res.stats.pages } : {}),
          errors,
          warnings,
          ...(res.data !== undefined && !problem ? { output } : {}),
          diagnostics: res.diagnostics,
          files: [input, ...[...read].filter((f) => f !== input)],
        };
        deps = new Map([...read].map((f) => [norm(f), { path: f, stamp: before.get(norm(f)) ?? stamp(f) }]));
      }
    } catch (e) {
      // A bug in a stage: report it and keep watching; the next change may get past it.
      problem = `internal error: ${((e as Error).message ?? String(e)).split("\n")[0]}`;
      r = { n, ms: performance.now() - t0, ok: false, errors: 1, warnings: 0, diagnostics: [], files: [input, ...read] };
    }
    if (!deps.has(norm(input))) deps = new Map([[norm(input), { path: input, stamp: stamp(input) }], ...deps]);
    deps.delete(norm(output));
    deps.delete(norm(tmp));
    // Only this document is rendered here: what the last two renders did not use was edited away.
    sweepCaches(2);
    if (!stopped) {
      syncWatchers();
      report(r, problem);
    }
    running = false;
    if (pending && !stopped) schedule();
  };

  /** Did any file this render depends on change since it started? */
  const changed = (): boolean => {
    for (const d of deps.values()) if (stamp(d.path) !== d.stamp) return true;
    return false;
  };

  const fire = () => {
    timer = undefined;
    firstEvent = 0;
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    if (!changed()) return;
    void render();
  };

  const schedule = () => {
    if (stopped) return;
    if (running) {
      pending = true;
      return;
    }
    const now = Date.now();
    if (!firstEvent) firstEvent = now;
    if (timer) clearTimeout(timer);
    // A file that keeps changing (a log, a slow copy) still gets a render every ten quiet periods.
    const wait = now - firstEvent > debounce * 10 ? 0 : debounce;
    timer = setTimeout(fire, wait);
  };

  /** Is `p` (a path an event named) one of the files, or a folder on the way to one? */
  const relevant = (p: string): boolean => {
    const q = norm(p);
    if (deps.has(q)) return true;
    for (const d of deps.keys()) if (d.startsWith(q + sep)) return true;
    return false;
  };

  /** Watches the folder of every file (its nearest existing ancestor when the folder is missing), and no others. */
  const syncWatchers = () => {
    const want = new Set<string>();
    for (const d of deps.values()) {
      let dir = dirname(d.path);
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      if (want.size < MAX_DIRS) want.add(dir);
    }
    for (const [dir, fw] of watchers) {
      if (!want.has(dir)) {
        fw.close();
        watchers.delete(dir);
      }
    }
    for (const dir of want) {
      if (watchers.has(dir)) continue;
      try {
        const fw = watch(dir, { persistent: true }, (_event, name) => {
          if (name === null || name === undefined || relevant(join(dir, String(name)))) schedule();
        });
        fw.on("error", () => {
          // The folder went away (or the watch broke): watch again after the next render.
          fw.close();
          watchers.delete(dir);
          schedule();
        });
        watchers.set(dir, fw);
      } catch {
        // Cannot watch this folder (permissions, too many watches): its files are polled on the next event elsewhere.
      }
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const fw of watchers.values()) fw.close();
    watchers.clear();
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing left behind.
    }
    if (w.handleSignals !== false) {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    resolveDone(0);
  };

  if (w.handleSignals !== false) {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
  if (w.signal) {
    if (w.signal.aborted) stop();
    else w.signal.addEventListener("abort", stop, { once: true });
  }
  if (!stopped) {
    if (mode !== "json" && !w.quiet) say(`watching ${opts.input}; Ctrl+C to stop\n`);
    void render();
  }
  return done;
}
