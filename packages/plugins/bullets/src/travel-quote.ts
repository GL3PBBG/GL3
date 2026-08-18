import { ownerAt } from "@gl3/plugin-properties";
import { on, type PluginCtx } from "@gl3/plugin-sdk";
import { locationsListed, type LocationListing } from "@gl3/plugin-travel";
import { eq } from "drizzle-orm";
import { effectiveCost } from "./pricing.js";
import { settings } from "./schema.js";
import { readBulletSettings } from "./settings.js";

/**
 * Rewrites the travel board's `bulletCost` to the price the shop actually
 * charges — the franchise owner's lever when the town's factory is owned and
 * priced, clamped by the admin's `max_cost` cap — so the board never quotes a
 * number `POST /api/bullets/buy` would not honour.
 *
 * The cap is read from the `settings` TABLE rather than from
 * `ctx.settings.get`, and that is not a style choice: `runFilterChain` threads
 * the *applying* plugin's ctx into every subscriber, so here
 * `ctx.settings.get("max_cost")` would resolve `travel.max_cost` — the same
 * mislabelling trap `lever-cap.ts` documents. The transaction is this
 * filter's own; filters cannot join the caller's write.
 */
export const quoteBulletPrices = on(locationsListed, async (ctx: PluginCtx, listings: LocationListing[]) =>
  ctx.transaction(async (tx) => {
    const [row] = await tx.db.select({ value: settings.value }).from(settings)
      .where(eq(settings.key, "bullets.max_cost"));
    const maxCost = readBulletSettings((key) => (key === "max_cost" ? row?.value ?? null : null)).maxCost;

    const quoted: LocationListing[] = [];
    for (const listing of listings) {
      const franchise = await ownerAt(tx, "bullets", listing.id);
      quoted.push({
        ...listing,
        bulletCost: effectiveCost(franchise?.lever ?? null, listing.bulletCost, maxCost),
      });
    }
    return quoted;
  }));
