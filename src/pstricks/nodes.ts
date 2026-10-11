/**
 * pst-node: nodes (\pnode, \cnode, \Cnode, \rnode, \circlenode and the
 * other box nodes, \dotnode, \fnode, \nput), connections (\ncline, \ncarc,
 * \nccurve, \ncangle, \ncangles, \ncbar, \ncdiag, \ncdiagg, \ncloop,
 * \nccircle, \ncbox and the \pc forms between coordinates) and their labels
 * (\naput, \nbput, \ncput, \tlput, \trput, \taput, \tbput).
 */

import type { NodeInfo } from "../tikz/interp.js";
import { borderPoint } from "../tikz/interp.js";
import { type Pt, add, apply, bez, bezTangent, dir, dist, lineIntersection, scale, sub, unit } from "../tikz/geom.js";
import { type PBox, type PstInterp, box, ellipseSegs, nodeBoxOf, objectState, polySegs, refPoint, uputRef } from "./interp.js";
import { type Call, cmd } from "./registry.js";
import { type PState, cloneState } from "./state.js";

// ---------------------------------------------------------------- nodes

function regNode(it: PstInterp, name: string, info: Omit<NodeInfo, "name">): void {
  it.addNode(name.trim(), { name: name.trim(), ...info });
}

cmd("pnode", ({ it, sc, st }) => {
  const cs = it.coordList(sc, 1);
  const p = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  const name = it.arg(sc) ?? "";
  if (p) regNode(it, name, { center: p, shape: "coordinate", hw: 0, hh: 0, rot: 0, baseDy: 0 });
});

cmd("cnode Cnode", (c) => {
  const { it, sc, name } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 1);
  const p = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  const r = name === "cnode" ? it.len(it.arg(sc), st.runit, st) : (it.len(st.kv.get("radius"), st.runit, st) ?? 0.25 * st.runit);
  const nm = it.arg(sc) ?? "";
  if (!p || r === undefined) return;
  const L = st.T;
  const ex = scale(unit([L[0], L[1]]), r * Math.hypot(L[0], L[1]));
  const ey: Pt = [-ex[1], ex[0]];
  it.drawPath(ellipseSegs(p, ex, ey), st, { closed: true });
  regNode(it, nm, { center: p, shape: "circle", hw: r + st.lw / 2, hh: r + st.lw / 2, rot: 0, baseDy: 0 });
});

cmd("dotnode", (c) => {
  const { it, sc } = c;
  const opts = sc.options();
  const st = cloneState(c.st);
  it.set(st, opts);
  const cs = it.coordList(sc, 1);
  const p = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  const nm = it.arg(sc) ?? "";
  if (!p) return;
  it.dot(p, st);
  const r = (st.dotsize[0] + st.dotsize[1] * st.lw) / 2;
  regNode(it, nm, { center: p, shape: "circle", hw: r, hh: r, rot: 0, baseDy: 0 });
});

cmd("fnode", (c) => {
  const { it, sc } = c;
  const { st } = objectState(c);
  const cs = it.coordList(sc, 1);
  const p = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  const nm = it.arg(sc) ?? "";
  if (!p) return;
  const fs = (st.kv.get("framesize") ?? "10pt").trim().split(/\s+/);
  const w = it.len(fs[0], st.xunit, st) ?? 10;
  const h = it.len(fs[1] ?? fs[0], st.yunit, st) ?? w;
  it.drawPath(polySegs([add(p, [-w / 2, -h / 2]), add(p, [w / 2, -h / 2]), add(p, [w / 2, h / 2]), add(p, [-w / 2, h / 2])], true), st, { closed: true });
  regNode(it, nm, { center: p, shape: "rectangle", hw: w / 2, hh: h / 2, rot: 0, baseDy: 0 });
});

