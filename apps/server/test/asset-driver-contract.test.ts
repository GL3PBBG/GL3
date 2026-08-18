import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StorageDriver } from "../src/assets/driver.js";
import { FilesystemDriver } from "../src/assets/fs-driver.js";
import { S3Driver } from "../src/assets/s3-driver.js";
import { hashBytes } from "../src/assets/image.js";

/**
 * The storage contract, run against every backend that claims to implement it.
 *
 * This exists because of a trade made deliberately when the cluster was
 * designed: production uses S3 (Cloudflare R2), the suite uses the filesystem,
 * and `npm run verify` therefore never touches the S3 code path. That is the
 * right default — the suite must run offline, and a credentialled bucket shared
 * between concurrently running agents is precisely the cross-talk this project
 * has been burned by twice.
 *
 * The mitigation is that the S3 driver has a green path it can be MADE to
 * prove. Export the four `S3_TEST_*` variables below and this same block runs
 * against a real endpoint:
 *
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9000 S3_TEST_BUCKET=gl3-test \
 *   S3_TEST_ACCESS_KEY_ID=... S3_TEST_SECRET_ACCESS_KEY=... npx vitest run asset-driver-contract
 *
 * Unset — the normal case — the S3 block is skipped and says so.
 */
function contractFor(name: string, make: () => StorageDriver): void {
  describe(`${name} storage driver`, () => {
    it("round-trips bytes under their content hash", async () => {
      const driver = make();
      const bytes = Buffer.from("round-trip payload");
      const key = hashBytes(bytes);

      await driver.put(key, bytes, "image/png");

      expect(await driver.get(key)).toEqual(bytes);
    });

    it("answers null for a key that was never stored, rather than throwing", async () => {
      const driver = make();
      // A miss must be distinguishable from a failure: the serve route turns
      // null into a 404 and lets everything else become a 500.
      const missing = hashBytes(Buffer.from("never stored"));

      expect(await driver.get(missing)).toBeNull();
    });

    it("treats storing the same key twice as idempotent", async () => {
      const driver = make();
      const bytes = Buffer.from("stored twice");
      const key = hashBytes(bytes);

      await driver.put(key, bytes, "image/png");
      await driver.put(key, bytes, "image/png");

      expect(await driver.get(key)).toEqual(bytes);
    });

    it("deletes, and deleting an absent key is not an error", async () => {
      const driver = make();
      const bytes = Buffer.from("to be deleted");
      const key = hashBytes(bytes);
      await driver.put(key, bytes, "image/png");

      await driver.delete(key);
      expect(await driver.get(key)).toBeNull();

      // Second delete: the sweeper can race itself, and a throw here would turn
      // a lost race into a failed pass.
      await expect(driver.delete(key)).resolves.toBeUndefined();
    });

    it("builds a URL that ends in the key", async () => {
      const driver = make();
      const key = hashBytes(Buffer.from("url shape"));

      expect(driver.urlFor(key).endsWith(key)).toBe(true);
    });
  });
}

contractFor("filesystem", () => new FilesystemDriver(mkdtempSync(join(tmpdir(), "gl3-contract-"))));

const s3Endpoint = process.env["S3_TEST_ENDPOINT"];
const s3Bucket = process.env["S3_TEST_BUCKET"];
const s3Key = process.env["S3_TEST_ACCESS_KEY_ID"];
const s3Secret = process.env["S3_TEST_SECRET_ACCESS_KEY"];

if (s3Endpoint !== undefined && s3Bucket !== undefined && s3Key !== undefined && s3Secret !== undefined) {
  contractFor("s3", () => new S3Driver({
    endpoint: s3Endpoint,
    bucket: s3Bucket,
    accessKeyId: s3Key,
    secretAccessKey: s3Secret,
    region: process.env["S3_TEST_REGION"] ?? "auto",
    cdnBase: process.env["S3_TEST_CDN_BASE"] ?? "https://cdn.example.test",
  }));
} else {
  describe.skip("s3 storage driver (set S3_TEST_ENDPOINT to run)", () => {
    it("is skipped without a live endpoint", () => { expect(true).toBe(true); });
  });
}

describe("filesystem driver key validation", () => {
  it("refuses a key that is not a bare content hash", async () => {
    const driver = new FilesystemDriver(mkdtempSync(join(tmpdir(), "gl3-contract-")));

    // Traversal cannot reach the driver through the serve route — the Zod param
    // rejects it first — but the driver must not rely on that. Two layers,
    // because the day someone adds a second caller is the day the first layer
    // stops being the only one.
    await expect(driver.get("../../etc/passwd")).rejects.toThrow(/invalid asset key/);
    await expect(driver.put("nope", Buffer.from("x"), "image/png")).rejects.toThrow(/invalid asset key/);
  });
});
