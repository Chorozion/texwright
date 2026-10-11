/**
 * Mermaid gantt charts. Dates are read with the chart's dateFormat (moment
 * tokens) and kept as UTC milliseconds, so output never depends on the
 * machine's time zone or the current date: "today" is not drawn.
 *
 * Tasks are `Name :tags, id, start, end` with any of the leading tags done,
 * active, crit, milestone and vert; start is a date or `after a b`; end is a
 * date, a duration (3d, 2w, 12h, 30m, 1M, 1y) or `until a`. A duration skips
 * excluded days (`excludes weekends, 2024-12-25`), as Mermaid does; an
 * explicit end date is taken as written. References may point forward.
 *
 * The drawing is restrained: one calm colour for work, a warm accent for the
 * critical path, done work muted, active work outlined, milestones as
 * diamonds. Sections are alternating bands named in a left column; the time
 * axis picks hours, days, weeks, months or years so its labels never crowd.
 */

import { closest, escLabel, isDark, MARGIN, measure, mix, paper, plainText, type Stmt, statementsOf, textAt, textOn, tint, titleBlock, unknownStatement, warmAccent, baselineFor } from "./chartkit.js";
import { n, svgDocument } from "./svg.js";
import { layoutLabel } from "./text.js";
import type { DiagramContext, DiagramError, Rendered } from "./types.js";
import { labelSvg } from "./svg.js";

export const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

// ---------------------------------------------------------------- dates

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const TOKEN = /\[[^\]]*\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|HH|H|hh|h|mm|m|ss|s|SSS|SS|S|A|a|X|x|ZZ|Z|dddd|ddd/g;

