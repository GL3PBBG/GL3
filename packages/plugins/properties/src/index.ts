import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { propertiesTable, locations, players, playerStats } from "./schema.js";
import { PROPERTIES_MIGRATIONS } from "./migrations.js";
import { readPropertiesSettings } from "./settings.js";
import { accruedSince } from "./resolve.js";
import { adminPage } from "./pages.js";

// Re-exported so tests can import the parser and types directly.
export { readPropertiesSettings, type PropertiesSettings } from "./settings.js";
export { accruedSince } from "./resolve.js";

// ---------------------------------------------------------------------------
// Params schema — id in the path, validated by the loader via `params`.
// ---------------------------------------------------------------------------

const PropertyParamsSchema = z.object({ id: z.string().uuid() });

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
    const config = readPropertiesSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      const rows = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          pluginId: propertiesTable.pluginId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
          rate: propertiesTable.rate,
          lastClaimedAt: propertiesTable.lastClaimedAt,
          locationName: locations.name,
          ownerName: players.username,
        })
        .from(propertiesTable)
        .leftJoin(locations, eq(locations.id, propertiesTable.locationId))
        .leftJoin(players, eq(players.id, propertiesTable.ownerPlayerId));

      const now = new Date();
      return {
        status: 200,
        body: {
          rows: rows.map((row) => {
            const isOwner = row.ownerPlayerId === player.id;
            const accrued = isOwner
              ? accruedSince(row.lastClaimedAt, row.rate, config.income.cap, now)
              : 0n;
            return {
              id: row.id,
              locationName: row.locationName ?? "",
              pluginId: row.pluginId,
              rate: row.rate.toString(),
              ownerName: row.ownerPlayerId ? (row.ownerName ?? "") : "—",
              cost: row.cost.toString(),
              accrued: accrued.toString(),
            };
          }),
        },
      };
    });
  },
});

// ---------------------------------------------------------------------------
// Buy route
// ---------------------------------------------------------------------------

const buyRoute = route({
  method: "POST",
  path: "/api/properties/:id/buy",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Unlocked read, only to learn WHICH row (and location) we act on.
      const [before] = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
        })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id));
      if (before === undefined) throw new PluginError("property_not_found", 404);

      // RULE 6: location first, then player — the established order for the
      // location↔player pair (travel/bullets deadlock).
      await tx.locks.location(before.locationId);
      await tx.locks.player([player.id]);

      // Lock-then-recheck (TOCTOU).
      const [row] = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
        })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id))
        .for("update");
      if (row === undefined) throw new PluginError("property_not_found", 404);
      if (row.ownerPlayerId !== null) throw new PluginError("already_owned", 409);

      const [stats] = await tx.db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (stats === undefined || stats.cash < row.cost) {
        throw new PluginError("insufficient_funds", 409);
      }

      const now = new Date();
      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: -row.cost,
        kind: "cash",
        reason: "properties.buy",
      });
      await tx.db
        .update(propertiesTable)
        .set({ ownerPlayerId: player.id, lastClaimedAt: now })
        .where(eq(propertiesTable.id, row.id));

      // Fetch the location name for the event payload under the same tx.
      const [loc] = await tx.db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, row.locationId));

      await tx.events.publish({
        name: "bought",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { propertyName: loc?.name ?? "", cost: row.cost.toString() },
      });

      return { status: 200, body: { propertyId: row.id } };
    });
  },
});

// ---------------------------------------------------------------------------
// Sell route
// ---------------------------------------------------------------------------

