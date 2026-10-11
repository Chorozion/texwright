/**
 * tikz-3dplot, the basics: \tdplotsetmaincoords{theta}{phi} defines the
 * style tdplot_main_coords (the x, y and z vectors of a view rotated by
 * theta about x, then phi about z), \tdplotsetrotatedcoords{a}{b}{c} and
 * \tdplotsetthetaplanecoords{phi} define tdplot_rotated_coords inside it,
 * \tdplotsetcoord{P}{r}{theta}{phi} names a point in spherical coordinates
 * with its projections (Pxy, Pz, ...), and \tdplotdrawarc draws an arc in
 * the xy-plane of the current coordinates with a label at its middle.
 */

import { evaluate, fmt, num } from "./expr.js";
import { type Pt, type Seg, applyLinear } from "./geom.js";
import type { Interp } from "./interp.js";
import { applyOptions } from "./options.js";
import type { Scanner } from "./scan.js";
import { type GS, cloneGS } from "./state.js";

type V3 = [number, number, number];
type M3 = [V3, V3, V3];

interface TdState {
  /** Rows: screen x and y of the unit x, y, z vectors, in cm. */
  main: [V3, V3];
}

const states = new WeakMap<Interp, TdState>();

const rad = (d: number) => (d * Math.PI) / 180;

/** The main view matrix of tikz-3dplot (2 x 3, rows are screen x and y). */
export function mainCoords(theta: number, phi: number): [V3, V3] {
  const t = rad(theta);
  const p = rad(phi);
  return [
    [Math.cos(p), Math.sin(p), 0],
    [-Math.cos(t) * Math.sin(p), Math.cos(t) * Math.cos(p), Math.sin(t)],
  ];
}

/** Euler rotation z(a) y(b) z(c), as tikz-3dplot's rotated coordinates use. */
function euler(a: number, b: number, c: number): M3 {
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(rad(a)), Math.sin(rad(a)), Math.cos(rad(b)), Math.sin(rad(b)), Math.cos(rad(c)), Math.sin(rad(c))];
  return [
    [ca * cb * cc - sa * sc, -ca * cb * sc - sa * cc, ca * sb],
    [sa * cb * cc + ca * sc, -sa * cb * sc + ca * cc, sa * sb],
    [-sb * cc, sb * sc, cb],
  ];
}

const vecStyle = (m: [V3, V3], col: (k: number) => V3): string =>
  ["x", "y", "z"]
    .map((n, k) => {
      const v = col(k);
      const sx = m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2];
      const sy = m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2];
      return `${n}={(${fmt(sx)}cm,${fmt(sy)}cm)}`;
    })
    .join(",");

function numArg(it: Interp, sc: Scanner): number {
  const t = sc.group("{") ?? "0";
  return num(it.expand(t)) ?? 0;
}

