import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { assets, entityAssets } from "../src/db/schema/index.js";
import { hashBytes } from "../src/assets/image.js";
import {
  AssetError, bindAsset, resolveAssets, storeAsset, unbindAsset,
} from "../src/assets/service.js";
import { makeJpeg, makePng, testAssetDriver } from "./helpers/assets.js";
import { resetDb, testDb } from "./helpers/db.js";

const LIMITS = { maxBytes: 524_288, maxDimension: 2048 };

// Per test, not per file: these assert on whole-table counts, and a leftover
// row from the previous test reads as a sweep or dedup bug that is not there.
beforeEach(async () => {
  const { db } = await testDb();
  await resetDb(db);
});

describe("storeAsset", () => {
  it("stores the bytes under their hash and records the row", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const png = makePng(16, 16);

    const stored = await storeAsset(db, driver, {
      bytes: png, declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });

    expect(stored.sha256).toBe(hashBytes(png));
    expect(stored).toMatchObject({ mime: "image/png", width: 16, height: 16, deduped: false });
    // The object is really on disk, not merely recorded as being there.
    expect(await driver.get(stored.sha256)).toEqual(png);
  });

  it("returns the existing row when the same bytes are uploaded twice", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const png = makePng(8, 8);
    const first = await storeAsset(db, driver, {
      bytes: png, declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });

    const second = await storeAsset(db, driver, {
      bytes: png, declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });

    // Content-addressed storage makes a re-upload free rather than a conflict:
    // two items sharing one sprite is a normal thing for an admin to do.
    expect(second.id).toBe(first.id);
    expect(second.deduped).toBe(true);
    const rows = await db.select().from(assets).where(eq(assets.sha256, first.sha256));
    expect(rows).toHaveLength(1);
  });

  it("refuses bytes whose real format contradicts the declared content-type", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();

    // The whole point of sniffing: a caller that says `image/png` and sends
    // something else must not get its chosen content-type stored and echoed
    // back by the serve route later.
    await expect(storeAsset(db, driver, {
      bytes: makeJpeg(10, 10), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    })).rejects.toMatchObject({ code: "content_type_mismatch" });
  });

  it("refuses a payload that is not an image at all", async () => {
    const { db } = await testDb();

    await expect(storeAsset(db, testAssetDriver(), {
      bytes: Buffer.from("<?php system($_GET['c']); ?>"), declaredMime: "image/png",
      uploadedBy: null, ...LIMITS,
    })).rejects.toBeInstanceOf(AssetError);
  });

  it("refuses a body over the size limit before touching storage", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const png = makePng(64, 64);

    await expect(storeAsset(db, driver, {
      bytes: png, declaredMime: "image/png", uploadedBy: null, maxBytes: 10, maxDimension: 2048,
    })).rejects.toMatchObject({ code: "too_large" });

    // Nothing was written: the size check runs before the driver call, so an
    // oversized upload cannot leave an object behind for the sweeper.
    expect(await driver.get(hashBytes(png))).toBeNull();
  });

  it("refuses an image whose dimensions exceed the limit", async () => {
    const { db } = await testDb();

    await expect(storeAsset(db, testAssetDriver(), {
      bytes: makePng(100, 40), declaredMime: "image/png", uploadedBy: null,
      maxBytes: 524_288, maxDimension: 64,
    })).rejects.toMatchObject({ code: "dimensions_too_large" });
  });

  it("refuses an empty body", async () => {
    const { db } = await testDb();

    await expect(storeAsset(db, testAssetDriver(), {
      bytes: Buffer.alloc(0), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    })).rejects.toMatchObject({ code: "empty_body" });
  });
});

describe("bindAsset / resolveAssets", () => {
  it("resolves many entities in one call and omits the ones with no art", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const stored = await storeAsset(db, driver, {
      bytes: makePng(12, 12), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    const bound = uuidv7();
    const unbound = uuidv7();
    await bindAsset(db, { scope: "core", entityId: bound, slot: "item", assetId: stored.id });

    const urls = await resolveAssets(db, driver, "core", [bound, unbound], "item");

    expect(urls.get(bound)).toBe(driver.urlFor(stored.sha256));
    // Absent, not null and not a placeholder string: "no art yet" is the normal
    // state of most rows, and the renderer owns what to show for it.
    expect(urls.has(unbound)).toBe(false);
  });

  it("keeps scopes apart, so one plugin's slot cannot answer for another's", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const stored = await storeAsset(db, driver, {
      bytes: makePng(12, 12), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    const entityId = uuidv7();
    await bindAsset(db, { scope: "theft", entityId, slot: "car", assetId: stored.id });

    expect((await resolveAssets(db, driver, "core", [entityId], "car")).size).toBe(0);
    expect((await resolveAssets(db, driver, "theft", [entityId], "car")).size).toBe(1);
  });

  it("replaces the binding rather than accumulating rows", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const first = await storeAsset(db, driver, {
      bytes: makePng(4, 4), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    const second = await storeAsset(db, driver, {
      bytes: makePng(5, 5), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    const entityId = uuidv7();

    await bindAsset(db, { scope: "core", entityId, slot: "item", assetId: first.id });
    await bindAsset(db, { scope: "core", entityId, slot: "item", assetId: second.id });

    const urls = await resolveAssets(db, driver, "core", [entityId], "item");
    expect(urls.get(entityId)).toBe(driver.urlFor(second.sha256));
    expect(await db.select().from(entityAssets)).toHaveLength(1);
  });

  it("unbinds, and unbinding an empty slot is a no-op", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const stored = await storeAsset(db, driver, {
      bytes: makePng(4, 4), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    const entityId = uuidv7();
    await bindAsset(db, { scope: "core", entityId, slot: "item", assetId: stored.id });

    await unbindAsset(db, { scope: "core", entityId, slot: "item" });
    await expect(unbindAsset(db, { scope: "core", entityId, slot: "item" })).resolves.toBeUndefined();

    expect((await resolveAssets(db, driver, "core", [entityId], "item")).size).toBe(0);
  });

  it("returns an empty map for an empty id list without querying", async () => {
    const { db } = await testDb();

    expect((await resolveAssets(db, testAssetDriver(), "core", [], "item")).size).toBe(0);
  });
});
