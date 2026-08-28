import { and, eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { definePlugin, filterPoint, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";
import { propertiesTable, locations, players, playerStats, settings } from "./schema.js";
import { PROPERTIES_MIGRATIONS } from "./migrations.js";
import { adminPage } from "./pages.js";
import { seizeOnKill } from "./seizure.js";
import { readSkimPercent } from "./api.js";

export { ownerAt, payOwner, readSkimPercent, takeOverFrom, type PropertyOwnership } from "./api.js";
export { propertiesTable } from "./schema.js";

// ---------------------------------------------------------------------------
// Params schema — id in the path, validated by the loader via `params`.
// ---------------------------------------------------------------------------

const PropertyParamsSchema = z.object({ id: z.string().uuid() });

/** A bigint-safe amount on the wire: digits only, never a JSON number.
 *  Shared by the lever body and the admin create/update bodies. */
const NonNegativeIntegerString = z.string().regex(/^\d+$/, "nonnegative integer string");

// ---------------------------------------------------------------------------
// List route (read-only, no locks)
// ---------------------------------------------------------------------------

const listRoute = route({
  method: "GET",
  path: "/api/properties",
  accessInJail: true,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // The page is the town's property board, not the world's: only the
      // location the caller is standing in is listed. A property the caller
      // owns elsewhere is therefore NOT listed — its lever/transfer/drop/reset
      // routes still work (they are not location-gated), but reaching them
      // means travelling back. Deliberate.
      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      // `location_id` is nullable and a stats row can be missing; a player who
      // is nowhere sees no board rather than an error — this is a read, and
      // `buyRoute` already owns the 409 for acting without a location.
      const here = stats?.locationId ?? null;
      if (here === null) return { status: 200, body: { rows: [] } };

      const rows = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          pluginId: propertiesTable.pluginId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
          profit: propertiesTable.profit,
          locationName: locations.name,
          ownerName: players.username,
        })
        .from(propertiesTable)
        .leftJoin(locations, eq(locations.id, propertiesTable.locationId))
        .leftJoin(players, eq(players.id, propertiesTable.ownerPlayerId))
        .where(eq(propertiesTable.locationId, here));

      // One lookup per DECLARED TYPE, not per row: art belongs to the type, so
      // a town with four casinos in it still costs one read per type. The list
      // is the manifest registry, which is small and fixed at boot.
      const typeArt = new Map<string, string>();
      for (const decl of ctx.propertyTypes.list()) {
        const url = await ctx.assets.singleton(decl.id, "property");
        if (url !== null) typeArt.set(decl.id, url);
      }

      const realRows = rows.map((row) => {
        const decl = ctx.propertyTypes.get(row.pluginId);
        const isOwner = row.ownerPlayerId === player.id;
        return {
          id: row.id,
          locationId: row.locationId,
          locationName: row.locationName ?? "",
          pluginId: row.pluginId,
          typeName: decl?.name ?? row.pluginId,
          // "" when the type is not installed: there is no declared price,
          // so the row is not buyable and the page renders no Buy button.
          price: decl === null ? "" : decl.price.toString(),
          leverLabel: decl?.leverLabel ?? "",
          ownerName: row.ownerPlayerId ? (row.ownerName ?? "") : "—",
          // The lever and the P&L are the owner's business only.
          lever: isOwner ? row.cost.toString() : "",
          profit: isOwner ? row.profit.toString() : "",
          imageUrl: typeArt.get(row.pluginId) ?? "",
        };
      });

      // The row is created lazily on first purchase (see `buyRoute`), so a
      // franchise nobody has bought yet has no real row here and would
      // otherwise have no list entry and no Buy button — unreachable from
      // the UI. Synthesize one unowned row per (declared type × location)
      // pair the query above did not already return, so every buyable
      // franchise is listed even before its first sale.
      const covered = new Set(rows.map((row) => `${row.locationId}:${row.pluginId}`));
      const hereRows = await tx.db
        .select({ id: locations.id, name: locations.name })
        .from(locations)
        .where(eq(locations.id, here));
      const syntheticRows: (typeof realRows)[number][] = [];
      for (const decl of ctx.propertyTypes.list()) {
        for (const loc of hereRows) {
          if (covered.has(`${loc.id}:${decl.id}`)) continue;
          syntheticRows.push({
            // Composite, not a uuid — deliberately: nothing may treat this as
            // a real property row id. The page uses `row.id` only as a React
            // key, and buy posts `{ pluginId, locationId }` separately, so
            // this never reaches the server as an id.
            id: `${loc.id}:${decl.id}`,
            locationId: loc.id,
            locationName: loc.name,
            pluginId: decl.id,
            typeName: decl.name,
            price: decl.price.toString(),
            leverLabel: decl.leverLabel,
            ownerName: "—",
            lever: "",
            profit: "",
            imageUrl: typeArt.get(decl.id) ?? "",
          });
        }
      }

      return { status: 200, body: { rows: [...realRows, ...syntheticRows] } };
    });
  },
});

