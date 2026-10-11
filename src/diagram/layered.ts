/**
 * Layered graph layout (the Sugiyama method), written for texwright's
 * diagrams: flowcharts, state, class and entity-relationship diagrams.
 *
 * 1. Cycles are broken by reversing the back edges a depth-first search finds.
 * 2. Ranks: longest path from the sources, then nodes with no incoming edges
 *    are pulled down next to what they feed. Every edge's length is doubled
 *    so each edge crosses at least one empty rank; an edge's label sits on
 *    that middle rank as a node of its own, so labels never sit on a box.
 * 3. Long edges are chains of dummy nodes, one per rank they cross.
 * 4. Order within ranks: barycentre sweeps down and up, keeping the order
 *    with fewest crossings. Subgraphs (clusters) stay contiguous, and border
 *    nodes on each of their ranks keep anything else from landing inside.
 * 5. Horizontal positions: each rank in turn is placed as close as it can be
 *    to the average of its neighbours above or below, subject to the minimum
 *    gaps, which is isotonic regression and is solved exactly by pooling
 *    adjacent violators. Dummy chains weigh more, so long edges run straight.
 * 6. Vertical positions from the tallest thing on each rank, with room for
 *    subgraph titles and padding.
 *
 * Everything is computed top to bottom; LR, RL and BT are the same layout
 * turned at the end, with node sizes swapped going in.
 */

import type { Pt } from "./svg.js";

export type RankDir = "TB" | "BT" | "LR" | "RL";

export interface LNode {
  id: string;
  width: number;
  height: number;
  cluster?: string;
}

export interface LEdge {
  id: number;
  from: string;
  to: string;
  /** Ranks the edge spans at least (default 1). */
  minlen?: number;
  /** Importance for straightness (default 1). */
  weight?: number;
  label?: { width: number; height: number };
}

export interface LCluster {
  id: string;
  parent?: string;
  padding: number;
  /** Room for the title, along the top of the box in the final drawing. */
  titleWidth: number;
  titleHeight: number;
}

export interface LayoutOptions {
  rankdir: RankDir;
  nodesep: number;
  ranksep: number;
  edgesep: number;
}

export interface PlacedNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  /** From the source's centre row (a port across its side) through the bends to the target's. */
  points: Pt[];
  label?: Pt;
  reversed: boolean;
}

export interface LayoutResult {
  width: number;
  height: number;
  /** Ranks run down (TB, BT) or across (LR, RL): the direction edges leave and enter nodes. */
  vertical: boolean;
  nodes: Map<string, PlacedNode>;
  edges: Map<number, PlacedEdge>;
  clusters: Map<string, { x: number; y: number; width: number; height: number }>;
  selfLoops: LEdge[];
}

interface V {
  id: string;
  /** Real node index into the input, or -1. */
  real: number;
  kind: "node" | "dummy" | "label" | "border-l" | "border-r";
  width: number;
  height: number;
  rank: number;
  order: number;
  x: number;
  /** Innermost cluster, and the chain of clusters from the outermost. */
  cluster?: string;
  path: string[];
  /** For border nodes: the cluster they bound. */
  of?: string;
}

interface Seg {
  /** Upper and lower node in rank order. */
  u: number;
  v: number;
  w: number;
}

