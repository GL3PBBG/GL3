import { createHash } from "node:crypto";

/**
 * Image sniffing and header parsing, in pure TypeScript.
 *
 * This project takes no native image dependency. `sharp` would bring a
 * prebuilt binary per platform into an image that CI builds and this machine
 * cannot, for two things we do not do: re-encoding and resizing. What we DO
 * need is (a) proof the bytes are the format the caller claims and (b) the
 * intrinsic dimensions, so a renderer can reserve the box. Both live in the
 * first few dozen bytes of every format we accept.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

export const ACCEPTED_MIMES: readonly ImageMime[] = ["image/png", "image/jpeg", "image/webp"];

export interface ImageInfo {
  mime: ImageMime;
  width: number;
  height: number;
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Identify `bytes` from its own content and read its dimensions, or return null
 * if it is not one of the three formats we accept.
 *
 * The declared Content-Type is NOT consulted here, deliberately: the caller
 * compares this result against what was declared and rejects a mismatch. A
 * `.php` renamed `.png` and served as `image/png` fails that comparison, which
 * is the whole point — trusting the header would make the upload route a file
 * drop that happens to have image in its name.
 */
export function identifyImage(bytes: Buffer): ImageInfo | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(b: Buffer): ImageInfo | null {
  // 8-byte signature, then the IHDR chunk, which the spec requires to come
  // first: length(4) type(4) width(4) height(4).
  if (b.length < 24) return null;
  if (!b.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (b.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { mime: "image/png", width, height };
}

function readJpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4) return null;
  if (b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;

  // Walk the segment chain looking for a Start Of Frame. Dimensions do not
  // live at a fixed offset in JPEG — an arbitrary number of APPn/COM segments
  // (EXIF, ICC profiles, thumbnails) precede the frame, and each declares its
  // own length. DHT/DRI/DAC and the SOF markers themselves are the only ones
  // that matter; SOS (0xDA) means the entropy-coded scan has begun and there
  // is no header left to find.
  let offset = 2;
  while (offset + 3 < b.length) {
    if (b[offset] !== 0xff) return null;
    const marker = b[offset + 1]!;
    // Padding: a fill byte run of 0xFF is legal between segments.
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    if (marker === 0xda) return null;
    const length = b.readUInt16BE(offset + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      // precision(1) height(2) width(2), starting after the length field.
      if (offset + 9 > b.length) return null;
      const height = b.readUInt16BE(offset + 5);
      const width = b.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) return null;
      return { mime: "image/jpeg", width, height };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * SOF0-SOF15, minus the three markers that share the numeric range but are not
 * frame headers: DHT (0xC4), JPG (0xC8) and DAC (0xCC).
 */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readWebp(b: Buffer): ImageInfo | null {
  if (b.length < 30) return null;
  if (b.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (b.subarray(8, 12).toString("latin1") !== "WEBP") return null;

  const chunk = b.subarray(12, 16).toString("latin1");

  if (chunk === "VP8 ") {
    // Lossy. The keyframe start code 9D 01 2A sits at 23; the two 16-bit
    // fields after it carry a 14-bit dimension plus a 2-bit scale.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    const width = b.readUInt16LE(26) & 0x3fff;
    const height = b.readUInt16LE(28) & 0x3fff;
    if (width === 0 || height === 0) return null;
    return { mime: "image/webp", width, height };
  }

  if (chunk === "VP8L") {
    // Lossless. One signature byte, then 14 bits of width-1 and 14 bits of
    // height-1 packed little-endian across the next four bytes.
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { mime: "image/webp", width, height };
  }

  if (chunk === "VP8X") {
    // Extended (animation, alpha, ICC). Canvas size is 24-bit little-endian
    // minus one, at offset 24.
    const width = (b.readUIntLE(24, 3) & 0xffffff) + 1;
    const height = (b.readUIntLE(27, 3) & 0xffffff) + 1;
    return { mime: "image/webp", width, height };
  }

  return null;
}
