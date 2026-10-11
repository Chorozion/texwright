/**
 * The add-on packages people reach for next, in their basic forms:
 * pst-3dplot (\pstThreeDCoor, \psplotThreeD, \parametricplotThreeD,
 * \pstThreeDLine, \pstThreeDDot, \pstThreeDPut, \pstThreeDBox, drawn in
 * its parallel projection), pst-eucl (\pstGeonode, \pstTriangle,
 * \pstLineAB, \pstSegmentMark, \pstMarkAngle, \pstRightAngle,
 * \pstCircleOA, \pstMiddleAB, \pstProjection, \pstInterLL, \pstCGravABC)
 * and pst-coil (\pscoil, \pszigzag).
 */

import type { NodeInfo } from "../tikz/interp.js";
import { type Pt, type Seg, add, apply, arcCubics, dir, dist, lineIntersection, scale, sub, unit } from "../tikz/geom.js";
import { type PstInterp, ellipseSegs, objectState, polySegs, uputRef } from "./interp.js";
import { compilePlot } from "./plot.js";
import { type Call, cmd } from "./registry.js";
import { RpnError } from "./rpn.js";
import { type PState, cloneState } from "./state.js";

// ---------------------------------------------------------------- pst-3dplot

/** pst-3dplot's parallel projection of (x,y,z) to the plane, in units. */
export function project(st: PState, it: PstInterp, x: number, y: number, z: number): Pt {
  const A = ((it.number(st.kv.get("Alpha")) ?? 45) * Math.PI) / 180;
  const B = ((it.number(st.kv.get("Beta")) ?? 30) * Math.PI) / 180;
  return [-x * Math.sin(A) + y * Math.cos(A), -x * Math.cos(A) * Math.sin(B) - y * Math.sin(A) * Math.sin(B) + z * Math.cos(B)];
}

function p3(it: PstInterp, st: PState, raw: string): Pt | undefined {
  const parts = it.expandText(raw).split(",");
  if (parts.length !== 3) return undefined;
  const v = parts.map((s) => it.number(s));
  if (v.some((x) => x === undefined)) return undefined;
  const q = project(st, it, v[0]!, v[1]!, v[2]!);
  return apply(st.T, [q[0] * st.xunit, q[1] * st.yunit]);
}

cmd("pstThreeDCoor", (c) => {
  const { it } = c;
  const { st } = objectState(c);
  const kv = st.kv;
  const n = (k: string, d: number) => it.number(kv.get(k)) ?? d;
  const ax: [string, number, number, string, number][] = [
    ["x", n("xMin", -1), n("xMax", 4), kv.get("nameX") ?? "$x$", n("spotX", 180)],
    ["y", n("yMin", -1), n("yMax", 4), kv.get("nameY") ?? "$y$", n("spotY", 0)],
    ["z", n("zMin", -1), n("zMax", 4), kv.get("nameZ") ?? "$z$", n("spotZ", 90)],
  ];
  const s2 = cloneState(st);
  if (s2.arrows === "-") s2.arrows = "->";
  for (const [a, lo, hi, name, spot] of ax) {
    const P = (v: number): Pt => {
      const q = project(st, it, a === "x" ? v : 0, a === "y" ? v : 0, a === "z" ? v : 0);
      return apply(st.T, [q[0] * st.xunit, q[1] * st.yunit]);
    };
    it.drawPath(polySegs([P(lo), P(hi)], false), s2);
    if (name.trim()) {
      const bx = it.makeBox(name, st, c.base, false);
      const Q = add(P(hi), scale(dir(spot), st.labelsep));
      it.place(bx, Q, uputRef(bx, spot), 0, { ...st, T: [1, 0, 0, 1, 0, 0] });
    }
  }
});

