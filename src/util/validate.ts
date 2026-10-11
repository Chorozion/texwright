/**
 * A small JSON Schema (2020-12) validator for the subset texwright's own
 * schemas use: type (one or several), properties, required,
 * additionalProperties (false or a schema), enum, const, items, $ref into
 * the root's $defs, oneOf (with a fast path when every branch pins the same
 * property to a constant, as the document tree's `t` does), anyOf, minimum,
 * maximum, minLength, maxLength and minItems. Annotations (title,
 * description, default, examples) are ignored.
 *
 * It reports issues with JSON paths such as `blocks[0].content[1].t`, stops
 * after `maxIssues`, and costs time linear in the size of the value.
 */

export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  type?: JsonType | JsonType[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
}

export interface ValidationIssue {
  /** JSON path of the offending value, e.g. "blocks[0].content[1].t"; "" for the root. */
  path: string;
  message: string;
}

export interface ValidateOptions {
  /** Schema whose $defs resolve `$ref`s. Default: the schema itself. */
  root?: JsonSchema;
  /** Stop after this many issues. Default 25. */
  maxIssues?: number;
}

/** Validate `value` against `schema`; an empty list means it is valid. */
export function validate(value: unknown, schema: JsonSchema, options: ValidateOptions = {}): ValidationIssue[] {
  const v = new Validator(options.root ?? schema, options.maxIssues ?? 25);
  v.check(value, schema, "", 0);
  return v.issues;
}