/** Box nodes: \rnode{name}{stuff}, \circlenode{name}{stuff} ... */
box("rnode Rnode circlenode ovalnode dianode trinode", (it, sc, st, star, base, exact) => {
  const kind = /^\\([A-Za-z]+)/.exec(sc.s)![1];
  const opts = sc.options();
  const s2 = cloneState(st);
  it.set(s2, opts);
  const name = (it.arg(sc) ?? "").trim();
  sc.ws();
  const start = sc.i + 1;
  const body = it.arg(sc) ?? "";
  let inner = it.makeBox(body, s2, base + start, exact);
  if (kind === "circlenode") inner = it.frameBox("pscirclebox", inner, s2, star);
  else if (kind === "ovalnode") inner = it.frameBox("psovalbox", inner, s2, star);
  else if (kind === "dianode") inner = it.frameBox("psdiabox", inner, s2, star);
  else if (kind === "trinode") inner = it.frameBox("pstribox", inner, s2, star);
  if (kind === "Rnode") {
    // \Rnode: the node's centre sits a little above the baseline (vref=0.7ex).
    const vref = it.len(s2.kv.get("vref"), s2.yunit, s2) ?? 3;
    return nodeBoxOf(it, name, inner, vref);
  }
  return nodeBoxOf(it, name, inner);
});

/** In the picture's flow (not inside \rput) a node box sits at the origin. */
cmd("rnode Rnode circlenode ovalnode dianode trinode", (c) => {
  flowBox(c);
});

/** \cnodeput(x,y){name}{stuff}, \rnode at coordinates (pst-node's \Rput style). */
cmd("cnodeput ovalnodeput dianodeput trinodeput rnodeput", (c) => {
  const { it, sc, st, star, name, base, exact } = c;
  const opts = sc.options();
  if (sc.peek() === "{") sc.group("{");
  const s2 = cloneState(st);
  it.set(s2, opts);
  const cs = it.coordList(sc, 1);
  const P = cs.length ? it.coord(cs[0], st) : apply(st.T, [0, 0]);
  const nm = (it.arg(sc) ?? "").trim();
  const body = it.arg(sc) ?? "";
  if (!P) return;
  const kind = name === "cnodeput" ? "pscirclebox" : name === "ovalnodeput" ? "psovalbox" : name === "dianodeput" ? "psdiabox" : name === "trinodeput" ? "pstribox" : "";
  let inner = it.makeBox(body, s2, base, exact);
  if (kind) inner = it.frameBox(kind, inner, s2, star);
  const bx = nodeBoxOf(it, nm, inner);
  it.place(bx, P, refPoint(bx, undefined), 0, st);
});

function flowBox(c: Call): void {
  const { it, sc, st, star, name, base, exact } = c;
  const start = sc.i;
  const tmp = sc.i;
  sc.options();
  let n = 0;
  while (n < 2 && sc.peek() === "{") {
    sc.group("{");
    n++;
  }
  const text = `\\${name}${star ? "*" : ""}${sc.s.slice(tmp, sc.i)}`;
  const bx = it.commandBox(text, st, base + start, exact);
  it.place(bx, apply(st.T, [0, 0]), [0, 0], 0, st);
}

cmd("nput", ({ it, sc, st, base, exact }) => {
  const opts = sc.options();
  const s2 = cloneState(st);
  it.set(s2, opts);
  const ang = it.number(it.arg(sc)) ?? 0;
  const nm = (it.arg(sc) ?? "").trim();
  const body = it.arg(sc) ?? "";
  const n = it.nodes.get(nm);
  if (!n) {
    it.warnOnce(`node:${nm}`, `Unknown node (${nm})`);
    return;
  }
  const edge = borderPoint(n, add(n.center, dir(ang)));
  const Q = add(edge, scale(dir(ang), s2.labelsep));
  const bx = it.makeBox(body, s2, base, exact);
  it.place(bx, Q, uputRef(bx, ang), 0, { ...s2, T: [1, 0, 0, 1, 0, 0] });
});

// ---------------------------------------------------------------- connections

interface Ends {
  a: NodeInfo;
  b: NodeInfo;
}

