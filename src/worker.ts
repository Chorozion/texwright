/** Worker entry point for runIsolated(): answers requests one at a time for as long as it lives. */

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parentPort } from "node:worker_threads";
import { type ConvertOptions, check, convert, fixDocument, outline, preview } from "./index.js";
import { type IsolatedRequest, type IsolatedResult, type WorkerMemory, type WorkerRequest, type WorkerResponse, WORKER_LIMIT_BYTES } from "./isolate.js";
import { clearCaches } from "./util/lru.js";

/**
 * A full garbage collection, for telling what a worker keeps from what it has merely not yet
 * collected. V8 hands the function only to contexts made after --expose-gc is set; this one
 * exists for nothing else.
 */
const collect: (() => void) | undefined = (() => {
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as unknown;
    return typeof gc === "function" ? (gc as () => void) : undefined;
  } catch {
    return undefined;
  }
})();

async function run(req: IsolatedRequest): Promise<IsolatedResult> {
  if (req.op === "check") {
    const res = check(req.options);
    return { ok: res.ok, diagnostics: res.diagnostics };
  }
  if (req.op === "outline") {
    const res = outline(req.options);
    return { ok: res.ok, diagnostics: res.diagnostics, outline: res.outline };
  }
  if (req.op === "fix") {
    const res = fixDocument(req.options);
    return { ok: res.ok, diagnostics: res.diagnostics, applied: res.applied, skipped: res.skipped };
  }
  if (req.op === "preview") {
    const res = preview(req.options);
    return { ok: res.ok, diagnostics: res.diagnostics, pageCount: res.pageCount, pages: res.pages, placement: res.placement };
  }
  const res = await convert(req.options as ConvertOptions);
  return { ok: res.ok, diagnostics: res.diagnostics, output: res.output, stats: res.stats, ...(res.placement ? { placement: res.placement } : {}) };
}

/** Live heap and external buffers (caches, font data), in bytes. */
function live(): number {
  const m = process.memoryUsage();
  return m.heapUsed + m.external;
}

/**
 * This worker's memory between requests. Past the limit (counting garbage not yet collected) it
 * collects, which takes a large heap 100 ms or more and so happens only then; still past it, it
 * empties the caches (layout, fonts, compressed streams) and collects again. runIsolated()
 * replaces a worker that is past the limit even so.
 */
function memory(): number {
  let used = live();
  if (used > WORKER_LIMIT_BYTES && collect) {
    collect();
    used = live();
    if (used > WORKER_LIMIT_BYTES) {
      clearCaches();
      collect();
      used = live();
    }
  }
  return used;
}

parentPort?.on("message", ({ id, req }: WorkerRequest) => {
  run(req).then(
    (result) => {
      parentPort?.postMessage({ id, result } satisfies WorkerResponse);
      // After the answer, so that the caller does not wait for the collection.
      setImmediate(() => parentPort?.postMessage({ memory: memory() } satisfies WorkerMemory));
    },
    (e: Error) =>
      parentPort?.postMessage({
        id,
        result: { ok: false, diagnostics: [{ code: "INT001", severity: "error", message: `Internal error: ${e.message}` }] },
      } satisfies WorkerResponse),
  );
});