// ---------------------------------------------------------------------------
// Buy route
// ---------------------------------------------------------------------------

const BuyBodySchema = z.object({
  pluginId: z.string().min(1).max(80),
  locationId: z.string().uuid(),
}).strict();

/**
 * V2's `method_own()`, which lived in each consumer module (bullets, blackjack)
 * as copy-pasted code. GL3 keeps it here once: the price comes from the
 * consumer's `providesProperties` declaration, so a new franchise needs no new
 * buy route.
 *
 * The row is created lazily on first purchase, as V2 does — the table ships
 * empty. V2's insert races (two concurrent first-buys make two rows, since its
 * only key is PR_id); here the location lock is taken first, so the two
 * serialise and the second sees the row the first inserted.
 */
const buyRoute = route({
  method: "POST",
  path: "/api/properties/buy",
  accessInJail: false,
  accessInHospital: true,
  body: BuyBodySchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const decl = ctx.propertyTypes.get(body.pluginId);
    if (decl === null) throw new PluginError("unknown_property_type", 404);

    return ctx.transaction(async (tx) => {
      // RULE 6: location first, then player.
      await tx.locks.location(body.locationId);
      await tx.locks.player([player.id]);

      const [stats] = await tx.db
        .select({ locationId: playerStats.locationId, cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats === undefined) throw new PluginError("no_location", 409);
      if (stats.locationId !== body.locationId) throw new PluginError("wrong_location", 409);
      if (stats.cash < decl.price) throw new PluginError("insufficient_funds", 409);

      const [existing] = await tx.db
        .select({ id: propertiesTable.id, ownerPlayerId: propertiesTable.ownerPlayerId })
        .from(propertiesTable)
        .where(and(
          eq(propertiesTable.locationId, body.locationId),
          eq(propertiesTable.pluginId, body.pluginId),
        ))
        .for("update");
      if (existing !== undefined && existing.ownerPlayerId !== null) {
        // Including when the caller already owns it — buying your own is the
        // same error, as in the shipped route.
        throw new PluginError("already_owned", 409);
      }

      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: -decl.price,
        kind: "cash",
        reason: "properties.buy",
      });

      let propertyId: string;
      if (existing === undefined) {
        propertyId = uuidv7();
        await tx.db.insert(propertiesTable).values({
          id: propertyId,
          locationId: body.locationId,
          pluginId: body.pluginId,
          ownerPlayerId: player.id,
        });
      } else {
        propertyId = existing.id;
        // cost = 0: a new owner inherits no lever, matching V2's transfer().
        await tx.db
          .update(propertiesTable)
          .set({ ownerPlayerId: player.id, cost: 0n })
          .where(eq(propertiesTable.id, propertyId));
      }

      const [loc] = await tx.db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, body.locationId));

      await tx.events.publish({
        name: "bought",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: {
          typeName: decl.name,
          locationName: loc?.name ?? "",
          price: decl.price.toString(),
        },
      });

      return { status: 200, body: { propertyId } };
    });
  },
});

