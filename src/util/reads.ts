/**
 * Which files a conversion read: the document, \input and \include files,
 * images (also those an SVG figure refers to), bibliographies, brand fonts,
 * data files of plots. `texwright watch` re-renders when any of them
 * changes. Files looked for but missing are noted too, so that creating
 * one also triggers a render.
 *
 * Reads are noted only inside trackReads(), per asynchronous context, so
 * concurrent conversions in one process do not mix their lists.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

const MAX_FILES = 5000;
const store = new AsyncLocalStorage<Set<string>>();

/** Notes that the conversion running now read (or looked for) `path`. */
export function noteRead(path: string): void {
  const files = store.getStore();
  if (files && files.size < MAX_FILES && typeof path === "string" && path) files.add(resolve(path));
}

/** Runs `fn` and collects the absolute paths of every file it reads into `files`. */
export function trackReads<T>(files: Set<string>, fn: () => T): T {
  return store.run(files, fn);
}
