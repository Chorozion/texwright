/**
 * Link destinations: percent-encoding for the URL a link points to, decoding
 * for the text an autolink shows, IDNA (punycode) host names, and the check
 * that refuses script and file URLs.
 *
 * A URL is split into protocol, auth, host, path, query and fragment the way
 * the long-standing Markdown tool chain does (an old `url.parse` variant):
 * only the host is ever rewritten, everything else is passed through the
 * same encoder, so a link that is already valid comes out unchanged.
 */

const SAFE_CHARS = ";/?:@&=+$,-_.!~*'()#";
const KEEP_ENCODED = ";/?:@&=+$,#";

const encodeTables = new Map<string, string[]>();

function encodeTable(exclude: string): string[] {
  let table = encodeTables.get(exclude);
  if (table) return table;
  table = [];
  for (let i = 0; i < 128; i++) {
    const ch = String.fromCharCode(i);
    table.push(/^[0-9a-z]$/i.test(ch) ? ch : "%" + i.toString(16).toUpperCase().padStart(2, "0"));
  }
  for (const ch of exclude) table[ch.charCodeAt(0)] = ch;
  encodeTables.set(exclude, table);
  return table;
}

/** Percent-encode everything but alphanumerics and `exclude`, keeping valid %XX escapes. */
function encodeUrl(s: string, exclude = SAFE_CHARS): string {
  const table = encodeTable(exclude);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x25 && i + 2 < s.length && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      out += s.slice(i, i + 3);
      i += 2;
    } else if (code < 128) {
      out += table[code];
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
        out += encodeURIComponent(s[i] + s[i + 1]);
        i++;
      } else {
        out += "%EF%BF%BD";
      }
    } else {
      out += encodeURIComponent(s[i]);
    }
  }
  return out;
}

