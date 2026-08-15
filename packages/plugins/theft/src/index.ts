import { and, gte, lte, sql } from "drizzle-orm";
import { definePlugin, PluginError, route } from "@gl3/plugin-sdk";
import { cars, theftTiers } from "./schema.js";
import { THEFT_MIGRATIONS } from "./migrations.js";

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
  routes: [tiersRoute],
});