cmd("pstThreeDLine pstThreeDDot pstThreeDPut pstThreeDNode", (c) => {
  const { it, sc, name } = c;
  if (name === "pstThreeDPut") {
    const ref = sc.options();
    const cs = it.coordList(sc, 1);
    const body = it.arg(sc) ?? "";
    const p = cs.length ? p3(it, c.st, cs[0]) : undefined;
    if (!p) return;
    const bx = it.makeBox(body, c.st, c.base, false);
    const r = ref ? ref : "";
    const x = /l/.test(r) ? 0 : /r/.test(r) ? bx.w : bx.w / 2;
    const y = /t/.test(r) ? bx.h : /b/.test(r) ? -bx.d : (bx.h - bx.d) / 2;
    it.place(bx, p, [x, y], 0, { ...c.st, T: [1, 0, 0, 1, 0, 0] });
    return;
  }
  const { st } = objectState(c);
  const raws = it.coordList(sc);
  const pts = raws.map((s) => p3(it, st, s)).filter((p): p is Pt => !!p);
  if (name === "pstThreeDNode") {
    const nm = it.arg(sc) ?? "";
    if (pts[0]) it.addNode(nm.trim(), { name: nm.trim(), center: pts[0], shape: "coordinate", hw: 0, hh: 0, rot: 0, baseDy: 0 });
    return;
  }
  if (name === "pstThreeDDot") {
    if (/^(true|)$/.test((st.kv.get("drawCoor") ?? "false").trim())) {
      // Dashed lines from the point down to the xy plane and from there to both axes.
      const ls = cloneState(st);
      ls.linestyle = "dashed";
      ls.lw = Math.min(ls.lw, 0.4);
      ls.dash = [3, 2];
      ls.arrows = "-";
      for (const raw of raws) {
        const v = it.expandText(raw).split(",").map((x) => it.number(x) ?? 0);
        if (v.length !== 3) continue;
        const P = (x: number, y: number, z: number): Pt => {
          const q = project(st, it, x, y, z);
          return apply(st.T, [q[0] * st.xunit, q[1] * st.yunit]);
        };
        it.drawPath(polySegs([P(v[0], v[1], v[2]), P(v[0], v[1], 0)], false), ls);
        it.drawPath(polySegs([P(v[0], 0, 0), P(v[0], v[1], 0), P(0, v[1], 0)], false), ls);
      }
    }
    for (const p of pts) it.dot(p, st);
    return;
  }
  if (pts.length >= 2) it.drawPath(polySegs(pts, false), st);
});

cmd("pstThreeDBox", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 4);
  const v = cs.map((s) => it.expandText(s).split(",").map((x) => it.number(x) ?? 0));
  if (v.length !== 4 || v.some((x) => x.length !== 3)) return;
  const [o, a, b, h] = v;
  const P = (q: number[]): Pt => {
    const r = project(st, it, q[0], q[1], q[2]);
    return apply(st.T, [r[0] * st.xunit, r[1] * st.yunit]);
  };
  const addv = (...xs: number[][]) => xs.reduce((s, x) => s.map((y, i) => y + x[i]), [0, 0, 0]);
  const c0 = [o, addv(o, a), addv(o, a, b), addv(o, b)];
  const c1 = c0.map((q) => addv(q, h));
  const segs: Seg[] = [...polySegs(c0.map(P), true), ...polySegs(c1.map(P), true)];
  for (let k = 0; k < 4; k++) segs.push({ t: "M", p: P(c0[k]) }, { t: "L", p: P(c1[k]) });
  it.drawPath(segs, st, { noArrows: true });
});

