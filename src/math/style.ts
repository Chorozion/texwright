/**
 * TeX's math styles (display, text, script, scriptscript, each with a
 * cramped twin), in a module of their own so the array builder and the
 * layout, which import each other, never read them across that cycle.
 */

export type Style = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const D: Style = 0;
export const T: Style = 2;
export const S: Style = 4;
export const SS: Style = 6;