/** `path` extended by an object key: `a.b`, or `a["odd key"]` when the key isn't a plain name. */
export function childPath(path: string, key: string): string {
  if (/^[A-Za-z_$][\w$-]*$/.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

const MAX_DEPTH = 2000;

interface Discriminator {
  key: string;
  branches: Map<unknown, JsonSchema>;
}

class Validator {
  readonly issues: ValidationIssue[] = [];
  private readonly discriminators = new WeakMap<JsonSchema[], Discriminator | null>();

  constructor(
    private readonly root: JsonSchema,
    private readonly maxIssues: number,
  ) {}

  private issue(path: string, message: string): void {
    if (this.issues.length < this.maxIssues) this.issues.push({ path, message });
  }

  private get full(): boolean {
    return this.issues.length >= this.maxIssues;
  }

  private resolve(ref: string): JsonSchema {
    const m = /^#\/\$defs\/(.+)$/.exec(ref);
    const target = m ? this.root.$defs?.[decodeURIComponent(m[1]!)] : ref === "#" ? this.root : undefined;
    if (!target) throw new Error(`Unresolvable $ref ${ref}`);
    return target;
  }

  check(value: unknown, schema: JsonSchema, path: string, depth: number): void {
    if (this.full) return;
    if (depth > MAX_DEPTH) {
      this.issue(path, "nested too deeply");
      return;
    }
    while (schema.$ref) schema = this.resolve(schema.$ref);
    if (schema.oneOf) {
      this.oneOf(value, schema.oneOf, path, depth);
      return;
    }
    if (schema.anyOf) {
      this.anyOf(value, schema.anyOf, path, depth);
      return;
    }
    if (schema.const !== undefined) {
      if (!equal(value, schema.const)) this.issue(path, `must be ${JSON.stringify(schema.const)}, got ${show(value)}`);
      return;
    }
    if (schema.enum) {
      if (!schema.enum.some((e) => equal(e, value))) this.issue(path, `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}; got ${show(value)}`);
      return;
    }
    if (schema.type !== undefined && !typeMatches(value, schema.type)) {
      this.issue(path, `expected ${typeLabel(schema.type)}, got ${kindOf(value)}`);
      return;
    }
    if (typeof value === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) this.issue(path, schema.minLength === 1 ? "must not be empty" : `must be at least ${schema.minLength} characters long`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) this.issue(path, `must be at most ${schema.maxLength} characters long`);
    } else if (typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) this.issue(path, `must be at least ${schema.minimum}, got ${value}`);
      if (schema.maximum !== undefined && value > schema.maximum) this.issue(path, `must be at most ${schema.maximum}, got ${value}`);
    } else if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) this.issue(path, `must have at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
      if (schema.items) {
        for (let k = 0; k < value.length && !this.full; k++) this.check(value[k], schema.items, `${path}[${k}]`, depth + 1);
      }
    } else if (isObject(value)) {
      this.object(value, schema, path, depth);
    }
  }

  private object(value: Record<string, unknown>, schema: JsonSchema, path: string, depth: number): void {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) this.issue(childPath(path, key), "required property is missing");
    }
    const extra = schema.additionalProperties;
    for (const key of Object.keys(value)) {
      if (this.full) return;
      const child = value[key];
      if (Object.hasOwn(props, key)) {
        if (child !== undefined) this.check(child, props[key]!, childPath(path, key), depth + 1);
      } else if (extra === false) {
        const allowed = Object.keys(props);
        this.issue(childPath(path, key), `unknown property${allowed.length ? `; allowed: ${allowed.join(", ")}` : ""}`);
      } else if (extra && extra !== true) {
        this.check(child, extra, childPath(path, key), depth + 1);
      }
    }
  }

  /** Every branch pins one property (the same one) to a distinct constant: look the branch up instead of trying them all. */
  private discriminator(branches: JsonSchema[]): Discriminator | null {
    if (this.discriminators.has(branches)) return this.discriminators.get(branches)!;
    let found: Discriminator | null = null;
    const resolved = branches.map((b) => {
      let s = b;
      while (s.$ref) s = this.resolve(s.$ref);
      return s;
    });
    const first = resolved[0]?.properties;
    if (first) {
      for (const key of Object.keys(first)) {
        const map = new Map<unknown, JsonSchema>();
        const ok = resolved.every((b) => {
          const c = b.properties?.[key]?.const;
          if (c === undefined || (typeof c === "object" && c !== null) || map.has(c)) return false;
          map.set(c, b);
          return b.required?.includes(key) ?? false;
        });
        if (ok) {
          found = { key, branches: map };
          break;
        }
      }
    }
    this.discriminators.set(branches, found);
    return found;
  }

  private oneOf(value: unknown, branches: JsonSchema[], path: string, depth: number): void {
    const d = this.discriminator(branches);
    if (d) {
      if (!isObject(value)) {
        this.issue(path, `expected an object, got ${kindOf(value)}`);
        return;
      }
      const tag = value[d.key];
      const where = childPath(path, d.key);
      const names = [...d.branches.keys()].map((k) => String(k)).join(", ");
      if (tag === undefined) {
        this.issue(where, `required property is missing; one of ${names}`);
        return;
      }
      const branch = d.branches.get(tag);
      if (!branch) {
        this.issue(where, `unknown type ${JSON.stringify(tag)}; expected one of ${names}`);
        return;
      }
      this.check(value, branch, path, depth + 1);
      return;
    }
    const results = branches.map((b) => this.trial(value, b, path, depth));
    const passing = results.filter((r) => r.length === 0).length;
    if (passing === 1) return;
    if (passing > 1) {
      this.issue(path, "matches more than one of the allowed forms");
      return;
    }
    this.reportClosest(results, path);
  }

  private anyOf(value: unknown, branches: JsonSchema[], path: string, depth: number): void {
    const results: ValidationIssue[][] = [];
    for (const b of branches) {
      const r = this.trial(value, b, path, depth);
      if (r.length === 0) return;
      results.push(r);
    }
    this.reportClosest(results, path);
  }

  private trial(value: unknown, schema: JsonSchema, path: string, depth: number): ValidationIssue[] {
    const sub = new Validator(this.root, this.maxIssues);
    sub.check(value, schema, path, depth + 1);
    return sub.issues;
  }

  private reportClosest(results: ValidationIssue[][], path: string): void {
    if (!results.length) {
      this.issue(path, "no allowed form to match");
      return;
    }
    // Report the branch that came closest: fewest issues, deepest first issue.
    const best = [...results].sort((a, b) => a.length - b.length || b[0]!.path.length - a[0]!.path.length)[0]!;
    if (best.length && best[0]!.path !== path) for (const i of best) this.issue(i.path, i.message);
    else this.issue(path, `doesn't match any allowed form${best[0] ? ` (${best[0].message})` : ""}`);
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(value: unknown, type: JsonType | JsonType[]): boolean {
  if (Array.isArray(type)) return type.some((t) => typeMatches(value, t));
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
  }
}

function typeLabel(type: JsonType | JsonType[]): string {
  if (!Array.isArray(type)) return type === "integer" ? "a whole number" : type === "array" ? "an array" : type === "object" ? "an object" : `a ${type}`;
  return type.map((t) => typeLabel(t)).join(" or ");
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "number") return `the number ${value}`;
  if (typeof value === "string") return `the string ${show(value)}`;
  if (typeof value === "boolean") return String(value);
  return typeof value === "object" ? "an object" : typeof value;
}

function show(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
