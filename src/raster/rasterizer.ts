/**
 * Anti-aliased scanline filling by exact area coverage.
 *
 * Every edge of a path adds, to each pixel cell it passes through, the
 * signed area between the edge and the cell's right side (positive for an
 * edge going down, negative going up), and the rest of its height to the
 * cell after it. A running sum along a row then gives each pixel the
 * integral of the winding number over the pixel: exactly the covered area
 * for paths whose parts do not overlap, which is what text and most figures
 * are. The nonzero rule takes the magnitude capped at 1; even-odd folds it
 * into 0..1 (2 is outside, 3 inside again).
 *
 * The accumulator covers the whole canvas and is reset as it is swept, so
 * filling a small glyph only touches the cells under it.
 */

/** Pixels whose coverage is this close to 0 or 1 count as 0 or 1. */
export const COVERAGE_EPSILON = 1 / 1024;

export class CoverageRasterizer {
  readonly width: number;
  readonly height: number;
  private readonly stride: number;
  private readonly cells: Float32Array;
  /** Coverage of the row being swept, indexed by x. */
  private readonly row: Float32Array;
  // Cells touched since the last sweep (inclusive).
  private top = Infinity;
  private bottom = -Infinity;
  private left = Infinity;
  private right = -Infinity;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    // One extra cell per row takes what an edge passes to the right of the last pixel.
    this.stride = width + 1;
    this.cells = new Float32Array(this.stride * height);
    this.row = new Float32Array(width);
  }

  /** Adds the edge from (ax, ay) to (bx, by) in device pixels (y down). */
  line(ax: number, ay: number, bx: number, by: number): void {
    if (ay === by || !(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by))) return;
    let sign = 1;
    if (ay > by) {
      let t = ax;
      ax = bx;
      bx = t;
      t = ay;
      ay = by;
      by = t;
      sign = -1;
    }
    const H = this.height;
    if (by <= 0 || ay >= H) return;
    const dxdy = (bx - ax) / (by - ay);
    if (ay < 0) {
      ax -= ay * dxdy;
      ay = 0;
    }
    if (by > H) {
      bx = ax + (H - ay) * dxdy;
      by = H;
    }
    let r = Math.floor(ay);
    if (r < this.top) this.top = r;
    const last = Math.min(H - 1, Math.ceil(by) - 1);
    if (last > this.bottom) this.bottom = last;
    let y = ay;
    let x = ax;
    while (y < by) {
      const yn = Math.min(by, r + 1);
      const xn = yn === by ? bx : ax + (yn - ay) * dxdy;
      this.piece(r, x, xn, (yn - y) * sign);
      x = xn;
      y = yn;
      r++;
    }
  }

  /**
   * One edge piece inside row r, from x0 to x1, covering `dy` of the row's
   * height (signed). The area right of the edge within a cell is dy times
   * the distance from the edge's mean x to the cell's right side.
   */
  private piece(r: number, x0: number, x1: number, dy: number): void {
    let xl = x0 < x1 ? x0 : x1;
    let xr = x0 < x1 ? x1 : x0;
    const W = this.width;
    if (xl >= W) {
      // Only cells right of the canvas change, but whatever lies left of this
      // edge now reaches the canvas's right side: the sweep must run that far.
      this.right = W;
      return;
    }
    const base = r * this.stride;
    const cells = this.cells;
    if (xr <= 0) {
      // Left of the canvas: every pixel in the row is right of the edge.
      cells[base] += dy;
      if (this.left > 0) this.left = 0;
      if (this.right < 0) this.right = 0;
      return;
    }
    if (xl < 0) {
      const part = (dy * -xl) / (xr - xl);
      cells[base] += part;
      dy -= part;
      xl = 0;
    }
    if (xr > W) {
      dy *= (W - xl) / (xr - xl);
      xr = W;
    }
    let c = Math.floor(xl);
    if (c < this.left) this.left = c;
    if (xr <= c + 1) {
      const mid = (xl + xr) / 2 - c;
      cells[base + c] += dy * (1 - mid);
      cells[base + c + 1] += dy * mid;
      if (c + 1 > this.right) this.right = c + 1;
      return;
    }
    const k = dy / (xr - xl);
    let xa = xl;
    while (xa < xr) {
      const xb = xr < c + 1 ? xr : c + 1;
      const d = (xb - xa) * k;
      const mid = (xa + xb) / 2 - c;
      cells[base + c] += d * (1 - mid);
      cells[base + c + 1] += d * mid;
      xa = xb;
      c++;
    }
    if (c > this.right) this.right = c;
  }

  /**
   * Adds a cubic Bézier as line segments, subdivided so the polyline stays
   * within `tolerance` pixels of the curve: with second differences of at
   * most L, n uniform pieces deviate by at most 0.75 L / n².
   */
  cubic(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tolerance: number): void {
    const n = cubicSteps(x0, y0, x1, y1, x2, y2, x3, y3, tolerance);
    // Power basis: B(t) = ((a t + b) t + c) t + p0.
    const ax = -x0 + 3 * (x1 - x2) + x3;
    const ay = -y0 + 3 * (y1 - y2) + y3;
    const bx = 3 * (x0 - 2 * x1 + x2);
    const by = 3 * (y0 - 2 * y1 + y2);
    const cx = 3 * (x1 - x0);
    const cy = 3 * (y1 - y0);
    let px = x0;
    let py = y0;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const qx = ((ax * t + bx) * t + cx) * t + x0;
      const qy = ((ay * t + by) * t + cy) * t + y0;
      this.line(px, py, qx, qy);
      px = qx;
      py = qy;
    }
    this.line(px, py, x3, y3);
  }

  /** True when no edge has been added since the last sweep. */
  get empty(): boolean {
    return this.top > this.bottom;
  }

  /** The pixel box the edges added so far can cover: [x0, y0, x1, y1), or undefined when empty. */
  bounds(): [number, number, number, number] | undefined {
    if (this.empty) return undefined;
    return [Math.max(0, this.left), this.top, Math.min(this.width, this.right + 1), this.bottom + 1];
  }

  /**
   * Turns the edges added since the last sweep into coverage, one row at a
   * time: `visit(y, x0, x1, cov)` gets cov[x] in 0..1 for x0 <= x < x1.
   * Clears the accumulator.
   */
  sweep(evenOdd: boolean, visit: (y: number, x0: number, x1: number, cov: Float32Array) => void): void {
    if (this.empty) return;
    const cells = this.cells;
    const row = this.row;
    const W = this.width;
    const x0 = Math.max(0, this.left);
    const end = Math.min(this.right, W); // last cell index to clear (may be the overflow cell)
    const x1 = Math.min(W, end + 1);
    for (let y = this.top; y <= this.bottom; y++) {
      const base = y * this.stride;
      let acc = 0;
      for (let x = x0; x <= end; x++) {
        acc += cells[base + x];
        cells[base + x] = 0;
        if (x >= W) break;
        let a = acc < 0 ? -acc : acc;
        if (evenOdd) {
          a %= 2;
          if (a > 1) a = 2 - a;
        } else if (a > 1) a = 1;
        row[x] = a;
      }
      visit(y, x0, x1, row);
    }
    this.reset();
  }

  /** Forgets the edges added since the last sweep. */
  clear(): void {
    if (this.empty) return;
    const x0 = Math.max(0, this.left);
    const end = Math.min(this.right, this.width);
    for (let y = this.top; y <= this.bottom; y++) this.cells.fill(0, y * this.stride + x0, y * this.stride + end + 1);
    this.reset();
  }

  private reset(): void {
    this.top = Infinity;
    this.bottom = -Infinity;
    this.left = Infinity;
    this.right = -Infinity;
  }
}

/** Uniform pieces needed to keep a cubic's polyline within `tolerance` of it (1 to 1000). */
export function cubicSteps(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tolerance: number): number {
  const ddx0 = x0 - 2 * x1 + x2;
  const ddy0 = y0 - 2 * y1 + y2;
  const ddx1 = x1 - 2 * x2 + x3;
  const ddy1 = y1 - 2 * y2 + y3;
  const l = Math.sqrt(Math.max(ddx0 * ddx0 + ddy0 * ddy0, ddx1 * ddx1 + ddy1 * ddy1));
  const n = Math.ceil(Math.sqrt((0.75 * l) / tolerance));
  return n >= 1 ? (n <= 1000 ? n : 1000) : 1;
}