/** Reads a date written in a moment-style format; undefined when it does not match. Times are UTC. */
export function parseDate(text: string, format: string): number | undefined {
  const s = text.trim();
  let re = "^";
  const fields: string[] = [];
  let at = 0;
  for (const m of format.matchAll(TOKEN)) {
    re += escapeRe(format.slice(at, m.index));
    at = m.index! + m[0].length;
    const tok = m[0];
    if (tok.startsWith("[")) {
      re += escapeRe(tok.slice(1, -1));
      continue;
    }
    fields.push(tok);
    re +=
      tok === "YYYY" ? "([+-]?\\d{4,6})" :
      tok === "YY" ? "(\\d{2})" :
      tok === "MMMM" || tok === "MMM" ? "([A-Za-z]+\\.?)" :
      tok === "dddd" || tok === "ddd" ? "([A-Za-z]+\\.?)" :
      tok === "Do" ? "(\\d{1,2})(?:st|nd|rd|th)" :
      tok === "SSS" ? "(\\d{1,3})" : tok === "SS" ? "(\\d{1,2})" : tok === "S" ? "(\\d)" :
      tok === "A" || tok === "a" ? "([AaPp][Mm])" :
      tok === "X" ? "(-?\\d+(?:\\.\\d+)?)" : tok === "x" ? "(-?\\d+)" :
      tok === "ZZ" || tok === "Z" ? "(Z|[+-]\\d{2}:?\\d{2})" :
      tok.length === 2 ? "(\\d{2})" : "(\\d{1,2})";
  }
  re += escapeRe(format.slice(at)) + "$";
  const m = new RegExp(re).exec(s);
  if (!m) return undefined;
  let y = 1970, mo = 0, d = 1, h = 0, mi = 0, sec = 0, ms = 0, pm: boolean | undefined, tz = 0;
  for (let i = 0; i < fields.length; i++) {
    const v = m[i + 1];
    switch (fields[i]) {
      case "YYYY": y = Number(v); break;
      case "YY": y = 2000 + Number(v) - (Number(v) > 68 ? 100 : 0); break;
      case "MM": case "M": mo = Number(v) - 1; break;
      case "MMMM": case "MMM": {
        const k = MONTHS.findIndex((x) => x.slice(0, 3).toLowerCase() === v.slice(0, 3).toLowerCase());
        if (k < 0) return undefined;
        mo = k;
        break;
      }
      case "DD": case "D": case "Do": d = Number(v); break;
      case "HH": case "H": case "hh": case "h": h = Number(v); break;
      case "mm": case "m": mi = Number(v); break;
      case "ss": case "s": sec = Number(v); break;
      case "SSS": ms = Number(v.padEnd(3, "0")); break;
      case "SS": ms = Number(v) * 10; break;
      case "S": ms = Number(v) * 100; break;
      case "A": case "a": pm = /p/i.test(v); break;
      case "X": return Math.round(Number(v) * 1000);
      case "x": return Number(v);
      case "ZZ": case "Z": {
        if (v !== "Z") {
          const z = /([+-])(\d{2}):?(\d{2})/.exec(v)!;
          tz = (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
        }
        break;
      }
    }
  }
  if (pm !== undefined) h = (h % 12) + (pm ? 12 : 0);
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 24 || mi > 59 || sec > 60) return undefined;
  const t = Date.UTC(y, mo, d, h, mi, sec, ms) - tz * MINUTE;
  // Reject day 31 of a 30-day month and the like.
  if (new Date(t + tz * MINUTE).getUTCDate() !== d) return undefined;
  return t;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A date written in a moment-style format: used for hints that show the expected form. */
export function formatMoment(t: number, format: string): string {
  const dt = new Date(t);
  const p2 = (v: number) => String(v).padStart(2, "0");
  return format.replace(TOKEN, (tok) => {
    if (tok.startsWith("[")) return tok.slice(1, -1);
    const h = dt.getUTCHours();
    switch (tok) {
      case "YYYY": return String(dt.getUTCFullYear());
      case "YY": return p2(dt.getUTCFullYear() % 100);
      case "MMMM": return MONTHS[dt.getUTCMonth()];
      case "MMM": return MONTHS[dt.getUTCMonth()].slice(0, 3);
      case "MM": return p2(dt.getUTCMonth() + 1);
      case "M": return String(dt.getUTCMonth() + 1);
      case "DD": return p2(dt.getUTCDate());
      case "D": return String(dt.getUTCDate());
      case "Do": return `${dt.getUTCDate()}th`;
      case "HH": return p2(h);
      case "H": return String(h);
      case "hh": return p2(h % 12 || 12);
      case "h": return String(h % 12 || 12);
      case "mm": return p2(dt.getUTCMinutes());
      case "m": return String(dt.getUTCMinutes());
      case "ss": return p2(dt.getUTCSeconds());
      case "s": return String(dt.getUTCSeconds());
      case "SSS": return String(dt.getUTCMilliseconds()).padStart(3, "0");
      case "A": return h < 12 ? "AM" : "PM";
      case "a": return h < 12 ? "am" : "pm";
      case "X": return String(Math.floor(t / 1000));
      case "x": return String(t);
      case "dddd": return WEEKDAYS[dt.getUTCDay()];
      case "ddd": return WEEKDAYS[dt.getUTCDay()].slice(0, 3);
      default: return tok;
    }
  });
}

/** strftime for axis labels: %Y %y %m %d %e %b %B %a %A %H %I %M %S %p %j %L %%, with %-d style unpadded forms. */
export function strftime(t: number, format: string): string {
  const dt = new Date(t);
  const p2 = (v: number) => String(v).padStart(2, "0");
  return format.replace(/%([-_0]?)([a-zA-Z%])/g, (m, flag: string, c: string) => {
    const unpad = flag === "-";
    const pad = (v: number) => (unpad ? String(v) : p2(v));
    const h = dt.getUTCHours();
    switch (c) {
      case "Y": return String(dt.getUTCFullYear());
      case "y": return p2(dt.getUTCFullYear() % 100);
      case "m": return pad(dt.getUTCMonth() + 1);
      case "d": return pad(dt.getUTCDate());
      case "e": return String(dt.getUTCDate());
      case "b": case "h": return MONTHS[dt.getUTCMonth()].slice(0, 3);
      case "B": return MONTHS[dt.getUTCMonth()];
      case "a": return WEEKDAYS[dt.getUTCDay()].slice(0, 3);
      case "A": return WEEKDAYS[dt.getUTCDay()];
      case "H": return pad(h);
      case "I": return pad(h % 12 || 12);
      case "M": return pad(dt.getUTCMinutes());
      case "S": return pad(dt.getUTCSeconds());
      case "L": return String(dt.getUTCMilliseconds()).padStart(3, "0");
      case "p": return h < 12 ? "AM" : "PM";
      case "j": return String(Math.floor((t - Date.UTC(dt.getUTCFullYear(), 0, 1)) / DAY) + 1).padStart(unpad ? 0 : 3, "0");
      case "u": return String(dt.getUTCDay() || 7);
      case "w": return String(dt.getUTCDay());
      case "V": case "W": case "U": return pad(isoWeek(t));
      case "q": return String(Math.floor(dt.getUTCMonth() / 3) + 1);
      case "%": return "%";
      default: return m;
    }
  });
}

function isoWeek(t: number): number {
  const d = new Date(t);
  const day = d.getUTCDay() || 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
  const y = new Date(thursday).getUTCFullYear();
  return Math.floor((thursday - Date.UTC(y, 0, 1)) / DAY / 7) + 1;
}

/** Adds months in the calendar (Jan 31 + 1M is the last day of February). */
export function addMonths(t: number, k: number): number {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + k;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export interface Duration {
  value: number;
  unit: "ms" | "s" | "m" | "h" | "d" | "w" | "M" | "y";
}

/** 3d, 2w, 12h, 30m, 1.5d, 1M (months), 1y, 500ms. */
export function parseDuration(s: string): Duration | undefined {
  const m = /^(\d+(?:\.\d+)?|\.\d+)(ms|[smhdwMy])$/.exec(s.trim());
  return m ? { value: Number(m[1]), unit: m[2] as Duration["unit"] } : undefined;
}

export function addDuration(t: number, d: Duration): number {
  switch (d.unit) {
    case "ms": return t + d.value;
    case "s": return t + d.value * 1000;
    case "m": return t + d.value * MINUTE;
    case "h": return t + d.value * HOUR;
    case "d": return t + d.value * DAY;
    case "w": return t + d.value * 7 * DAY;
    case "M": return addMonths(t, Math.floor(d.value)) + (d.value % 1) * 30 * DAY;
    case "y": return addMonths(t, Math.floor(d.value) * 12) + (d.value % 1) * 365 * DAY;
  }
}

/** Days off: weekends, weekday names, single dates (UTC day numbers). */
export interface Excludes {
  weekdays: Set<number>;
  days: Set<number>;
}

export function isExcluded(t: number, ex: Excludes): boolean {
  if (!ex.weekdays.size && !ex.days.size) return false;
  const day = Math.floor(t / DAY);
  return ex.weekdays.has(new Date(day * DAY).getUTCDay()) || ex.days.has(day);
}

/**
 * Pushes an end out past excluded days, as Mermaid does: every excluded day
 * from the start's day up to and including the end's day adds a day.
 */
export function skipExcluded(start: number, end: number, ex: Excludes): number {
  if (!ex.weekdays.size && !ex.days.size) return end;
  let d = Math.floor(start / DAY) * DAY;
  let guard = 0;
  while (d <= end && guard++ < 20000) {
    if (isExcluded(d, ex)) end += DAY;
    d += DAY;
  }
  return end;
}

// ---------------------------------------------------------------- model

export interface GanttTask {
  id: string;
  name: string;
  section: number;
  line: number;
  col: number;
  done: boolean;
  active: boolean;
  crit: boolean;
  milestone: boolean;
  vert: boolean;
  start?: number;
  end?: number;
  /** As written, resolved in passes so references may point forward. */
  startSpec: { kind: "date"; t: number } | { kind: "after"; ids: string[]; col: number } | { kind: "prev" };
  endSpec: { kind: "date"; t: number } | { kind: "duration"; d: Duration } | { kind: "until"; ids: string[]; col: number };
}

export interface Gantt {
  title?: string;
  dateFormat: string;
  axisFormat?: string;
  tickInterval?: { k: number; unit: TickUnit };
  excludes: Excludes;
  weekStart: number;
  inclusiveEndDates: boolean;
  topAxis: boolean;
  sections: string[];
  tasks: GanttTask[];
}

type TickUnit = "minute" | "hour" | "day" | "week" | "month" | "year";

const KEYWORDS = ["title", "dateFormat", "axisFormat", "tickInterval", "excludes", "includes", "todayMarker", "section", "weekday", "inclusiveEndDates", "topAxis", "displayMode", "accTitle", "accDescr", "click"];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseGantt(src: string, errors: DiagramError[]): Gantt {
  const g: Gantt = { dateFormat: "YYYY-MM-DD", excludes: { weekdays: new Set(), days: new Set() }, weekStart: 1, inclusiveEndDates: false, topAxis: false, sections: [], tasks: [] };
  const stmts = statementsOf(src);
  const err = (line: number, col: number, message: string, hint?: string, fix?: DiagramError["fix"]) => errors.push({ line, col, message, ...(hint ? { hint } : {}), ...(fix ? { fix } : {}) });
  let section = -1;
  let auto = 0;
  // Exclusion dates are read after dateFormat is known, wherever it is written.
  const excludeLines: Stmt[] = [];
  const taskLines: { s: Stmt; section: number }[] = [];
  stmts.forEach((s, i) => {
    if (i === 0) {
      const rest = s.text.replace(/^gantt\b/, "").trim();
      if (rest) err(s.line, s.col + s.text.indexOf(rest), `Unexpected "${rest}" after gantt`, "Put statements on their own lines");
      return;
    }
    const kw = /^([A-Za-z]+)\b\s*(.*)$/.exec(s.text);
    const word = kw?.[1] ?? "";
    const rest = (kw?.[2] ?? "").trim();
    const isKeyword = KEYWORDS.includes(word) && !word.startsWith("acc") && (s.text.length === word.length || /\s/.test(s.text[word.length]));
    const isTask = !isKeyword && /:/.test(s.text) && !/^(accTitle|accDescr)\b/.test(s.text);
    if (!isTask && kw) {
      switch (word) {
        case "title": g.title = rest; return;
        case "dateFormat": g.dateFormat = rest || "YYYY-MM-DD"; return;
        case "axisFormat": g.axisFormat = rest; return;
        case "tickInterval": {
          const m = /^(\d+)\s*(minute|hour|day|week|month|year)s?$/.exec(rest);
          if (m && Number(m[1]) > 0) g.tickInterval = { k: Number(m[1]), unit: m[2] as TickUnit };
          else err(s.line, s.col + s.text.indexOf(rest), `Cannot read tickInterval "${rest}"`, "Write a number and a unit: 1day, 2week, 1month (minute, hour, day, week, month, year)");
          return;
        }
        case "excludes": excludeLines.push(s); return;
        case "includes": case "todayMarker": case "displayMode": case "accTitle": case "accDescr": case "click": return;
        case "weekday": {
          const k = DAY_NAMES.indexOf(rest.toLowerCase());
          if (k >= 0) g.weekStart = k;
          else err(s.line, s.col + s.text.indexOf(rest), `Unknown weekday "${rest}"`, "Write a day name: monday ... sunday");
          return;
        }
        case "inclusiveEndDates": g.inclusiveEndDates = true; return;
        case "topAxis": g.topAxis = true; return;
        case "section":
          g.sections.push(rest);
          section = g.sections.length - 1;
          return;
      }
    }
    if (/^(accTitle|accDescr)\s*:/.test(s.text)) return;
    if (!isTask) {
      errors.push(unknownStatement(s, KEYWORDS, "gantt chart", "A task is  Name : start, duration  (for example  Design : 2024-03-01, 5d)"));
      return;
    }
    taskLines.push({ s, section });
  });

  for (const s of excludeLines) {
    const rest = s.text.replace(/^excludes\b/, "");
    const base = s.col + s.text.length - rest.length;
    let off = 0;
    for (const part of rest.split(/[,\s]+/)) {
      const at = rest.indexOf(part, off);
      off = at + part.length;
      if (!part) continue;
      const p = part.toLowerCase();
      if (p === "weekends" || p === "weekend") {
        g.excludes.weekdays.add(0);
        g.excludes.weekdays.add(6);
      } else if (DAY_NAMES.includes(p)) g.excludes.weekdays.add(DAY_NAMES.indexOf(p));
      else {
        const t = parseDate(part, g.dateFormat) ?? parseDate(part, "YYYY-MM-DD");
        if (t === undefined) err(s.line, base + at, `Cannot read "${part}" in excludes`, `Exclude weekends, day names (friday) or dates written as ${g.dateFormat}`);
        else g.excludes.days.add(Math.floor(t / DAY));
      }
    }
  }

  const exampleDate = formatMoment(Date.UTC(2024, 2, 15, 9, 30), g.dateFormat);
  for (const { s, section: sec } of taskLines) {
    const colon = s.text.indexOf(":");
    const name = s.text.slice(0, colon).trim();
    const data = s.text.slice(colon + 1);
    const dataCol = s.col + colon + 1;
    const parts: { text: string; col: number }[] = [];
    let off = 0;
    for (const raw of data.split(",")) {
      parts.push({ text: raw.trim(), col: dataCol + off + (raw.length - raw.trimStart().length) });
      off += raw.length + 1;
    }
    const task: GanttTask = { id: "", name, section: sec, line: s.line, col: s.col, done: false, active: false, crit: false, milestone: false, vert: false, startSpec: { kind: "prev" }, endSpec: { kind: "duration", d: { value: 1, unit: "d" } } };
    if (!name) err(s.line, s.col, "A task needs a name before the colon", "Write  Name : start, duration");
    while (parts.length && /^(done|active|crit|milestone|vert)$/.test(parts[0].text)) {
      const tag = parts.shift()!.text as "done" | "active" | "crit" | "milestone" | "vert";
      task[tag] = true;
    }
    const items = parts.filter((p) => p.text !== "");
    if (items.length > 3 || !items.length) {
      const near = items[0] ? closest(items[0].text, ["done", "active", "crit", "milestone"]) : undefined;
      err(s.line, items[0]?.col ?? dataCol, items.length ? `Task "${name}" has ${items.length} values after its tags; at most id, start and end` : `Task "${name}" has no start or duration`, "Write  Name : [tags,] [id,] start, end  where end is a date or a duration such as 3d", near && items[0] && near !== items[0].text ? { old: items[0].text, new: near } : undefined);
      if (!items.length) {
        g.tasks.push({ ...task, id: `task${++auto}` });
        continue;
      }
    }
    const [idP, startP, endP] = items.length >= 3 ? [items[items.length - 3], items[items.length - 2], items[items.length - 1]] : items.length === 2 ? [undefined, items[0], items[1]] : [undefined, undefined, items[0]];
    task.id = idP?.text ?? `task${++auto}`;
    if (idP) {
      const near = closest(idP.text, ["done", "active", "crit", "milestone"]);
      if (near && near !== idP.text && /^[a-z]+$/i.test(idP.text) && items.length > 3) err(s.line, idP.col, `"${idP.text}" looks like a misspelt tag`, "Tags are done, active, crit, milestone", { old: idP.text, new: near });
    }
    if (startP) {
      const after = /^after\s+(.+)$/.exec(startP.text);
      if (after) task.startSpec = { kind: "after", ids: after[1].trim().split(/\s+/), col: startP.col + startP.text.indexOf(after[1]) };
      else {
        const t = parseDate(startP.text, g.dateFormat);
        if (t === undefined) {
          const iso = parseDate(startP.text, "YYYY-MM-DD");
          err(s.line, startP.col, `Cannot read the start "${startP.text}" of "${name}"`, iso !== undefined ? `dateFormat is ${g.dateFormat}, so write dates as ${exampleDate}` : `Start is a date written as ${g.dateFormat} (for example ${exampleDate}) or  after taskId`, iso !== undefined ? { old: startP.text, new: formatMoment(iso, g.dateFormat) } : undefined);
          if (iso !== undefined) task.startSpec = { kind: "date", t: iso };
        } else task.startSpec = { kind: "date", t };
      }
    }
    if (endP) {
      const until = /^until\s+(.+)$/.exec(endP.text);
      const dur = parseDuration(endP.text);
      if (until) task.endSpec = { kind: "until", ids: until[1].trim().split(/\s+/), col: endP.col + endP.text.indexOf(until[1]) };
      else if (dur) task.endSpec = { kind: "duration", d: dur };
      else {
        const t = parseDate(endP.text, g.dateFormat);
        if (t !== undefined) task.endSpec = { kind: "date", t: g.inclusiveEndDates ? t + DAY : t };
        else {
          const fixed = fixDuration(endP.text);
          const iso = parseDate(endP.text, "YYYY-MM-DD");
          err(
            s.line,
            endP.col,
            `Cannot read the end "${endP.text}" of "${name}"`,
            fixed ? `Durations are a number and a unit: ${fixed}` : iso !== undefined ? `dateFormat is ${g.dateFormat}, so write dates as ${exampleDate}` : `End is a duration (3d, 2w, 12h, 30m, 1M) or a date written as ${g.dateFormat}`,
            fixed ? { old: endP.text, new: fixed } : iso !== undefined ? { old: endP.text, new: formatMoment(iso, g.dateFormat) } : undefined,
          );
          if (fixed) task.endSpec = { kind: "duration", d: parseDuration(fixed)! };
          else if (iso !== undefined) task.endSpec = { kind: "date", t: iso };
        }
      }
    }
    g.tasks.push(task);
  }
  resolve(g, errors);
  return g;
}

/** "3 days", "3days", "2 weeks", "4 hrs" -> 3d, 2w, 4h. */
function fixDuration(s: string): string | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(days?|d|weeks?|wks?|w|hours?|hrs?|h|minutes?|mins?|m|months?|mon|years?|yrs?|y)$/i.exec(s.trim());
  if (!m) return undefined;
  const u = m[2].toLowerCase();
  const unit = u.startsWith("d") ? "d" : u.startsWith("w") ? "w" : u.startsWith("h") ? "h" : u.startsWith("mo") ? "M" : u.startsWith("m") ? "m" : "y";
  return `${m[1]}${unit}`;
}

/** Works out start and end of every task; references may point forward, so this runs in passes. */
function resolve(g: Gantt, errors: DiagramError[]): void {
  const byId = new Map<string, GanttTask>();
  for (const t of g.tasks) if (!byId.has(t.id)) byId.set(t.id, t);
  const reported = new Set<string>();
  const missing = (t: GanttTask, id: string, col: number) => {
    const key = `${t.line}:${id}`;
    if (reported.has(key)) return;
    reported.add(key);
    const near = closest(id, byId.keys());
    errors.push({ line: t.line, col, message: `No task has the id "${id}"`, hint: near ? `Did you mean "${near}"?` : "Give the task an id: Name : id, start, duration", ...(near ? { fix: { old: id, new: near } } : {}) });
  };
  for (let pass = 0; pass < g.tasks.length + 2; pass++) {
    let progress = false;
    let prevEnd: number | undefined;
    for (const t of g.tasks) {
      if (t.start === undefined) {
        const sp = t.startSpec;
        if (sp.kind === "date") t.start = sp.t;
        else if (sp.kind === "prev") t.start = prevEnd;
        else {
          let best: number | undefined = undefined;
          let ok = true;
          for (const id of sp.ids) {
            const o = byId.get(id);
            if (!o) {
              if (pass > 0) missing(t, id, sp.col + sp.ids.slice(0, sp.ids.indexOf(id)).join(" ").length + (sp.ids.indexOf(id) ? 1 : 0));
              continue;
            }
            if (o.end === undefined) ok = false;
            else best = best === undefined ? o.end : Math.max(best, o.end);
          }
          if (ok && best !== undefined) t.start = best;
          else if (ok && pass > 0 && sp.ids.every((id) => !byId.has(id))) t.start = prevEnd;
        }
        if (t.start !== undefined) progress = true;
      }
      if (t.start !== undefined && t.end === undefined) {
        const ep = t.endSpec;
        if (ep.kind === "date") t.end = ep.t;
        else if (ep.kind === "duration") t.end = skipExcluded(t.start, addDuration(t.start, ep.d), g.excludes);
        else {
          let best: number | undefined;
          let ok = true;
          for (const id of ep.ids) {
            const o = byId.get(id);
            if (!o) {
              if (pass > 0) missing(t, id, ep.col);
              continue;
            }
            if (o.start === undefined) ok = false;
            else best = best === undefined ? o.start : Math.min(best, o.start);
          }
          if (ok && best !== undefined) t.end = best;
          else if (ok && pass > 0) t.end = t.start + DAY;
        }
        if (t.end !== undefined) progress = true;
      }
      prevEnd = t.end ?? prevEnd;
    }
    if (g.tasks.every((t) => t.start !== undefined && t.end !== undefined)) break;
    if (!progress && pass > 0) {
      // A cycle of references, or a first task with no start: reported once, at the first task left over.
      const t = g.tasks.find((x) => x.start === undefined || x.end === undefined)!;
      const noStart = t.startSpec.kind === "prev" && t.start === undefined;
      errors.push({ line: t.line, col: t.col, message: noStart ? `"${t.name}" has no start date and no task before it` : `The start or end of "${t.name}" depends on itself`, hint: noStart ? "Give the first task a start date: Name : 2024-03-01, 5d" : "Check the after and until references for a loop" });
      break;
    }
  }
  for (const t of g.tasks) {
    if (t.start !== undefined && t.end !== undefined && t.end < t.start) {
      errors.push({ line: t.line, col: t.col, message: `"${t.name}" ends before it starts`, hint: "Check the end date or the duration" });
      t.end = t.start;
    }
  }
}

// ---------------------------------------------------------------- ticks

interface TickPlan {
  k: number;
  unit: TickUnit;
}

const TICK_PLANS: TickPlan[] = [
  { k: 15, unit: "minute" }, { k: 30, unit: "minute" },
  { k: 1, unit: "hour" }, { k: 2, unit: "hour" }, { k: 3, unit: "hour" }, { k: 6, unit: "hour" }, { k: 12, unit: "hour" },
  { k: 1, unit: "day" }, { k: 2, unit: "day" },
  { k: 1, unit: "week" }, { k: 2, unit: "week" },
  { k: 1, unit: "month" }, { k: 3, unit: "month" }, { k: 6, unit: "month" },
  { k: 1, unit: "year" }, { k: 2, unit: "year" }, { k: 5, unit: "year" }, { k: 10, unit: "year" },
];

function approxMs(p: TickPlan): number {
  const u = { minute: MINUTE, hour: HOUR, day: DAY, week: 7 * DAY, month: 30.4 * DAY, year: 365.25 * DAY }[p.unit];
  return p.k * u;
}

/** Tick times from lo to hi for a plan, aligned to the calendar (weeks start on weekStart). */
export function tickTimes(lo: number, hi: number, p: TickPlan, weekStart = 1): number[] {
  const out: number[] = [];
  const d = new Date(lo);
  let t: number;
  switch (p.unit) {
    case "minute":
    case "hour": {
      const step = approxMs(p);
      t = Math.ceil(lo / step) * step;
      for (; t <= hi && out.length < 500; t += step) out.push(t);
      return out;
    }
    case "day": {
      t = Math.ceil(lo / DAY) * DAY;
      for (; t <= hi && out.length < 500; t += p.k * DAY) out.push(t);
      return out;
    }
    case "week": {
      t = Math.ceil(lo / DAY) * DAY;
      while (new Date(t).getUTCDay() !== weekStart) t += DAY;
      for (; t <= hi && out.length < 500; t += p.k * 7 * DAY) out.push(t);
      return out;
    }
    case "month": {
      let y = d.getUTCFullYear();
      let m = d.getUTCMonth();
      t = Date.UTC(y, m, 1);
      if (t < lo) m++;
      while (m % p.k) m++;
      for (; out.length < 500; m += p.k) {
        t = Date.UTC(y, m, 1);
        if (t > hi) break;
        out.push(t);
      }
      return out;
    }
    case "year": {
      let y = d.getUTCFullYear();
      if (Date.UTC(y, 0, 1) < lo) y++;
      while (y % p.k) y++;
      for (; out.length < 500; y += p.k) {
        t = Date.UTC(y, 0, 1);
        if (t > hi) break;
        out.push(t);
      }
      return out;
    }
  }
}

/** The axis label for a tick when the author gave no axisFormat: short, and naming the month or year where it changes. */
function autoLabel(t: number, prev: number | undefined, p: TickPlan): string {
  const d = new Date(t);
  const pd = prev === undefined ? undefined : new Date(prev);
  switch (p.unit) {
    case "minute":
    case "hour":
      return !pd || pd.getUTCDate() !== d.getUTCDate() ? strftime(t, "%b %-d %H:%M") : strftime(t, "%H:%M");
    case "day":
    case "week":
      return strftime(t, "%b %-d");
    case "month":
      return !pd || pd.getUTCFullYear() !== d.getUTCFullYear() ? strftime(t, "%b %Y") : strftime(t, "%b");
    case "year":
      return strftime(t, "%Y");
  }
}

// ---------------------------------------------------------------- drawing

export function renderGantt(src: string, ctx: DiagramContext): Rendered {
  const th = ctx.theme;
  const g = parseGantt(src, ctx.errors);
  if (g.title && !ctx.title) ctx.title = g.title;
  const title = g.title ?? ctx.title;
  const fs = th.fontSize;
  const small = Math.round(fs * 0.86 * 10) / 10;
  const tasks = g.tasks.filter((t) => t.start !== undefined && t.end !== undefined && Number.isFinite(t.start) && Number.isFinite(t.end));
  const rowsTasks = tasks.filter((t) => !t.vert);
  const verts = tasks.filter((t) => t.vert);
  const out: string[] = [];
  const head = titleBlock(title, th, 760);

  if (!tasks.length) {
    const w = Math.max(260, head.width + 2 * MARGIN);
    const h = MARGIN + head.height + 36;
    out.push(head.svg, textAt("No tasks to draw", MARGIN, MARGIN + head.height + 12, small, th.mutedText));
    return { svg: svgDocument(w, h, out.join(""), th, title), width: w, height: h };
  }

  let lo = Math.min(...tasks.map((t) => t.start!));
  let hi = Math.max(...tasks.map((t) => t.end!));
  if (hi - lo < HOUR) hi = lo + DAY;
  const span = hi - lo;
  // A little air at both ends so bars do not touch the frame.
  lo -= span * 0.015;
  hi += span * 0.015;

  // Plot width grows with the number of days, but stays within what a printed page holds at nearly
  // full size (a 6.5in text block is about 620px): wider charts get shrunk and their labels with them.
  const days = span / DAY;
  const plotW = Math.round(Math.max(440, Math.min(560, days * 22)));
  const scaleX = (t: number) => ((t - lo) / (hi - lo)) * plotW;

  // Tick plan: the finest one whose labels do not crowd.
  const labelFor = (p: TickPlan) => (t: number, prev: number | undefined) => (g.axisFormat ? strftime(t, g.axisFormat) : autoLabel(t, prev, p));
  let plan: TickPlan = g.tickInterval ?? TICK_PLANS[TICK_PLANS.length - 1];
  if (!g.tickInterval) {
    for (const p of TICK_PLANS) {
      const px = (approxMs(p) / (hi - lo)) * plotW;
      if (px < 28) continue;
      // With weekends off, every second day lands on them half the time: weeks read better.
      if (p.unit === "day" && p.k === 2 && g.excludes.weekdays.size) continue;
      const ts = tickTimes(lo, hi, p, g.weekStart);
      if (ts.length > 40) continue;
      const lf = labelFor(p);
      const texts = ts.map((t, i) => lf(t, ts[i - 1]));
      // An axisFormat coarser than the ticks (%b on weekly ticks) would repeat labels: go coarser.
      if (texts.some((x, i) => i > 0 && x === texts[i - 1])) continue;
      const widest = Math.max(0, ...texts.map((x) => measure(x, small)));
      if (px >= widest + 14) {
        plan = p;
        break;
      }
    }
  }
  // Reach back to a tick just before the start, so the first period is named (Jan for a plan starting Jan 5).
  {
    const before = tickTimes(lo - approxMs(plan) * 1.2, lo, plan, g.weekStart).pop();
    if (before !== undefined && before < lo && lo - before < approxMs(plan) * 0.3) lo = before;
  }
  const ticks = tickTimes(lo, hi, plan, g.weekStart);

  // Left column: section names.
  const named = g.sections.some((s) => s.trim());
  const colMax = 160;
  const secLabels = g.sections.map((s) => layoutLabel(`<b>${escLabel(s)}</b>`, small, colMax));
  const colW = named ? Math.min(colMax, Math.max(60, ...secLabels.map((l) => l.width))) + 18 : 0;

  const barH = Math.round(fs * 1.45);
  const rowH = barH + 10;
  const x0 = MARGIN + colW;
  const top = MARGIN + head.height + (head.height ? 4 : 0) + (verts.length ? small * 1.6 : 0);
  const axisH = small * 1.3 + 10;
  const topAxisH = g.topAxis ? axisH : 0;
  const rowsTop = top + topAxisH;

  // Order: by section, then source order.
  const order = [...rowsTasks].sort((a, b) => a.section - b.section || g.tasks.indexOf(a) - g.tasks.indexOf(b));
  const sectionIds = [...new Set(order.map((t) => t.section))];
  // Rows, with a small gap between sections.
  const rowY = new Map<GanttTask, number>();
  const bands: { section: number; y: number; h: number }[] = [];
  let y = rowsTop;
  for (const s of sectionIds) {
    const items = order.filter((t) => t.section === s);
    const lab = s >= 0 ? secLabels[s] : undefined;
    const h = Math.max(items.length * rowH + 6, (lab?.height ?? 0) + 12);
    bands.push({ section: s, y, h });
    let yy = y + 3 + (h - 6 - items.length * rowH) / 2;
    for (const t of items) {
      rowY.set(t, yy + rowH / 2);
      yy += rowH;
    }
    y += h;
  }
  const rowsBottom = y;

  // Colours.
  const base = th.palette[0];
  const warm = warmAccent(th);
  const bg = paper(th);
  const style = (t: GanttTask) => {
    const c = t.crit ? warm : base;
    if (t.done) return { fill: mix(c, bg, 0.6), stroke: "none", text: isDark(th) ? th.text : mix(c, th.text, 0.55) };
    if (t.active) return { fill: tint(c, th, 0.84), stroke: c, text: isDark(th) ? th.text : mix(c, th.text, 0.45) };
    return { fill: c, stroke: "none", text: textOn(c, th) };
  };

  // Labels beside bars may reach past the plot: measure first, widen if needed.
  const radius = 3;
  const pad = 7;
  const placed: { t: GanttTask; x: number; align: "start" | "end"; inside: boolean }[] = [];
  let extraRight = 0;
  for (const t of order) {
    const bx = scaleX(t.start!);
    const bw = Math.max(t.milestone ? 0 : 2, scaleX(t.end!) - bx);
    const w = measure(escLabel(t.name), small);
    if (t.milestone) {
      const mx = scaleX((t.start! + t.end!) / 2);
      const right = mx + barH * 0.45 + 6;
      if (right + w <= plotW + 140 || mx - barH * 0.45 - 6 - w < 0) {
        placed.push({ t, x: right, align: "start", inside: false });
        extraRight = Math.max(extraRight, right + w - plotW);
      } else placed.push({ t, x: mx - barH * 0.45 - 6, align: "end", inside: false });
    } else if (w + 2 * pad <= bw) placed.push({ t, x: bx + pad, align: "start", inside: true });
    else if (bx + bw + 6 + w <= plotW + 8 || bx - 6 - w < 0) {
      placed.push({ t, x: bx + bw + 6, align: "start", inside: false });
      extraRight = Math.max(extraRight, bx + bw + 6 + w - plotW);
    } else placed.push({ t, x: bx - 6, align: "end", inside: false });
  }

  // Tick labels sit centred on their ticks; the outermost may reach past the plot.
  const lf = labelFor(plan);
  const tickLabels = ticks.map((t, i) => ({ t, x: scaleX(t), text: lf(t, ticks[i - 1]) }));
  for (const tl of tickLabels) {
    const w = measure(tl.text, small);
    extraRight = Math.max(extraRight, tl.x + w / 2 - plotW);
  }
  const leftReach = Math.max(0, ...tickLabels.map((tl) => measure(tl.text, small) / 2 - tl.x - colW));
  const shiftX = leftReach > 0 ? leftReach : 0;
  const X = (v: number) => x0 + shiftX + v;

  const width = Math.max(X(plotW) + Math.max(0, extraRight) + MARGIN, head.width + 2 * MARGIN);
  const height = rowsBottom + axisH + MARGIN;

  out.push(head.svg);
  // Section bands.
  bands.forEach((b, i) => {
    if (i % 2 === 0) out.push(`<rect x="${n(MARGIN)}" y="${n(b.y)}" width="${n(width - 2 * MARGIN)}" height="${n(b.h)}" fill="${th.clusterFill}"/>`);
    const lab = b.section >= 0 ? secLabels[b.section] : undefined;
    if (lab && lab.lines.length) out.push(labelSvg(lab, MARGIN + 8, b.y + 6 + lab.height / 2, th.text, { align: "start" }));
  });
  // Days off, shaded faintly when a day is wide enough to see.
  const dayPx = (DAY / (hi - lo)) * plotW;
  if ((g.excludes.weekdays.size || g.excludes.days.size) && dayPx >= 3) {
    const shade = isDark(th) ? "#ffffff" : th.line;
    for (let d = Math.floor(lo / DAY) * DAY; d < hi; d += DAY) {
      if (!isExcluded(d, g.excludes)) continue;
      const a = Math.max(0, scaleX(d));
      const b = Math.min(plotW, scaleX(d + DAY));
      if (b > a) out.push(`<rect x="${n(X(a))}" y="${n(rowsTop)}" width="${n(b - a)}" height="${n(rowsBottom - rowsTop)}" fill="${shade}" fill-opacity="0.05"/>`);
    }
  }
  // Gridlines and the axis.
  const grid = th.clusterStroke;
  for (const tl of tickLabels) out.push(`<path d="M${n(X(tl.x))} ${n(rowsTop)}V${n(rowsBottom + 4)}" stroke="${grid}" stroke-width="0.75"/>`);
  out.push(`<path d="M${n(X(0))} ${n(rowsBottom)}H${n(X(plotW))}" stroke="${th.line}" stroke-width="0.9"/>`);
  for (const tl of tickLabels) out.push(plainText(tl.text, X(tl.x), baselineFor(rowsBottom + 6 + small * 0.65, small), small, th.mutedText, "middle"));
  if (g.topAxis) {
    out.push(`<path d="M${n(X(0))} ${n(rowsTop)}H${n(X(plotW))}" stroke="${th.line}" stroke-width="0.9"/>`);
    for (const tl of tickLabels) out.push(plainText(tl.text, X(tl.x), baselineFor(top + topAxisH / 2 - 2, small), small, th.mutedText, "middle"));
  }

  // Bars and milestones.
  for (const p of placed) {
    const t = p.t;
    const cy = rowY.get(t)!;
    const st = style(t);
    if (t.milestone) {
      const mx = X(scaleX((t.start! + t.end!) / 2));
      const r = barH * 0.45;
      const fill = t.done ? st.fill : t.crit ? warm : th.text;
      out.push(`<path d="M${n(mx)} ${n(cy - r)}L${n(mx + r)} ${n(cy)}L${n(mx)} ${n(cy + r)}L${n(mx - r)} ${n(cy)}Z" fill="${t.active ? st.fill : fill}" stroke="${t.active ? st.stroke : bg}" stroke-width="${t.active ? 1.4 : 1}" stroke-linejoin="round"/>`);
    } else {
      const bx = X(scaleX(t.start!));
      const bw = Math.max(2, scaleX(t.end!) - scaleX(t.start!));
      const inset = st.stroke !== "none" ? 0.7 : 0;
      out.push(`<rect x="${n(bx + inset)}" y="${n(cy - barH / 2 + inset)}" width="${n(Math.max(1, bw - 2 * inset))}" height="${n(barH - 2 * inset)}" rx="${radius}" fill="${st.fill}"${st.stroke !== "none" ? ` stroke="${st.stroke}" stroke-width="1.4"` : ""}/>`);
    }
    const color = p.inside ? st.text : t.crit && !t.done ? warm : t.done ? th.mutedText : th.text;
    out.push(textAt(escLabel(t.name), X(p.x), cy, small, color, { align: p.align }));
  }

  // Vertical markers.
  for (const v of verts) {
    const vx = X(scaleX(v.start!));
    const c = v.crit ? warm : th.text;
    out.push(`<path d="M${n(vx)} ${n(rowsTop - 2)}V${n(rowsBottom)}" stroke="${c}" stroke-width="1" stroke-dasharray="3 2.5"/>`);
    out.push(textAt(escLabel(v.name), vx, rowsTop - small * 0.85, small, c, { align: "middle" }));
  }

  return { svg: svgDocument(width, height, out.join(""), th, title), width, height };
}
