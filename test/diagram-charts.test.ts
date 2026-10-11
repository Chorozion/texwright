import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decimalsFor, formatNumber, niceScale, niceStep } from "../src/diagram/chartkit.js";
import { addDuration, parseDate, parseDuration, parseGantt, skipExcluded, strftime, tickTimes } from "../src/diagram/gantt.js";
import { renderDiagram } from "../src/diagram/index.js";
import { parsePie, percentText } from "../src/diagram/pie.js";
import { parseQuadrant } from "../src/diagram/quadrant.js";
import { parseTimeline } from "../src/diagram/timeline.js";
import { parseXyChart } from "../src/diagram/xychart.js";
import { makeTheme } from "../src/diagram/theme.js";
import type { DiagramError } from "../src/diagram/types.js";

const D = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);

/** The SVG is one well-formed element tree, with no NaN or Infinity in it. */
function wellFormed(svg: string): void {
  assert.ok(svg.startsWith("<svg"), "starts with <svg");
  assert.ok(svg.endsWith("</svg>"), "ends with </svg>");
  assert.ok(!/NaN|Infinity|undefined/.test(svg), "no NaN, Infinity or undefined");
  const stack: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `closing ${m[2]}`);
    else stack.push(m[2]);
  }
  assert.equal(stack.length, 0, "every element closed");
}