/**
 * Locks location → player, re-reads the row FOR UPDATE and verifies the caller
 * owns it. 404 for both "no such row" and "not yours" — 404-not-403 so a
 * property's existence is not probeable, the shipped convention.
 *
 * `alsoLock` names any OTHER players this route also needs locked (transfer's
 * target). RULE 6: the caller and every name in `alsoLock` go through this
 * ONE `tx.locks.player` call — `tx.locks.player` sorts and dedupes *within* a
 * call but has no memory across calls in the same transaction, so a caller
 * that took the caller's row here and then took a second, separate
 * `tx.locks.player` call later for a second player is two lock statements,
 * not one, and that is exactly what let A-transfers-to-B deadlock against
 * B-transfers-to-A (fixed; see `properties-lock-order.test.ts`).
 */
async function loadOwnedRow(
  tx: PluginTx, propertyId: string, playerId: string, alsoLock: readonly string[] = [],
): Promise<{ id: string; locationId: string; pluginId: string; cost: bigint; profit: bigint }> {
  const [before] = await tx.db
    .select({ locationId: propertiesTable.locationId })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId));
  if (before === undefined) throw new PluginError("property_not_found", 404);

  await tx.locks.location(before.locationId);
  await tx.locks.player([playerId, ...alsoLock]);

  const [row] = await tx.db
    .select({
      id: propertiesTable.id,
      locationId: propertiesTable.locationId,
      pluginId: propertiesTable.pluginId,
      ownerPlayerId: propertiesTable.ownerPlayerId,
      cost: propertiesTable.cost,
      profit: propertiesTable.profit,
    })
    .from(propertiesTable)
    .where(eq(propertiesTable.id, propertyId))
    .for("update");
  if (row === undefined) throw new PluginError("property_not_found", 404);
  if (row.ownerPlayerId !== playerId) throw new PluginError("not_owned", 404);
  return { id: row.id, locationId: row.locationId, pluginId: row.pluginId, cost: row.cost, profit: row.profit };
}

/** V2's `$100` floor on PR_cost — money bigints are whole dollars. */
const LEVER_FLOOR = 100n;

const LeverBodySchema = z.object({ value: NonNegativeIntegerString }).strict();

/**
 * A lever is whatever the declaring plugin says it is (a price per bullet, a
 * table limit), so only that plugin can say whether a figure is acceptable.
 * This point lets it refuse one: a subscriber throwing a `PluginError` aborts
 * the set, and returning the value unchanged accepts it. Shaped after
 * `combat.killResolved`, the first cross-plugin filter to ship.
 *
 * `bullets` is the first subscriber, enforcing V2's `maxBulletCost`.
 */
export interface LeverSet {
  propertyTypeId: string;
  propertyId: string;
  playerId: string;
  value: bigint;
}
export const leverSet = filterPoint<LeverSet>("properties.leverSet", "propagate");

/** V2's `method_cost`: the owner sets the consumer's local price or limit. */
const leverRoute = route({
  method: "POST",
  path: "/api/properties/:id/lever",
  accessInJail: true,
  accessInHospital: true,
  params: PropertyParamsSchema,
  body: LeverBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const value = BigInt(body.value);
    if (value < LEVER_FLOOR) throw new PluginError("lever_too_low", 400);

    // The declaring plugin's veto. Filters cannot join the caller's write
    // (spec: Filters), so the type is read in its own transaction first and
    // the chain runs between the two — a subscriber that throws stops the set
    // before anything is written. A row that is missing or not the caller's is
    // left to `loadOwnedRow` below, which owns those two errors.
    const [existing] = await ctx.transaction(async (tx) =>
      tx.db.select({ pluginId: propertiesTable.pluginId }).from(propertiesTable)
        .where(eq(propertiesTable.id, params.id)));
    if (existing) {
      await ctx.filters.apply(leverSet, {
        propertyTypeId: existing.pluginId, propertyId: params.id, playerId: player.id, value,
      });
    }

    await ctx.transaction(async (tx) => {
      const row = await loadOwnedRow(tx, params.id, player.id);
      await tx.db.update(propertiesTable).set({ cost: value }).where(eq(propertiesTable.id, row.id));
    });
    return { status: 204 };
  },
});

const TransferBodySchema = z.object({ username: z.string().min(1).max(64) }).strict();