/** Decode %XX sequences as UTF-8, except for the characters in `keep`; malformed bytes become U+FFFD. */
function decodeUrl(s: string, keep = KEEP_ENCODED): string {
  return s.replace(/(%[a-f0-9]{2})+/gi, (seq) => {
    let out = "";
    const byte = (k: number): number => parseInt(seq.slice(k + 1, k + 3), 16);
    for (let i = 0; i < seq.length; i += 3) {
      const b1 = byte(i);
      if (b1 < 0x80) {
        const ch = String.fromCharCode(b1);
        out += keep.includes(ch) ? seq.slice(i, i + 3).toUpperCase() : ch;
        continue;
      }
      if ((b1 & 0xe0) === 0xc0 && i + 3 < seq.length) {
        const b2 = byte(i + 3);
        if ((b2 & 0xc0) === 0x80) {
          const c = ((b1 << 6) & 0x7c0) | (b2 & 0x3f);
          out += c < 0x80 ? "\ufffd\ufffd" : String.fromCharCode(c);
          i += 3;
          continue;
        }
      }
      if ((b1 & 0xf0) === 0xe0 && i + 6 < seq.length) {
        const b2 = byte(i + 3);
        const b3 = byte(i + 6);
        if ((b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80) {
          const c = ((b1 << 12) & 0xf000) | ((b2 << 6) & 0xfc0) | (b3 & 0x3f);
          out += c < 0x800 || (c >= 0xd800 && c <= 0xdfff) ? "\ufffd\ufffd\ufffd" : String.fromCharCode(c);
          i += 6;
          continue;
        }
      }
      if ((b1 & 0xf8) === 0xf0 && i + 9 < seq.length) {
        const b2 = byte(i + 3);
        const b3 = byte(i + 6);
        const b4 = byte(i + 9);
        if ((b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80 && (b4 & 0xc0) === 0x80) {
          const c = ((b1 << 18) & 0x1c0000) | ((b2 << 12) & 0x3f000) | ((b3 << 6) & 0xfc0) | (b4 & 0x3f);
          if (c < 0x10000 || c > 0x10ffff) out += "\ufffd\ufffd\ufffd\ufffd";
          else out += String.fromCharCode(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff));
          i += 9;
          continue;
        }
      }
      out += "\ufffd";
    }
    return out;
  });
}

// ------------------------------------------------------------------ splitting URLs

interface UrlParts {
  protocol: string;
  slashes: boolean;
  auth: string | null;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  hash: string;
}

const PROTOCOL = /^([a-z0-9.+-]+:)/i;
const PORT = /:[0-9]*$/;
const HOST_PART = /^[+a-z0-9A-Z_-]{0,63}$/;
const HOST_PART_START = /^([+a-z0-9A-Z_-]{0,63})(.*)$/;
const HOSTLESS = new Set(["javascript", "javascript:"]);
const SLASHED = new Set(["http", "https", "ftp", "gopher", "file", "http:", "https:", "ftp:", "gopher:", "file:"]);
const codes = (chars: string[]): Set<number> => new Set(chars.map((c) => c.charCodeAt(0)));
const HOST_ENDS = codes(["/", "?", "#"]);
const NON_HOST = codes(["%", "/", "?", ";", "#", "'", "{", "}", "|", "\\", "^", "`", "<", ">", '"', " ", "\r", "\n", "\t"]);

/** Index of the first character of `s` that is in `chars`, or -1. */
function firstOf(s: string, chars: Set<number>): number {
  for (let i = 0; i < s.length; i++) if (chars.has(s.charCodeAt(i))) return i;
  return -1;
}


function splitUrl(url: string): UrlParts {
  const u: UrlParts = { protocol: "", slashes: false, auth: null, hostname: "", port: "", pathname: "", search: "", hash: "" };
  let rest = url.trim();
  const proto = PROTOCOL.exec(rest)?.[0] ?? "";
  if (proto) {
    u.protocol = proto;
    rest = rest.slice(proto.length);
  }
  const slashes = rest.startsWith("//");
  if (slashes && !(proto && HOSTLESS.has(proto))) {
    rest = rest.slice(2);
    u.slashes = true;
  }
  if (!HOSTLESS.has(proto) && (slashes || (proto && !SLASHED.has(proto)))) {
    const hostEnd = firstOf(rest, HOST_ENDS);
    const at = hostEnd === -1 ? rest.lastIndexOf("@") : rest.lastIndexOf("@", hostEnd);
    if (at !== -1) {
      u.auth = rest.slice(0, at);
      rest = rest.slice(at + 1);
    }
    let end = firstOf(rest, NON_HOST);
    if (end === -1) end = rest.length;
    if (rest[end - 1] === ":") end--;
    let host = rest.slice(0, end);
    rest = rest.slice(end);
    const port = PORT.exec(host)?.[0];
    if (port) {
      if (port !== ":") u.port = port.slice(1);
      host = host.slice(0, host.length - port.length);
    }
    u.hostname = host;
    const ipv6 = u.hostname.startsWith("[") && u.hostname.endsWith("]");
    if (!ipv6) {
      const parts = u.hostname.split(".");
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part || HOST_PART.test(part)) continue;
        // Characters past ASCII may be IDNA labels; anything else ends the host.
        if (HOST_PART.test(part.replace(/[^\0-\x7f]/g, "x"))) continue;
        const valid = parts.slice(0, i);
        const notHost = parts.slice(i + 1);
        const bit = HOST_PART_START.exec(part);
        if (bit) {
          valid.push(bit[1]);
          notHost.unshift(bit[2]);
        }
        if (notHost.length) rest = notHost.join(".") + rest;
        u.hostname = valid.join(".");
        break;
      }
    }
    if (u.hostname.length > 255) u.hostname = "";
    if (ipv6) u.hostname = u.hostname.slice(1, -1);
  }
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    u.hash = rest.slice(hash);
    rest = rest.slice(0, hash);
  }
  const query = rest.indexOf("?");
  if (query !== -1) {
    u.search = rest.slice(query);
    rest = rest.slice(0, query);
  }
  u.pathname = rest;
  return u;
}

function joinUrl(u: UrlParts): string {
  const host = u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname;
  return u.protocol + (u.slashes ? "//" : "") + (u.auth ? u.auth + "@" : "") + host + (u.port ? ":" + u.port : "") + u.pathname + u.search + u.hash;
}

const RECODE_HOST_FOR = new Set(["http:", "https:", "mailto:"]);

/** The URL a link points to: host names in ASCII form, unsafe characters percent-encoded. */
export function normalizeLink(url: string): string {
  const u = splitUrl(url);
  if (u.hostname && (!u.protocol || RECODE_HOST_FOR.has(u.protocol))) {
    try {
      u.hostname = domainToAscii(u.hostname);
    } catch {
      // keep the host as written
    }
  }
  if (u.auth) u.auth = encodeUrl(u.auth);
  u.hostname = encodeUrl(u.hostname);
  u.pathname = encodeUrl(u.pathname);
  u.search = encodeUrl(u.search);
  u.hash = encodeUrl(u.hash);
  return joinUrl(u);
}

/** The text shown for a URL: host names in Unicode, percent escapes decoded where that is safe. */
export function normalizeLinkText(url: string): string {
  const u = splitUrl(url);
  if (u.hostname && (!u.protocol || RECODE_HOST_FOR.has(u.protocol))) {
    try {
      u.hostname = domainToUnicode(u.hostname);
    } catch {
      // keep the host as written
    }
  }
  return decodeUrl(joinUrl(u), KEEP_ENCODED + "%");
}

const BAD_PROTOCOL = /^(vbscript|javascript|file|data):/;
const GOOD_DATA = /^data:image\/(gif|png|jpeg|webp);/;