/** Text content of the SVG, entities decoded. */
const texts = (svg: string) => [...svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')).join(" | ");

describe("chart kit", () => {
  it("picks steps of 1, 2, 2.5 and 5", () => {
    assert.equal(niceStep(100, 5), 20);
    assert.equal(niceStep(1, 5), 0.2);
    assert.equal(niceStep(7000, 5), 1000);
    assert.equal(niceStep(12, 5), 2.5);
  });
  it("rounds the ends out to ticks", () => {
    const s = niceScale(3, 97);
    assert.equal(s.lo, 0);
    assert.equal(s.hi, 100);
    assert.deepEqual(s.ticks, [0, 20, 40, 60, 80, 100]);
    const neg = niceScale(-11.6, 15.9);
    assert.ok(neg.ticks.includes(0));
    assert.ok(neg.lo <= -11.6 && neg.hi >= 15.9);
  });
  it("keeps fixed ends and lands ticks on them when it can", () => {
    const s = niceScale(0, 1200, 5, true);
    assert.equal(s.lo, 0);
    assert.equal(s.hi, 1200);
    assert.equal(s.ticks[s.ticks.length - 1], 1200);
    const odd = niceScale(4000, 11000, 5, true);
    assert.equal(odd.ticks[0], 4000);
    assert.equal(odd.ticks[odd.ticks.length - 1], 11000);
  });
  it("has no floating point noise in ticks", () => {
    const s = niceScale(0, 0.7);
    for (const t of s.ticks) assert.ok(String(t).length < 6, String(t));
    assert.equal(decimalsFor(0.25), 2);
    assert.equal(decimalsFor(1000), 0);
  });
  it("formats numbers with separators and a real minus", () => {
    assert.equal(formatNumber(11000), "11,000");
    assert.equal(formatNumber(-4.25, 2), "−4.25");
    assert.equal(formatNumber(2_500_000, 1, true), "2.5M");
    assert.equal(formatNumber(0, 1), "0.0");
  });
});

describe("gantt dates", () => {
  it("reads moment formats", () => {
    assert.equal(parseDate("2024-03-15", "YYYY-MM-DD"), D(2024, 3, 15));
    assert.equal(parseDate("15/03/2024", "DD/MM/YYYY"), D(2024, 3, 15));
    assert.equal(parseDate("Mar 5 2024", "MMM D YYYY"), D(2024, 3, 5));
    assert.equal(parseDate("2024-03-15 14:30", "YYYY-MM-DD HH:mm"), D(2024, 3, 15, 14, 30));
    assert.equal(parseDate("08:00", "HH:mm"), D(1970, 1, 1, 8));
    assert.equal(parseDate("1700000000", "X"), 1_700_000_000_000);
    assert.equal(parseDate("2024-02-30", "YYYY-MM-DD"), undefined);
    assert.equal(parseDate("2024/03/15", "YYYY-MM-DD"), undefined);
  });
  it("reads durations and adds them in the calendar", () => {
    assert.deepEqual(parseDuration("3d"), { value: 3, unit: "d" });
    assert.deepEqual(parseDuration("1.5h"), { value: 1.5, unit: "h" });
    assert.equal(parseDuration("3 days"), undefined);
    assert.equal(addDuration(D(2024, 1, 31), { value: 1, unit: "M" }), D(2024, 2, 29));
    assert.equal(addDuration(D(2024, 1, 1), { value: 2, unit: "w" }), D(2024, 1, 15));
  });
  it("pushes ends past excluded weekends", () => {
    const ex = { weekdays: new Set([0, 6]), days: new Set<number>() };
    // Monday 2026-03-02 + 5d runs over the weekend into the next Monday.
    assert.equal(skipExcluded(D(2026, 3, 2), D(2026, 3, 7), ex), D(2026, 3, 9));
    // Thursday + 2d skips Saturday and Sunday.
    assert.equal(skipExcluded(D(2026, 3, 5), D(2026, 3, 7), ex), D(2026, 3, 9));
  });
  it("formats axis labels with strftime", () => {
    assert.equal(strftime(D(2024, 3, 5), "%Y-%m-%d"), "2024-03-05");
    assert.equal(strftime(D(2024, 3, 5), "%b %-d"), "Mar 5");
    assert.equal(strftime(D(2024, 3, 5), "%d/%m"), "05/03");
    assert.equal(strftime(D(2024, 3, 5, 14, 7), "%H:%M %p"), "14:07 PM");
    assert.equal(strftime(D(2024, 3, 5), "%A %B"), "Tuesday March");
  });
  it("aligns ticks to the calendar", () => {
    const weeks = tickTimes(D(2026, 3, 4), D(2026, 4, 1), { k: 1, unit: "week" }, 1);
    assert.ok(weeks.every((t) => new Date(t).getUTCDay() === 1));
    const months = tickTimes(D(2026, 1, 15), D(2026, 7, 1), { k: 1, unit: "month" });
    assert.deepEqual(months.map((t) => new Date(t).getUTCMonth()), [1, 2, 3, 4, 5, 6]);
  });
});

describe("gantt parsing", () => {
  const plan = `gantt
    title Plan
    dateFormat YYYY-MM-DD
    excludes weekends
    section A
      Design   :done, des, 2026-03-02, 3d
      Build    :crit, build, after des, 5d
      Review   :milestone, rev, after build test, 0d
    section B
      Test     :test, after des, 2026-03-20
      Write up :until rev
      Next     :2d`;
  it("resolves after chains, until, implicit starts and excludes", () => {
    const errors: DiagramError[] = [];
    const g = parseGantt(plan, errors);
    assert.deepEqual(errors, []);
    const by = new Map(g.tasks.map((t) => [t.id, t]));
    assert.equal(by.get("des")!.end, D(2026, 3, 5));
    assert.equal(by.get("build")!.start, D(2026, 3, 5));
    // Thursday + 5 working days ends the next Thursday.
    assert.equal(by.get("build")!.end, D(2026, 3, 12));
    assert.equal(by.get("test")!.end, D(2026, 3, 20));
    // after build test: the later of the two ends.
    assert.equal(by.get("rev")!.start, D(2026, 3, 20));
    assert.ok(by.get("rev")!.milestone);
    assert.ok(by.get("build")!.crit && by.get("des")!.done);
    const writeUp = g.tasks.find((t) => t.name === "Write up")!;
    assert.equal(writeUp.start, D(2026, 3, 20));
    assert.equal(writeUp.end, D(2026, 3, 20));
    const next = g.tasks.find((t) => t.name === "Next")!;
    assert.equal(next.start, writeUp.end);
  });
  it("resolves references that point forward", () => {
    const errors: DiagramError[] = [];
    const g = parseGantt("gantt\n  B :b, after a, 1d\n  A :a, 2024-01-01, 2d", errors);
    assert.deepEqual(errors, []);
    assert.equal(g.tasks[0].start, D(2024, 1, 3));
  });
  it("reports a bad date with its position and the expected form", () => {
    const errors: DiagramError[] = [];
    parseGantt("gantt\n  dateFormat DD/MM/YYYY\n  A :a, 2024-03-15, 2d", errors);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 2);
    assert.equal(errors[0].col, 8);
    assert.match(errors[0].hint!, /DD\/MM\/YYYY/);
    assert.deepEqual(errors[0].fix, { old: "2024-03-15", new: "15/03/2024" });
  });
  it("fixes spelled-out durations and unknown ids", () => {
    const errors: DiagramError[] = [];
    parseGantt("gantt\n  A :alpha, 2024-01-01, 3 days\n  B :after alpah, 1d", errors);
    assert.equal(errors.length, 2);
    assert.deepEqual(errors[0].fix, { old: "3 days", new: "3d" });
    assert.equal(errors[0].line, 1);
    assert.equal(errors[1].line, 2);
    assert.deepEqual(errors[1].fix, { old: "alpah", new: "alpha" });
  });
  it("reports unknown statements and a missing first start", () => {
    const errors: DiagramError[] = [];
    parseGantt("gantt\n  dateFormatt YYYY-MM-DD\n  A :3d", errors);
    assert.ok(errors.some((e) => e.line === 1 && e.fix?.new === "dateFormat"));
    assert.ok(errors.some((e) => e.line === 2 && /no start date/.test(e.message)));
  });
  it("keeps keywords out of task names", () => {
    const errors: DiagramError[] = [];
    const g = parseGantt("gantt\n  dateFormat HH:mm\n  axisFormat %H:%M\n  A :a, 08:00, 30m", errors);
    assert.deepEqual(errors, []);
    assert.equal(g.tasks.length, 1);
    assert.equal(g.tasks[0].end! - g.tasks[0].start!, 30 * 60_000);
  });
});