/**
 * V2's `method_transfer`. Zeroes the lever on handover, as V2 does.
 *
 * RULE 6: this is a player↔player pair, and both players go through
 * `loadOwnedRow`'s ONE `tx.locks.player` call (via `alsoLock`) — that single
 * sorted, deduped statement is what makes A-transfers-to-B safe against
 * B-transfers-to-A. `target` is resolved from `players` (no lock needed for a
 * plain lookup) BEFORE `loadOwnedRow` runs, specifically so its id can be
 * folded into that one call rather than locked separately afterwards; a
 * second, later `tx.locks.player` call for the caller's row already held is
 * NOT a no-op across transactions — it is a second lock statement, and two
 * transactions taking their two statements in opposite orders is exactly an
 * ABBA cycle. A real 40P01 shipped from that shape once; do not reintroduce a
 * second player-lock call in this route.
 *
 * Consequence: `player_not_found` / `cannot_transfer_to_self` now resolve
 * before the property's own `property_not_found` / `not_owned` — verified
 * against every existing test, none of which relied on the old order.
 */
const transferRoute = route({
  method: "POST",
  path: "/api/properties/:id/transfer",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  body: TransferBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    await ctx.transaction(async (tx) => {
      const [target] = await tx.db
        .select({ id: players.id, username: players.username })
        .from(players)
        .where(eq(players.username, body.username));
      if (target === undefined) throw new PluginError("player_not_found", 404);
      if (target.id === player.id) throw new PluginError("cannot_transfer_to_self", 409);

      const row = await loadOwnedRow(tx, params.id, player.id, [target.id]);

      await tx.db
        .update(propertiesTable)
        .set({ ownerPlayerId: target.id, cost: 0n })
        .where(eq(propertiesTable.id, row.id));

      const [loc] = await tx.db
        .select({ name: locations.name }).from(locations).where(eq(locations.id, row.locationId));
      const decl = ctx.propertyTypes.get(row.pluginId);

      await tx.events.publish({
        name: "transferred",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: target.id },
        payload: { typeName: decl?.name ?? row.pluginId, locationName: loc?.name ?? "" },
      });
    });
    return { status: 204 };
  },
});

/** Half the declared price, rounded DOWN, and 0n for a type that is no longer
 *  installed — there is no declared price to halve, and a property row stores
 *  no record of what its owner paid. Exported so the page's warning and the
 *  route quote the same figure. */
export function dropRefund(price: bigint | null): bigint {
  return price === null ? 0n : price / 2n;
}

/** V2's `method_drop`/`method_dropDo` is a DELETE with NO refund; GL3 pays
 *  half the declared price back, so a franchise is a partial sink rather than
 *  a total loss. The row is kept and unowned rather than deleted, so its
 *  lifetime P&L survives its owners. The page warns first (`Properties.tsx`),
 *  but the refund is the server's figure — `dropRefund` above is the one
 *  definition both quote. */
const dropRoute = route({
  method: "POST",
  path: "/api/properties/:id/drop",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const refund = await ctx.transaction(async (tx) => {
      const row = await loadOwnedRow(tx, params.id, player.id);
      await tx.db
        .update(propertiesTable)
        .set({ ownerPlayerId: null, cost: 0n })
        .where(eq(propertiesTable.id, row.id));

      const [loc] = await tx.db
        .select({ name: locations.name }).from(locations).where(eq(locations.id, row.locationId));
      const decl = ctx.propertyTypes.get(row.pluginId);

      // Paid AFTER the row is unowned, inside the same transaction: the row is
      // already locked by `loadOwnedRow`, so nothing can buy it back and be
      // refunded twice. Rule 3 — one ledger row, bigint throughout.
      const paid = dropRefund(decl?.price ?? null);
      if (paid > 0n) {
        await tx.economy.applyBalanceChange({
          playerId: player.id, amount: paid, kind: "cash", reason: "properties.drop.refund",
        });
      }

      await tx.events.publish({
        name: "dropped",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: {
          typeName: decl?.name ?? row.pluginId,
          locationName: loc?.name ?? "",
          refund: paid.toString(),
        },
      });
      return paid;
    });
    return { status: 200, body: { refund: refund.toString() } };
  },
});

