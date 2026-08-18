import { randomInt } from "node:crypto";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { bracketWeight, resolveTheft, type CatalogueCar, type TheftTier } from "./resolve.js";
import { cars, garage, locations, playerStats, theftTiers } from "./schema.js";
import { THEFT_MIGRATIONS } from "./migrations.js";
import { readTheftSettings } from "./settings.js";
import { adminPage, garagePage, theftPage } from "./pages.js";
// Re-exported so `test/plugin-manifest-endpoint.test.ts` can assert against
// the same page objects rather than a hand-copied duplicate of their view
// trees, which would silently drift if `pages.ts` changed.
export { adminPage, garagePage, theftPage } from "./pages.js";

// Re-exported rather than reached via a `@gl3/plugin-theft/settings` subpath
// import: this workspace's vitest srcAliases only match an import specifier
// that is EXACTLY one of its keys (verified empirically — a shorter sibling
// key such as "@gl3/plugin-theft" does not act as a prefix for
// "@gl3/plugin-theft/settings"), so an unbuilt subpath falls through to the
// real workspace-linked package's `exports` map and 404s on a `dist/` that
// only `tsc --build` produces. No other plugin in this repo uses a subpath
// export for this reason.
export { readTheftSettings, type TheftSettings } from "./settings.js";
export {
  bracketWeight,
  resolveTheft,
  type CatalogueCar,
  type TheftOutcome,
  type TheftRolls,
  type TheftTier,
} from "./resolve.js";

/**
 * Shaped as a TableRowsResponse (`{ rows: [{...strings}] }`) because it is
 * both the `table.source` and the `optionsSource` of the steal form's select.
 * Every value is a string for that reason. `id` is present as the select's
 * valueKey and is never rendered as a column.
 */
const tiersRoute = route({
  method: "GET",
  path: "/api/theft/tiers",
  accessInJail: true,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const cooldownRemaining = await ctx.cooldown.peek("theft", player.id);

    return ctx.transaction(async (tx) => {
      const tiers = await tx.db.select().from(theftTiers).orderBy(theftTiers.minCarValue);
      const rows = [];
      for (const tier of tiers) {
        const [counted] = await tx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(cars)
          .where(and(gte(cars.value, tier.minCarValue), lte(cars.value, tier.maxCarValue)));
        rows.push({
          id: tier.id,
          name: tier.name,
          successChance: String(tier.successChance),
          maxDamage: String(tier.maxDamage),
          minCarValue: tier.minCarValue.toString(),
          maxCarValue: tier.maxCarValue.toString(),
          cars: String(counted?.n ?? 0),
          cooldownRemaining: String(cooldownRemaining),
        });
      }
      return { status: 200, body: { rows } };
    });
  },
});

/**
 * Steal a car from one tier's value bracket, or run from the police.
 *
 * Synchronous, like combat and unlike crimes: there is no shared outcome and
 * no delay to model, so a BullMQ job would buy nothing but a rule-1
 * idempotency key to maintain.
 *
 * The id arrives in the BODY, not the path: the declarative page posts through
 * a form, and a form submits a body. Every mutating route in this plugin takes
 * its id the same way.
 */
