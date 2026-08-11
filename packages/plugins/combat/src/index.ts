import { definePlugin, PluginError, type PluginTx, route } from "@gl3/plugin-sdk";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ITEM_TYPE_WEAPON, WeaponEffectsSchema } from "./effects.js";
import type { WeaponProfile } from "./resolve.js";
import { items, playerStats, ranks } from "./schema.js";
import { type CombatSettings, readCombatSettings } from "./settings.js";

// Re-exported from the manifest module rather than through an `exports`
// subpath: no other plugin has one, and the resolver is the only part of
// combat worth importing from outside (its tests run in the no-DB
// `@gl3/server:unit` project because it touches neither Postgres nor Redis).
export { resolveShot, rollFor } from "./resolve.js";
export type { Rolls, ShotOutcome, WeaponProfile } from "./resolve.js";
export { readCombatSettings } from "./settings.js";
export type { CombatSettings } from "./settings.js";

/**
 * The target's elapsed sentence, cleared inside the caller's lock. Duplicates
 * core's `settleHospital` because a plugin may not import from `apps/server`;
 * kept to the same two statements so the two cannot diverge in behaviour.
 *
 * Without this, an elapsed sentence is only settled by the VICTIM's own next
 * request — until then they sit at 0 health and are one hit from dying again.
 */
async function settleTargetHospital(tx: PluginTx, targetId: string): Promise<void> {
  const [row] = await tx.db
    .select({ hospitalUntil: playerStats.hospitalUntil, maxHealth: ranks.maxHealth })
    .from(playerStats)
    .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
    .where(eq(playerStats.playerId, targetId));
  if (!row?.hospitalUntil) return;
  if (row.hospitalUntil.getTime() > Date.now()) return;
  await tx.db
    .update(playerStats)
    .set({ hospitalUntil: null, health: row.maxHealth ?? 100 })
    .where(and(eq(playerStats.playerId, targetId), isNotNull(playerStats.hospitalUntil)));
}

/** The equipped weapon's stats, or the unarmed profile when nothing is equipped. */
async function loadWeapon(
  tx: PluginTx,
  weaponItemId: string | null,
  config: CombatSettings,
): Promise<WeaponProfile> {
  const unarmed: WeaponProfile = {
    accuracy: config.unarmed.accuracy,
    damageMin: config.unarmed.damageMin,
    damageMax: config.unarmed.damageMax,
    bulletsPerShot: config.unarmed.bulletsPerShot,
    critChance: 0,
    critMultiplier: 1,
    armorPierce: 0,
    minRankExp: 0,
  };
  if (weaponItemId === null) return unarmed;

  const [row] = await tx.db
    .select({ effects: items.effects, itemType: items.itemType })
    .from(items)
    .where(eq(items.id, weaponItemId));
  if (!row || row.itemType !== ITEM_TYPE_WEAPON) return unarmed;

  const parsed = WeaponEffectsSchema.safeParse(row.effects);
  // A malformed weapon falls back to unarmed rather than 500ing: the jsonb is
  // an external boundary. A V2-migrated item with no accuracy is the expected
  // case for the settings fallback below, not this branch.
  if (!parsed.success) return unarmed;
  return parsed.data;
}

const attackRoute = route({
  method: "POST",
  path: "/api/combat/attack/:targetId",
  accessInJail: false,
  accessInHospital: false,
  params: z.object({ targetId: z.string().uuid() }),
  handler: async (ctx, { params }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    if (params.targetId === player.id) throw new PluginError("self_attack", 400);

    const config = readCombatSettings((key) => ctx.settings.get(key));

    // Claimed BEFORE the transaction, and deliberately never released on a
    // 4xx: releasing would be a check-then-act on Redis (NOTES.md rule 2),
    // and keeping it denies a client a free probe for scanning who is
    // attackable at no cost.
    const acquired = await ctx.cooldown.acquire("combat.attack", player.id, config.cooldownSeconds);
    if (!acquired) {
      const remaining = await ctx.cooldown.peek("combat.attack", player.id);
      throw new PluginError("cooldown", 429, {}, { "retry-after": String(remaining) });
    }

    return ctx.transaction(async (tx) => {
      // FIRST statement. Ascending UUID via the shared helper, which is what
      // makes A-shoots-B and B-shoots-A safe against each other (no ABBA).
      await tx.locks.player([player.id, params.targetId]);

      // The attacker's own hospital state was settled by the loader gate
      // before this handler ran. The target's must be settled HERE, inside
      // the lock: a target whose sentence just elapsed otherwise sits at
      // health 0 and is instantly re-killable.
      await settleTargetHospital(tx, params.targetId);

      const [attacker] = await tx.db
        .select()
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const [target] = await tx.db
        .select()
        .from(playerStats)
        .where(eq(playerStats.playerId, params.targetId));
      if (!attacker) throw new PluginError("unauthorized", 401);
      if (!target) throw new PluginError("no_such_target", 404);

      const now = Date.now();
      if (target.hospitalUntil && target.hospitalUntil.getTime() > now) {
        throw new PluginError("target_hospitalised", 409);
      }
      if (target.jailedUntil && target.jailedUntil.getTime() > now) {
        throw new PluginError("target_jailed", 409);
      }
      if (attacker.locationId === null || attacker.locationId !== target.locationId) {
        throw new PluginError("target_elsewhere", 409);
      }
      if (attacker.gangId !== null && attacker.gangId === target.gangId) {
        throw new PluginError("same_gang", 409);
      }
      // Mutual: below the threshold you can neither be attacked NOR attack.
      // One-way protection would let a newbie farm with impunity.
      if (attacker.exp < config.newbieExpThreshold || target.exp < config.newbieExpThreshold) {
        throw new PluginError("protected", 409);
      }

      const weapon = await loadWeapon(tx, attacker.weaponItemId, config);
      if (attacker.bullets < BigInt(weapon.bulletsPerShot)) {
        throw new PluginError("insufficient_bullets", 409);
      }

      await tx.db
        .update(playerStats)
        .set({ bullets: sql`${playerStats.bullets} - ${weapon.bulletsPerShot}` })
        .where(eq(playerStats.playerId, player.id));

      // Task 11 replaces this stub with the resolution, log and events.
      return {
        status: 200,
        body: { hit: false, damage: 0, bulletsSpent: weapon.bulletsPerShot },
      };
    });
  },
});

export default definePlugin({
  id: "combat",
  version: "1.0.0",
  basePaths: ["/api/combat"],
  routes: [attackRoute],
});