/** V2's `method_reset`: a stat reset. Moves no money and publishes nothing. */
const resetRoute = route({
  method: "POST",
  path: "/api/properties/:id/reset",
  accessInJail: true,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    await ctx.transaction(async (tx) => {
      const row = await loadOwnedRow(tx, params.id, player.id);
      await tx.db.update(propertiesTable).set({ profit: 0n }).where(eq(propertiesTable.id, row.id));
    });
    return { status: 204 };
  },
});

// ---------------------------------------------------------------------------
// Event declarations
// ---------------------------------------------------------------------------

// Re-exported so test/plugin-manifest-endpoint.test.ts can assert against
// the same page object rather than a hand-copied duplicate of its view tree,
// which would silently drift if pages.ts changed.
export { adminPage } from "./pages.js";

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

/**
 * The page renderer posts every field in a form, sending "" for the ones the
 * admin left blank (`PageRenderer.tsx`'s form `onSubmit`). Blank is
 * normalised to `undefined` here so an update that only changes one column
 * leaves every other column untouched — the theft convention, reused.
 */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

/**
 * Extracts a Postgres error code (`err.code` directly, or `err.cause.code`
 * for a driver that wraps it), or null if `err` carries none. Generalised
 * from the old `isUniqueViolation` so the create route can also translate
 * `23503` (foreign-key violation, an unknown `locationId`) instead of
 * letting it fall through to an unhandled 500.
 */
function pgErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  if (
    err instanceof Error &&
    err.cause !== null &&
    typeof err.cause === "object" &&
    err.cause !== undefined &&
    "code" in err.cause &&
    typeof (err.cause as { code: unknown }).code === "string"
  ) {
    return (err.cause as { code: string }).code;
  }
  return null;
}

const PropertyCreateSchema = z
  .object({
    locationId: z.string().uuid(),
    pluginId: z.string().min(1).max(80),
    cost: NonNegativeIntegerString,
  })
  .strict();

const PropertyUpdateSchema = z
  .object({
    id: z.string().uuid(),
    pluginId: blankable(z.string().min(1).max(80)),
    cost: NonNegativeIntegerString,
  })
  .strict();

/**
 * Every location as a TableRowsResponse — the create form's select
 * `optionsSource`. It no longer filters out locations that already have a
 * property: since `0004_location_plugin_unique` the key is
 * (location_id, plugin_id), so a town with one type can still take another.
 * The 409 `location_type_taken` guard on the create route is what rejects a
 * genuine duplicate.
 */
const adminLocationsRoute = route({
  method: "GET",
  path: "/api/admin/properties/locations",
  auth: "admin",
  handler: async (ctx) => {
    return ctx.transaction(async (tx) => {
      const rows = (await tx.db.select({ id: locations.id, name: locations.name }).from(locations))
        .map((loc) => ({ locationId: loc.id, locationName: loc.name }));
      return { status: 200, body: { rows } };
    });
  },
});

/**
 * Every property type any installed plugin declares, as a TableRowsResponse —
 * the create form's select `optionsSource`. `pluginId` is the select's
 * `valueKey`; the human `name` is what an admin sees, so nobody types a plugin
 * id by hand any more.
 */
const adminTypesRoute = route({
  method: "GET",
  path: "/api/admin/properties/types",
  auth: "admin",
  handler: async (ctx) => {
    const rows = ctx.propertyTypes.list().map((decl) => ({
      pluginId: decl.id,
      name: decl.name,
      price: decl.price.toString(),
      leverLabel: decl.leverLabel,
    }));
    return { status: 200, body: { rows } };
  },
});

/**
 * Existing properties only, as a TableRowsResponse. `id` is the update
 * form's select `valueKey` — it must resolve to a real property, or an
 * admin picking a location-with-no-property row would submit `id: ""` and
 * get a bare 400 from `PropertyUpdateSchema` with no indication why. A
 * location that has no property simply does not appear here; use
 * `/api/admin/properties/locations` to find those. Not rendered as a
 * table column.
 */
