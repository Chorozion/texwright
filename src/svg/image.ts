/**
 * Raster images inside SVG: `data:image/png` and `data:image/jpeg` URLs are
 * decoded here and handed back as an ImageRef that carries its bytes, so
 * the PDF writer can embed them without any file access.
 */

import { createHash } from "node:crypto";
import type { ImageRef } from "../layout/types.js";

/** An ImageRef decoded from a data: URL; the typesetter registers `bytes` with the PDF writer under `id`. */
export interface EmbeddedImageRef extends ImageRef {
  bytes: Uint8Array;
  format: "png" | "jpeg";
}

export function isEmbeddedImage(ref: ImageRef): ref is EmbeddedImageRef {
  return (ref as Partial<EmbeddedImageRef>).bytes instanceof Uint8Array;
}

/** Decodes a data: URL; undefined when it is not one or is malformed. */
export function decodeDataUrl(href: string): { mime: string; bytes: Uint8Array } | undefined {
  const m = /^data:([^,;]*)((?:;[^,;]*)*),/i.exec(href.slice(0, 512));
  if (!m) return undefined;
  const mime = (m[1] || "text/plain").trim().toLowerCase();
  const base64 = /;base64/i.test(m[2]);
  const payload = href.slice(m[0].length);
  try {
    if (base64) {
      const clean = payload.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) return undefined;
      return { mime, bytes: new Uint8Array(Buffer.from(clean, "base64")) };
    }
    return { mime, bytes: new Uint8Array(Buffer.from(decodeURIComponent(payload), "latin1")) };
  } catch {
    return undefined;
  }
}

/** Pixel size of a PNG (IHDR) or JPEG (first SOFn marker); undefined when the bytes are not that format. */
export function rasterSize(bytes: Uint8Array, format: "png" | "jpeg"): { width: number; height: number } | undefined {
  if (format === "png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return undefined;
    const u32 = (o: number) => ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return undefined;
    const width = u32(16);
    const height = u32(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (len < 2) return undefined;
    i += 2 + len;
  }
  return undefined;
}

/** An EmbeddedImageRef for a PNG or JPEG data: URL, or undefined. */
export function embeddedImage(href: string): EmbeddedImageRef | undefined {
  const d = decodeDataUrl(href);
  if (!d) return undefined;
  const format = d.mime === "image/png" ? "png" : d.mime === "image/jpeg" || d.mime === "image/jpg" ? "jpeg" : undefined;
  if (!format) return undefined;
  const size = rasterSize(d.bytes, format);
  if (!size) return undefined;
  const id = `svg-${format}-${createHash("sha256").update(d.bytes).digest("hex").slice(0, 24)}`;
  return { id, pixelWidth: size.width, pixelHeight: size.height, bytes: d.bytes, format };
}
