import { eq } from "drizzle-orm";
import { on } from "@gl3/plugin-sdk";
import { killResolved } from "@gl3/plugin-combat";
import { propertiesTable } from "./schema.js";

/**
 * V2's `propertyManagement.hooks.php` `userKilled` hook, with one deliberate
 * change. V2 transfers every property the victim owned TO THE SHOOTER. GL3
 * does not: the shooter already takes the kill's payout, and a franchise on
 * top compounds a winner's lead. Instead the properties are seized — unowned,
 * back on the market at the declared price for anyone to buy.
 *
 * `profit` is left alone: it is that ROW's lifetime P&L across owners, not the
 * victim's, and zeroing it would erase a fact nobody asked to erase.
 *
 * No `seized` event is published here, on purpose. `runFilterChain` (SDK)
 * calls a subscriber with the APPLYING plugin's ctx, not the subscriber's own
 * — and it is combat that calls `ctx.filters.apply(killResolved, ...)`, so
 * `ctx.pluginId` inside this subscriber is "combat". A `tx.events.publish(...)`
 * here would therefore be wrapped as `toEnvelope("combat", ...)` — an event on
 * the wire labelled as combat's, for a name combat never declared, which no
 * client-side plugin-event invalidation can match. `tx.notify(...)` has no
 * such problem: it always publishes the core `notification.created` event,
 * which is not scoped to any plugin id.
 *
 * Filters run OUTSIDE the caller's transaction (SDK rule), so this opens its
 * own. Idempotent by shape — `WHERE owner_player_id = victim` matches nothing
 * on a second run — and crash-safe without a queue: if it never runs, the
 * victim keeps the property and the next kill seizes it. Combat logs and
 * swallows a subscriber failure, so a failed seizure never undoes a kill.
 */
export const seizeOnKill = on(killResolved, async (ctx, value) => {
  await ctx.transaction(async (tx) => {
    // No location lock: this takes no player lock and no balance moves, so it
    // holds exactly one kind of row and cannot be half of a deadlock cycle.
    // Do not grow a balance change in here without revisiting that.
    const seized = await tx.db
      .update(propertiesTable)
      .set({ ownerPlayerId: null, cost: 0n })
      .where(eq(propertiesTable.ownerPlayerId, value.victimId))
      .returning({ id: propertiesTable.id });
    if (seized.length === 0) return;

    const noun = seized.length === 1 ? "property" : "properties";
    await tx.notify(
      value.victimId,
      `${seized.length} of your ${noun} ${seized.length === 1 ? "was" : "were"} seized after your death.`,
    );
  });
  return value;
});