describe("gantt drawing", () => {
  it("draws a plan with sections, bars, a milestone and dated ticks", () => {
    const r = renderDiagram(`gantt
      title Website relaunch
      dateFormat YYYY-MM-DD
      excludes weekends
      section Discovery
        Interviews :done, int, 2026-03-02, 5d
        Signed     :milestone, req, after int, 0d
      section Build
        Front end  :crit, fe, after int, 12d`);
    assert.deepEqual(r.errors, []);
    assert.equal(r.kind, "gantt");
    wellFormed(r.svg);
    const t = texts(r.svg);
    for (const s of ["Website relaunch", "Discovery", "Build", "Interviews", "Front end", "Signed", "Mar 9"]) assert.ok(t.includes(s), s);
    assert.ok(r.width >= 520 && r.width <= 1000, String(r.width));
    assert.ok(r.svg.includes("<path d=\"M"), "milestone diamond");
  });
  it("is deterministic", () => {
    const src = "gantt\n  A :a, 2024-01-01, 3d\n  B :after a, 2d";
    assert.equal(renderDiagram(src).svg, renderDiagram(src).svg);
  });
});

describe("pie", () => {
  it("parses title, showData and slices", () => {
    const ctx = { theme: makeTheme("default"), errors: [] as DiagramError[] };
    const p = parsePie('pie showData title Pets\n  "Dogs" : 386\n  "Cats" : 85.5', ctx);
    assert.equal(p.title, "Pets");
    assert.ok(p.showData);
    assert.deepEqual(p.slices.map((s) => [s.label, s.value]), [["Dogs", 386], ["Cats", 85.5]]);
    assert.equal(percentText(1, 3), "33.3%");
  });
  it("reports bad values with positions and fixes", () => {
    const ctx = { theme: makeTheme("default"), errors: [] as DiagramError[] };
    parsePie('pie\n  "A" : 1,200\n  "B" : -3\n  C : 4', ctx);
    const [a, b, c] = ctx.errors;
    assert.equal(a.line, 1);
    assert.equal(a.col, 8);
    assert.deepEqual(a.fix, { old: "1,200", new: "1200" });
    assert.equal(b.line, 2);
    assert.match(b.message, /negative/);
    assert.deepEqual(c.fix, { old: "C", new: '"C"' });
  });
  it("draws labels with percentages, and a legend when there are many slices", () => {
    const r = renderDiagram('pie title Share\n  "Apple" : 27.4\n  "Samsung" : 22.1\n  "Others" : 50.5');
    assert.deepEqual(r.errors, []);
    wellFormed(r.svg);
    const t = texts(r.svg);
    for (const s of ["Share", "Apple", "27.4%", "Samsung", "22.1%", "50.5%"]) assert.ok(t.includes(s), s);
    const many = renderDiagram("pie showData\n" + Array.from({ length: 12 }, (_, i) => `  "S${i}" : ${i + 1}`).join("\n"));
    wellFormed(many.svg);
    assert.ok(texts(many.svg).includes("S11"));
    assert.ok(texts(many.svg).includes("15.4%"), "share of the largest slice");
  });
  it("takes slice colours from themeVariables", () => {
    const r = renderDiagram('%%{init: {"themeVariables": {"pie1": "#123456"}}}%%\npie\n  "A" : 1\n  "B" : 2');
    assert.ok(r.svg.includes("#123456"));
  });
});