export function layoutGraph(nodesIn: LNode[], edgesIn: LEdge[], clustersIn: LCluster[], opts: LayoutOptions): LayoutResult {
  const vertical = opts.rankdir === "TB" || opts.rankdir === "BT";
  const swap = !vertical;
  const clusters = new Map(clustersIn.map((c) => [c.id, c]));
  const clusterPath = (c: string | undefined): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let k = c; k && clusters.has(k) && !seen.has(k); k = clusters.get(k)!.parent) {
      seen.add(k);
      out.unshift(k);
    }
    return out;
  };

  // ------------------------------------------------------------ graph
  const V: V[] = [];
  const index = new Map<string, number>();
  for (const nd of nodesIn) {
    if (index.has(nd.id)) continue;
    index.set(nd.id, V.length);
    const p = clusterPath(nd.cluster);
    V.push({ id: nd.id, real: V.length, kind: "node", width: swap ? nd.height : nd.width, height: swap ? nd.width : nd.height, rank: 0, order: 0, x: 0, cluster: p[p.length - 1], path: p });
  }
  const realCount = V.length;
  const selfLoops: LEdge[] = [];
  const edges: { e: LEdge; u: number; v: number; reversed: boolean }[] = [];
  for (const e of edgesIn) {
    const u = index.get(e.from);
    const v = index.get(e.to);
    if (u === undefined || v === undefined) continue;
    if (u === v) {
      selfLoops.push(e);
      continue;
    }
    edges.push({ e, u, v, reversed: false });
  }

  // ------------------------------------------------------------ 1. cycles
  {
    const out: number[][] = Array.from({ length: realCount }, () => []);
    edges.forEach((ed, i) => out[ed.u].push(i));
    const state = new Uint8Array(realCount);
    for (let s = 0; s < realCount; s++) {
      if (state[s]) continue;
      const stack: [number, number][] = [[s, 0]];
      state[s] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [node, k] = top;
        if (k < out[node].length) {
          top[1]++;
          const ed = edges[out[node][k]];
          const t = ed.v;
          if (state[t] === 1) ed.reversed = true;
          else if (!state[t]) {
            state[t] = 1;
            stack.push([t, 0]);
          }
        } else {
          state[node] = 2;
          stack.pop();
        }
      }
    }
  }
  const tail = (ed: (typeof edges)[number]) => (ed.reversed ? ed.v : ed.u);
  const head = (ed: (typeof edges)[number]) => (ed.reversed ? ed.u : ed.v);
  const len = (ed: (typeof edges)[number]) => 2 * Math.max(0, Math.round(ed.e.minlen ?? 1));

  // ------------------------------------------------------------ 2. ranks
  {
    const indeg = new Array(realCount).fill(0);
    const out: number[][] = Array.from({ length: realCount }, () => []);
    const inn: number[][] = Array.from({ length: realCount }, () => []);
    edges.forEach((ed, i) => {
      indeg[head(ed)]++;
      out[tail(ed)].push(i);
      inn[head(ed)].push(i);
    });
    const topo: number[] = [];
    const queue: number[] = [];
    for (let i = 0; i < realCount; i++) if (!indeg[i]) queue.push(i);
    while (queue.length) {
      const u = queue.shift()!;
      topo.push(u);
      for (const ei of out[u]) {
        const w = head(edges[ei]);
        V[w].rank = Math.max(V[w].rank, V[u].rank + len(edges[ei]));
        if (--indeg[w] === 0) queue.push(w);
      }
    }
    // Pull nodes down toward the nodes they feed when nothing above holds them.
    for (let k = topo.length - 1; k >= 0; k--) {
      const u = topo[k];
      if (!out[u].length) continue;
      let lo = Infinity;
      for (const ei of out[u]) lo = Math.min(lo, V[head(edges[ei])].rank - len(edges[ei]));
      // Only nodes nothing points at move: sources drop to just above what they feed.
      if (!inn[u].length && lo > V[u].rank) V[u].rank = lo;
    }
    const min = Math.min(0, ...V.map((x) => x.rank));
    for (const x of V) x.rank -= min;
  }

  // ------------------------------------------------------------ 3. dummies
  const segs: Seg[] = [];
  const chains = new Map<number, number[]>();
  const labelAt = new Map<number, number>();
  const lca = (a: string[], b: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < Math.min(a.length, b.length) && a[i] === b[i]; i++) out.push(a[i]);
    return out;
  };
  for (const ed of edges) {
    const t = tail(ed);
    const h = head(ed);
    const r0 = V[t].rank;
    const r1 = V[h].rank;
    const path = lca(V[t].path, V[h].path);
    const chain = [t];
    const label = ed.e.label;
    const mid = r0 + Math.max(1, Math.round((r1 - r0) / 2));
    for (let r = r0 + 1; r < r1; r++) {
      const isLabel = !!label && r === mid;
      const idx = V.length;
      V.push({
        id: `\u0000d${idx}`,
        real: -1,
        kind: isLabel ? "label" : "dummy",
        width: isLabel ? (swap ? label!.height : label!.width) : 0,
        height: isLabel ? (swap ? label!.width : label!.height) : 0,
        rank: r,
        order: 0,
        x: 0,
        cluster: path[path.length - 1],
        path,
      });
      if (isLabel) labelAt.set(ed.e.id, idx);
      chain.push(idx);
    }
    chain.push(h);
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i];
      const b = chain[i + 1];
      const w = (ed.e.weight ?? 1) * (V[a].real < 0 && V[b].real < 0 ? 8 : V[a].real < 0 || V[b].real < 0 ? 2 : 1);
      segs.push({ u: a, v: b, w });
    }
    chains.set(ed.e.id, chain);
  }
  const maxRank = V.reduce((m, x) => Math.max(m, x.rank), 0);

  // ------------------------------------------------------------ cluster borders
  const span = new Map<string, [number, number]>();
  for (const x of V) {
    if (x.kind !== "node" && x.kind !== "label") continue;
    for (const c of x.path) {
      const s = span.get(c);
      span.set(c, s ? [Math.min(s[0], x.rank), Math.max(s[1], x.rank)] : [x.rank, x.rank]);
    }
  }
  const borders = new Map<string, { l: number[]; r: number[]; r0: number }>();
  for (const [c, [r0, r1]] of span) {
    const p = clusterPath(c);
    const l: number[] = [];
    const r: number[] = [];
    for (let k = r0; k <= r1; k++) {
      for (const side of ["border-l", "border-r"] as const) {
        const idx = V.length;
        V.push({ id: `\u0000${side}${c}${k}`, real: -1, kind: side, width: 0, height: 0, rank: k, order: 0, x: 0, cluster: c, path: p, of: c });
        (side === "border-l" ? l : r).push(idx);
      }
    }
    for (let i = 0; i + 1 < l.length; i++) {
      segs.push({ u: l[i], v: l[i + 1], w: 6 });
      segs.push({ u: r[i], v: r[i + 1], w: 6 });
    }
    borders.set(c, { l, r, r0 });
  }

  // ------------------------------------------------------------ 4. order
  const ranks: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  const up: Seg[][] = V.map(() => []);
  const down: Seg[][] = V.map(() => []);
  for (const s of segs) {
    down[s.u].push(s);
    up[s.v].push(s);
  }
  {
    // Initial order: depth-first from the sources in input order.
    const seen = new Uint8Array(V.length);
    const visit = (s: number) => {
      const stack = [s];
      while (stack.length) {
        const v = stack.pop()!;
        if (seen[v]) continue;
        seen[v] = 1;
        ranks[V[v].rank].push(v);
        const next = down[v].map((x) => x.v);
        for (let i = next.length - 1; i >= 0; i--) if (!seen[next[i]]) stack.push(next[i]);
      }
    };
    for (let i = 0; i < V.length; i++) if (!up[i].length) visit(i);
    for (let i = 0; i < V.length; i++) if (!seen[i]) visit(i);
  }
  const setOrder = () => ranks.forEach((r) => r.forEach((v, i) => (V[v].order = i)));
  const arrange = (layer: number[], key: Float64Array) => {
    // Sort by barycentre, then regroup so every cluster stays contiguous, its borders at its ends.
    const sorted = [...layer].sort((a, b) => key[a] - key[b] || V[a].order - V[b].order);
    const group = (items: number[], depth: number): number[] => {
      const buckets = new Map<string, number[]>();
      const solo: { k: number; items: number[] }[] = [];
      for (const v of items) {
        const c = V[v].path[depth];
        if (c === undefined) {
          solo.push({ k: key[v], items: [v] });
          continue;
        }
        let b = buckets.get(c);
        if (!b) buckets.set(c, (b = []));
        b.push(v);
      }
      const units: { k: number; items: number[] }[] = [...solo];
      for (const [c, members] of buckets) {
        const inner = members.filter((v) => !(V[v].of === c && V[v].path.length === depth + 1));
        const ls = members.filter((v) => V[v].of === c && V[v].kind === "border-l" && V[v].path.length === depth + 1);
        const rs = members.filter((v) => V[v].of === c && V[v].kind === "border-r" && V[v].path.length === depth + 1);
        const body = group(inner, depth + 1);
        const keys = inner.length ? inner.map((v) => key[v]) : members.map((v) => key[v]);
        units.push({ k: keys.reduce((s, x) => s + x, 0) / keys.length, items: [...ls, ...body, ...rs] });
      }
      return units.sort((a, b) => a.k - b.k).flatMap((u) => u.items);
    };
    return group(sorted, 0);
  };
  const crossings = (): number => {
    let total = 0;
    for (let r = 0; r < maxRank; r++) {
      const es: [number, number][] = [];
      for (const v of ranks[r]) for (const s of down[v]) if (V[s.v].rank === r + 1) es.push([V[v].order, V[s.v].order]);
      es.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) if (es[j][0] > es[i][0] && es[j][1] < es[i][1]) total++;
    }
    return total;
  };
  setOrder();
  ranks.forEach((r, i) => (ranks[i] = arrange(r, Float64Array.from(V, (x) => x.order))));
  setOrder();
  let best = ranks.map((r) => [...r]);
  let bestCross = crossings();
  const key = new Float64Array(V.length);
  for (let iter = 0; iter < 24 && bestCross > 0; iter++) {
    const downward = iter % 2 === 0;
    const seq = downward ? ranks.map((_, i) => i).slice(1) : ranks.map((_, i) => i).slice(0, -1).reverse();
    for (const r of seq) {
      for (const v of ranks[r]) {
        const nb = downward ? up[v] : down[v];
        let s = 0;
        let w = 0;
        for (const e of nb) {
          const o = downward ? e.u : e.v;
          s += V[o].order * e.w;
          w += e.w;
        }
        key[v] = w ? s / w : V[v].order;
      }
      ranks[r] = arrange(ranks[r], key);
      ranks[r].forEach((v, i) => (V[v].order = i));
    }
    const c = crossings();
    if (c < bestCross) {
      bestCross = c;
      best = ranks.map((r) => [...r]);
    }
  }
  best.forEach((r, i) => (ranks[i] = r));
  setOrder();

  // ------------------------------------------------------------ 5. x
  const gap = (a: V, b: V): number => {
    const half = (a.width + b.width) / 2;
    // Entering a cluster after its left border, or leaving before its right border: the padding.
    if (a.kind === "border-l" && b.path.includes(a.of!)) return half + clusters.get(a.of!)!.padding;
    if (b.kind === "border-r" && a.path.includes(b.of!)) return half + clusters.get(b.of!)!.padding;
    const real = (x: V) => x.kind === "node" || x.kind === "label";
    if (real(a) && real(b)) return half + opts.nodesep;
    if (a.kind.startsWith("border") || b.kind.startsWith("border")) return half + opts.nodesep / 2;
    return half + opts.edgesep;
  };
  for (const r of ranks) {
    let x = 0;
    r.forEach((v, i) => {
      if (i) x += gap(V[r[i - 1]], V[v]);
      V[v].x = x;
    });
  }
  const place = (r: number[], desired: Float64Array, weight: Float64Array) => {
    // Weighted isotonic regression on y = x - c with adjacent violators pooled.
    const k = r.length;
    if (!k) return;
    const c = new Float64Array(k);
    for (let i = 1; i < k; i++) c[i] = c[i - 1] + gap(V[r[i - 1]], V[r[i]]);
    const blocks: { sum: number; w: number; start: number; end: number }[] = [];
    for (let i = 0; i < k; i++) {
      const w = weight[r[i]] || 1e-6;
      blocks.push({ sum: (desired[r[i]] - c[i]) * w, w, start: i, end: i });
      while (blocks.length > 1) {
        const b = blocks[blocks.length - 1];
        const a = blocks[blocks.length - 2];
        if (a.sum / a.w <= b.sum / b.w) break;
        blocks.pop();
        a.sum += b.sum;
        a.w += b.w;
        a.end = b.end;
      }
    }
    for (const b of blocks) for (let i = b.start; i <= b.end; i++) V[r[i]].x = b.sum / b.w + c[i];
  };
  const desired = new Float64Array(V.length);
  const weight = new Float64Array(V.length);
  for (let iter = 0; iter < 16; iter++) {
    const downward = iter % 2 === 0;
    const seq = downward ? ranks.map((_, i) => i) : ranks.map((_, i) => i).reverse();
    for (const r of seq) {
      for (const v of ranks[r]) {
        // The last few passes look both ways, which settles nodes between their parents and children.
        const nb = iter >= 12 ? [...up[v], ...down[v]] : downward ? up[v] : down[v];
        let s = 0;
        let w = 0;
        for (const e of nb) {
          const o = e.u === v ? e.v : e.u;
          s += V[o].x * e.w;
          w += e.w;
        }
        desired[v] = w ? s / w : V[v].x;
        weight[v] = w ? w : 0.05;
      }
      place(ranks[r], desired, weight);
    }
  }
  const minX = Math.min(...V.map((v) => v.x - v.width / 2));
  for (const v of V) v.x -= minX;

  // ------------------------------------------------------------ 6. y
  const rankH = new Float64Array(maxRank + 1);
  for (const v of V) if (v.kind === "node" || v.kind === "label") rankH[v.rank] = Math.max(rankH[v.rank], v.height);
  // Extra room above the first rank of a cluster (padding, plus its title when the title is on top in this space).
  const extraAbove = new Float64Array(maxRank + 2);
  const extraBelow = new Float64Array(maxRank + 2);
  for (const [c, [r0, r1]] of span) {
    const cl = clusters.get(c)!;
    const title = vertical ? cl.titleHeight : 0;
    extraAbove[r0] += cl.padding + title;
    extraBelow[r1] += cl.padding;
  }
  const rankY = new Float64Array(maxRank + 1);
  let y = extraAbove[0];
  for (let r = 0; r <= maxRank; r++) {
    if (r) y += rankH[r - 1] / 2 + extraBelow[r - 1] + opts.ranksep / 2 + extraAbove[r] + rankH[r] / 2;
    else y += rankH[0] / 2;
    rankY[r] = y;
  }
  const totalH = y + rankH[maxRank] / 2 + extraBelow[maxRank];

  // ------------------------------------------------------------ ports
  // Edge ends spread along a node's side, ordered by where they go, so a node with several edges fans them out.
  const ports = new Map<string, number>();
  for (let i = 0; i < realCount; i++) {
    const nd = V[i];
    const sides: { below: { key: string; x: number }[]; above: { key: string; x: number }[] } = { below: [], above: [] };
    for (const [id, chain] of chains) {
      const at = chain.indexOf(i);
      if (at < 0) continue;
      const other = V[chain[at === 0 ? 1 : at - 1]];
      const entry = { key: `${id}:${at === 0 ? "s" : "e"}`, x: other.x };
      (other.rank > nd.rank ? sides.below : sides.above).push(entry);
    }
    for (const list of [sides.below, sides.above]) {
      list.sort((a, b) => a.x - b.x);
      const spread = Math.min(nd.width * 0.6, (list.length - 1) * 18);
      list.forEach((p, k) => ports.set(p.key, list.length > 1 ? -spread / 2 + (spread * k) / (list.length - 1) : 0));
    }
  }

  // ------------------------------------------------------------ out
  const totalW = Math.max(1, ...V.map((v) => v.x + v.width / 2));
  const final = (x: number, yy: number): Pt => {
    switch (opts.rankdir) {
      case "BT":
        return [x, totalH - yy];
      case "LR":
        return [yy, x];
      case "RL":
        return [totalH - yy, x];
      default:
        return [x, yy];
    }
  };
  const nodes = new Map<string, PlacedNode>();
  for (let i = 0; i < realCount; i++) {
    const v = V[i];
    const [fx, fy] = final(v.x, rankY[v.rank]);
    nodes.set(v.id, { x: fx, y: fy, width: swap ? v.height : v.width, height: swap ? v.width : v.height });
  }
  const placedEdges = new Map<number, PlacedEdge>();
  for (const ed of edges) {
    const chain = chains.get(ed.e.id)!;
    const pts: Pt[] = chain.map((v, k) => {
      const dx = k === 0 ? (ports.get(`${ed.e.id}:s`) ?? 0) : k === chain.length - 1 ? (ports.get(`${ed.e.id}:e`) ?? 0) : 0;
      return final(V[v].x + dx, rankY[V[v].rank]);
    });
    const li = labelAt.get(ed.e.id);
    placedEdges.set(ed.e.id, {
      points: ed.reversed ? pts.reverse() : pts,
      label: li !== undefined ? final(V[li].x, rankY[V[li].rank]) : undefined,
      reversed: ed.reversed,
    });
  }
  // Clusters: the borders across, the members' extent (plus padding and title) down.
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const depthOf = (c: string) => clusterPath(c).length;
  const order = [...span.keys()].sort((a, b) => depthOf(b) - depthOf(a));
  const layoutBox = new Map<string, [number, number, number, number]>();
  for (const c of order) {
    const cl = clusters.get(c)!;
    const b = borders.get(c)!;
    // Across: the members and inner boxes, not the border chain. Borders only keep
    // outsiders away during placement; they can drift wider than what they hold.
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const v of V) {
      if ((v.kind !== "node" && v.kind !== "label") || !v.path.includes(c)) continue;
      y0 = Math.min(y0, rankY[v.rank] - v.height / 2);
      y1 = Math.max(y1, rankY[v.rank] + v.height / 2);
      x0 = Math.min(x0, v.x - v.width / 2 - cl.padding);
      x1 = Math.max(x1, v.x + v.width / 2 + cl.padding);
    }
    for (const [k, inner] of layoutBox) {
      if (clusters.get(k)?.parent !== c) continue;
      x0 = Math.min(x0, inner[0] - cl.padding);
      x1 = Math.max(x1, inner[2] + cl.padding);
      y0 = Math.min(y0, inner[1]);
      y1 = Math.max(y1, inner[3]);
    }
    if (!Number.isFinite(x0)) {
      // An empty cluster: fall back to its border chain.
      x0 = Math.min(...b.l.map((i) => V[i].x));
      x1 = Math.max(...b.r.map((i) => V[i].x));
      y0 = Math.min(...b.l.map((i) => rankY[V[i].rank]));
      y1 = Math.max(...b.l.map((i) => rankY[V[i].rank]));
    }
    y0 -= cl.padding + (vertical ? cl.titleHeight : 0);
    y1 += cl.padding;
    if (!vertical) x0 -= cl.titleHeight;
    // The title must fit across the box.
    const across = vertical ? x1 - x0 : y1 - y0;
    const need = cl.titleWidth + 2 * cl.padding;
    if (across < need) {
      const d = (need - across) / 2;
      if (vertical) {
        x0 -= d;
        x1 += d;
      } else {
        y0 -= d;
        y1 += d;
      }
    }
    layoutBox.set(c, [x0, y0, x1, y1]);
    const a = final(x0, y0);
    const z = final(x1, y1);
    boxes.set(c, { x: Math.min(a[0], z[0]), y: Math.min(a[1], z[1]), width: Math.abs(z[0] - a[0]), height: Math.abs(z[1] - a[1]) });
  }
  // Everything shifted so nothing sits at a negative coordinate.
  let mx = 0;
  let my = 0;
  let Mx = swap ? totalH : totalW;
  let My = swap ? totalW : totalH;
  for (const b of boxes.values()) {
    mx = Math.min(mx, b.x);
    my = Math.min(my, b.y);
    Mx = Math.max(Mx, b.x + b.width);
    My = Math.max(My, b.y + b.height);
  }
  if (mx < 0 || my < 0) {
    for (const nd of nodes.values()) {
      nd.x -= mx;
      nd.y -= my;
    }
    for (const e of placedEdges.values()) {
      e.points = e.points.map((p) => [p[0] - mx, p[1] - my]);
      if (e.label) e.label = [e.label[0] - mx, e.label[1] - my];
    }
    for (const b of boxes.values()) {
      b.x -= mx;
      b.y -= my;
    }
  }
  return { width: Mx - mx, height: My - my, vertical, nodes, edges: placedEdges, clusters: boxes, selfLoops };
}