const sellRoute = route({
  method: "POST",
  path: "/api/properties/:id/sell",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readPropertiesSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      // Unlocked read, only to learn WHICH row (and location) we act on.
      const [before] = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
        })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id));
      if (before === undefined) throw new PluginError("property_not_found", 404);

      await tx.locks.location(before.locationId);
      await tx.locks.player([player.id]);

      // Lock-then-recheck.
      const [row] = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
          lastClaimedAt: propertiesTable.lastClaimedAt,
          rate: propertiesTable.rate,
          profit: propertiesTable.profit,
        })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id))
        .for("update");
      if (row === undefined) throw new PluginError("property_not_found", 404);
      if (row.ownerPlayerId !== player.id) throw new PluginError("not_owned", 404);

      const now = new Date();
      const accrued = accruedSince(row.lastClaimedAt, row.rate, config.income.cap, now);
      const payout = row.cost + accrued;

      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: payout,
        kind: "cash",
        reason: "properties.sell",
      });
      await tx.db
        .update(propertiesTable)
        .set({
          ownerPlayerId: null,
          lastClaimedAt: null,
          profit: sql`${propertiesTable.profit} + ${accrued}`,
        })
        .where(eq(propertiesTable.id, row.id));

      // Fetch the location name for the event payload.
      const [loc] = await tx.db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, row.locationId));

      await tx.events.publish({
        name: "sold",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { propertyName: loc?.name ?? "", payout: payout.toString() },
      });

      return { status: 200, body: { payout: payout.toString() } };
    });
  },
});

// ---------------------------------------------------------------------------
// Claim route
// ---------------------------------------------------------------------------

const claimRoute = route({
  method: "POST",
  path: "/api/properties/:id/claim",
  accessInJail: false,
  accessInHospital: true,
  params: PropertyParamsSchema,
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readPropertiesSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      // Unlocked read, only to learn WHICH row (and location) we act on.
      const [before] = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
        })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id));
      if (before === undefined) throw new PluginError("property_not_found", 404);

      await tx.locks.location(before.locationId);
      await tx.locks.player([player.id]);

      // Lock-then-recheck.
      const [row] = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          lastClaimedAt: propertiesTable.lastClaimedAt,
          rate: propertiesTable.rate,
          profit: propertiesTable.profit,
        })
        .from(propertiesTable)
        .where(eq(propertiesTable.id, params.id))
        .for("update");
      if (row === undefined) throw new PluginError("property_not_found", 404);
      if (row.ownerPlayerId !== player.id) throw new PluginError("not_owned", 404);

      const now = new Date();
      const accrued = accruedSince(row.lastClaimedAt, row.rate, config.income.cap, now);

      // Zero-claim: return immediately, do NOT touch last_claimed_at.
      if (accrued === 0n) {
        return { status: 200, body: { claimed: "0" } };
      }

      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: accrued,
        kind: "cash",
        reason: "properties.income",
      });
      await tx.db
        .update(propertiesTable)
        .set({
          lastClaimedAt: now,
          profit: sql`${propertiesTable.profit} + ${accrued}`,
        })
        .where(eq(propertiesTable.id, row.id));

      // Fetch the location name for the event payload.
      const [loc] = await tx.db
        .select({ name: locations.name })
        .from(locations)
        .where(eq(locations.id, row.locationId));

      await tx.events.publish({
        name: "income",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { propertyName: loc?.name ?? "", amount: accrued.toString() },
      });

      return { status: 200, body: { claimed: accrued.toString() } };
    });
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

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");

/**
 * The page renderer posts every field in a form, sending "" for the ones the
 * admin left blank (`PageRenderer.tsx`'s form `onSubmit`). Blank is
 * normalised to `undefined` here so an update that only changes one column
 * leaves every other column untouched — the theft convention, reused.
 */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505") return true;
  if (err instanceof Error && err.cause !== null && typeof err.cause === "object" && "code" in err.cause && (err.cause as { code: string }).code === "23505") return true;
  return false;
}

const PropertyCreateSchema = z
  .object({
    locationId: z.string().uuid(),
    pluginId: z.string().min(1).max(80),
    cost: AdminMoney,
    rate: AdminMoney,
  })
  .strict();

const PropertyUpdateSchema = z
  .object({
    id: z.string().uuid(),
    pluginId: blankable(z.string().min(1).max(80)),
    cost: AdminMoney,
    rate: AdminMoney,
  })
  .strict();

