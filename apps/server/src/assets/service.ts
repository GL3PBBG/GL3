import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../db/client.js";
import { assets, entityAssets } from "../db/schema/index.js";
import type { Tx } from "../economy/ledger.js";
import type { StorageDriver } from "./driver.js";
import { ACCEPTED_MIMES, hashBytes, identifyImage, type ImageMime } from "./image.js";

/**
 * Every write here works the same on a pooled connection or inside a caller's
 * transaction, and both are used: the upload route stores standalone, while a
 * plugin resolving art mid-change wants it on its own tx.
 */
export type DbOrTx = Db | Tx;

export const DEFAULT_MAX_BYTES = 524_288;
export const DEFAULT_MAX_DIMENSION = 2048;

export type AssetErrorCode =
  | "unsupported_media_type"
  | "empty_body"
  | "too_large"
  | "not_an_image"
  | "content_type_mismatch"
  | "dimensions_too_large";

export class AssetError extends Error {
  constructor(readonly code: AssetErrorCode, message: string) {
    super(message);
    this.name = "AssetError";
  }
}

export interface StoreAssetInput {
  bytes: Buffer;
  /** The `Content-Type` the caller declared. Checked AGAINST the bytes, never trusted. */
  declaredMime: string;
  uploadedBy: string | null;
  maxBytes: number;
  maxDimension: number;
}

export interface StoredAsset {
  id: string;
  sha256: string;
  mime: ImageMime;
  width: number;
  height: number;
  bytes: number;
  url: string;
  /** True when these exact bytes were already stored and no new row was written. */
  deduped: boolean;
}

/**
 * Validate, store and record one image.
 *
 * The write order is driver-then-database, and it is not arbitrary. A crash
 * between the two leaves an unreferenced object in the bucket, which the
 * sweeper collects and which nothing ever serves. The other order leaves a row
 * pointing at an object that does not exist — a broken image with no way to
 * tell it apart from a working one until a player loads the page.
 */
export async function storeAsset(
  db: DbOrTx,
  driver: StorageDriver,
  input: StoreAssetInput,
): Promise<StoredAsset> {
  if (input.bytes.length === 0) throw new AssetError("empty_body", "request body was empty");
  if (input.bytes.length > input.maxBytes) {
    throw new AssetError("too_large", `image is ${input.bytes.length} bytes, limit is ${input.maxBytes}`);
  }

  const declared = normaliseMime(input.declaredMime);
  if (declared === null) {
    throw new AssetError("unsupported_media_type", `content-type must be one of ${ACCEPTED_MIMES.join(", ")}`);
  }

  const info = identifyImage(input.bytes);
  if (info === null) throw new AssetError("not_an_image", "body is not a PNG, JPEG or WebP image");
  // The declared type must agree with what the bytes actually are. This is the
  // check that stops a renamed executable being stored and later served with an
  // attacker-chosen content type.
  if (info.mime !== declared) {
    throw new AssetError("content_type_mismatch", `declared ${declared} but the bytes are ${info.mime}`);
  }
  if (info.width > input.maxDimension || info.height > input.maxDimension) {
    throw new AssetError(
      "dimensions_too_large",
      `image is ${info.width}x${info.height}, limit is ${input.maxDimension} on either side`,
    );
  }

  const sha256 = hashBytes(input.bytes);
  await driver.put(sha256, input.bytes, info.mime);

  const [inserted] = await db
    .insert(assets)
    .values({
      id: uuidv7(),
      sha256,
      mime: info.mime,
      bytes: input.bytes.length,
      width: info.width,
      height: info.height,
      uploadedBy: input.uploadedBy,
    })
    .onConflictDoNothing({ target: assets.sha256 })
    .returning({ id: assets.id });

  if (inserted !== undefined) {
    return { id: inserted.id, sha256, mime: info.mime, width: info.width, height: info.height, bytes: input.bytes.length, url: driver.urlFor(sha256), deduped: false };
  }

  // Conflict: these exact bytes are already stored. Return the existing row
  // rather than a 409 — re-uploading the same art is a normal thing for an
  // admin to do (two items sharing a sprite), and it costs no storage.
  const [existing] = await db.select().from(assets).where(eq(assets.sha256, sha256)).limit(1);
  if (existing === undefined) {
    // Only reachable if the conflicting row was deleted between the insert and
    // this read. Vanishingly rare, and a plain retry is the honest answer.
    throw new AssetError("not_an_image", "asset row vanished during upload; retry");
  }
  return {
    id: existing.id,
    sha256,
    mime: info.mime,
    width: existing.width,
    height: existing.height,
    bytes: existing.bytes,
    url: driver.urlFor(sha256),
    deduped: true,
  };
}

