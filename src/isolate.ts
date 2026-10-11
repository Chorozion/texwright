/**
 * Run a conversion in a worker thread with a wall-clock limit.
 *
 * Parsing is synchronous, so a document that is slow to parse would
 * otherwise block the whole process. Long-lived hosts (the MCP server) run
 * every request this way: a request that runs over its limit is stopped and
 * reported as TIME001, and other requests are unaffected.
 *
 * Starting a worker means loading every module again, which costs more than
 * checking a typical document, so a worker that has answered a request stays
 * warm for the next one. Each request still has a worker to itself: requests
 * that arrive while it is busy get workers of their own, and only one worker
 * is kept once they are done. A worker that runs over its limit or fails is
 * terminated, and the next request starts a fresh one. An idle worker
 * whose memory has grown past a limit is replaced. An idle worker does not
 * keep the process alive.
 */

import { SHARE_ENV, Worker } from "node:worker_threads";
import type { Diagnostic, Fix } from "./diagnostics.js";
import type { ConvertOptions, Placement, PreviewOptions, RenderedPage } from "./index.js";
import type { Outline } from "./outline.js";

export interface IsolatedResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  output?: string;
  stats?: { pages?: number; passes?: number; ms: number };
  /** For op "outline". */
  outline?: Outline;
  /** For op "fix": the fixes written, and safe fixes that could not be placed. */
  applied?: Fix[];
  skipped?: Fix[];
  /** For ops "convert" (PDF) and "preview": where things landed. */
  placement?: Placement[];
  /** For op "preview". */
  pageCount?: number;
  pages?: RenderedPage[];
}

export interface IsolatedRequest {
  op: "convert" | "check" | "outline" | "fix" | "preview";
  options: ConvertOptions | PreviewOptions;
}

/** A request as posted to a worker, and its answer. */
export interface WorkerRequest {
  id: number;
  req: IsolatedRequest;
}
export interface WorkerResponse {
  id: number;
  result: IsolatedResult;
}
/** What a worker posts after each answer: the memory it holds, in bytes (see WORKER_LIMIT_BYTES). */
export interface WorkerMemory {
  memory: number;
}

// In the single-file bundle (scripts/bundle.mjs) import.meta also names the
// bundle's worker entry, which loads one file instead of every module under
// dist/src.
const WORKER_URL = new URL((import.meta as ImportMeta & { texwrightWorker?: string }).texwrightWorker ?? "./worker.js", import.meta.url);

/** Workers that have finished a request and wait for the next one. */
const idle: Worker[] = [];
const MAX_IDLE = 1;
/**
 * What a worker may hold between requests (live heap and buffers; it collects garbage to tell),
 * so that a long-running host stays bounded however many documents pass through. Past it the
 * worker empties its caches, and an idle worker still past it is replaced by a fresh one.
 * TEXWRIGHT_WORKER_MB sets another limit.
 */
export const WORKER_LIMIT_BYTES = (Number(process.env.TEXWRIGHT_WORKER_MB) || 128) * 2 ** 20;
let lastId = 0;

function startWorker(): Worker {
  // SHARE_ENV: a warm worker sees the environment as it is now (SOURCE_DATE_EPOCH and the like), not as it was when it started.
  // An 8 MB young generation instead of V8's 32 or so: some 20 MB less resident, measured no slower.
  const worker = new Worker(WORKER_URL, { env: SHARE_ENV, resourceLimits: { maxYoungGenerationSizeMb: 8 } });
  // A worker that dies while idle leaves the pool; one that fails during a request is handled there.
  const leave = () => {
    const k = idle.indexOf(worker);
    if (k >= 0) idle.splice(k, 1);
  };
  worker.on("error", leave);
  worker.on("exit", leave);
  // Grown too big: replaced while idle, its successor loading while the caller reads the answer.
  worker.on("message", (msg: WorkerMemory | WorkerResponse) => {
    if (!("memory" in msg) || msg.memory <= WORKER_LIMIT_BYTES) return;
    const k = idle.indexOf(worker);
    if (k < 0) return;
    idle.splice(k, 1);
    void worker.terminate();
    warmUpIsolated();
  });
  return worker;
}

/**
 * Starts a worker ahead of the first request, so that a long-lived host does
 * not pay for loading the modules when the first request arrives.
 */
export function warmUpIsolated(): void {
  if (idle.length) return;
  const worker = startWorker();
  worker.unref();
  idle.push(worker);
}

export function runIsolated(req: IsolatedRequest, timeoutMs: number): Promise<IsolatedResult> {
  return new Promise((resolvePromise) => {
    const worker = idle.pop() ?? startWorker();
    worker.ref();
    const id = ++lastId;
    let settled = false;
    const finish = (result: IsolatedResult, reusable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
      if (reusable && idle.length < MAX_IDLE) {
        worker.unref();
        idle.push(worker);
      } else void worker.terminate();
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      finish(
        {
          ok: false,
          diagnostics: [
            {
              code: "TIME001",
              severity: "error",
              message: `Stopped after ${Math.round(timeoutMs / 1000)} s`,
              hint: "The document may contain something pathological (a huge table, runaway macros); split it up or simplify it",
            },
          ],
        },
        false,
      );
    }, timeoutMs);
    const onMessage = (msg: WorkerResponse | WorkerMemory) => {
      if ("id" in msg && msg.id === id) finish(msg.result, true);
    };
    const onError = (e: Error) =>
      finish({ ok: false, diagnostics: [{ code: "INT001", severity: "error", message: `Worker failed: ${e.message.split("\n")[0]}` }] }, false);
    const onExit = (code: number) => finish({ ok: false, diagnostics: [{ code: "INT001", severity: "error", message: `Worker exited with code ${code}` }] }, false);
    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    worker.postMessage({ id, req } satisfies WorkerRequest);
  });
}