const adminListRoute = route({
  method: "GET",
  path: "/api/admin/properties",
  auth: "admin",
  handler: async (ctx) => {
    return ctx.transaction(async (tx) => {
      const props = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          pluginId: propertiesTable.pluginId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
          profit: propertiesTable.profit,
          locationName: locations.name,
          ownerName: players.username,
        })
        .from(propertiesTable)
        .leftJoin(locations, eq(locations.id, propertiesTable.locationId))
        .leftJoin(players, eq(players.id, propertiesTable.ownerPlayerId));

      const rows = props.map((p) => {
        const decl = ctx.propertyTypes.get(p.pluginId);
        return {
          id: p.id,
          locationId: p.locationId,
          locationName: p.locationName ?? "",
          plugin: p.pluginId,
          // The update form's select label — since 0004_location_plugin_unique
          // a town can hold several rows, so `locationName` alone (the old
          // label, from the one-row-per-town era) is no longer unique enough
          // for an admin to tell them apart.
          label: `${p.locationName ?? ""} — ${decl?.name ?? p.pluginId}`,
          ownerName: p.ownerPlayerId ? (p.ownerName ?? "") : "",
          cost: p.cost.toString(),
          profit: p.profit.toString(),
        };
      });

      return { status: 200, body: { rows } };
    });
  },
});

const adminCreateRoute = route({
  method: "POST",
  path: "/api/admin/properties",
  auth: "admin",
  body: PropertyCreateSchema,
  // The INSERT takes FOR KEY SHARE on locations[L] via the location_id FK
  // and acquires nothing afterwards (rule 6) — it cannot be half of a
  // deadlock cycle with buy's or loadOwnedRow's locations-then-player
  // order, the same reasoning as adminUpdateRoute below.
  handler: async (ctx, { body }) => {
    if (ctx.propertyTypes.get(body.pluginId) === null) {
      throw new PluginError("unknown_property_type", 404);
    }
    const id = uuidv7();
    try {
      await ctx.transaction(async (tx) => {
        await tx.db.insert(propertiesTable).values({
          id,
          locationId: body.locationId,
          pluginId: body.pluginId,
          cost: BigInt(body.cost),
        });
      });
    } catch (err: unknown) {
      const code = pgErrorCode(err);
      // unique(location_id, plugin_id) violation → this town already has a
      // property of this type.
      if (code === "23505") throw new PluginError("location_type_taken", 409);
      // location_id FK violation (unknown locationId) → 404
      if (code === "23503") throw new PluginError("location_not_found", 404);
      throw err;
    }
    return { status: 201, body: { id } };
  },
});

const adminUpdateRoute = route({
  method: "POST",
  path: "/api/admin/properties/update",
  auth: "admin",
  body: PropertyUpdateSchema,
  handler: async (ctx, { body }) => {
    if (body.pluginId !== undefined && ctx.propertyTypes.get(body.pluginId) === null) {
      throw new PluginError("unknown_property_type", 404);
    }
    // The property editor selects FOR UPDATE on exactly one
    // p_properties_properties row and locks nothing else. A transaction
    // holding exactly one lock cannot be half of a deadlock cycle, which is
    // why this route introduces no new deadlock edge — do not grow a second
    // lock in this route.
    let updated: boolean;
    try {
      updated = await ctx.transaction(async (tx) => {
        const [existing] = await tx.db
          .select()
          .from(propertiesTable)
          .where(eq(propertiesTable.id, body.id))
          .for("update");
        if (existing === undefined) return false;
        await tx.db
          .update(propertiesTable)
          .set({
            cost: BigInt(body.cost),
            ...(body.pluginId !== undefined && { pluginId: body.pluginId }),
          })
          .where(eq(propertiesTable.id, body.id));
        return true;
      });
    } catch (err: unknown) {
      // unique(location_id, plugin_id) violation → retyping this row to a
      // type its location already has, same as adminCreateRoute's guard.
      if (pgErrorCode(err) === "23505") throw new PluginError("location_type_taken", 409);
      throw err;
    }
    if (!updated) throw new PluginError("property_not_found", 404);
    return { status: 204 };
  },
});