/**
 * All properties as a TableRowsResponse. `id` is the update form's select
 * `valueKey`; `locationId` is the create form's select `valueKey`. Neither
 * is rendered as a column.
 */
const adminListRoute = route({
  method: "GET",
  path: "/api/admin/properties",
  auth: "admin",
  handler: async (ctx) => {
    return ctx.transaction(async (tx) => {
      const allLocations = await tx.db.select({ id: locations.id, name: locations.name }).from(locations);

      const props = await tx.db
        .select({
          id: propertiesTable.id,
          locationId: propertiesTable.locationId,
          pluginId: propertiesTable.pluginId,
          ownerPlayerId: propertiesTable.ownerPlayerId,
          cost: propertiesTable.cost,
          rate: propertiesTable.rate,
          profit: propertiesTable.profit,
          ownerName: players.username,
        })
        .from(propertiesTable)
        .leftJoin(players, eq(players.id, propertiesTable.ownerPlayerId));

      const propByLocation = new Map(props.map((p) => [p.locationId, p]));

      const rows = allLocations.map((loc) => {
        const p = propByLocation.get(loc.id);
        return {
          id: p?.id ?? "",
          locationId: loc.id,
          locationName: loc.name,
          plugin: p?.pluginId ?? "",
          ownerName: p?.ownerPlayerId ? (p?.ownerName ?? "") : "",
          cost: p?.cost.toString() ?? "0",
          rate: p?.rate.toString() ?? "0",
          profit: p?.profit.toString() ?? "0",
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
  handler: async (ctx, { body }) => {
    const id = uuidv7();
    try {
      await ctx.transaction(async (tx) => {
        await tx.db.insert(propertiesTable).values({
          id,
          locationId: body.locationId,
          pluginId: body.pluginId,
          cost: BigInt(body.cost),
          rate: BigInt(body.rate),
        });
      });
    } catch (err: unknown) {
      // unique(location_id) violation → 409
      if (isUniqueViolation(err)) {
        throw new PluginError("location_taken", 409);
      }
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
    // The property editor selects FOR UPDATE on exactly one
    // p_properties_properties row and locks nothing else. A transaction
    // holding exactly one lock cannot be half of a deadlock cycle, which is
    // why this route introduces no new deadlock edge — do not grow a second
    // lock in this route.
    const updated = await ctx.transaction(async (tx) => {
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
          rate: BigInt(body.rate),
          ...(body.pluginId !== undefined && { pluginId: body.pluginId }),
        })
        .where(eq(propertiesTable.id, body.id));
      return true;
    });
    if (!updated) throw new PluginError("property_not_found", 404);
    return { status: 204 };
  },
});

// ---------------------------------------------------------------------------
// Event declarations (cont.)
// ---------------------------------------------------------------------------

const boughtEvent = {
  name: "bought",
  payload: z.object({ propertyName: z.string(), cost: z.string() }),
  describe: "{actorName} bought {propertyName} for {cost}",
  invalidates: ["properties", "me"],
};

const soldEvent = {
  name: "sold",
  payload: z.object({ propertyName: z.string(), payout: z.string() }),
  describe: "{actorName} sold {propertyName} for {payout}",
  invalidates: ["properties", "me"],
};

const incomeEvent = {
  name: "income",
  payload: z.object({ propertyName: z.string(), amount: z.string() }),
  describe: "{actorName} claimed {amount} from {propertyName}",
  invalidates: ["properties", "me"],
};

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export default definePlugin({
  id: "properties",
  version: "1.0.0",
  basePaths: ["/api/properties", "/api/admin/properties"],
  tables: {
    properties: "p_properties_properties",
  },
  migrations: PROPERTIES_MIGRATIONS,
  routes: [listRoute, buyRoute, sellRoute, claimRoute, adminListRoute, adminCreateRoute, adminUpdateRoute],
  events: [boughtEvent, soldEvent, incomeEvent],
  pages: [],
  adminPages: [adminPage],
});