describe("xychart", () => {
  it("parses axes, ranges and named series", () => {
    const errors: DiagramError[] = [];
    const c = parseXyChart('xychart-beta horizontal\n  title "Sales"\n  x-axis "Month" [jan, "feb", mar]\n  y-axis "Revenue" 0 --> 100\n  bar "2025" [10, 20, 30]\n  line [5, 15, 25]', errors);
    assert.deepEqual(errors, []);
    assert.ok(c.horizontal);
    assert.equal(c.title, "Sales");
    assert.equal(c.xTitle, "Month");
    assert.deepEqual(c.categories, ["jan", "feb", "mar"]);
    assert.deepEqual(c.yRange, [0, 100]);
    assert.equal(c.series[0].name, "2025");
    assert.deepEqual(c.series[1].values, [5, 15, 25]);
    const num = parseXyChart("xychart-beta\n  x-axis Week 1 --> 12\n  line [1, 2]", errors);
    assert.equal(num.xTitle, "Week");
    assert.deepEqual(num.xRange, [1, 12]);
  });
  it("reports bad values and mismatched lengths", () => {
    const errors: DiagramError[] = [];
    parseXyChart("xychart-beta\n  x-axis [a, b, c]\n  bar [1, $2, 3]\n  line [1, 2]\n  y-axis 0 -> 10", errors);
    const bad = errors.find((e) => /not a number/.test(e.message))!;
    assert.equal(bad.line, 2);
    assert.equal(bad.col, 10);
    assert.deepEqual(bad.fix, { old: "$2", new: "2" });
    assert.ok(errors.some((e) => e.line === 3 && /2 values/.test(e.message)));
    assert.ok(errors.some((e) => e.line === 4 && /range/.test(e.message)));
  });
  it("draws bars, a line, gridlines and nice tick labels", () => {
    const r = renderDiagram('xychart-beta\n  title "Revenue"\n  x-axis [Q1, Q2, Q3, Q4]\n  y-axis "EUR" 0 --> 1200\n  bar "Actual" [520, 610, 740, 1150]\n  line "Target" [550, 600, 650, 700]');
    assert.deepEqual(r.errors, []);
    wellFormed(r.svg);
    const t = texts(r.svg);
    for (const s of ["Revenue", "Q1", "Q4", "EUR", "Actual", "Target", "1,200", "0"]) assert.ok(t.includes(s), s);
    const h = renderDiagram("xychart-beta horizontal\n  x-axis [a, b]\n  bar [-3, 7]");
    wellFormed(h.svg);
  });
});

describe("timeline", () => {
  it("parses sections, periods, events and continuation lines", () => {
    const errors: DiagramError[] = [];
    const tl = parseTimeline("timeline\n  title History\n  section Early\n    2002 : LinkedIn\n    2004 : Facebook : Google\n         : Flickr\n  section Late\n    10:30 : Standup : Retro", errors);
    assert.deepEqual(errors, []);
    assert.equal(tl.title, "History");
    assert.deepEqual(tl.sections, ["Early", "Late"]);
    assert.deepEqual(tl.periods.map((p) => [p.label, p.events, p.section]), [
      ["2002", ["LinkedIn"], 0],
      ["2004", ["Facebook", "Google", "Flickr"], 0],
      ["10:30", ["Standup", "Retro"], 1],
    ]);
  });
  it("reports a stray event line and a misspelt keyword", () => {
    const errors: DiagramError[] = [];
    parseTimeline("timeline\n  : orphan\n  sectoin\n  2020 : ok", errors);
    assert.equal(errors[0].line, 1);
    assert.equal(errors[1].line, 2);
    assert.deepEqual(errors[1].fix, { old: "sectoin", new: "section" });
  });
  it("draws periods and event cards, wrapping long timelines into rows", () => {
    const r = renderDiagram("timeline\n  title T\n  section S\n  2001 : A : B\n  2002 : C");
    assert.deepEqual(r.errors, []);
    wellFormed(r.svg);
    for (const s of ["T", "S", "2001", "2002", "A", "B", "C"]) assert.ok(texts(r.svg).includes(s), s);
    const long = renderDiagram("timeline\n" + Array.from({ length: 14 }, (_, i) => `  ${2000 + i} : Event number ${i}`).join("\n"));
    wellFormed(long.svg);
    assert.ok(long.width < 1000, String(long.width));
  });
});