/** False for `javascript:`, `vbscript:`, `file:` and non-image `data:` URLs, which never become links. */
export function validateLink(url: string): boolean {
  const s = url.trim().toLowerCase();
  return BAD_PROTOCOL.test(s) ? GOOD_DATA.test(s) : true;
}

// ------------------------------------------------------------------ punycode (RFC 3492)

const MAX_INT = 0x7fffffff;
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;

function adapt(delta: number, points: number, first: boolean): number {
  let k = 0;
  delta = first ? Math.floor(delta / DAMP) : delta >> 1;
  delta += Math.floor(delta / points);
  for (; delta > ((BASE - T_MIN) * T_MAX) >> 1; k += BASE) delta = Math.floor(delta / (BASE - T_MIN));
  return Math.floor(k + ((BASE - T_MIN + 1) * delta) / (delta + SKEW));
}

const threshold = (k: number, bias: number): number => (k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias);
const digitChar = (d: number): string => String.fromCharCode(d + 22 + (d < 26 ? 75 : 0));

/** Code points of a string; lone surrogates count as themselves. */
function codePoints(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const next = s.charCodeAt(i + 1);
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      out.push(((c & 0x3ff) << 10) + (next & 0x3ff) + 0x10000);
      i++;
    } else out.push(c);
  }
  return out;
}

function punycodeEncode(label: string): string {
  const input = codePoints(label);
  let out = input.filter((c) => c < 0x80).map((c) => String.fromCharCode(c)).join("");
  const basic = out.length;
  let handled = basic;
  if (basic) out += "-";
  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < input.length) {
    let m = MAX_INT;
    for (const c of input) if (c >= n && c < m) m = c;
    if (m - n > Math.floor((MAX_INT - delta) / (handled + 1))) throw new RangeError("punycode overflow");
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of input) {
      if (c < n && ++delta > MAX_INT) throw new RangeError("punycode overflow");
      if (c !== n) continue;
      let q = delta;
      for (let k = BASE; ; k += BASE) {
        const t = threshold(k, bias);
        if (q < t) break;
        out += digitChar(t + ((q - t) % (BASE - t)));
        q = Math.floor((q - t) / (BASE - t));
      }
      out += digitChar(q);
      bias = adapt(delta, handled + 1, handled === basic);
      delta = 0;
      handled++;
    }
    delta++;
    n++;
  }
  return out;
}

function digitOf(code: number): number {
  if (code >= 0x30 && code < 0x3a) return 26 + (code - 0x30);
  if (code >= 0x41 && code < 0x5b) return code - 0x41;
  if (code >= 0x61 && code < 0x7b) return code - 0x61;
  return BASE;
}

function punycodeDecode(input: string): string {
  const out: number[] = [];
  let basic = input.lastIndexOf("-");
  if (basic < 0) basic = 0;
  for (let j = 0; j < basic; j++) {
    if (input.charCodeAt(j) >= 0x80) throw new RangeError("punycode: not basic");
    out.push(input.charCodeAt(j));
  }
  let i = 0;
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const old = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) throw new RangeError("punycode: invalid input");
      const digit = digitOf(input.charCodeAt(index++));
      if (digit >= BASE) throw new RangeError("punycode: invalid input");
      if (digit > Math.floor((MAX_INT - i) / w)) throw new RangeError("punycode overflow");
      i += digit * w;
      const t = threshold(k, bias);
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) throw new RangeError("punycode overflow");
      w *= BASE - t;
    }
    const count = out.length + 1;
    bias = adapt(i - old, count, old === 0);
    if (Math.floor(i / count) > MAX_INT - n) throw new RangeError("punycode overflow");
    n += Math.floor(i / count);
    i %= count;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** Apply `fn` to each label of a domain (the part after `@` in an address); IDNA dots count as dots. */
function mapDomain(domain: string, fn: (label: string) => string): string {
  const at = domain.split("@");
  let prefix = "";
  if (at.length > 1) {
    prefix = at[0] + "@";
    domain = at[1];
  }
  return prefix + domain.replace(/[.\u3002\uff0e\uff61]/g, ".").split(".").map(fn).join(".");
}

function domainToAscii(domain: string): string {
  if (!/[^\0-\x7f]/.test(domain)) return domain; // nothing to encode (and no IDNA dots)
  return mapDomain(domain, (label) => (/[^\0-\x7f]/.test(label) ? "xn--" + punycodeEncode(label) : label));
}

function domainToUnicode(domain: string): string {
  if (!domain.includes("xn--") && !/[\u3002\uff0e\uff61]/.test(domain)) return domain;
  return mapDomain(domain, (label) => (/^xn--/.test(label) ? punycodeDecode(label.slice(4).toLowerCase()) : label));
}