cmd("psplotThreeD", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 2);
  const code = it.arg(sc) ?? "";
  if (cs.length !== 2) return;
  const [x0, x1] = cs[0].split(",").map((s) => it.number(s) ?? 0);
  const [y0, y1] = cs[1].split(",").map((s) => it.number(s) ?? 0);
  const f = compilePlot(it, code, st.algebraic);
  if (!f) return;
  const nx = Math.max(2, Math.min(200, Math.round(it.number(st.kv.get("xPlotpoints")) ?? 25)));
  const ny = Math.max(2, Math.min(200, Math.round(it.number(st.kv.get("yPlotpoints")) ?? 25)));
  const style = (st.kv.get("drawStyle") ?? "xLines").trim();
  const P = (x: number, y: number): Pt => {
    let z = Number.NaN;
    try {
      const r = f({ x, y });
      z = r[r.length - 1];
    } catch (e) {
      if (!(e instanceof RpnError)) throw e;
    }
    const q = project(st, it, x, y, Number.isFinite(z) ? z : Number.NaN);
    return apply(st.T, [q[0] * st.xunit, q[1] * st.yunit]);
  };
  it.tick(Math.ceil((nx * ny) / 20));
  const segs: Seg[] = [];
  const lineX = style === "xLines" || style === "xyLines";
  const lineY = style === "yLines" || style === "xyLines";
  if (lineX)
    for (let j = 0; j < ny; j++) {
      const y = y0 + ((y1 - y0) * j) / (ny - 1);
      for (let i = 0; i < nx; i++) segs.push({ t: i ? "L" : "M", p: P(x0 + ((x1 - x0) * i) / (nx - 1), y) } as Seg);
    }
  if (lineY)
    for (let i = 0; i < nx; i++) {
      const x = x0 + ((x1 - x0) * i) / (nx - 1);
      for (let j = 0; j < ny; j++) segs.push({ t: j ? "L" : "M", p: P(x, y0 + ((y1 - y0) * j) / (ny - 1)) } as Seg);
    }
  if (!lineX && !lineY) it.warnOnce("3d-style", `drawStyle=${style} is drawn as xLines`);
  it.drawPath(segs, st, { noArrows: true });
});

cmd("parametricplotThreeD", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 2);
  const code = it.arg(sc) ?? "";
  if (!cs.length) return;
  const [t0, t1] = cs[0].split(",").map((s) => it.number(s) ?? 0);
  const f = compilePlot(it, code, st.algebraic);
  if (!f) return;
  const n = Math.max(2, Math.min(5000, st.plotpoints));
  const pts: Pt[] = [];
  for (let k = 0; k <= n; k++) {
    const t = t0 + ((t1 - t0) * k) / n;
    try {
      const r = f({ t });
      if (r.length >= 3) {
        const q = project(st, it, r[r.length - 3], r[r.length - 2], r[r.length - 1]);
        pts.push(apply(st.T, [q[0] * st.xunit, q[1] * st.yunit]));
      }
    } catch (e) {
      if (!(e instanceof RpnError)) throw e;
    }
  }
  it.tick(Math.ceil(n / 20));
  if (pts.length >= 2) it.drawPath(polySegs(pts, false), st);
});

// ---------------------------------------------------------------- pst-eucl

function pointName(st: PState, name: string, which = ""): string | undefined {
  const pn = (st.kv.get(`PointName${which}`) ?? st.kv.get("PointName") ?? "default").trim();
  if (pn === "none") return undefined;
  if (pn === "default") return `$${name}$`;
  return pn.includes("$") || pn.includes("\\") ? pn : `$${pn}$`;
}