function normaliseMime(raw: string): ImageMime | null {
  // `image/png; charset=binary` is legal and a proxy may add it.
  const base = raw.split(";")[0]?.trim().toLowerCase() ?? "";
  return ACCEPTED_MIMES.includes(base as ImageMime) ? (base as ImageMime) : null;
}

/** Bind an asset to a slot, replacing whatever was bound there. */
export async function bindAsset(
  db: DbOrTx,
  input: { scope: string; entityId: string; slot: string; assetId: string },
): Promise<void> {
  await db
    .insert(entityAssets)
    .values(input)
    .onConflictDoUpdate({
      target: [entityAssets.scope, entityAssets.entityId, entityAssets.slot],
      set: { assetId: input.assetId, boundAt: sql`now()` },
    });
}

/** Remove a binding. Unbinding an empty slot is a no-op, not an error. */
export async function unbindAsset(
  db: DbOrTx,
  input: { scope: string; entityId: string; slot: string },
): Promise<void> {
  await db.delete(entityAssets).where(and(
    eq(entityAssets.scope, input.scope),
    eq(entityAssets.entityId, input.entityId),
    eq(entityAssets.slot, input.slot),
  ));
}

/**
 * URLs for many entities at once, keyed by entity id.
 *
 * Batched by construction: this takes an array and there is deliberately no
 * single-id counterpart anywhere in the surface. A list page is the common
 * case, and a per-row lookup inside a `.map()` is an N+1 that would be
 * invisible until a location had forty items in it.
 *
 * An entity with no binding is simply absent from the Map — the caller renders
 * its placeholder. That is not an error condition: most rows have no art until
 * an admin uploads some.
 */
export async function resolveAssets(
  db: DbOrTx,
  driver: StorageDriver,
  scope: string,
  entityIds: readonly string[],
  slot: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (entityIds.length === 0) return out;
  const rows = await db
    .select({ entityId: entityAssets.entityId, sha256: assets.sha256 })
    .from(entityAssets)
    .innerJoin(assets, eq(assets.id, entityAssets.assetId))
    .where(and(
      eq(entityAssets.scope, scope),
      eq(entityAssets.slot, slot),
      inArray(entityAssets.entityId, [...new Set(entityIds)]),
    ));
  for (const row of rows) out.set(row.entityId, driver.urlFor(row.sha256));
  return out;
}

/**
 * Assets no `entity_assets` row references any more, oldest first.
 *
 * Deliberately a plain SELECT with no lock, matching the sentence sweeper: two
 * overlapping passes may pick the same row, and the DELETE is the claim.
 */
export async function findUnreferencedAssets(
  db: Db, limit: number, graceSeconds: number,
): Promise<{ id: string; sha256: string }[]> {
  return db
    .select({ id: assets.id, sha256: assets.sha256 })
    .from(assets)
    .where(and(
      notExists(
        db.select({ one: sql`1` }).from(entityAssets).where(eq(entityAssets.assetId, assets.id)),
      ),
      // The grace period is what makes this safe against the ordinary admin
      // flow. Upload and bind are two separate requests with a human between
      // them: without it, a sweep landing in that gap would delete the asset
      // the admin is about to bind, and the bind would then succeed against a
      // row that no longer exists. Anything younger than the grace is presumed
      // to be mid-flow.
      sql`${assets.createdAt} < now() - make_interval(secs => ${graceSeconds})`,
    ))
    .orderBy(assets.createdAt)
    .limit(limit);
}
