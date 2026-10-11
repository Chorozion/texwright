/** Date parsing shared by the BibTeX and CSL-JSON readers. */

import type { DateParts } from "./types.js";

export const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "3", "March", "mar", "Mar.~15", "3 15": month (1-12) and an optional day. */
export function parseMonth(s: string): { month?: number; day?: number } {
  const t = s.trim();
  const num = /^(\d{1,2})(?:\D+(\d{1,2}))?$/.exec(t);
  if (num) {
    const month = Number(num[1]);
    if (month < 1 || month > 12) return {};
    return num[2] ? { month, day: Number(num[2]) } : { month };
  }
  const named = /^(\p{L}{3})\p{L}*\.?\W*(\d{1,2})?$/u.exec(t);
  const index = named ? MONTH_KEYS.indexOf(named[1].toLowerCase()) : -1;
  if (!named || index < 0) return {};
  return named[2] ? { month: index + 1, day: Number(named[2]) } : { month: index + 1 };
}

/** ISO-like dates ("2020", "2020-03", "2020-03-15", ranges "2020-03-15/2020-03-20"); anything else is a literal. */
export function parseDateString(s: string): DateParts {
  const t = s.trim();
  const m = /^(-?\d{1,4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T[\d:.]+Z?)?(?:\s*\/.*)?$/.exec(t);
  if (!m) return { literal: t };
  const parts = [Number(m[1])];
  if (m[2]) {
    parts.push(Number(m[2]));
    if (m[3]) parts.push(Number(m[3]));
  }
  return { "date-parts": [parts] };
}

/** First date of a DateParts as [year, month?, day?], or undefined. */
export function dateParts(d: DateParts | undefined): number[] | undefined {
  const first = d?.["date-parts"]?.[0];
  if (first && first.length > 0 && Number.isFinite(first[0])) return first;
  if (d?.raw) return parseDateString(d.raw)["date-parts"]?.[0];
  return undefined;
}