/** Draws a pst-eucl point: its symbol and its name at PosAngle (or away from `away`). */
function geoPoint(it: PstInterp, st: PState, name: string, p: Pt, posAngle: number | undefined, away: Pt | undefined, base: number, which = ""): void {
  it.addNode(name, { name, center: p, shape: "coordinate", hw: 0, hh: 0, rot: 0, baseDy: 0 });
  const sym = (st.kv.get(`PointSymbol${which}`) ?? st.kv.get("PointSymbol") ?? "*").trim();
  if (sym !== "none") {
    const s2 = cloneState(st);
    s2.dotstyle = sym;
    const k = it.number(st.kv.get("DotScale"));
    if (k !== undefined) s2.dotscale = [k, k];
    it.dot(p, s2);
  }
  const label = pointName(st, name, which);
  if (!label) return;
  let ang = posAngle;
  if (ang === undefined) ang = away && dist(away, p) > 1e-6 ? (Math.atan2(p[1] - away[1], p[0] - away[0]) * 180) / Math.PI : 90;
  const bx = it.makeBox(label, st, base, false);
  // PointNameSep (1em) is to the label's centre; a large label keeps clear of its point.
  const u = dir(ang);
  const reach = Math.min(Math.abs(u[0]) > 1e-6 ? bx.w / 2 / Math.abs(u[0]) : Infinity, Math.abs(u[1]) > 1e-6 ? (bx.h + bx.d) / 2 / Math.abs(u[1]) : Infinity);
  const sep = it.len(st.kv.get("PointNameSep"), st.xunit, st) ?? Math.max(10, reach + 3);
  const Q = add(p, scale(u, sep));
  it.place(bx, Q, [bx.w / 2, (bx.h - bx.d) / 2], 0, { ...st, T: [1, 0, 0, 1, 0, 0] });
}

function angleList(it: PstInterp, raw: string | undefined): (number | undefined)[] {
  if (raw === undefined) return [];
  return raw.split(",").map((s) => it.number(s));
}

cmd("pstGeonode pstTriangle", (c) => {
  const { it, sc, name } = c;
  const opts = sc.options();
  const st = cloneState(c.st);
  it.set(st, opts);
  const items: { p: Pt; name: string }[] = [];
  while (sc.peek() === "(") {
    const p = it.coord(sc.group("(") ?? "", st);
    const n = (it.arg(sc) ?? "").trim();
    if (p && n) items.push({ p, name: n });
    if (items.length > 500) break;
  }
  const angles = angleList(it, st.kv.get("PosAngle"));
  const ctr: Pt = items.length ? [items.reduce((s, x) => s + x.p[0], 0) / items.length, items.reduce((s, x) => s + x.p[1], 0) / items.length] : [0, 0];
  items.forEach((x, i) => {
    const which = name === "pstTriangle" ? ["A", "B", "C"][i] ?? "" : "";
    const pa = angles.length ? angles[Math.min(i, angles.length - 1)] : (it.number(st.kv.get(`PosAngle${which}`)) ?? undefined);
    geoPoint(it, st, x.name, x.p, pa, items.length > 1 ? ctr : undefined, c.base, which);
  });
  if (name === "pstTriangle" && items.length === 3) {
    const s2 = cloneState(st);
    it.drawPath(polySegs(items.map((x) => x.p), true), s2, { closed: true });
  }
});

function nodesOf(it: PstInterp, names: string[]): NodeInfo[] | undefined {
  const out: NodeInfo[] = [];
  for (const n of names) {
    const x = it.nodes.get(n.trim());
    if (!x) {
      it.warnOnce(`node:${n}`, `Unknown point (${n.trim()})`, "Define it first with \\pstGeonode");
      return undefined;
    }
    out.push(x);
  }
  return out;
}

function readNames(it: PstInterp, sc: Call["sc"], n: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < n; k++) out.push((it.arg(sc) ?? "").trim());
  return out;
}

