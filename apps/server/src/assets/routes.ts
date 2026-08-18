import { hasPermission, type AssetSlot } from "@gl3/plugin-sdk";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { loadGrants } from "../plugins/routes.js";
import { CORE_SCOPE, slotKey } from "../plugins/asset-slots.js";
import { items, locations, ranks } from "../db/schema/index.js";
import type { StorageDriver } from "./driver.js";
import { ACCEPTED_MIMES } from "./image.js";
import {
  AssetError, bindAsset, DEFAULT_MAX_BYTES, DEFAULT_MAX_DIMENSION, storeAsset, unbindAsset,
} from "./service.js";

/**
 * The three core-owned tables that carry art, paired with the column an admin
 * recognises them by. Order fixed here rather than derived, so the section's
 * three pickers always appear the same way round.
 */
const CORE_ENTITY_SOURCES = [
  ["items", items, items.name],
  ["locations", locations, locations.name],
  ["ranks", ranks, ranks.name],
] as const;

/** The content hash, and nothing else. */
const KeyParamsSchema = z.object({ key: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

const BindBodySchema = z.object({
  scope: z.string().min(1),
  entityId: z.string().uuid(),
  slot: z.string().min(1),
  /** Null unbinds. A slot with nothing in it is a normal state, not an error. */
  assetId: z.string().uuid().nullable(),
}).strict();

/** Which `AssetError` maps to which status. Everything else is a 500 and should be. */
const STATUS_BY_CODE: Record<string, number> = {
  unsupported_media_type: 415,
  empty_body: 400,
  too_large: 413,
  not_an_image: 400,
  content_type_mismatch: 400,
  dimensions_too_large: 413,
};

export interface AssetRouteDeps {
  db: Db;
  driver: StorageDriver;
  settings: Record<string, string>;
  /** The loader's registry, keyed by `slotKey`. Binding validates against it. */
  assetSlots: ReadonlyMap<string, AssetSlot>;
}

export function registerAssetRoutes(app: FastifyInstance, deps: AssetRouteDeps): void {
  // Explicit per-type parsers. app.ts registers a catch-all `*` parser that
  // reads every unclaimed media type as a STRING — which would corrupt image
  // bytes silently, since a Buffer round-tripped through utf-8 is not the same
  // Buffer. Fastify prefers the most specific parser, so naming the three types
  // here is what keeps binary binary.
  for (const mime of ACCEPTED_MIMES) {
    app.addContentTypeParser(mime, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  }

  const maxBytes = numberSetting(deps.settings, "assets.max_bytes", DEFAULT_MAX_BYTES);
  const maxDimension = numberSetting(deps.settings, "assets.max_dimension", DEFAULT_MAX_DIMENSION);

  /**
   * Upload. Core rather than a plugin route because plugin routes take a
   * Zod-parsed JSON body, and pushing binary through that contract would drag
   * multipart handling into the SDK for every plugin that ever wants a picture.
   *
   * `auth: "admin"` in spirit — any grant will do here, because uploading bytes
   * that nothing references yet is inert; it is BINDING that needs the
   * scope-specific permission below. The sweeper collects anything uploaded and
   * never bound.
   */
  app.post("/api/admin/assets", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
    const grants = await loadGrants(deps.db, playerId);
    if (grants.length === 0) return reply.code(403).send({ error: "forbidden" });

    if (!Buffer.isBuffer(request.body)) {
      return reply.code(415).send({ error: "unsupported_media_type" });
    }

    try {
      const stored = await storeAsset(deps.db, deps.driver, {
        bytes: request.body,
        declaredMime: request.headers["content-type"] ?? "",
        uploadedBy: playerId,
        maxBytes,
        maxDimension,
      });
      return reply.code(201).send({
        assetId: stored.id,
        url: stored.url,
        width: stored.width,
        height: stored.height,
        bytes: stored.bytes,
        deduped: stored.deduped,
      });
    } catch (error) {
      if (error instanceof AssetError) {
        return reply.code(STATUS_BY_CODE[error.code] ?? 400).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /** Bind (or with a null `assetId`, unbind) an asset to one entity's slot. */
  app.put("/api/admin/assets/bind", { preHandler: [app.requireAuth] }, async (request, reply) => {
    const playerId = request.playerId;
    if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });

    const body = BindBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request" });

    // An undeclared slot is a 400, not a silently orphaned row: `entity_assets`
    // has no foreign key to check it, so this registry lookup is the ONLY thing
    // standing between a typo and a binding nothing will ever read.
    if (!deps.assetSlots.has(slotKey(body.data.scope, body.data.slot))) {
      return reply.code(400).send({ error: "unknown_slot" });
    }

    // Scoped, not blanket: the `travel` grant sets town art and cannot touch
    // item art. `*` still passes, as it does everywhere else.
    const grants = await loadGrants(deps.db, playerId);
    if (!hasPermission(grants, body.data.scope)) return reply.code(403).send({ error: "forbidden" });

    if (body.data.assetId === null) {
      await unbindAsset(deps.db, body.data);
      return reply.send({ bound: false });
    }
    await bindAsset(deps.db, { ...body.data, assetId: body.data.assetId });
    return reply.send({ bound: true });
  });

  // Entity pickers for core's own art section. Core routes, so they are not
  // subject to any plugin's basePath containment — and they exist at all
  // because `items`, `locations` and `ranks` are core-owned tables no plugin
  // may enumerate on core's behalf.
  for (const [name, table, label] of CORE_ENTITY_SOURCES) {
    app.get(`/api/admin/assets/entities/${name}`, { preHandler: [app.requireAuth] }, async (request, reply) => {
      const playerId = request.playerId;
      if (playerId === undefined) return reply.code(401).send({ error: "unauthorized" });
      const grants = await loadGrants(deps.db, playerId);
      if (!hasPermission(grants, CORE_SCOPE)) return reply.code(403).send({ error: "forbidden" });
      const rows = await deps.db.select({ id: table.id, name: label }).from(table).orderBy(label);
      return reply.send({ rows });
    });
  }

  /**
   * Serve, filesystem driver only — with `ASSET_DRIVER=s3` the browser fetches
   * from the CDN and never reaches this route. Public: art is not secret, and
   * putting auth in front of an `<img>` would defeat caching for no gain.
   *
   * The param is validated as a 64-character hex string, which makes path
   * traversal structurally impossible rather than sanitised away — `..` cannot
   * match the pattern, so no driver ever sees it.
   */
  app.get("/assets/:key", async (request, reply) => {
    const params = KeyParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_request" });
    const bytes = await deps.driver.get(params.data.key);
    if (bytes === null) return reply.code(404).send({ error: "not_found" });
    // The key IS the content hash, so this object can never change and the
    // header can never be wrong.
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("etag", `"${params.data.key}"`);
    // Sniffed rather than stored: the bytes were validated at upload, and one
    // read of the magic number here beats a database round trip per image.
    reply.header("content-type", sniffMime(bytes));
    return reply.send(bytes);
  });
}

function sniffMime(bytes: Buffer): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "image/webp";
}

function numberSetting(settings: Record<string, string>, key: string, fallback: number): number {
  const raw = settings[key];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  // A malformed setting falls back rather than throwing at boot: an admin
  // typo in one limit must not take the whole server down, and the default is
  // the conservative direction.
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