/** Runs a \tdplot... command; `sc` is just after the command name. */
export function tdplotCommand(it: Interp, name: string, sc: Scanner, g: GS): void {
  const st = states.get(it) ?? { main: mainCoords(70, 110) };
  states.set(it, st);
  const define = (style: string, body: string) => applyOptions(g, `${style}/.style={${body}}`, "scope", it);
  switch (name) {
    case "tdplotsetmaincoords": {
      const theta = numArg(it, sc);
      const phi = numArg(it, sc);
      st.main = mainCoords(theta, phi);
      define("tdplot_main_coords", vecStyle(st.main, (k) => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]));
      // Rotated coordinates start out equal to the main ones.
      define("tdplot_rotated_coords", vecStyle(st.main, (k) => [k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0]));
      return;
    }
    case "tdplotsetrotatedcoords":
    case "tdplotsetthetaplanecoords": {
      let R: M3;
      if (name === "tdplotsetthetaplanecoords") {
        const p = rad(numArg(it, sc));
        // x' along z, y' towards phi in the xy-plane.
        R = [
          [0, Math.cos(p), -Math.sin(p)],
          [0, Math.sin(p), Math.cos(p)],
          [1, 0, 0],
        ];
      } else R = euler(numArg(it, sc), numArg(it, sc), numArg(it, sc));
      const prev = g.styles.get("tdplot_rotated_coords")?.body ?? "";
      const shift = /shift=\{[^}]*\}/.exec(prev)?.[0];
      define("tdplot_rotated_coords", vecStyle(st.main, (k) => [R[0][k], R[1][k], R[2][k]]) + (shift ? `,${shift}` : ""));
      return;
    }
    case "tdplotsetrotatedcoordsorigin": {
      const o = (sc.group("{") ?? "").trim();
      const prev = g.styles.get("tdplot_rotated_coords")?.body ?? "";
      define("tdplot_rotated_coords", `${prev.replace(/,?shift=\{[^}]*\}/, "")},shift={${o}}`);
      return;
    }
    case "tdplotsetcoord": {
      const n = (sc.group("{") ?? "").trim().replace(/[^\w ]/g, "");
      const r = numArg(it, sc);
      const t = rad(numArg(it, sc));
      const p = rad(numArg(it, sc));
      if (!n) return;
      const x = fmt(r * Math.sin(t) * Math.cos(p));
      const y = fmt(r * Math.sin(t) * Math.sin(p));
      const z = fmt(r * Math.cos(t));
      const pts: [string, string][] = [
        ["", `${x},${y},${z}`],
        ["x", `${x},0,0`],
        ["y", `0,${y},0`],
        ["z", `0,0,${z}`],
        ["xy", `${x},${y},0`],
        ["xz", `${x},0,${z}`],
        ["yz", `0,${y},${z}`],
      ];
      it.run(pts.map(([s, c]) => `\\coordinate (${n}${s}) at (${c});`).join(""), it.off, false, g);
      return;
    }
    case "tdplotdrawarc": {
      const opts = sc.options() ?? "";
      const centre = (sc.group("{") ?? "(0,0,0)").trim().replace(/^\(([^]*)\)$/, "$1");
      const rText = it.expand(sc.group("{") ?? "1");
      const a0 = numArg(it, sc);
      const a1 = numArg(it, sc);
      const labelOpts = sc.group("{") ?? "";
      const label = sc.group("{") ?? "";
      let r: { v: number; dim: boolean };
      try {
        r = evaluate(rText);
      } catch {
        it.warn(`cannot read the radius ${rText.trim()} of \\tdplotdrawarc`);
        return;
      }
      // The arc lies in the xy-plane of the coordinates its options select (tdplot_rotated_coords, say).
      const ag = cloneGS(g);
      ag.doDraw = true;
      if (opts) applyOptions(ag, it.expand(opts), "path", it);
      const c = it.coord(centre, ag);
      if (!c) return;
      const ex: Pt = r.dim ? applyLinear(ag.T, [r.v, 0]) : applyLinear(ag.T, [ag.xv[0] * r.v, ag.xv[1] * r.v]);
      const ey: Pt = r.dim ? applyLinear(ag.T, [0, r.v]) : applyLinear(ag.T, [ag.yv[0] * r.v, ag.yv[1] * r.v]);
      const at = (deg: number): Pt => [c.p[0] + ex[0] * Math.cos(rad(deg)) + ey[0] * Math.sin(rad(deg)), c.p[1] + ex[1] * Math.cos(rad(deg)) + ey[1] * Math.sin(rad(deg))];
      const n = Math.max(8, Math.min(180, Math.ceil(Math.abs(a1 - a0) / 3)));
      const segs: Seg[] = [];
      for (let i = 0; i <= n; i++) segs.push({ t: i ? "L" : "M", p: at(a0 + ((a1 - a0) * i) / n) });
      it.tick(n);
      it.strokeWithArrows(segs, ag, ag.doFill);
      it.drawn++;
      if (label.trim()) {
        const m = at((a0 + a1) / 2);
        const tg = cloneGS(g);
        tg.T = [1, 0, 0, 1, 0, 0];
        it.run(`\\node[${labelOpts}] at (${fmt(m[0])}pt,${fmt(m[1])}pt) {${label}};`, it.off, false, tg);
      }
      return;
    }
  }
}
