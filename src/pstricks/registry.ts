/** The table of PSTricks commands: each module registers the commands it draws. */

import type { Scanner } from "../tikz/scan.js";
import type { PstInterp } from "./interp.js";
import type { PState } from "./state.js";

export interface Call {
  it: PstInterp;
  sc: Scanner;
  st: PState;
  /** The command was starred (\pscircle*). */
  star: boolean;
  name: string;
  /** Offset of the scanner's text in the picture source, and whether offsets inside it are exact (not from a macro). */
  base: number;
  exact: boolean;
}

export type Handler = (c: Call) => void;

export const COMMANDS = new Map<string, Handler>();

/** Registers a handler for each space-separated command name (without the backslash). */
export function cmd(names: string, h: Handler): void {
  for (const n of names.split(/\s+/)) if (n) COMMANDS.set(n, h);
}