const adminDeleteRoute = route({
  method: "DELETE",
  path: "/api/admin/properties/:id",
  auth: "admin",
  params: z.object({ id: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    // Same one-row FOR UPDATE shape as adminUpdateRoute above — one lock,
    // no second acquisition, no new deadlock edge.
    const outcome = await ctx.transaction(async (tx) => {
      const [existing] = await tx.db
        .select({ id: propertiesTable.id, ownerPlayerId: propertiesTable.ownerPlayerId })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id))
        .for("update");
      if (existing === undefined) return "not_found" as const;
      // An owned deed is a player's asset (they paid the declared price for
      // it) — refused, the item_in_use shape. Disown it first: the admin
      // update path or the owner's own drop makes the dispossession a
      // deliberate act. An UNOWNED row is pure config and simply goes;
      // a casino session still pinned to it settles as against an unowned
      // house (`ownerAt` finds no owner), which cannot go bankrupt.
      if (existing.ownerPlayerId !== null) return "owned" as const;
      await tx.db.delete(propertiesTable).where(eq(propertiesTable.id, params.id));
      return "ok" as const;
    });
    if (outcome === "not_found") throw new PluginError("property_not_found", 404);
    if (outcome === "owned") throw new PluginError("property_owned", 409);
    return { status: 204 };
  },
});

// ---------------------------------------------------------------------------
// Event declarations (cont.)
// ---------------------------------------------------------------------------

const boughtEvent = {
  name: "bought",
  payload: z.object({ typeName: z.string(), locationName: z.string(), price: z.string() }),
  describe: "{actorName} bought the {typeName} in {locationName} for {price}",
  invalidates: ["properties", "me"],
};

const droppedEvent = {
  name: "dropped",
  payload: z.object({ typeName: z.string(), locationName: z.string(), refund: z.string() }),
  describe: "{actorName} dropped the {typeName} in {locationName} for {refund} back",
  invalidates: ["properties", "me"],
};

const transferredEvent = {
  name: "transferred",
  payload: z.object({ typeName: z.string(), locationName: z.string() }),
  describe: "{actorName} transferred the {typeName} in {locationName} to you",
  invalidates: ["properties", "me"],
};

// ---------------------------------------------------------------------------
// Admin settings — the skim knob. Reads and writes the settings TABLE, not
// the boot snapshot, and payOwner reads it live too, so an edit applies
// WITHOUT a restart — the one knob in this plugin that does, and the panel
// says so out loud.
// ---------------------------------------------------------------------------

const SkimSettingsBodySchema = z.object({
  // The admin form serialises every field as a string (PageRenderer.tsx's
  // `body: Record<string, string>`), so this coerces.
  skim_percent: z.coerce.number().int().min(0).max(100),
}).strict();

const adminSettingsListRoute = route({
  method: "GET", path: "/api/admin/properties/settings", auth: "admin",
  handler: async (ctx) => {
    // The effective value through the same parse payOwner uses, defaults
    // included, so the panel shows what the next credit will actually skim.
    const effective = await ctx.transaction((tx) => readSkimPercent(tx));
    return {
      status: 200,
      body: { rows: [{ key: "skim_percent", label: "Skim percent of owner income (0–100)", value: String(effective) }] },
    };
  },
});

const adminSettingsWriteRoute = route({
  method: "POST", path: "/api/admin/properties/settings", auth: "admin",
  body: SkimSettingsBodySchema,
  handler: async (ctx, { body }) => {
    await ctx.transaction(async (tx) => {
      await tx.db.insert(settings)
        .values({ key: "properties.skim_percent", value: String(body.skim_percent) })
        .onConflictDoUpdate({ target: settings.key, set: { value: String(body.skim_percent) } });
    });
    return { status: 204 };
  },
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export default definePlugin({
  id: "properties",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/properties", "/api/admin/properties"],
  // Real import dependencies (see this package's package.json) —
  // enforced against the final boot set by plugins/validate.ts.
  requires: ["combat"],
  tables: {
    properties: "p_properties_properties",
  },
  migrations: PROPERTIES_MIGRATIONS,
  routes: [
    listRoute, buyRoute, leverRoute, transferRoute, dropRoute, resetRoute,
    adminListRoute, adminLocationsRoute, adminTypesRoute, adminCreateRoute, adminUpdateRoute, adminDeleteRoute,
    adminSettingsListRoute, adminSettingsWriteRoute,
  ],
  events: [boughtEvent, droppedEvent, transferredEvent],
  pages: [],
  adminPages: [adminPage],
  filters: [seizeOnKill],
});
