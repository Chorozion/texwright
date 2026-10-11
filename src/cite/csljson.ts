/**
 * CSL-JSON reader: an array of CSL items, or {"items": [...]} as some tools
 * export it. Items are checked for an id and a type and lightly normalized:
 * numbers become strings, string or raw dates become date-parts, and names
 * given as plain strings become literal names.
 */

import type { Pos } from "../ast.js";
import { Diagnostics, offsetToPos } from "../diagnostics.js";
import { parseDateString } from "./dates.js";
import { setEntrySource } from "./source.js";
import type { BibEntry, DateParts, Name } from "./types.js";

const DATE_FIELDS = ["issued", "accessed", "event-date", "original-date", "submitted"];
const NAME_FIELDS = ["author", "editor", "translator", "container-author", "collection-editor", "director", "interviewer", "recipient"];
const NAME_PARTS = ["family", "given", "literal", "non-dropping-particle", "dropping-particle", "suffix"] as const;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseCslJson(text: string, ctx: { file?: string; diagnostics: Diagnostics }): BibEntry[] {
  const { file, diagnostics } = ctx;
  if (file) diagnostics.registerSource(file, text);
  const where = file ? { file } : undefined;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    diagnostics.add("CITE003", `Bibliography is not valid JSON: ${message}`, jsonErrorPos(text, message, file) ?? where, {
      hint: "CSL-JSON is an array of objects such as [{\"id\": \"doe2020\", \"type\": \"book\", \"title\": \"...\"}].",
    });
    return [];
  }
  const items = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.items) ? data.items : undefined;
  if (!items) {
    diagnostics.add("CITE003", "CSL-JSON bibliography must be an array of items (or an object with an \"items\" array)", where);
    return [];
  }
  const entries: BibEntry[] = [];
  const seen = new Set<string>();
  items.forEach((item: unknown, index: number) => {
    const label = `CSL-JSON item ${index + 1}`;
    if (!isObject(item)) {
      diagnostics.add("CITE003", `${label} is not an object`, where);
      return;
    }
    if (typeof item.id !== "string" && typeof item.id !== "number") {
      diagnostics.add("CITE003", `${label} has no "id"`, where, { hint: "Every item needs an id; it is the citation key." });
      return;
    }
    const id = String(item.id);
    if (seen.has(id)) {
      diagnostics.add("CITE003", `Duplicate CSL-JSON id "${id}"; the first item is kept`, where, { severity: "warning" });
      return;
    }
    seen.add(id);
    let type = item.type;
    if (typeof type !== "string" || type === "") {
      diagnostics.add("CITE003", `CSL-JSON item "${id}" has no "type"; using "document"`, where, { severity: "warning" });
      type = "document";
    }
    const entry = normalize({ ...item, id, type: type as string });
    setEntrySource(entry, where ?? {});
    entries.push(entry);
  });
  return entries;
}

function normalize(item: Json & { id: string; type: string }): BibEntry {
  const entry: BibEntry = { id: item.id, type: item.type };
  for (const [key, value] of Object.entries(item)) {
    if (key === "id" || key === "type") continue;
    if (DATE_FIELDS.includes(key)) {
      const date = normalizeDate(value);
      if (date) entry[key] = date;
    } else if (NAME_FIELDS.includes(key)) {
      if (Array.isArray(value)) entry[key] = value.map(normalizeName).filter((n): n is Name => n !== undefined);
    } else entry[key] = typeof value === "number" ? String(value) : value;
  }
  return entry;
}

function normalizeDate(v: unknown): DateParts | undefined {
  if (typeof v === "string" || typeof v === "number") return parseDateString(String(v));
  if (!isObject(v)) return undefined;
  const parts = v["date-parts"];
  if (Array.isArray(parts) && Array.isArray(parts[0])) {
    const nums = (parts as unknown[][]).map((p) => p.map(Number).filter(Number.isFinite));
    if (nums[0].length > 0) return { "date-parts": nums };
  }
  if (typeof v.raw === "string") return parseDateString(v.raw);
  if (typeof v.literal === "string") return { literal: v.literal };
  return undefined;
}

function normalizeName(v: unknown): Name | undefined {
  if (typeof v === "string") return v.trim() ? { literal: v.trim() } : undefined;
  if (!isObject(v)) return undefined;
  const name: Name = {};
  for (const part of NAME_PARTS) if (typeof v[part] === "string" && v[part] !== "") name[part] = v[part] as string;
  return Object.keys(name).length > 0 ? name : undefined;
}

/** Node reports "... at position 42 (line 3 column 5)"; older versions only the position. */
function jsonErrorPos(text: string, message: string, file: string | undefined): Pos | undefined {
  const lc = /line (\d+) column (\d+)/.exec(message);
  if (lc) return file ? { file, line: Number(lc[1]), col: Number(lc[2]) } : { line: Number(lc[1]), col: Number(lc[2]) };
  const at = /position (\d+)/.exec(message);
  return at ? offsetToPos(text, Number(at[1]), file) : undefined;
}