function nodePair(it: PstInterp, sc: Call["sc"], st: PState, coords: boolean): Ends | undefined {
  if (coords) {
    const cs = it.coordList(sc, 2);
    if (cs.length !== 2) return undefined;
    const p = it.coord(cs[0], st);
    const q = it.coord(cs[1], st);
    if (!p || !q) return undefined;
    const pt = (c: Pt): NodeInfo => ({ name: "", center: c, shape: "coordinate", hw: 0, hh: 0, rot: 0, baseDy: 0 });
    return { a: pt(p), b: pt(q) };
  }
  const an = (it.arg(sc) ?? "").trim();
  const bn = (it.arg(sc) ?? "").trim();
  const get = (n: string): NodeInfo | undefined => {
    const x = it.nodes.get(n);
    if (!x) it.warnOnce(`node:${n}`, `Unknown node (${n})`, "Define the node first (\\pnode, \\rnode, \\cnode, \\circlenode ...)");
    return x;
  };
  const a = get(an);
  const b = get(bn);
  return a && b ? { a, b } : undefined;
}

/** Where a connection leaves node n in direction `ang` (degrees), nodesep further out. */
function edge(n: NodeInfo, ang: number, sep: number): Pt {
  const p = n.shape === "coordinate" || (n.hw <= 0 && n.hh <= 0) ? n.center : borderPoint(n, add(n.center, dir(ang)));
  return add(p, scale(dir(ang), sep));
}

const angleOf = (v: Pt) => (Math.atan2(v[1], v[0]) * 180) / Math.PI;

function params(it: PstInterp, st: PState) {
  const kv = st.kv;
  const L = (k: string, d: number) => it.len(kv.get(k), st.xunit, st) ?? d;
  const N = (k: string, d: number) => it.number(kv.get(k)) ?? d;
  const nodesep = L("nodesep", 0);
  const arm = L("arm", 10);
  const angle = N("angle", 0);
  const offset = L("offset", 0);
  const arcangle = N("arcangle", 8);
  const ncurv = N("ncurv", 0.67);
  return {
    sepA: L("nodesepA", nodesep),
    sepB: L("nodesepB", nodesep),
    armA: L("armA", arm),
    armB: L("armB", arm),
    angleA: kv.has("angleA") ? N("angleA", 0) : angle,
    angleB: kv.has("angleB") ? N("angleB", 0) : angle,
    hasAngleA: kv.has("angleA") || kv.has("angle"),
    hasAngleB: kv.has("angleB") || kv.has("angle"),
    offA: L("offsetA", offset),
    offB: L("offsetB", offset),
    arcA: N("arcangleA", arcangle),
    arcB: N("arcangleB", arcangle),
    ncurvA: N("ncurvA", ncurv),
    ncurvB: N("ncurvB", ncurv),
    loopsize: L("loopsize", 28.4528),
    boxsize: L("boxsize", 0.4 * 28.4528),
    npos: kv.has("npos") ? N("npos", 0.5) : undefined,
  };
}

function connect(c: Call, kind: string, coords: boolean): void {
  const { it, sc } = c;
  const { st } = objectState(c);
  const ends = nodePair(it, sc, st, coords);
  it.lastConn = undefined;
  if (!ends) return;
  connectNodes(it, kind, ends.a, ends.b, st);
}

