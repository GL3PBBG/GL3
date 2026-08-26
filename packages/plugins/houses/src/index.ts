import { asc, eq } from "drizzle-orm";
import { bigint, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { z } from "zod";
import { HOUSES_MIGRATIONS } from "./migrations.js";
import { definePlugin, isInsufficientFundsError, PluginError, route, type PluginTx } from "@gl3/plugin-sdk";

/** This plugin's own catalog table (migrations.ts creates it). */
const houses = pgTable("p_houses", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  price: bigint("price", { mode: "bigint" }).notNull(),
  will: integer("will").notNull(),
});

const HouseIdSchema = z.object({ houseId: z.string().uuid() }).strict();

/**
 * The player's current house is derived, never stored: maxwill IS the house
 * (MCCodes `estate.php:12-17` matches `hWILL = maxwill`). No ownership row,
 * no ambiguity — one row per will value is the admin's content constraint.
 */
async function currentHouse(tx: PluginTx, willMax: number) {
  const [row] = await tx.db.select().from(houses).where(eq(houses.will, willMax)).limit(1);
  return row ?? null;
}

const listRoute = route({
  method: "GET",
  path: "/api/houses",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const attrs = await ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);
      return tx.attributes.read(player.id);
    });
    const rows = await ctx.transaction(async (tx) =>
      tx.db.select().from(houses).orderBy(asc(houses.will)));
    return {
      status: 200,
      body: {
        currentWillMax: attrs.willMax,
        houses: rows.map((h) => ({
          id: h.id, name: h.name, price: h.price.toString(), will: h.will,
        })),
      },
    };
  },
});

const buyRoute = route({
  method: "POST",
  path: "/api/houses/buy",
  body: HouseIdSchema,
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const [house] = await tx.db.select().from(houses).where(eq(houses.id, body.houseId));
      if (!house) throw new PluginError("house_not_found", 404);

      const attrs = await tx.attributes.read(player.id);
      // Upgrades only (estate.php:37-39): "You cannot go backwards in
      // houses!" — an equal-will buy is also refused; there is nothing to
      // gain and the will reset would be pure loss.
      if (house.will <= attrs.willMax) throw new PluginError("downgrade_refused", 409);

      try {
        await tx.economy.applyBalanceChange(
          { playerId: player.id, amount: -house.price, kind: "cash", reason: "houses.buy", refId: house.id },
        );
      } catch (error) {
        if (isInsufficientFundsError(error)) throw new PluginError("insufficient_funds", 409);
        throw error;
      }

      // Moving house resets will to zero (estate.php:47-51) — the new
      // maxwell's higher multiplier is earned back through regen.
      if (attrs.will > 0) await tx.attributes.spend(player.id, "will", attrs.will);
      await tx.attributes.setMax(player.id, "will", house.will);

      return { status: 200, body: { houseId: house.id, name: house.name, willMax: house.will } };
    });
  },
});

const sellRoute = route({
  method: "POST",
  path: "/api/houses/sell",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      await tx.locks.player([player.id]);

      const attrs = await tx.attributes.read(player.id);
      if (attrs.willMax <= 100) throw new PluginError("no_house_to_sell", 409);
      const house = await currentHouse(tx, attrs.willMax);
      if (house === null) throw new PluginError("no_house_to_sell", 409);

      // 100% refund (estate.php:56-69) — storage, not income; the player
      // re-earns nothing by cycling buy/sell.
      await tx.economy.applyBalanceChange(
        { playerId: player.id, amount: house.price, kind: "cash", reason: "houses.sell", refId: house.id },
      );
      if (attrs.will > 0) await tx.attributes.spend(player.id, "will", attrs.will);
      await tx.attributes.setMax(player.id, "will", 100);

      return { status: 200, body: { soldHouseId: house.id, refund: house.price.toString(), willMax: 100 } };
    });
  },
});

/**
 * Houses (C spec §4.2): maxwill IS the house. Buying upgrades the ceiling
 * and resets current will; selling refunds in full and returns to the
 * Default House's 100. Requires the anchor for the will pool.
 */
export default definePlugin({
  id: "houses",
  version: "1.0.0",
  basePaths: ["/api/houses"],
  requires: ["mccodes-attributes"],
  migrations: HOUSES_MIGRATIONS,
  routes: [listRoute, buyRoute, sellRoute],
});
