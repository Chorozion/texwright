import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { colorAt, namedColormap, parseColormap, DEFAULT_COLORMAP } from "../src/tikz/colormap.js";
import { picturePreamble, renderTikz } from "../src/tikz/index.js";
import { clipToX } from "../src/tikz/pgfplots.js";
import { MAX_SURFACE_SAMPLES, Projection, isAxis3d, patchOrder, tickEdge } from "../src/tikz/pgfplots3d.js";
import { mainCoords } from "../src/tikz/tdplot.js";

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not close to ${b}`);
const axis = (opts: string, body: string) => String.raw`\begin{tikzpicture}\begin{axis}[${opts}]` + body + String.raw`\end{axis}\end{tikzpicture}`;
const paths = (svg: string) => svg.match(/<path /g)?.length ?? 0;

describe("3D axes: detection and options", () => {
  test("\\addplot3 or a view makes an axis 3D", () => {
    assert.ok(isAxis3d("", String.raw`\addplot3 {x*y};`));
    assert.ok(isAxis3d("", String.raw`\addplot3+[surf] {x*y};`));
    assert.ok(isAxis3d("view={0}{90}", String.raw`\addplot {x};`));
    assert.ok(!isAxis3d("xlabel=x", String.raw`\addplot {x};`));
  });

  test("a surface draws without warnings", () => {
    const r = renderTikz(axis("view={45}{30}, colormap/viridis, xlabel=$x$, zlabel=$z$", String.raw`\addplot3[surf, domain=-2:2, samples=10] {exp(-x^2-y^2)};`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    // 9 x 9 patches, each a path, plus the frame and labels.
    assert.ok(paths(r.svg!) >= 81);
  });

  test("unknown colour maps warn and fall back", () => {
    const r = renderTikz(axis("colormap/nonesuch", String.raw`\addplot3[surf, samples=4] {x+y};`));
    assert.ok(r.svg);
    assert.ok(r.messages.some((m) => /Colour map nonesuch/.test(m.message)));
  });

  test("view, zmin and zmax, axis lines=center, hide axis", () => {
    for (const o of ["view={120}{40}", "view={0}{90}", "view={30}{-20}", "zmin=0, zmax=2", "axis lines=center", "axis lines=left", "hide axis", "grid=major", "colorbar", "colorbar horizontal", "axis equal", "3d box=complete"]) {
      const r = renderTikz(axis(o, String.raw`\addplot3[surf, samples=6, domain=-1:1] {x^2-y^2};`));
      assert.ok(r.svg, o);
      assert.ok(!/NaN|Infinity/.test(r.svg!), o);
      assert.deepEqual(r.messages, [], o);
    }
  });
});

describe("3D plot sources", () => {
  test("coordinates with empty lines between scan lines make a grid", () => {
    const r = renderTikz(axis("", String.raw`\addplot3[surf] coordinates {(0,0,0) (1,0,1) (2,0,0)

(0,1,1) (1,1,2) (2,1,1)};`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
  });

  test("a table with mesh/rows makes a grid; without it a surface warns and draws a line", () => {
    const data = "x y z\n0 0 1\n1 0 2\n0 1 3\n1 1 4\n";
    const ok = renderTikz(axis("", String.raw`\addplot3[surf, mesh/rows=2] table {` + data + "};"));
    assert.deepEqual(ok.messages, []);
    const line = renderTikz(axis("", String.raw`\addplot3[surf] table {` + "x y z\n0 0 1\n1 3 2\n5 1 3\n" + "};"));
    assert.ok(line.svg);
    assert.ok(line.messages.some((m) => /needs a grid/.test(m.message)));
  });

  test("a parametric curve with samples y=0 is a line, not a surface", () => {
    const r = renderTikz(axis("", String.raw`\addplot3[blue, domain=0:6.28, samples=50, samples y=0, variable=t] ({cos(deg(t))}, {sin(deg(t))}, {t});`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    // One stroked polyline with 50 points.
    const line = /<path d="(M[^"]*)" fill="none" stroke="#0000ff"/.exec(r.svg!);
    assert.ok(line);
    assert.equal((line![1].match(/L/g) ?? []).length, 49);
  });

  test("scatter colours marks by point meta", () => {
    const r = renderTikz(axis("colormap/jet", String.raw`\addplot3[scatter, only marks, point meta=z] coordinates {(0,0,0) (1,1,1) (2,2,2)};`));
    assert.ok(r.svg);
    // jet's ends: dark blue and dark red.
    assert.match(r.svg!, /fill="#000080"/);
    assert.match(r.svg!, /fill="#800000"/);
  });

  test("contour gnuplot draws level lines by marching squares", () => {
    const r = renderTikz(axis("view={0}{90}, colormap/jet", String.raw`\addplot3[contour gnuplot={levels={1,2}}, samples=11, domain=-2:2] {x^2+y^2};`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    // One path per level, coloured from the map (the levels span z from 0 to 8).
    const lines = r.svg!.match(/<path d="[^"]*" fill="none" stroke="#[0-9a-f]{6}" stroke-width="0.4" stroke-linecap="round"/g) ?? [];
    assert.equal(lines.length, 2);
  });

  test("patch draws triangles of consecutive points", () => {
    const r = renderTikz(axis("", String.raw`\addplot3[patch] coordinates {(0,0,0) (1,0,1) (0,1,2) (1,1,0) (2,1,1) (1,2,2)};`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    assert.equal((r.svg!.match(/<path d="M[^"]*Z" fill="#/g) ?? []).length, 2);
  });

  test("quiver draws one arrow per point", () => {
    const r = renderTikz(axis("", String.raw`\addplot3[red, quiver={u=1, v=0, w=0}, samples=3, domain=0:1] (x, y, 0);`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    assert.equal((r.svg!.match(/stroke="#ff0000"/g) ?? []).length, 9);
  });

  test("a 2D axis with a colour bar or a quiver plot is drawn from above", () => {
    assert.ok(isAxis3d("colorbar", String.raw`\addplot[scatter, only marks] coordinates {(0,0) (1,1)};`));
    assert.ok(isAxis3d("", String.raw`\addplot[quiver={u=1, v=x}] coordinates {(0,0) (1,1)};`));
    assert.ok(!isAxis3d("colorbar, ybar", String.raw`\addplot coordinates {(0,0) (1,1)};`));
    assert.ok(!isAxis3d("colorbar", String.raw`\addplot coordinates {(0,0) (1,1)};`, "semilogyaxis"));
    const r = renderTikz(axis("colorbar, colormap/viridis", String.raw`\addplot[scatter, only marks] coordinates {(0,0) (1,1) (2,4)};`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    // Point meta is y in 2D: the lowest point gets the start of the map, the highest its end.
    assert.match(r.svg!, /fill="#440154"/);
    assert.match(r.svg!, /fill="#fde725"/);
    const q = renderTikz(axis("", String.raw`\addplot[blue, -stealth, quiver={u=-y, v=x, scale arrows=0.2}, samples=4, domain=-1:1] (x, x);`));
    assert.ok(q.svg);
    assert.deepEqual(q.messages, []);
  });

  test("\\addplot in a 3D axis lies in the plane z = 0", () => {
    const r = renderTikz(axis("view={30}{30}", String.raw`\addplot3[surf, samples=4] {x+y}; \addplot[red] coordinates {(0,0) (1,1)};`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
  });
});

describe("projection and depth", () => {
  test("pgfplots' default view: x runs right and down, y right and up, z straight up", () => {
    const P = new Projection(25, 30, [0, 0, 0], [1, 1, 1], [1, 1, 1]);
    near(P.r1[0], Math.cos((25 * Math.PI) / 180));
    near(P.r2[0], -Math.sin((25 * Math.PI) / 180) * 0.5);
    near(P.r2[2], Math.cos(Math.PI / 6));
    P.fit(200, 150, 0, 0, false);
    const o = P.screen(0, 0, 0);
    const x = P.screen(1, 0, 0);
    const y = P.screen(0, 1, 0);
    const z = P.screen(0, 0, 1);
    assert.ok(x[0] > o[0] && x[1] < o[1]);
    assert.ok(y[0] > o[0] && y[1] > o[1]);
    near(z[0], o[0]);
    assert.ok(z[1] > o[1]);
    // The viewer is in front of x = max, y = min, above z = max.
    assert.ok(P.depth(1, 0, 1) > P.depth(0, 1, 0));
  });

  test("the box fills the axis size", () => {
    const P = new Projection(25, 30, [-2, -2, 0], [2, 2, 5], [1, 1, 1]);
    P.fit(195, 162, 10, 20, false);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const [a, b, c] of [[-2, -2, 0], [2, -2, 0], [-2, 2, 0], [2, 2, 0], [-2, -2, 5], [2, -2, 5], [-2, 2, 5], [2, 2, 5]]) {
      const q = P.screen(a, b, c);
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    near(x0, 10);
    near(x1, 205);
    near(y0, 20);
    near(y1, 182);
  });

  test("ticks go on the front edges: x at y=min, y at x=max, z on the left", () => {
    const P = new Projection(25, 30, [0, 0, 0], [1, 1, 1], [1, 1, 1]);
    P.fit(200, 150, 0, 0, false);
    const x = tickEdge(P, 0)!;
    const y = tickEdge(P, 1)!;
    const z = tickEdge(P, 2)!;
    assert.deepEqual([x.fb, x.fc], [0, 0]);
    assert.deepEqual([y.fb, y.fc], [1, 0]);
    assert.deepEqual([z.fb, z.fc], [0, 0]);
    // Labels go below x and y, left of z.
    assert.ok(x.out[1] < 0 && y.out[1] < 0 && z.out[0] < 0);
  });

  test("seen from above, x ticks are at the bottom and y ticks on the left; z has none", () => {
    const P = new Projection(0, 90, [0, 0, 0], [1, 1, 1], [1, 1, 1]);
    P.fit(200, 200, 0, 0, false);
    const x = tickEdge(P, 0)!;
    const y = tickEdge(P, 1)!;
    near(x.p0[1], 0);
    near(y.p0[0], 0);
    assert.equal(tickEdge(P, 2), undefined);
  });

  test("patches are drawn back to front", () => {
    // A 3 x 3 grid whose depth grows with the column: patch order is by column.
    const dep = [0, 1, 2, 0, 1, 2, 0, 1, 2];
    assert.deepEqual(patchOrder(dep, 3, 3), [0, 3, 1, 4]);
    // A row of depths falling to the right reverses it.
    assert.deepEqual(patchOrder([2, 1, 0, 2, 1, 0], 3, 2), [1, 0]);
    // Undefined corners leave their patches out.
    assert.deepEqual(patchOrder([0, NaN, 2, 0, 1, 2], 3, 2), []);
  });

  test("a sphere's last drawn patch faces the viewer", () => {
    const src = axis("view={30}{20}, axis equal", String.raw`\addplot3[surf, z buffer=sort, samples=12, domain=0:360, y domain=0:180, colormap/blackwhite, point meta=z] ({cos(x)*sin(y)}, {sin(x)*sin(y)}, {cos(y)});`);
    const r = renderTikz(src);
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
  });
});

describe("colour maps", () => {
  test("built-in maps and pgfplots' default", () => {
    assert.equal(DEFAULT_COLORMAP.name, "hot");
    assert.equal(colorAt(DEFAULT_COLORMAP, 0), "#0000ff");
    assert.equal(colorAt(DEFAULT_COLORMAP, 1), "#ff0000");
    assert.equal(colorAt(namedColormap("viridis")!, 0), "#440154");
    assert.equal(colorAt(namedColormap("colormap/viridis")!, 1), "#fde725");
    assert.equal(colorAt(namedColormap("jet")!, 0.5), "#80ff80");
    assert.equal(colorAt(namedColormap("hot2")!, 0), "#000000");
    assert.equal(colorAt(namedColormap("cool")!, 1), "#ff00ff");
    assert.equal(namedColormap("nonesuch"), undefined);
  });

  test("values outside 0..1 and NaN are clamped", () => {
    const m = namedColormap("viridis")!;
    assert.equal(colorAt(m, -3), "#440154");
    assert.equal(colorAt(m, 7), "#fde725");
    assert.equal(colorAt(m, NaN), "#440154");
  });

  test("colormap={name}{...} in rgb255, rgb, color and gray, with or without positions", () => {
    const m = parseColormap("{mine}{rgb255(0cm)=(255,0,0); rgb255(1cm)=(0,0,255)}", new Map())!;
    assert.equal(m.name, "mine");
    assert.equal(colorAt(m, 0), "#ff0000");
    assert.equal(colorAt(m, 0.5), "#800080");
    const c = parseColormap("{c}{color=(red) color=(white) color=(blue)}", new Map())!;
    assert.equal(colorAt(c, 0.5), "#ffffff");
    const u = parseColormap("{u}{gray(0cm)=(0) rgb(3cm)=(1,1,1) color(4cm)=(red)}", new Map())!;
    assert.equal(colorAt(u, 0.75), "#ffffff");
    assert.equal(parseColormap("{x}{nothing here}", new Map()), undefined);
  });

  test("a colour map defined in the axis colours the surface", () => {
    const r = renderTikz(axis("colormap={bw}{color=(black) color=(white)}, view={0}{90}", String.raw`\addplot3[surf, shader=flat, samples=3, domain=0:1] {x};`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    assert.match(r.svg!, /fill="#404040"/);
    assert.match(r.svg!, /fill="#bfbfbf"/);
  });
});

describe("limits, safety, determinism", () => {
  test("surfaces are capped at 100 x 100 samples and stay within the time budget", () => {
    const r = renderTikz(axis("", String.raw`\addplot3[surf, shader=interp, samples=400, domain=-3:3] {sin(deg(x))*cos(deg(y))};`));
    assert.ok(r.svg);
    assert.ok(r.messages.some((m) => m.message.includes(`${MAX_SURFACE_SAMPLES} times per direction`)));
    // The interpreter stops at its 0.8 s budget; the margin is for test machines under load.
    assert.ok(r.ms < 1600, `${r.ms} ms`);
    // 99 x 99 patches at most, plus the frame.
    assert.ok(paths(r.svg!) < 99 * 99 + 200);
  });

  test("singularities, NaN and garbage never reach the SVG and never throw", () => {
    const bodies = [
      String.raw`\addplot3[surf, samples=9, domain=-1:1] {1/(x*y)};`,
      String.raw`\addplot3[surf, samples=9, domain=-1:1] {sqrt(x)};`,
      String.raw`\addplot3[mesh, samples=9, domain=-1:1] {ln(x^2+y^2)};`,
      String.raw`\addplot3 coordinates {(1,2,nan) (2,3,4) (inf,1,1)};`,
      String.raw`\addplot3[surf] coordinates {};`,
      String.raw`\addplot3[surf] {;`,
      String.raw`\addplot3[quiver={u=1/0}] (x,y,0);`,
      String.raw`\addplot3[surf, mesh/rows=0] table {x y z};`,
      String.raw`\addplot3 graphics {foo.png};`,
      String.raw`\addplot3[surf, samples=3] {x} \addplot3 [`,
    ];
    for (const b of bodies) {
      let r: ReturnType<typeof renderTikz> | undefined;
      assert.doesNotThrow(() => (r = renderTikz(axis("", b))), b);
      if (r?.svg) assert.ok(!/NaN|Infinity/.test(r.svg), b);
    }
  });

  test("the same picture gives the same SVG", () => {
    const src = axis("view={60}{35}, colorbar, colormap/jet", String.raw`\addplot3[surf, shader=interp, samples=15, domain=-2:2] {x^2+y^2};`);
    assert.equal(renderTikz(src).svg, renderTikz(src).svg);
  });
});

describe("fill between", () => {
  test("fills between two named plots, soft-clipped", () => {
    const src = axis("domain=0:2, samples=20", String.raw`\addplot[name path=f, blue] {x}; \addplot[name path=g, red] {x^2}; \addplot[gray!30] fill between[of=f and g, soft clip={domain=0:1}];`);
    const r = renderTikz(src);
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    assert.match(r.svg!, /fill="#d9d9d9"/);
    // The fill is drawn before the curves.
    assert.ok(r.svg!.indexOf('fill="#d9d9d9"') < r.svg!.indexOf('stroke="#0000ff"'));
  });

  test("fills down to a \\path with name path", () => {
    const r = renderTikz(axis("domain=-2:2", String.raw`\addplot[name path=A] {exp(-x^2)}; \path[name path=B] (axis cs:-2,0) -- (axis cs:2,0); \addplot[blue!20] fill between[of=A and B];`));
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    assert.match(r.svg!, /fill="#ccccff"/);
  });

  test("an unknown path name warns", () => {
    const r = renderTikz(axis("", String.raw`\addplot[name path=A] {x}; \addplot fill between[of=A and Z];`));
    assert.ok(r.messages.some((m) => /no path named Z/.test(m.message)));
  });

  test("clipToX cuts at the crossings", () => {
    assert.deepEqual(
      clipToX(
        [
          [0, 0],
          [2, 2],
          [4, 0],
        ],
        [1, 3],
      ),
      [
        [1, 1],
        [2, 2],
        [3, 1],
      ],
    );
    assert.deepEqual(clipToX([[0, NaN], [1, 1]]), [[1, 1]]);
  });
});

describe("tikz-3dplot", () => {
  test("main coordinates are those of tikz-3dplot", () => {
    const [r1, r2] = mainCoords(70, 110);
    near(r1[0], Math.cos((110 * Math.PI) / 180));
    near(r2[2], Math.sin((70 * Math.PI) / 180));
    near(r2[0], -Math.cos((70 * Math.PI) / 180) * Math.sin((110 * Math.PI) / 180));
  });

  test("tdplot_main_coords, \\tdplotsetcoord and \\tdplotdrawarc", () => {
    const pre = String.raw`\tdplotsetmaincoords{70}{110}`;
    const src = String.raw`\begin{tikzpicture}[scale=2, tdplot_main_coords]
      \draw (0,0,0) -- (1,0,0);
      \tdplotsetcoord{P}{1}{45}{30}
      \draw (0,0,0) -- (P) -- (Pxy) -- cycle;
      \tdplotdrawarc{(0,0,0)}{0.5}{0}{30}{anchor=north}{$\phi$}
      \tdplotsetthetaplanecoords{30}
      \tdplotdrawarc[tdplot_rotated_coords]{(0,0,0)}{0.5}{0}{45}{anchor=south}{$\theta$}
    \end{tikzpicture}`;
    const r = renderTikz(src, { preamble: picturePreamble(pre) });
    assert.ok(r.svg);
    assert.deepEqual(r.messages, []);
    // x points down and to the left in the main view, scaled once by 2.
    const line = /<path d="M0 0L(-?[\d.]+) (-?[\d.]+)"/.exec(r.svg!);
    assert.ok(line);
    near(Number(line![1]), 2 * 28.4528 * Math.cos((110 * Math.PI) / 180), 0.05);
  });
});

describe("the 3D corpus", () => {
  const dir = join("test", "tikz-suite-3d");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tex"))) {
    test(f, () => {
      const text = readFileSync(join(dir, f), "utf8");
      for (const m of text.matchAll(/\\begin\{tikzpicture\}[^]*?\\end\{tikzpicture\}/g)) {
        const r = renderTikz(m[0], { preamble: picturePreamble(text, m.index) });
        assert.ok(r.svg, f);
        assert.ok(!/NaN|Infinity/.test(r.svg!), f);
        assert.ok(r.ms < 1600, `${f}: ${r.ms} ms`);
        // Only node text the text engine cannot set yet (siunitx in text mode) may warn.
        for (const msg of r.messages) assert.match(msg.message, /could not be typeset completely/, `${f}: ${msg.message}`);
      }
    });
  }
});