cmd("pstLineAB pstSegmentMark pstCircleOA pstCircleAB", (c) => {
  const { it, sc, name } = c;
  const { st } = objectState(c);
  const ns = nodesOf(it, readNames(it, sc, 2));
  if (!ns) return;
  const [A, B] = ns.map((n) => n.center);
  if (name === "pstLineAB") {
    const u = unit(sub(B, A));
    const ea = it.len(st.kv.get("nodesepA") ?? st.kv.get("nodesep"), st.xunit, st) ?? 0;
    const eb = it.len(st.kv.get("nodesepB") ?? st.kv.get("nodesep"), st.xunit, st) ?? 0;
    it.drawPath(polySegs([add(A, scale(u, ea)), add(B, scale(u, -eb))], false), st);
  } else if (name === "pstSegmentMark") {
    const m: Pt = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const u = unit(sub(B, A));
    const nrm: Pt = [-u[1], u[0]];
    const s = 3.5;
    const sym = (st.kv.get("SegmentSymbol") ?? "pstslash").trim();
    const segs: Seg[] = [];
    const count = /dbl|two|ii/i.test(sym) ? 2 : /triple|iii/i.test(sym) ? 3 : 1;
    for (let k = 0; k < count; k++) {
      const o = add(m, scale(u, (k - (count - 1) / 2) * 2));
      const tilt = add(scale(nrm, s), scale(u, sym.includes("slash") ? 1.2 : 0));
      segs.push({ t: "M", p: sub(o, tilt) }, { t: "L", p: add(o, tilt) });
    }
    it.drawPath(segs, { ...st, arrows: "-" }, { noArrows: true });
  } else {
    const ctr: Pt = name === "pstCircleOA" ? A : [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const r = name === "pstCircleOA" ? dist(A, B) : dist(A, B) / 2;
    it.drawPath(ellipseSegs(ctr, [r, 0], [0, r]), st, { closed: true });
  }
});

cmd("pstMarkAngle pstRightAngle", (c) => {
  const { it, sc, name } = c;
  const { st } = objectState(c);
  const ns = nodesOf(it, readNames(it, sc, 3));
  const label = name === "pstMarkAngle" ? (it.arg(sc) ?? "") : "";
  if (!ns) return;
  const [A, B, C] = ns.map((n) => n.center);
  const a0 = (Math.atan2(A[1] - B[1], A[0] - B[0]) * 180) / Math.PI;
  let a1 = (Math.atan2(C[1] - B[1], C[0] - B[0]) * 180) / Math.PI;
  while (a1 <= a0) a1 += 360;
  if (name === "pstRightAngle") {
    const s = it.len(st.kv.get("RightAngleSize"), st.xunit, st) ?? 0.28 * st.xunit;
    const u = scale(unit(sub(A, B)), s);
    const v = scale(unit(sub(C, B)), s);
    it.drawPath(polySegs([add(B, u), add(add(B, u), v), add(B, v)], false), { ...st, arrows: "-" });
    return;
  }
  const r = it.len(st.kv.get("MarkAngleRadius"), st.xunit, st) ?? 0.4 * st.xunit;
  const arc = arcCubics(B, [r, 0], [0, r], a0, a1);
  it.drawPath([{ t: "M", p: arc.start }, ...arc.segs.map((s) => ({ t: "C" as const, ...s }))], st);
  if (label.trim()) {
    const sepRaw = st.kv.get("LabelSep");
    const sep = sepRaw !== undefined ? (it.len(sepRaw, st.xunit, st) ?? r + 8) : r + 9;
    const mid = (a0 + a1) / 2;
    const bx = it.makeBox(label, st, c.base, false);
    const Q = add(B, scale(dir(mid), sep));
    it.place(bx, Q, [bx.w / 2, (bx.h - bx.d) / 2], 0, { ...st, T: [1, 0, 0, 1, 0, 0] });
  }
});

/** A constructed point: registered and drawn as a geonode. */
function constructed(it: PstInterp, st: PState, name: string, p: Pt, away: Pt | undefined, base: number): void {
  const pa = it.number(st.kv.get("PosAngle"));
  geoPoint(it, st, name, p, pa, away, base);
}

cmd("pstMiddleAB pstProjection pstInterLL pstCGravABC pstSymO pstOrtSym", (c) => {
  const { it, sc, name } = c;
  const opts = sc.options();
  const st = cloneState(c.st);
  it.set(st, opts);
  const need = name === "pstMiddleAB" ? 2 : name === "pstProjection" ? 3 : name === "pstInterLL" ? 4 : name === "pstCGravABC" ? 3 : name === "pstSymO" ? 2 : 3;
  const names = readNames(it, sc, need);
  let out = ((sc.peek() === "[" ? sc.options() : it.arg(sc)) ?? "").trim();
  const ns = nodesOf(it, names);
  if (!ns) return;
  const P = ns.map((n) => n.center);
  let p: Pt | undefined;
  let away: Pt | undefined;
  switch (name) {
    case "pstMiddleAB":
      p = [(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2];
      away = add(p, [0, 1]);
      if (!out) out = "M";
      break;
    case "pstProjection": {
      const u = unit(sub(P[1], P[0]));
      const t = (P[2][0] - P[0][0]) * u[0] + (P[2][1] - P[0][1]) * u[1];
      p = add(P[0], scale(u, t));
      away = P[2];
      if (!out) out = `${names[2]}'`;
      break;
    }
    case "pstInterLL":
      p = lineIntersection(P[0], P[1], P[2], P[3]);
      away = P[0];
      break;
    case "pstCGravABC":
      p = [(P[0][0] + P[1][0] + P[2][0]) / 3, (P[0][1] + P[1][1] + P[2][1]) / 3];
      away = P[0];
      break;
    case "pstSymO":
      p = sub(scale(P[0], 2), P[1]);
      away = P[0];
      break;
    default: {
      // pstOrtSym{A}{B}{M}{M'}: reflection of M in line AB.
      const u = unit(sub(P[1], P[0]));
      const t = (P[2][0] - P[0][0]) * u[0] + (P[2][1] - P[0][1]) * u[1];
      const foot = add(P[0], scale(u, t));
      p = sub(scale(foot, 2), P[2]);
      away = foot;
    }
  }
  if (!p || !out) return;
  constructed(it, st, out, p, away, c.base);
});

// ---------------------------------------------------------------- pst-coil

cmd("pscoil pszigzag psCoil", (c) => {
  const { it, sc, name } = c;
  const { st } = objectState(c);
  const pts = it.coords(it.coordList(sc, 2), st);
  if (pts.length !== 2) return;
  const [A, B] = pts;
  const kv = st.kv;
  const width = it.len(kv.get("coilwidth"), st.xunit, st) ?? 0.4 * 28.4528;
  const heightK = it.number(kv.get("coilheight")) ?? 1;
  const arm = it.len(kv.get("coilarm"), st.xunit, st) ?? 0.5 * 28.4528;
  const armA = it.len(kv.get("coilarmA"), st.xunit, st) ?? arm;
  const armB = it.len(kv.get("coilarmB"), st.xunit, st) ?? arm;
  const aspect = ((it.number(kv.get("coilaspect")) ?? 45) * Math.PI) / 180;
  const L = dist(A, B);
  const u = unit(sub(B, A));
  const nrm: Pt = [-u[1], u[0]];
  const len = Math.max(0, L - armA - armB);
  const pitch = Math.max(0.5, heightK * width);
  const turns = Math.max(1, Math.min(400, Math.round(len / pitch)));
  const p = len / turns;
  const S = add(A, scale(u, armA));
  const r = width / 2;
  const at = (s: number, h: number): Pt => add(add(S, scale(u, s)), scale(nrm, h));
  const out: Pt[] = [A, S];
  if (name === "pszigzag") {
    for (let k = 0; k < turns; k++) {
      out.push(at(p * (k + 0.25), r), at(p * (k + 0.75), -r));
    }
    out.push(at(len, 0));
  } else {
    const steps = turns * 24;
    for (let k = 1; k <= steps; k++) {
      const th = (2 * Math.PI * k) / 24;
      out.push(at((p * k) / 24 + r * Math.sin(aspect) * (1 - Math.cos(th)) * 0.9, r * Math.sin(th)));
    }
  }
  out.push(B);
  it.tick(Math.ceil(out.length / 50));
  it.drawPath(polySegs(out, false), { ...st, linearc: 0 });
});