describe("quadrant", () => {
  it("parses axes, quadrants, points, classes and styles", () => {
    const errors: DiagramError[] = [];
    const q = parseQuadrant("quadrantChart\n  title Q\n  x-axis Low --> High\n  y-axis Bottom\n  quadrant-1 Expand\n  quadrant-3 Drop\n  A: [0.3, 0.6]\n  B:::hot: [0.9, 0.1] radius: 9\n  classDef hot color: #ff0000", errors);
    assert.deepEqual(errors, []);
    assert.equal(q.xLow, "Low");
    assert.equal(q.xHigh, "High");
    assert.equal(q.yLow, "Bottom");
    assert.equal(q.yHigh, undefined);
    assert.equal(q.quadrants[0], "Expand");
    assert.equal(q.quadrants[2], "Drop");
    assert.deepEqual(q.points.map((p) => [p.name, p.x, p.y]), [["A", 0.3, 0.6], ["B", 0.9, 0.1]]);
    assert.equal(q.points[1].style.color, "#ff0000");
    assert.equal(q.points[1].style.radius, "9");
  });
  it("reports points outside the chart and missing brackets", () => {
    const errors: DiagramError[] = [];
    parseQuadrant("quadrantChart\n  A: [30, 60]\n  B: 0.2, 0.4\n  quadrant-5 X", errors);
    assert.equal(errors[0].line, 1);
    assert.deepEqual(errors[0].fix, { old: "30, 60", new: "0.3, 0.6" });
    assert.deepEqual(errors[1].fix, { old: "0.2, 0.4", new: "[0.2, 0.4]" });
    assert.equal(errors[2].line, 3);
  });
  it("draws a square plot with labelled points", () => {
    const r = renderDiagram("quadrantChart\n  title Priorities\n  x-axis Low effort --> High effort\n  y-axis Low impact --> High impact\n  quadrant-1 Major\n  quadrant-2 Quick wins\n  SSO: [0.7, 0.8]\n  CSV: [0.2, 0.7]");
    assert.deepEqual(r.errors, []);
    wellFormed(r.svg);
    for (const s of ["Priorities", "Major", "Quick wins", "SSO", "CSV", "Low effort", "High impact"]) assert.ok(texts(r.svg).includes(s), s);
  });
});

describe("chart speed", () => {
  it("draws each chart in a few milliseconds", () => {
    const srcs = [
      "gantt\n  dateFormat YYYY-MM-DD\n  excludes weekends\n" + Array.from({ length: 40 }, (_, i) => `  T${i} :t${i}, ${i ? `after t${i - 1}` : "2024-01-01"}, 3d`).join("\n"),
      "pie\n" + Array.from({ length: 8 }, (_, i) => `  "S${i}" : ${i + 1}`).join("\n"),
      "xychart-beta\n  x-axis [" + Array.from({ length: 24 }, (_, i) => `m${i}`).join(", ") + "]\n  bar [" + Array.from({ length: 24 }, (_, i) => i * 3).join(", ") + "]\n  line [" + Array.from({ length: 24 }, (_, i) => i * 2).join(", ") + "]",
      "timeline\n" + Array.from({ length: 12 }, (_, i) => `  ${2000 + i} : Event ${i} : Another`).join("\n"),
      "quadrantChart\n" + Array.from({ length: 30 }, (_, i) => `  P${i}: [${((i * 37) % 100) / 100}, ${((i * 53) % 100) / 100}]`).join("\n"),
    ];
    for (const s of srcs) renderDiagram(s);
    for (const s of srcs) {
      const t0 = performance.now();
      const r = renderDiagram(s);
      const ms = performance.now() - t0;
      assert.deepEqual(r.errors, []);
      assert.ok(ms < 60, `${r.kind} took ${ms.toFixed(1)} ms`);
    }
  });
});