/** Draws a connection of `kind` (line, arc, curve, angle, angles, bar, diag, diagg, loop, box) from a to b and remembers it for labels. */
export function connectNodes(it: PstInterp, kind: string, a: NodeInfo, b: NodeInfo, st: PState): void {
  it.lastConn = undefined;
  const P = params(it, st);
  const AB = angleOf(sub(b.center, a.center));
  let pts: Pt[];
  let curve = false;
  let defPos = 0.5;
  const shiftPerp = (p: Pt, ang: number, off: number): Pt => (off ? add(p, scale(dir(ang + 90), off)) : p);
  switch (kind) {
    case "line": {
      let A = edge(a, AB, P.sepA);
      let B = edge(b, AB + 180, P.sepB);
      A = shiftPerp(A, AB, P.offA);
      B = shiftPerp(B, AB, P.offB);
      pts = [A, B];
      break;
    }
    case "arc":
    case "curve": {
      const aa = kind === "arc" ? AB + P.arcA : P.angleA;
      const ab = kind === "arc" ? AB + 180 - P.arcB : P.angleB;
      const A = edge(a, aa, P.sepA);
      const B = edge(b, ab, P.sepB);
      const d = dist(A, B);
      let kA: number;
      let kB: number;
      if (kind === "arc") {
        const th = (P.arcA * Math.PI) / 180;
        kA = Math.abs(th) > 1e-6 ? (4 / 3) * Math.tan(th / 2) * (d / (2 * Math.sin(th))) : d / 3;
        const thB = (P.arcB * Math.PI) / 180;
        kB = Math.abs(thB) > 1e-6 ? (4 / 3) * Math.tan(thB / 2) * (d / (2 * Math.sin(thB))) : d / 3;
        kA = Math.abs(kA);
        kB = Math.abs(kB);
      } else {
        kA = P.ncurvA * d * 0.5;
        kB = P.ncurvB * d * 0.5;
      }
      pts = [A, add(A, scale(dir(aa), kA)), add(B, scale(dir(ab), kB)), B];
      curve = true;
      break;
    }
    case "angle":
    case "angles": {
      const A = edge(a, P.angleA, P.sepA);
      const B = edge(b, P.angleB, P.sepB);
      const Q = add(B, scale(dir(P.angleB), P.armB));
      if (kind === "angles") {
        const A1 = add(A, scale(dir(P.angleA), P.armA));
        // Middle: from A1 go perpendicular to armB's direction until in line with Q.
        const corner = lineIntersection(A1, add(A1, dir(P.angleA + 90)), Q, add(Q, dir(P.angleB)));
        pts = corner ? [A, A1, corner, Q, B] : [A, A1, Q, B];
        defPos = 1.5;
        break;
      }
      const corner = lineIntersection(A, add(A, dir(P.angleA)), Q, add(Q, dir(P.angleB + 90)));
      if (corner && dist(corner, A) < 1e5) pts = [A, corner, Q, B];
      else {
        // Parallel arms: an L through B's arm.
        const u = dir(P.angleA);
        const t = (Q[0] - A[0]) * u[0] + (Q[1] - A[1]) * u[1];
        pts = [A, add(A, scale(u, t)), Q, B];
      }
      defPos = 1.5;
      break;
    }
    case "bar": {
      const ang = P.hasAngleA ? P.angleA : 0;
      const u = dir(ang);
      const A = edge(a, ang, P.sepA);
      const B = edge(b, ang, P.sepB);
      const pa = A[0] * u[0] + A[1] * u[1];
      const pb = B[0] * u[0] + B[1] * u[1];
      const far = Math.max(pa + P.armA, pb + P.armB);
      pts = [A, add(A, scale(u, far - pa)), add(B, scale(u, far - pb)), B];
      defPos = 1.5;
      break;
    }
    case "diag":
    case "diagg": {
      const A = edge(a, P.angleA, P.sepA);
      const B = edge(b, P.angleB, P.sepB);
      const A1 = add(A, scale(dir(P.angleA), P.armA));
      pts = kind === "diag" ? [A, A1, add(B, scale(dir(P.angleB), P.armB)), B] : [A, A1, B];
      defPos = kind === "diag" ? 1.5 : 0.5;
      break;
    }
    case "loop": {
      const angA = P.hasAngleA ? P.angleA : 0;
      const angB = P.hasAngleB ? P.angleB : 180;
      const A = edge(a, angA, P.sepA);
      const B = edge(b, angB, P.sepB);
      const A1 = add(A, scale(dir(angA), P.armA));
      const B1 = add(B, scale(dir(angB), P.armB));
      const up = dir(angA + 90);
      pts = [A, A1, add(A1, scale(up, P.loopsize)), add(B1, scale(up, P.loopsize)), B1, B];
      defPos = 2.5;
      break;
    }
    case "box": {
      const A = a.center;
      const B = b.center;
      const u = unit(sub(B, A));
      const nrm: Pt = [-u[1], u[0]];
      const h = P.boxsize;
      const ext = P.sepA;
      const a0 = add(A, scale(u, -ext));
      const b0 = add(B, scale(u, P.sepB));
      it.drawPath(polySegs([add(a0, scale(nrm, -h)), add(b0, scale(nrm, -h)), add(b0, scale(nrm, h)), add(a0, scale(nrm, h))], true), st, { closed: true });
      it.lastConn = { pts: [add(a0, scale(nrm, h)), add(b0, scale(nrm, h))], kind: "poly", npos: 0.5, st };
      return;
    }
    default:
      pts = [a.center, b.center];
  }
  if (curve) it.drawPath([{ t: "M", p: pts[0] }, { t: "C", c1: pts[1], c2: pts[2], p: pts[3] }], st);
  else it.drawPath(polySegs(pts, false), st);
  it.lastConn = { pts, kind: curve ? "curve" : "poly", npos: P.npos ?? defPos, st };
}