const stealRoute = route({
  method: "POST",
  path: "/api/theft/steal",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ tierId: z.string().uuid() }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readTheftSettings((key) => ctx.settings.get(key));

    // Both reads happen BEFORE the cooldown is claimed, so neither a bad id
    // nor an empty catalogue costs the player anything — the ordering
    // `packages/plugins/crimes/src/index.ts` established. Unlocked, and
    // deliberately: the authoritative reads happen under the locks below.
    const precheck = await ctx.transaction(async (tx) => {
      const [tier] = await tx.db.select().from(theftTiers).where(eq(theftTiers.id, body.tierId));
      if (tier === undefined) return { tier: undefined, inBracket: 0 };
      const [counted] = await tx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(cars)
        .where(and(gte(cars.value, tier.minCarValue), lte(cars.value, tier.maxCarValue)));
      return { tier, inBracket: counted?.n ?? 0 };
    });
    const tier: TheftTier | undefined = precheck.tier;
    if (tier === undefined) throw new PluginError("tier_not_found", 404);
    if (precheck.inBracket === 0) throw new PluginError("no_cars_in_tier", 409);

    // Redis SET NX EX inside the SDK, so rule 2 is satisfied structurally —
    // there is no peek-then-set to get wrong. The action is the bare segment
    // `theft`: the SDK's key grammar takes one key segment, not a dotted path.
    const claimed = await ctx.cooldown.acquire("theft", player.id, config.cooldownSeconds);
    if (!claimed) {
      const retryAfter = await ctx.cooldown.peek("theft", player.id);
      throw new PluginError("cooldown_active", 429, { retryAfter }, { "retry-after": String(retryAfter) });
    }

    try {
      return await ctx.transaction(async (tx) => {
        // Where the car will be parked has to be READ before it can be
        // locked, so this read is unlocked and is re-checked below.
        const [before] = await tx.db
          .select({ locationId: playerStats.locationId })
          .from(playerStats)
          .where(eq(playerStats.playerId, player.id));
        const locationId = before?.locationId ?? null;
        if (locationId === null) throw new PluginError("no_location", 409);

        // RULE 6, and the load-bearing lines of this plugin. Inserting a
        // p_theft_garage row reaches `locations` implicitly through
        // location_id's FK (FOR KEY SHARE). Locking the player first and
        // arriving at the location afterwards is the shipped travel deadlock
        // exactly — bullets locks location->player, so the inverse order
        // deadlocks against it under load. Location first, then the player,
        // through the SDK helpers and never a hand-written FOR UPDATE.
        await tx.locks.location(locationId);
        await tx.locks.player([player.id]);

        // Lock-then-recheck (TOCTOU): a player who travelled between the
        // unlocked read and the lock must not park a car in the city they
        // left. This is a defence, not an optimisation.
        const [after] = await tx.db
          .select({ locationId: playerStats.locationId })
          .from(playerStats)
          .where(eq(playerStats.playerId, player.id));
        if (after?.locationId !== locationId) throw new PluginError("wrong_location", 409);

        const catalogue: CatalogueCar[] = await tx.db
          .select({ id: cars.id, name: cars.name, value: cars.value, theftWeight: cars.theftWeight })
          .from(cars);
        const total = bracketWeight(tier, catalogue);

        const outcome = resolveTheft(
          {
            successRoll: randomInt(0, 100),
            // `randomInt(n, n)` throws, so the zero-weight case never draws —
            // resolveTheft answers `empty` from the same fact.
            carRoll: total > 0 ? randomInt(0, total) : 0,
            // maxDamage 0 -> randomInt(0, 1) -> 0. Pristine, and no throw.
            damageRoll: randomInt(0, tier.maxDamage + 1),
            escapeRoll: randomInt(0, 100),
          },
          tier,
          catalogue,
          config.chase.escapeChance,
        );

        // The pre-check counted cars in the bracket; this catches the case it
        // cannot see — a bracket whose every car carries weight 0. Throwing
        // rolls the transaction back and the catch below returns the cooldown.
        if (outcome.kind === "empty") throw new PluginError("no_cars_in_tier", 409);

        if (outcome.kind === "stolen") {
          await tx.db.insert(garage).values({
            id: uuidv7(),
            playerId: player.id,
            carId: outcome.car.id,
            damage: outcome.damage,
            locationId,
          });
          await tx.events.publish({
            name: "resolved",
            actorId: player.id,
            actorName: player.username,
            audience: { kind: "player", playerId: player.id },
            payload: {
              outcome: `stole a ${outcome.car.name}`,
              carName: outcome.car.name,
              success: "true",
            },
          });
          return {
            status: 201,
            body: { outcome: "stolen", car: outcome.car.name, damage: outcome.damage },
          };
        }

        const escaped = outcome.kind === "escaped";
        // The module's own outcome first, the state change second — the
        // crimes ordering, preserved by tx.events' single buffer. Buffered
        // here and flushed after commit, so rule 5 holds.
        await tx.events.publish({
          name: "resolved",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: player.id },
          payload: {
            outcome: escaped ? "was spotted lifting a car and got away" : "was caught lifting a car",
            carName: "",
            success: "false",
          },
        });

        if (escaped) return { status: 200, body: { outcome: "escaped" } };

        // Takes the player lock itself, in the same order as
        // economy.applyBalanceChange, so it needs no lock call of its own.
        const until = await tx.jail.sendToJail(player.id, config.chase.jailSeconds);
        await tx.events.publishCore({
          type: "player.jailed",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: player.id },
          until: until.toISOString(),
          reason: "caught stealing a car",
        });
        return { status: 200, body: { outcome: "caught", until: until.toISOString() } };
      });
    } catch (err) {
      // The theft did not happen, so the player must not pay for it. Unlike
      // combat's attack — which keeps the cooldown on a 4xx to deny a free
      // probe — every refusal reachable here is about the WORLD (an empty
      // bracket, no location, a mid-flight move), not about the target.
      await ctx.cooldown.release("theft", player.id);
      throw err;
    }
  },
});

