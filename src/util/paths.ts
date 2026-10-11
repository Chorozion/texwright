import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Resolve directory aliases even when the final file or subdirectories do not
 * exist yet. Only missing components are reconstructed; inaccessible paths and
 * dangling symlinks fail rather than being mistaken for ordinary new files.
 */
export function realPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = realpathSync(current);
      if (missing.length && !statSync(canonical).isDirectory()) {
        throw Object.assign(new Error("A parent path is not a directory"), { code: "ENOTDIR" });
      }
      return join(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || lstatSync(current, { throwIfNoEntry: false })) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}
