import { definePlugin, PluginError, type PluginTx, route } from "@gl3/plugin-sdk";
import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { ArmorEffectsSchema, ITEM_TYPE_ARMOR, ITEM_TYPE_WEAPON, WeaponEffectsSchema } from "./effects.js";
import { resolveShot, rollFor, type WeaponProfile } from "./resolve.js";
import { combatLog, items, players, playerStats, ranks } from "./schema.js";
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
  // an external boundary.
  if (!parsed.success) return unarmed;

  // The one field a migrated V2 item never carries — `itemEffects` has no
  // accuracy column. `??`, not `||`: a weapon that states `accuracy: 0` means
  // it, and `||` would silently upgrade it to the default.
  return { ...parsed.data, accuracy: parsed.data.accuracy ?? config.defaultWeaponAccuracy };
}

/**
 * The target's equipped armor rating, or 0 when unarmored, wrong-typed or
 * malformed. Same external-boundary reasoning as `loadWeapon`: `armor_item_id`
 * is an unconstrained FK to `items` and the jsonb is admin-editable, so an
 * unusable row means "no armor", never a 500 in the middle of a shot.
 */
async function loadArmor(tx: PluginTx, armorItemId: string | null): Promise<number> {
  if (armorItemId === null) return 0;
  const [row] = await tx.db
    .select({ effects: items.effects, itemType: items.itemType })
    .from(items)
    .where(eq(items.id, armorItemId));
  if (!row || row.itemType !== ITEM_TYPE_ARMOR) return 0;
  const parsed = ArmorEffectsSchema.safeParse(row.effects);
  return parsed.success ? parsed.data.armor : 0;
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
    // 4xx: releasing would be a check-then-act on Redis (CLAUDE.md rule 2),
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

      const targetArmor = await loadArmor(tx, target.armorItemId);
      const outcome = resolveShot(weapon, targetArmor, rollFor(weapon));

      const targetHealth = Math.max(0, target.health - outcome.damage);
      // Skipped on a zero-damage hit: armor held, so the row is unchanged and
      // there is nothing to write.
      if (outcome.damage > 0) {
        await tx.db
          .update(playerStats)
          .set({ health: targetHealth })
          .where(eq(playerStats.playerId, params.targetId));
      }

      // `outcome.damage > 0` is not redundant with the health check: a target
      // already at 0 health that the shot misses would otherwise read as a
      // fresh kill on every attempt, paying out repeatedly.
      const killed = targetHealth === 0 && outcome.damage > 0;
      let payout = 0n;

      if (killed) {
        // The killer takes the victim's entire ON-HAND cash; the bank is
        // untouched, which is what makes depositing real counterplay.
        // `target.cash` was read under the lock taken as this transaction's
        // first statement, so it cannot have moved — the transfer can never
        // overdraw and needs no InsufficientFundsError catch.
        payout = target.cash;
        // Skipped at zero rather than relying on whether a 0n change is a
        // no-op or writes a zero ledger row.
        if (payout > 0n) {
          await tx.economy.applyBalanceChange({
            playerId: params.targetId,
            amount: -payout,
            kind: "cash",
            reason: "combat.killed",
          });
          await tx.economy.applyBalanceChange({
            playerId: player.id,
            amount: payout,
            kind: "cash",
            reason: "combat.kill_payout",
          });
        }
        // Sets health = 0 alongside the deadline, so the health UPDATE above
        // is redundant on this path — both write 0. Left alone; a conditional
        // there would be a second branch for no gain.
        await tx.hospital.sendToHospital(params.targetId, config.hospitalSeconds);
      }

      await tx.db.insert(combatLog).values({
        id: uuidv7(),
        attackerId: player.id,
        targetId: params.targetId,
        hit: outcome.hit,
        damage: outcome.damage,
        fatal: killed,
        weaponItemId: attacker.weaponItemId,
        payout,
      });

      const [targetRow] = await tx.db
        .select({ username: players.username })
        .from(players)
        .where(eq(players.id, params.targetId));
      const targetName = targetRow?.username ?? "unknown";

      // Attacker AND victim, never global: a global audience would broadcast
      // every shot to every socket and leak position to anyone watching the
      // firehose. Two calls because `AudienceSchema` has no two-player kind.
      // A miss publishes too, with damage 0 — the victim needs to know
      // someone is shooting at them.
      //
      // Inside the transaction only in appearance: the loader buffers these
      // and publishes after commit, discarding them on rollback (SDK
      // `ctx.ts`), which is what keeps CLAUDE.md rule 5 satisfied while
      // preserving publish ORDER for the death events Task 12 adds after.
      for (const audienceId of [player.id, params.targetId]) {
        await tx.events.publishCore({
          type: "player.attacked",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: audienceId },
          targetId: params.targetId,
          targetName,
          damage: outcome.damage,
        });
      }

      if (killed) {
        // AFTER player.attacked, deliberately: the buffer preserves relative
        // call order all the way to the wire, and a client rendering "shot for
        // 500" then "killed" reads correctly while the reverse reads as a
        // corpse taking damage.
        for (const audienceId of [player.id, params.targetId]) {
          await tx.events.publishCore({
            type: "player.killed",
            actorId: player.id,
            actorName: player.username,
            audience: { kind: "player", playerId: audienceId },
            victimId: params.targetId,
            victimName: targetName,
          });
        }
      }

      return {
        status: 200,
        body: {
          hit: outcome.hit,
          crit: outcome.crit,
          damage: outcome.damage,
          armorAbsorbed: outcome.armorAbsorbed,
          targetHealth,
          targetKilled: killed,
          payout: payout.toString(),
          bulletsSpent: outcome.bulletsSpent,
        },
      };
    });
  },
});

/**
 * The caller's own fights, as attacker or as target. No jail or hospital gate
 * — both default to open in the SDK and are left that way deliberately: the
 * player most likely to read this is one who just woke up in hospital wanting
 * to know who put them there.
 */
const logRoute = route({
  method: "GET",
  path: "/api/combat/log",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    return ctx.transaction(async (tx) => {
      // Bounded from the start. GET /api/mail and GET /api/notifications are
      // both unbounded and unpaginated (docs/STATUS.md, open issue) — this
      // does not become the third. Both directions of the OR are indexed
      // (`combat_log_attacker_idx`, `combat_log_target_idx`, each on
      // (player, created_at)).
      const entries = await tx.db
        .select()
        .from(combatLog)
        .where(or(eq(combatLog.attackerId, player.id), eq(combatLog.targetId, player.id)))
        .orderBy(desc(combatLog.createdAt))
        .limit(50);

      return {
        status: 200,
        body: {
          entries: entries.map((e) => ({
            id: e.id,
            attackerId: e.attackerId,
            targetId: e.targetId,
            hit: e.hit,
            damage: e.damage,
            fatal: e.fatal,
            // Money crosses the wire as a decimal string, never a JSON number.
            payout: e.payout.toString(),
            createdAt: e.createdAt.toISOString(),
          })),
        },
      };
    });
  },
});

export default definePlugin({
  id: "combat",
  version: "1.0.0",
  basePaths: ["/api/combat"],
  routes: [attackRoute, logRoute],
});