/**
 * bigint division truncates, which is the correct direction: the house keeps
 * the fraction. Shared by the list route and the sell route so the number a
 * player is shown is the number they are paid, by construction.
 */
function saleValueOf(value: bigint, damage: number): bigint {
  const intact = BigInt(Math.min(100, Math.max(0, damage)));
  return (value * (100n - intact)) / 100n;
}

/**
 * The caller's cars as a TableRowsResponse: car name, damage, the location's
 * name, the sale value, the repair cost, and whether the caller is standing
 * in that city. No locks, no cooldown — read-only.
 */
const listGarageRoute = route({
  method: "GET",
  path: "/api/garage",
  accessInJail: true,
  accessInHospital: true,
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readTheftSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      const [me] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));

      const owned = await tx.db
        .select({
          id: garage.id,
          damage: garage.damage,
          locationId: garage.locationId,
          carId: garage.carId,
          carName: cars.name,
          carValue: cars.value,
          locationName: locations.name,
        })
        .from(garage)
        .innerJoin(cars, eq(cars.id, garage.carId))
        .leftJoin(locations, eq(locations.id, garage.locationId))
        .where(eq(garage.playerId, player.id));

      // ONE query for the whole page, not one per row: `resolve` takes an array
      // precisely so a garage with twenty cars in it costs a single lookup.
      const art = await ctx.assets.mine(owned.map((row) => row.carId), "car");

      return {
        status: 200,
        body: {
          rows: owned.map((row) => ({
            // `id` is the select's valueKey and is never rendered as a
            // column — the rule test/admin-ids-hidden.test.ts enforces on the
            // admin side, kept here for the same reason.
            id: row.id,
            carName: row.carName,
            // Absent from the map when no art is bound — the renderer's
            // GameImage draws its placeholder for an empty string.
            image: art.get(row.carId) ?? "",
            damage: String(row.damage),
            locationName: row.locationName ?? "Unknown",
            saleValue: saleValueOf(row.carValue, row.damage).toString(),
            repairCost: (config.repair.costPerPoint * BigInt(row.damage)).toString(),
            here: row.locationId === me?.locationId ? "yes" : "no",
          })),
        },
      };
    });
  },
});

/**
 * Sell a car for its value scaled by damage. Requires standing in the car's
 * own location — `garage.location_id` is where the car sits and stays.
 */
const sellRoute = route({
  method: "POST",
  path: "/api/garage/sell",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ garageId: z.string().uuid() }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Unlocked read, only to learn WHICH location to lock.
      const [before] = await tx.db
        .select({ locationId: garage.locationId })
        .from(garage)
        .where(and(eq(garage.id, body.garageId), eq(garage.playerId, player.id)));
      if (before?.locationId == null) throw new PluginError("car_not_found", 404);

      // Rule 6: the location first, then the player. Deleting the garage row
      // still touches locations through the FK.
      await tx.locks.location(before.locationId);
      await tx.locks.player([player.id]);

      // Lock-then-recheck.
      const [row] = await tx.db
        .select({
          id: garage.id,
          damage: garage.damage,
          locationId: garage.locationId,
          carName: cars.name,
          carValue: cars.value,
        })
        .from(garage)
        .innerJoin(cars, eq(cars.id, garage.carId))
        .where(and(eq(garage.id, body.garageId), eq(garage.playerId, player.id)));
      if (row === undefined) throw new PluginError("car_not_found", 404);

      const [me] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (me?.locationId !== row.locationId) throw new PluginError("wrong_location", 409);

      const payout = saleValueOf(row.carValue, row.damage);
      await tx.db.delete(garage).where(eq(garage.id, row.id));
      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: payout,
        kind: "cash",
        reason: "theft.sell",
      });
      await tx.events.publish({
        name: "sold",
        actorId: player.id,
        actorName: player.username,
        audience: { kind: "player", playerId: player.id },
        payload: { carName: row.carName, payout: payout.toString() },
      });

      return { status: 200, body: { payout: payout.toString() } };
    });
  },
});

/**
 * Restore damage to 0. A pristine car is a 204 no-op, not an error — the
 * spec-1 gunsmith ruling, kept for the same reason: a no-op is not a
 * mistake, and charging for it or 4xx-ing it both punish a double click.
 * The 204 check runs AFTER the wrong-location check: a pristine car in
 * another city is still the wrong city.
 */
