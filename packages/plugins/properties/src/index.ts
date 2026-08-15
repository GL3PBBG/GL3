import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { propertiesTable, locations, players, playerStats } from "./schema.js";
import { PROPERTIES_MIGRATIONS } from "./migrations.js";
import { readPropertiesSettings } from "./settings.js";
import { accruedSince } from "./resolve.js";

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
  routes: [listRoute, buyRoute, sellRoute, claimRoute],
  events: [boughtEvent, soldEvent, incomeEvent],
  pages: [],
  adminPages: [],
});