cmd("ncline pcline", (c) => connect(c, "line", c.name === "pcline"));
cmd("ncarc pcarc", (c) => connect(c, "arc", c.name === "pcarc"));
cmd("nccurve pccurve", (c) => connect(c, "curve", c.name === "pccurve"));
cmd("ncangle pcangle", (c) => connect(c, "angle", c.name === "pcangle"));
cmd("ncangles pcangles", (c) => connect(c, "angles", c.name === "pcangles"));
cmd("ncbar pcbar", (c) => connect(c, "bar", c.name === "pcbar"));
cmd("ncdiag pcdiag", (c) => connect(c, "diag", c.name === "pcdiag"));
cmd("ncdiagg pcdiagg", (c) => connect(c, "diagg", c.name === "pcdiagg"));
cmd("ncloop pcloop", (c) => connect(c, "loop", c.name === "pcloop"));
cmd("ncbox ncarcbox pcbox", (c) => connect(c, "box", c.name === "pcbox"));
cmd("nccircle", (c) => {
  const { it, sc } = c;
  // \nccircle[opts]{arrows}{A}{r}: one node, then the radius.
  const opts = sc.options();
  const st = cloneState(c.st);
  it.set(st, opts);
  const arrows = it.arrowsArg(sc, st);
  if (arrows !== undefined) st.arrows = arrows;
  const an = (it.arg(sc) ?? "").trim();
  const a = it.nodes.get(an);
  if (!a) {
    it.warnOnce(`node:${an}`, `Unknown node (${an})`);
    it.arg(sc);
    return;
  }
  const r = it.len(it.arg(sc), st.runit, st) ?? 0.5 * st.runit;
  const P = params(it, st);
  const angA = P.hasAngleA ? P.angleA : 0;
  const ctr = add(a.center, scale(dir(angA + 90), r));
  const pts: Pt[] = [];
  for (let k = 0; k <= 96; k++) {
    const t = angA - 90 + (360 * k) / 96;
    const p = add(ctr, scale(dir(t), r));
    const bp = a.shape === "coordinate" ? a.center : borderPoint(a, p);
    const inside = dist(p, a.center) <= dist(bp, a.center) + P.sepA + 1e-6;
    if (!inside) pts.push(p);
  }
  it.lastConn = undefined;
  if (pts.length < 2) return;
  it.drawPath(polySegs(pts, false), st);
  it.lastConn = { pts, kind: "poly", npos: (pts.length - 1) / 2, st };
});

// ---------------------------------------------------------------- labels

