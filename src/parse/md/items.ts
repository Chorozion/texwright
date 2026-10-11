/**
 * The working list of the inline phase: a doubly linked list of items, each
 * a finished inline node or a delimiter run that may still become emphasis.
 * Linked so that wrapping a stretch into emphasis, or moving a marker, costs
 * O(1) however long the paragraph is.
 */
import type { Inline, Pos } from "../../ast.js";
import type { AttrSpec } from "./scan.js";

/** Display math found inside a paragraph: the paragraph is split around it. */
export interface DisplayMath {
  t: "$display";
  tex: string;
  env?: string;
  attr?: AttrSpec;
  pos: Pos;
}

/** A run of `*`, `_` or a pair of `~` that may open or close emphasis (spec 6.2). */
export interface Delim {
  char: "*" | "_" | "~";
  /** Characters still unused. */
  count: number;
  /** Length of the run as written, for the "rule of 3". */
  origCount: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delim | null;
  next: Delim | null;
  item: Item;
  active: boolean;
  /** Delimiters cut from one run of `~` share this; they never pair with each other. */
  run: number;
}

export interface Item {
  node: Inline | DisplayMath | null;
  /** Set while the item is an unresolved delimiter run; its text is in `node` (a Text). */
  delim: Delim | null;
  /** Text from a backslash escape or a character reference: typography and linkify leave it alone. */
  special?: boolean;
  /** Text that citations and references write around themselves: left alone too, but not "special". */
  opaque?: boolean;
  /** A lone `~` left over from an odd-length tilde run. */
  lone?: boolean;
  /** Content of emphasis, links and image descriptions, still as items. */
  kids?: ItemList;
  /** An attribute list written right after an image. */
  attr?: AttrSpec | null;
  /** A heading's or caption's final attribute list, right after its last image: applied over `attr`. */
  tailAttr?: AttrSpec;
  /** A link made from an autolink or a bare URL: its text is the URL and stays as written. */
  auto?: boolean;
  /** An image's description as written, the context curly quotes see around it. */
  raw?: string;
  prev: Item | null;
  next: Item | null;
}

export class ItemList {
  head: Item | null = null;
  tail: Item | null = null;

  push(node: Inline | DisplayMath | null, extra?: Partial<Item>): Item {
    const it: Item = { node, delim: null, prev: this.tail, next: null, ...extra };
    if (this.tail) this.tail.next = it;
    else this.head = it;
    this.tail = it;
    return it;
  }

  remove(it: Item): void {
    if (it.prev) it.prev.next = it.next;
    else this.head = it.next;
    if (it.next) it.next.prev = it.prev;
    else this.tail = it.prev;
    it.prev = it.next = null;
  }

  /** Insert `it` (not in any list) after `at`. */
  insertAfter(at: Item, it: Item): void {
    it.prev = at;
    it.next = at.next;
    if (at.next) at.next.prev = it;
    else this.tail = it;
    at.next = it;
  }

  /** Insert `it` (not in any list) before `at`. */
  insertBefore(at: Item, it: Item): void {
    it.next = at;
    it.prev = at.prev;
    if (at.prev) at.prev.next = it;
    else this.head = it;
    at.prev = it;
  }

  /** Detach the items strictly between `a` and `b` and return their nodes in order. */
  takeBetween(a: Item, b: Item): Item[] {
    const out: Item[] = [];
    for (let it = a.next; it && it !== b; it = it.next) out.push(it);
    a.next = b;
    b.prev = a;
    return out;
  }

}
