import { leverSet, type LeverSet } from "@gl3/plugin-properties";
import { on, PluginError, type PluginCtx } from "@gl3/plugin-sdk";
import { eq } from "drizzle-orm";
import { settings } from "./schema.js";
import { readBulletSettings } from "./settings.js";

/**
 * The set-side half of V2's `maxBulletCost`: an owner may not price their
 * bullet factory above the admin's cap.
 *
 * The cap is read from the `settings` TABLE rather than from
 * `ctx.settings.get`, and that is not a style choice. `runFilterChain` threads
 * the *applying* plugin's ctx into every subscriber, so inside this function
 * `ctx.settings.get("max_cost")` would resolve `properties.max_cost` — the same
 * mislabelling trap CLAUDE.md records for `tx.events.publish` in a
 * `combat.killResolved` subscriber. The transaction is this filter's own;
 * filters cannot join the caller's write.
 */
export const capLever = on(leverSet, async (ctx: PluginCtx, value: LeverSet) => {
  if (value.propertyTypeId !== "bullets") return value;

  const [row] = await ctx.transaction(async (tx) =>
    tx.db.select({ value: settings.value }).from(settings)
      .where(eq(settings.key, "bullets.max_cost")));

  // Reuses the plugin's own parser so blank, negative and unparseable all mean
  // "unlimited" here exactly as they do on the read side.
  const maxCost = readBulletSettings((key) => (key === "max_cost" ? row?.value ?? null : null)).maxCost;

  if (maxCost !== null && value.value > maxCost) {
    throw new PluginError("lever_above_cap", 400, { maxCost: maxCost.toString() });
  }
  return value;
});
