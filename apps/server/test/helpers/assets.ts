import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { FilesystemDriver } from "../../src/assets/fs-driver.js";

/**
 * A storage root of this test file's own, under the OS temp directory.
 *
 * Per-file, never shared: Redis and Postgres are shared across every
 * concurrently running test file here and that has repeatedly produced failures
 * that look like real regressions. Storage is the one shared resource this
 * cluster adds, and giving each file its own root is what keeps it from
 * becoming the next one.
 */
export function testAssetDriver(): FilesystemDriver {
  return new FilesystemDriver(mkdtempSync(join(tmpdir(), "gl3-assets-")));
}

/**
 * A real, valid PNG of the requested size — not a fixture file, because the
 * dimension parser under test reads the IHDR chunk and a hand-written byte
 * string is easier to reason about than a binary blob in the repo.
 *
 * Built properly (CRCs and a zlib-compressed IDAT) rather than truncated after
 * the header: the upload path hashes the whole body, and a test that fed it
 * something no decoder would accept would prove less than it appears to.
 */
export function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // colour type: truecolour
  // 10-12: compression, filter, interlace — all zero.

  // One filter byte plus three bytes per pixel, per row.
  const raw = Buffer.alloc(height * (1 + width * 3));
  const idatData = deflateSync(raw);

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdrData),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 8 + data.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A minimal but structurally valid JPEG: SOI, a SOF0 carrying the size, EOI. */
export function makeJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(11);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(9, 2); // segment length
  sof[4] = 8; // sample precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 1; // one component
  sof[10] = 1; // component id
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]), sof, Buffer.from([0xff, 0xd9])]);
}

/** A lossy WebP header carrying the requested canvas size. */
export function makeWebp(width: number, height: number): Buffer {
  const out = Buffer.alloc(30);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(22, 4);
  out.write("WEBP", 8, "latin1");
  out.write("VP8 ", 12, "latin1");
  out.writeUInt32LE(10, 16);
  out[20] = 0x00;
  out[21] = 0x00;
  out[22] = 0x00;
  out[23] = 0x9d;
  out[24] = 0x01;
  out[25] = 0x2a;
  out.writeUInt16LE(width, 26);
  out.writeUInt16LE(height, 28);
  return out;
}