/** Point and direction at position npos of the last connection. */
function along(conn: NonNullable<PstInterp["lastConn"]>, pos: number): { p: Pt; d: Pt } {
  const pts = conn.pts;
  if (conn.kind === "curve") {
    const t = Math.max(0, Math.min(1, pos));
    return { p: bez(pts[0], pts[1], pts[2], pts[3], t), d: bezTangent(pts[0], pts[1], pts[2], pts[3], t) };
  }
  const n = pts.length - 1;
  const k = Math.max(0, Math.min(n - 1, Math.floor(pos)));
  const t = Math.max(0, Math.min(1, pos - k));
  const a = pts[k];
  const b = pts[k + 1] ?? a;
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], d: sub(b, a) };
}

function connLabel(c: Call, where: Where): void {
  const { it, sc, st, star, base, exact } = c;
  const opts = sc.options();
  const s2 = cloneState(st);
  it.set(s2, opts);
  let rotRaw: string | undefined;
  if (sc.peek() === "{") {
    // A label, or {rotation}{label} when two groups follow.
    const save = sc.i;
    const first = sc.group("{");
    if (sc.peek() === "{" && first !== undefined && /^\s*[*]?[-+\d.ULDRNSEW:]+\s*$/.test(first)) rotRaw = first;
    else sc.i = save;
  }
  sc.ws();
  const start = sc.i + 1;
  const body = it.arg(sc) ?? "";
  if (!it.lastConn) return;
  labelConn(it, where, it.makeBox(body, s2, base + start, exact), s2, star, rotRaw);
}

export type Where = "above" | "below" | "on" | "left" | "right";

/** Puts a box on the last connection: above or below it (relative to its direction), on it, or left or right of it on the page. */
export function labelConn(it: PstInterp, where: Where, box0: PBox, s2: PState, star: boolean, rotRaw?: string): void {
  const conn = it.lastConn;
  if (!conn) return;
  const kv = s2.kv;
  const posRaw = kv.get("npos") ?? kv.get("tpos");
  const pos = posRaw !== undefined ? (it.number(posRaw) ?? conn.npos) : conn.npos;
  const { p, d } = along(conn, pos);
  const dang = angleOf(d);
  let rot = 0;
  const nrot = (rotRaw ?? kv.get("nrot") ?? "0").trim();
  if (nrot.startsWith(":")) {
    const r = nrot.slice(1);
    const base0 = { U: 0, L: 90, D: 180, R: -90 }[r as "U"] ?? it.number(r) ?? 0;
    rot = dang + base0;
    // Keep text readable.
    if (r === "U" && Math.cos((rot * Math.PI) / 180) < -1e-6) rot += 180;
  } else rot = { U: 0, L: 90, D: 180, R: -90 }[nrot as "U"] ?? it.number(nrot) ?? 0;
  let bx = box0;
  if (star) bx = it.frameBox("psframebox", bx, { ...cloneState(s2), fillstyle: "solid", fc: "#ffffff", linestyle: "none", framesep: 1 }, true);
  const id = { ...s2, T: [1, 0, 0, 1, 0, 0] } as PState;
  if (where === "on") {
    it.place(bx, p, refPoint(bx, undefined), rot, id);
    return;
  }
  let side: number;
  if (where === "above") side = dang + 90;
  else if (where === "below") side = dang - 90;
  else {
    // \tlput and \trput: left or right of the edge on the page.
    const left = dang + 90;
    const lx = Math.cos((left * Math.PI) / 180);
    const leftIsLeft = lx < -1e-6 || (Math.abs(lx) <= 1e-6 && Math.sin((left * Math.PI) / 180) > 0);
    side = (where === "left") === leftIsLeft ? left : dang - 90;
  }
  const Q = add(p, scale(dir(side), s2.labelsep));
  it.place(bx, Q, uputRef(bx, side - rot), rot, id);
}

cmd("naput taput Aput", (c) => connLabel(c, "above"));
cmd("nbput tbput Bput", (c) => connLabel(c, "below"));
cmd("ncput tvput thput mput Mput", (c) => connLabel(c, "on"));
cmd("tlput", (c) => connLabel(c, "left"));
cmd("trput", (c) => connLabel(c, "right"));