const repairRoute = route({
  method: "POST",
  path: "/api/garage/repair",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ garageId: z.string().uuid() }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readTheftSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      // Unlocked read, only to learn WHICH location to lock.
      const [before] = await tx.db
        .select({ locationId: garage.locationId })
        .from(garage)
        .where(and(eq(garage.id, body.garageId), eq(garage.playerId, player.id)));
      if (before?.locationId == null) throw new PluginError("car_not_found", 404);

      // Rule 6: the location first, then the player.
      await tx.locks.location(before.locationId);
      await tx.locks.player([player.id]);

      // Lock-then-recheck.
      const [row] = await tx.db
        .select({ id: garage.id, damage: garage.damage, locationId: garage.locationId })
        .from(garage)
        .where(and(eq(garage.id, body.garageId), eq(garage.playerId, player.id)));
      if (row === undefined) throw new PluginError("car_not_found", 404);

      const [me] = await tx.db
        .select({ locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (me?.locationId !== row.locationId) throw new PluginError("wrong_location", 409);

      if (row.damage === 0) return { status: 204 };

      const cost = config.repair.costPerPoint * BigInt(row.damage);
      const [stats] = await tx.db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      // Checked under the lock, so the balance cannot move between the check
      // and the debit.
      if (stats === undefined || stats.cash < cost) {
        throw new PluginError("insufficient_funds", 409);
      }
      await tx.economy.applyBalanceChange({
        playerId: player.id,
        amount: -cost,
        kind: "cash",
        reason: "theft.repair",
      });
      await tx.db.update(garage).set({ damage: 0 }).where(eq(garage.id, row.id));
      return { status: 200, body: { cost: cost.toString() } };
    });
  },
});

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------

const AdminMoney = z.string().regex(/^\d+$/, "nonnegative integer string");

/**
 * The page renderer posts every field in a form, sending "" for the ones the
 * admin left blank (`PageRenderer.tsx`'s form `onSubmit`). Blank is
 * normalised to `undefined` here so an update that only renames a row leaves
 * every other column untouched — `packages/plugins/inventory/src/index.ts`'s
 * admin routes' convention, reused rather than reinvented.
 */
function blankable<T extends z.ZodTypeAny>(inner: T): z.ZodEffects<z.ZodOptional<T>> {
  return z.preprocess((v) => (v === "" ? undefined : v), inner.optional()) as never;
}

const CarCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    value: AdminMoney,
    theftWeight: z.coerce.number().int().nonnegative(),
  })
  .strict();

const CarUpdateSchema = z
  .object({
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    value: AdminMoney,
    theftWeight: z.coerce.number().int().nonnegative(),
  })
  .strict();

const TierCreateSchema = z
  .object({
    name: z.string().min(1).max(80),
    successChance: z.coerce.number().int().min(0).max(100),
    maxDamage: z.coerce.number().int().nonnegative(),
    minCarValue: AdminMoney,
    maxCarValue: AdminMoney,
  })
  .strict()
  .refine((b) => BigInt(b.maxCarValue) >= BigInt(b.minCarValue), {
    message: "maxCarValue must be >= minCarValue",
  });

const TierUpdateSchema = z
  .object({
    id: z.string().uuid(),
    name: blankable(z.string().min(1).max(80)),
    successChance: z.coerce.number().int().min(0).max(100),
    maxDamage: z.coerce.number().int().nonnegative(),
    minCarValue: AdminMoney,
    maxCarValue: AdminMoney,
  })
  .strict()
  .refine((b) => BigInt(b.maxCarValue) >= BigInt(b.minCarValue), {
    message: "maxCarValue must be >= minCarValue",
  });

/**
 * The catalogue as a `TableRowsResponse`. `id` is the update form's select
 * `valueKey` and is never rendered as a column.
 */
const adminCarListRoute = route({
  method: "GET",
  path: "/api/admin/theft/cars",
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(cars));
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          value: r.value.toString(),
          theftWeight: String(r.theftWeight),
        })),
      },
    };
  },
});

