import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { assets, entityAssets, items } from "../src/db/schema/index.js";
import { bindAsset, storeAsset } from "../src/assets/service.js";
import { sweepOrphanedCoreBindings, sweepUnreferencedAssets } from "../src/assets/sweep.js";
import { makePng, testAssetDriver } from "./helpers/assets.js";
import { resetDb, testDb } from "./helpers/db.js";

const LIMITS = { maxBytes: 524_288, maxDimension: 2048 };

/** Backdate a row past the grace period without waiting an hour for it. */
async function age(db: Awaited<ReturnType<typeof testDb>>["db"], assetId: string): Promise<void> {
  await db.execute(sql`UPDATE assets SET created_at = now() - interval '2 hours' WHERE id = ${assetId}`);
}

// Per test, not per file: these assert on whole-table counts, and a leftover
// row from the previous test reads as a sweep or dedup bug that is not there.
beforeEach(async () => {
  const { db } = await testDb();
  await resetDb(db);
});

describe("sweepUnreferencedAssets", () => {
  it("collects an asset nothing references, removing the row and the object", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const stored = await storeAsset(db, driver, {
      bytes: makePng(8, 8), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    await age(db, stored.id);

    const { collected } = await sweepUnreferencedAssets(db, driver);

    expect(collected).toContain(stored.id);
    expect(await driver.get(stored.sha256)).toBeNull();
    expect(await db.select().from(assets)).toHaveLength(0);
  });

  it("leaves a bound asset alone", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const stored = await storeAsset(db, driver, {
      bytes: makePng(9, 9), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    await bindAsset(db, { scope: "core", entityId: uuidv7(), slot: "item", assetId: stored.id });
    await age(db, stored.id);

    const { collected } = await sweepUnreferencedAssets(db, driver);

    expect(collected).toEqual([]);
    expect(await driver.get(stored.sha256)).not.toBeNull();
  });

  it("leaves a freshly uploaded asset alone until the grace period passes", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    // Not aged: this is the upload-then-bind gap, with a human choosing an
    // entity in between. A sweep landing here must not delete the thing the
    // admin is halfway through binding.
    const stored = await storeAsset(db, driver, {
      bytes: makePng(10, 10), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });

    const { collected } = await sweepUnreferencedAssets(db, driver);

    expect(collected).toEqual([]);
    expect(await driver.get(stored.sha256)).not.toBeNull();
  });

  it("respects the batch limit so a backlog drains over several passes", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    for (let i = 0; i < 3; i += 1) {
      const stored = await storeAsset(db, driver, {
        bytes: makePng(2 + i, 2 + i), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
      });
      await age(db, stored.id);
    }

    expect((await sweepUnreferencedAssets(db, driver, 2)).collected).toHaveLength(2);
    expect((await sweepUnreferencedAssets(db, driver, 2)).collected).toHaveLength(1);
  });
});

describe("sweepOrphanedCoreBindings", () => {
  it("removes a binding whose core entity is gone, letting the asset be collected next pass", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const stored = await storeAsset(db, driver, {
      bytes: makePng(11, 11), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    const itemId = uuidv7();
    await db.insert(items).values({ id: itemId, name: "Doomed", itemType: "weapon", effects: {} });
    await bindAsset(db, { scope: "core", entityId: itemId, slot: "item", assetId: stored.id });
    await age(db, stored.id);

    // The asset survives while the item does: `entity_assets` has no foreign
    // key on `entity_id`, so nothing cascades and the sweep is the only thing
    // that will ever notice.
    expect((await sweepUnreferencedAssets(db, driver)).collected).toEqual([]);

    await db.delete(items);
    const { removed } = await sweepOrphanedCoreBindings(db);

    expect(removed).toBe(1);
    expect(await db.select().from(entityAssets)).toHaveLength(0);
    expect((await sweepUnreferencedAssets(db, driver)).collected).toContain(stored.id);
  });

  it("leaves a live item's binding alone", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const stored = await storeAsset(db, driver, {
      bytes: makePng(13, 13), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    const itemId = uuidv7();
    await db.insert(items).values({ id: itemId, name: "Kept", itemType: "weapon", effects: {} });
    await bindAsset(db, { scope: "core", entityId: itemId, slot: "item", assetId: stored.id });

    expect((await sweepOrphanedCoreBindings(db)).removed).toBe(0);
    expect(await db.select().from(entityAssets)).toHaveLength(1);
  });

  it("never touches a plugin scope, whose tables core cannot see", async () => {
    const { db } = await testDb();
    const driver = testAssetDriver();
    const stored = await storeAsset(db, driver, {
      bytes: makePng(14, 14), declaredMime: "image/png", uploadedBy: null, ...LIMITS,
    });
    // A `theft` binding pointing at nothing: core has no way to know, and the
    // documented contract is that it leaves plugin scopes entirely alone rather
    // than guessing.
    await bindAsset(db, { scope: "theft", entityId: uuidv7(), slot: "car", assetId: stored.id });

    expect((await sweepOrphanedCoreBindings(db)).removed).toBe(0);
    expect(await db.select().from(entityAssets)).toHaveLength(1);
  });
});