const adminCarCreateRoute = route({
  method: "POST",
  path: "/api/admin/theft/cars",
  auth: "admin",
  body: CarCreateSchema,
  handler: async (ctx, { body }) => {
    const id = uuidv7();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(cars).values({
        id,
        name: body.name,
        value: BigInt(body.value),
        theftWeight: body.theftWeight,
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminCarUpdateRoute = route({
  method: "POST",
  path: "/api/admin/theft/cars/update",
  auth: "admin",
  body: CarUpdateSchema,
  handler: async (ctx, { body }) => {
    // The catalogue editor takes FOR UPDATE on exactly one p_theft_cars row
    // and locks nothing else. A transaction holding exactly one lock cannot
    // be half of a deadlock cycle, which is why the new p_theft_cars node
    // introduces none — do not grow a second lock in this route.
    const updated = await ctx.transaction(async (tx) => {
      const [existing] = await tx.db.select().from(cars).where(eq(cars.id, body.id)).for("update");
      if (existing === undefined) return false;
      await tx.db
        .update(cars)
        .set({
          value: BigInt(body.value),
          theftWeight: body.theftWeight,
          ...(body.name !== undefined && { name: body.name }),
        })
        .where(eq(cars.id, body.id));
      return true;
    });
    if (!updated) throw new PluginError("car_not_found", 404);
    return { status: 204 };
  },
});

const adminTierListRoute = route({
  method: "GET",
  path: "/api/admin/theft/tiers",
  auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(theftTiers));
    return {
      status: 200,
      body: {
        rows: rows.map((r) => ({
          id: r.id,
          name: r.name,
          successChance: String(r.successChance),
          maxDamage: String(r.maxDamage),
          minCarValue: r.minCarValue.toString(),
          maxCarValue: r.maxCarValue.toString(),
        })),
      },
    };
  },
});

const adminTierCreateRoute = route({
  method: "POST",
  path: "/api/admin/theft/tiers",
  auth: "admin",
  body: TierCreateSchema,
  handler: async (ctx, { body }) => {
    const id = uuidv7();
    await ctx.transaction(async (tx) => {
      await tx.db.insert(theftTiers).values({
        id,
        name: body.name,
        successChance: body.successChance,
        maxDamage: body.maxDamage,
        minCarValue: BigInt(body.minCarValue),
        maxCarValue: BigInt(body.maxCarValue),
      });
    });
    return { status: 201, body: { id } };
  },
});

const adminTierUpdateRoute = route({
  method: "POST",
  path: "/api/admin/theft/tiers/update",
  auth: "admin",
  body: TierUpdateSchema,
  handler: async (ctx, { body }) => {
    const updated = await ctx.transaction(async (tx) => {
      const result = await tx.db
        .update(theftTiers)
        .set({
          successChance: body.successChance,
          maxDamage: body.maxDamage,
          minCarValue: BigInt(body.minCarValue),
          maxCarValue: BigInt(body.maxCarValue),
          ...(body.name !== undefined && { name: body.name }),
        })
        .where(eq(theftTiers.id, body.id))
        .returning({ id: theftTiers.id });
      return result.length > 0;
    });
    if (!updated) throw new PluginError("tier_not_found", 404);
    return { status: 204 };
  },
});

/**
 * One `describe` template, not the design doc's two: a manifest event declares
 * a single template, so the phrasing lives in the payload and the template
 * only positions it.
 */
const resolvedEvent = {
  name: "resolved",
  payload: z.object({ outcome: z.string(), carName: z.string(), success: z.string() }),
  describe: "{actorName} {outcome}",
  invalidates: ["theft", "garage", "me"],
};

/** Declared here, published by the garage's sell route. */
const soldEvent = {
  name: "sold",
  payload: z.object({ carName: z.string(), payout: z.string() }),
  describe: "{actorName} sold a {carName} for {payout}",
  invalidates: ["garage", "me"],
};

export default definePlugin({
  id: "theft",
  version: "1.0.0",
  basePaths: ["/api/theft", "/api/garage", "/api/admin/theft"],
  tables: {
    cars: "p_theft_cars",
    tiers: "p_theft_tiers",
    garage: "p_theft_garage",
  },
  migrations: THEFT_MIGRATIONS,
  routes: [
    tiersRoute,
    stealRoute,
    listGarageRoute,
    sellRoute,
    repairRoute,
    adminCarListRoute,
    adminCarCreateRoute,
    adminCarUpdateRoute,
    adminTierListRoute,
    adminTierCreateRoute,
    adminTierUpdateRoute,
  ],
  events: [resolvedEvent, soldEvent],
  // One slot: every row in this plugin's cars table may carry art. The loader
  // stamps the scope from this manifest's own id, so `theft:car` is the key and
  // no other plugin can bind to it.
  providesAssets: [{ slot: "car", label: "Car image" }],
  pages: [theftPage, garagePage],
  adminPages: [adminPage],
});
