import { definePlugin, filterPoint, PluginError, type PluginTx, route } from "@gl3/plugin-sdk";
import { and, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { itemPriceAt } from "@gl3/plugin-inventory";
import { activeReportTargetIds } from "@gl3/plugin-detectives";
import { backfireChanceFor, effectiveCondition, PRISTINE, repairCostFor } from "./condition.js";
import { cooldownSecondsFor } from "./cooldown.js";
import { ArmorEffectsSchema, ITEM_TYPE_ARMOR, ITEM_TYPE_WEAPON, WeaponEffectsSchema } from "./effects.js";
import { COMBAT_MIGRATIONS } from "./migrations.js";
import { resolveShot, rollFor, type WeaponProfile } from "./resolve.js";
import { combatLog, items, locations, playerItems, players, playerStats, ranks, weaponCondition } from "./schema.js";
import { type CombatSettings, readCombatSettings } from "./settings.js";

// Re-exported from the manifest module rather than through an `exports`
// subpath: no other plugin has one, and the resolver is the only part of
// combat worth importing from outside (its tests run in the no-DB
// `@gl3/server:unit` project because it touches neither Postgres nor Redis).
export { resolveShot, rollFor } from "./resolve.js";
export type { Rolls, ShotOutcome, WeaponProfile } from "./resolve.js";
export { backfireChanceFor, effectiveCondition, PRISTINE, repairCostFor } from "./condition.js";
export { cooldownSecondsFor } from "./cooldown.js";
export type { CooldownBounds, CooldownProfile } from "./cooldown.js";
export { readCombatSettings } from "./settings.js";
export type { CombatSettings } from "./settings.js";

/**
 * Fired after a fatal attack's transaction has COMMITTED — the V2
 * `userKilled` hook. Filters run outside transactions (SDK rule): a
 * subscriber that moves money opens its own transaction, and a subscriber
 * that dies loses nothing durable — bounties' sweep, the first consumer,
 * stays open and the next kill claims it.
 */
export interface KillResolved { killerId: string; victimId: string }
export const killResolved = filterPoint<KillResolved>("combat.killResolved");

/**
 * One player's elapsed sentence, cleared inside the caller's lock. Duplicates
 * core's `settleHospital` because a plugin may not import from `apps/server`;
 * kept to the same two statements so the two cannot diverge in behaviour.
 *
 * Without this, an elapsed sentence is only settled by that player's own next
 * request — until then they sit at 0 health and are one hit from dying again.
 * Called for BOTH parties: the target for that reason, the attacker so the
 * re-check below cannot 423 someone whose sentence has already run out.
 */
async function settleHospitalIfElapsed(tx: PluginTx, targetId: string): Promise<void> {
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

/**
 * The current, time-aged condition of one weapon, and the row it came from.
 * A missing row is PRISTINE — every migrated player's weapons start there and
 * no backfill migration is needed.
 */
async function readCondition(
  tx: PluginTx,
  playerId: string,
  itemId: string,
  config: CombatSettings,
  now: Date,
): Promise<number> {
  const [row] = await tx.db
    .select()
    .from(weaponCondition)
    .where(and(eq(weaponCondition.playerId, playerId), eq(weaponCondition.itemId, itemId)));
  if (row === undefined) return PRISTINE;
  return effectiveCondition(
    row.condition, row.updatedAt, now,
    config.condition.decayPeriodSeconds, config.condition.decayPerPeriod,
  );
}

/**
 * The equipped weapon's stats, or the unarmed profile when nothing is
 * equipped. `condition` is the caller's already-aged (`effectiveCondition`)
 * reading for `weaponItemId`, PRISTINE when unarmed — this function stays
 * pure with respect to time, same as `resolve.ts`.
 */
async function loadWeapon(
  tx: PluginTx,
  weaponItemId: string | null,
  config: CombatSettings,
  condition: number,
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
    // Fists have no condition row and never backfire.
    backfireChance: 0,
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
  return {
    ...parsed.data,
    accuracy: parsed.data.accuracy ?? config.defaultWeaponAccuracy,
    backfireChance: backfireChanceFor(
      parsed.data.backfireChance ?? config.backfire.baseChance,
      condition,
      config.backfire.wearFactor,
    ),
  };
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

/**
 * How long this attacker's next cooldown lasts, read BEFORE the attack's own
 * transaction opens.
 *
 * The ordering is forced. The cooldown is claimed ahead of the transaction on
 * purpose — that is what stops a client spending nothing to discover who is
 * attackable — but its TTL now depends on the equipped weapon, which the
 * transaction does not load until well inside itself. So the weapon's pacing
 * is read here, in its own read-only transaction (the ctx exposes no database
 * outside one), taking no locks: one statement, joining the equipped item on
 * `player_stats`.
 *
 * A weapon swapped between this read and the shot gives a cooldown sized for
 * the old weapon. That is accepted: the alternative is claiming the cooldown
 * after the roll, which hands back the free probe. It costs one weapon swap's
 * worth of mis-pacing, once, to the player who did the swapping.
 *
 * Every fallback here mirrors `loadWeapon` — no row, a wrong item type, or
 * malformed jsonb all mean "unarmed" — so a weapon combat will treat as fists
 * is also paced as fists.
 */
async function cooldownForAttacker(
  ctx: { transaction: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T> },
  playerId: string,
  config: CombatSettings,
): Promise<number> {
  const unarmed = {
    damageMin: config.unarmed.damageMin,
    damageMax: config.unarmed.damageMax,
    dps: config.unarmed.dps,
  };

  const profile = await ctx.transaction(async (tx) => {
    const [row] = await tx.db
      .select({ effects: items.effects, itemType: items.itemType })
      .from(playerStats)
      .leftJoin(items, eq(items.id, playerStats.weaponItemId))
      .where(eq(playerStats.playerId, playerId));
    if (!row || row.itemType !== ITEM_TYPE_WEAPON) return unarmed;
    const parsed = WeaponEffectsSchema.safeParse(row.effects);
    if (!parsed.success) return unarmed;
    return parsed.data;
  });

  return cooldownSecondsFor(profile, config);
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
    //
    // Its length is the weapon's, not a flat number: `cooldownForAttacker`
    // divides the weapon's average damage by its declared dps. A weapon
    // declaring none — every migrated V2 item — still gets
    // `combat.cooldown_seconds`.
    const cooldownSeconds = await cooldownForAttacker(ctx, player.id, config);
    const acquired = await ctx.cooldown.acquire("combat.attack", player.id, cooldownSeconds);
    if (!acquired) {
      const remaining = await ctx.cooldown.peek("combat.attack", player.id);
      throw new PluginError("cooldown", 429, {}, { "retry-after": String(remaining) });
    }

    const result = await ctx.transaction(async (tx) => {
      // FIRST statement. Ascending UUID via the shared helper, which is what
      // makes A-shoots-B and B-shoots-A safe against each other (no ABBA).
      await tx.locks.player([player.id, params.targetId]);

      // Both settled HERE, inside the lock. A target whose sentence just
      // elapsed otherwise sits at health 0 and is instantly re-killable; the
      // attacker is settled so the re-check below reads a current row rather
      // than a stale sentence the loader gate would have cleared.
      await settleHospitalIfElapsed(tx, params.targetId);
      await settleHospitalIfElapsed(tx, player.id);

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
      // The attacker's own sentence, re-checked under the lock. The loader
      // gate (`plugins/routes.ts`) runs BEFORE the transaction, so between it
      // and these locks the victim's gangmate can hospitalise or jail the
      // attacker — and the shot fires anyway. Same 423 + code the gate would
      // have sent, so a caller cannot tell which layer refused.
      if (attacker.hospitalUntil && attacker.hospitalUntil.getTime() > now) {
        throw new PluginError("hospitalised", 423);
      }
      if (attacker.jailedUntil && attacker.jailedUntil.getTime() > now) {
        throw new PluginError("jailed", 423);
      }
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

      // Underground towns are V2's rule: unshootable without a live detective
      // report. AFTER same_gang/protected so town mode never leaks through
      // error-ordering differences. Both reads are plain SELECTs — no lock,
      // no new edge (spec §1 rule-6 audit). attacker.locationId is non-null
      // here: target_elsewhere above already threw on null.
      const [town] = await tx.db
        .select({ combatMode: locations.combatMode })
        .from(locations)
        .where(eq(locations.id, attacker.locationId));
      if (town?.combatMode === "underground") {
        const reported = await activeReportTargetIds(tx, player.id, new Date());
        if (!reported.has(params.targetId)) {
          throw new PluginError("no_detective_report", 409);
        }
      }

      // Read once, used three times: to scale backfire chance, to compute the
      // value written back after the shot, and to answer the response. `now`
      // is captured once so the decay a shot observes and the decay it writes
      // cannot straddle a period boundary.
      const shotAt = new Date();
      const currentCondition = attacker.weaponItemId === null
        ? PRISTINE
        : await readCondition(tx, player.id, attacker.weaponItemId, config, shotAt);

      const weapon = await loadWeapon(tx, attacker.weaponItemId, config, currentCondition);
      if (attacker.bullets < BigInt(weapon.bulletsPerShot)) {
        throw new PluginError("insufficient_bullets", 409);
      }

      await tx.db
        .update(playerStats)
        .set({ bullets: sql`${playerStats.bullets} - ${weapon.bulletsPerShot}` })
        .where(eq(playerStats.playerId, player.id));

      const targetArmor = await loadArmor(tx, target.armorItemId);
      const outcome = resolveShot(weapon, targetArmor, rollFor(weapon));

      // Every shot wears the weapon, hit or miss or backfire: as with bullets,
      // the cost is firing, not connecting.
      //
      // `updated_at = shotAt` resets the time-decay clock, deliberately. Time
      // decay models rust from disuse and use decay models firing; a player
      // who shoots constantly accrues only the latter, one who never shoots
      // only the former. Both reach zero and neither double-counts.
      if (attacker.weaponItemId !== null) {
        const nextCondition = Math.max(0, currentCondition - config.condition.wearPerShot);
        await tx.db
          .insert(weaponCondition)
          .values({
            playerId: player.id,
            itemId: attacker.weaponItemId,
            condition: nextCondition,
            updatedAt: shotAt,
          })
          .onConflictDoUpdate({
            target: [weaponCondition.playerId, weaponCondition.itemId],
            set: { condition: nextCondition, updatedAt: shotAt },
          });
      }

      if (outcome.backfire) {
        const attackerHealth = Math.max(0, attacker.health - outcome.selfDamage);
        await tx.db
          .update(playerStats)
          .set({
            health: attackerHealth,
            backfire: sql`${playerStats.backfire} + 1`,
          })
          .where(eq(playerStats.playerId, player.id));

        const hospitalised = attackerHealth === 0;
        // No existing path hospitalises the ATTACKER — every other call sends
        // the victim. Sets health = 0 alongside the deadline, so the UPDATE
        // above is redundant on this path; left alone, as the kill path does.
        if (hospitalised) {
          await tx.hospital.sendToHospital(player.id, config.hospitalSeconds);
        }

        // The log answers "who shot at me", and someone did.
        await tx.db.insert(combatLog).values({
          id: uuidv7(),
          attackerId: player.id,
          targetId: params.targetId,
          hit: false,
          damage: 0,
          fatal: false,
          weaponItemId: attacker.weaponItemId,
          payout: 0n,
        });

        // Attacker only. The target has no way of knowing your gun jammed,
        // and telling them is information the attacker did not choose to give.
        await tx.events.publishCore({
          type: "player.backfired",
          actorId: player.id,
          actorName: player.username,
          audience: { kind: "player", playerId: player.id },
          selfDamage: outcome.selfDamage,
          hospitalised,
        });

        // Returns early, so the target's health is never written, no kill is
        // evaluated, no payout moves, and `killResolved` never runs —
        // a backfire cannot claim a bounty.
        return {
          status: 200,
          body: {
            hit: false, crit: false, damage: 0, armorAbsorbed: 0,
            targetHealth: target.health, targetKilled: false,
            payout: "0", bulletsSpent: outcome.bulletsSpent,
            backfire: true, selfDamage: outcome.selfDamage, attackerHealth,
          },
        };
      }

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
      // `ctx.ts`), which is what keeps NOTES.md rule 5 satisfied while
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
          backfire: false,
          selfDamage: 0,
          attackerHealth: attacker.health,
        },
      };
    });

    if (result.body.targetKilled) {
      try {
        await ctx.filters.apply(killResolved, { killerId: player.id, victimId: params.targetId });
      } catch (err) {
        // The kill is already committed and earned; a subscriber's failure is
        // its own problem. Log and return the response the transaction built.
        ctx.log.error("combat.killResolved subscriber failed", { error: String(err) });
      }
    }

    return result;
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

/**
 * Who the caller could shoot, here, right now.
 *
 * Read-only: no locks, no cooldown consumed. That last part is the point of
 * the route. `attack` claims its Redis cooldown BEFORE the transaction and
 * deliberately never releases it on a 4xx, so firing at an illegal target
 * costs the attacker a full cooldown. A pre-evaluated list is what stops the
 * UI from spending a player's cooldown to discover a rule.
 *
 * ADVISORY ONLY. `attack` re-checks every rule under the lock; nothing here is
 * trusted. `target_elsewhere` has no `reason` because such a player is simply
 * absent from the list.
 *
 * Does NOT evaluate the CALLER's own `hospitalUntil`/`jailedUntil` — only
 * each row's. `attack` checks the attacker's own sentence first (423,
 * before ever looking at the target: lines 147-152 above) and this route has
 * no reason member for that in the brief's `TargetReason` enum, so a
 * hospitalised or jailed caller (this route sets neither `accessInJail` nor
 * `accessInHospital`, so both default to open — see `logRoute`'s comment)
 * sees ordinary rows here that `attack` would still 423 on their own status
 * alone. That gap does not cost a cooldown either way — the loader gate and
 * `attack`'s own re-check both run before the Redis claim — so the advisory
 * purpose (never spend a cooldown to learn a rule) still holds; it is only
 * this route's per-target `hospitalised`/`jailed` reasons that reuse those
 * names for the TARGET's sentence, matching `attack`'s `target_hospitalised`/
 * `target_jailed` 409s, not its own-status 423s.
 *
 * Bounded at 50 and NOT paginated — the same deliberate limitation
 * GET /api/combat/log has, recorded here rather than discovered later.
 */
const targetsRoute = route({
  method: "GET",
  path: "/api/combat/targets",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);

    const config = readCombatSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      const [me] = await tx.db
        .select()
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      if (!me) throw new PluginError("unauthorized", 401);
      if (me.locationId === null) return { status: 200, body: { mode: "open" as const, targets: [] } };

      const [town] = await tx.db
        .select({ combatMode: locations.combatMode })
        .from(locations)
        .where(eq(locations.id, me.locationId));
      const mode = town?.combatMode === "underground" ? "underground" as const : "open" as const;

      // Underground: the report set becomes a SQL predicate BEFORE the
      // LIMIT — a post-limit filter would hide a legally attackable reported
      // player ranked below 50th by exp in a crowded town. The set is small
      // (the tracker caps at 100 searches), so the IN list is cheap.
      let reportedIds: string[] | null = null;
      if (mode === "underground") {
        const reported = await activeReportTargetIds(tx, player.id, new Date());
        if (reported.size === 0) return { status: 200, body: { mode, targets: [] } };
        reportedIds = [...reported];
      }

      const rows = await tx.db
        .select({
          playerId: playerStats.playerId,
          username: players.username,
          rank: ranks.name,
          health: playerStats.health,
          maxHealth: ranks.maxHealth,
          gangId: playerStats.gangId,
          exp: playerStats.exp,
          jailedUntil: playerStats.jailedUntil,
          hospitalUntil: playerStats.hospitalUntil,
        })
        .from(playerStats)
        .innerJoin(players, eq(players.id, playerStats.playerId))
        .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
        .where(and(
          eq(playerStats.locationId, me.locationId),
          ne(playerStats.playerId, player.id),
          ...(reportedIds === null ? [] : [inArray(playerStats.playerId, reportedIds)]),
        ))
        .orderBy(desc(playerStats.exp))
        .limit(50);

      const now = Date.now();
      // The caller being under the threshold makes EVERY row illegal —
      // protection is mutual, so a newbie can neither be attacked nor attack.
      const selfProtected = me.exp < config.newbieExpThreshold;

      return {
        status: 200,
        body: {
          mode,
          targets: rows.map((row) => {
            // Evaluated in the same order attack's PER-TARGET checks run
            // (hospitalised/jailed here read the ROW's own sentence, same as
            // attack's target_hospitalised/target_jailed). The caller's OWN
            // sentence is not represented at all — see the docblock above.
            const reason =
              row.hospitalUntil && row.hospitalUntil.getTime() > now ? "hospitalised"
              : row.jailedUntil && row.jailedUntil.getTime() > now ? "jailed"
              : me.gangId !== null && me.gangId === row.gangId ? "gang_mate"
              : selfProtected ? "newbie_self"
              : row.exp < config.newbieExpThreshold ? "newbie_protected"
              : null;
            return {
              playerId: row.playerId,
              username: row.username,
              rank: row.rank,
              health: row.health,
              // 100 matches core's ranks.max_health default and
              // hospital/status.ts's DEFAULT_MAX_HEALTH, used when the player
              // has no rank row yet. A plugin cannot import that constant from
              // apps/server, so the two are kept in step by hand.
              maxHealth: row.maxHealth ?? 100,
              attackable: reason === null,
              // null, not absent, when attackable: a nullable field is
              // friendlier to zod and to exactOptionalPropertyTypes than an
              // optional one, and the DTO stays a closed union plus null.
              reason,
            };
          }),
        },
      };
    });
  },
});

/**
 * What the combat page shows above the target list. Read-only, so it takes no
 * lock and opens no write. Fists report pristine, zero chance and zero cost:
 * there is nothing to wear and nothing to repair.
 */
const weaponRoute = route({
  method: "GET",
  path: "/api/combat/weapon",
  handler: async (ctx) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readCombatSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      const [stats] = await tx.db
        .select({ weaponItemId: playerStats.weaponItemId, locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const itemId = stats?.weaponItemId ?? null;
      if (itemId === null) {
        return {
          status: 200,
          body: {
            itemId: null, name: null, condition: PRISTINE,
            backfireChance: 0, repairCost: "0",
          },
        };
      }

      const [item] = await tx.db
        .select({ name: items.name, itemType: items.itemType, effects: items.effects })
        .from(items)
        .where(eq(items.id, itemId));
      const condition = await readCondition(tx, player.id, itemId, config, new Date());
      const parsed = item === undefined || item.itemType !== ITEM_TYPE_WEAPON
        ? undefined
        : WeaponEffectsSchema.safeParse(item.effects);
      const base = parsed?.success === true
        ? parsed.data.backfireChance ?? config.backfire.baseChance
        : 0;

      const price = await itemPriceAt(tx, itemId, stats?.locationId ?? null);
      return {
        status: 200,
        body: {
          itemId,
          name: item?.name ?? null,
          condition,
          backfireChance: backfireChanceFor(base, condition, config.backfire.wearFactor),
          repairCost: repairCostFor(
            price, PRISTINE - condition, config.repair.costMultiplier, config.repair.costPerPoint,
          ).toString(),
        },
      };
    });
  },
});

/**
 * The gunsmith. A full 0→100 repair costs `repair.cost_multiplier` × the
 * weapon's shop price, prorated by points restored (`repairCostFor`). `items`
 * has no value column — price lives in `p_inventory_shop_stock` — so the
 * price comes through inventory's exported `itemPriceAt` (local listing
 * first, else cheapest anywhere), the plugin→plugin helper shape properties'
 * `ownerAt` established rather than a cross-plugin table read. A weapon no
 * shop lists falls back to the flat `repair.cost_per_point` rate.
 *
 * No cooldown: cost is the limiter, and a cooldown would mean a Redis key,
 * which would mean rule 2's SET NX EX discipline for no gameplay gain.
 *
 * Reachable in hospital. You are not shooting anyone; you are fixing a gun.
 */
const repairRoute = route({
  method: "POST",
  path: "/api/combat/repair",
  accessInJail: false,
  accessInHospital: true,
  body: z.object({ itemId: z.string().uuid() }),
  handler: async (ctx, { body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    const config = readCombatSettings((key) => ctx.settings.get(key));

    return ctx.transaction(async (tx) => {
      // Player-only lock. Nothing here touches a gang, a location or a second
      // player, so this adds no edge to rule 6's graph.
      await tx.locks.player([player.id]);

      // Ownership, not equipment: a weapon in the bag can be repaired.
      const [owned] = await tx.db
        .select({ qty: playerItems.qty, itemType: items.itemType })
        .from(playerItems)
        .innerJoin(items, eq(items.id, playerItems.itemId))
        .where(and(eq(playerItems.playerId, player.id), eq(playerItems.itemId, body.itemId)));
      if (owned === undefined || owned.qty <= 0 || owned.itemType !== ITEM_TYPE_WEAPON) {
        throw new PluginError("weapon_not_found", 404);
      }

      const now = new Date();
      const current = await readCondition(tx, player.id, body.itemId, config, now);
      const restored = PRISTINE - current;
      // Not an error: repairing a pristine weapon is a no-op, and charging
      // zero would still write a ledger row.
      if (restored === 0) return { status: 204 };

      const [stats] = await tx.db
        .select({ cash: playerStats.cash, locationId: playerStats.locationId })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const price = await itemPriceAt(tx, body.itemId, stats?.locationId ?? null);
      const cost = repairCostFor(
        price, restored, config.repair.costMultiplier, config.repair.costPerPoint,
      );
      // Checked under the lock taken as this transaction's first statement,
      // so the balance cannot move between the check and the debit.
      if (stats === undefined || stats.cash < cost) {
        throw new PluginError("insufficient_funds", 409);
      }

      if (cost > 0n) {
        await tx.economy.applyBalanceChange({
          playerId: player.id,
          amount: -cost,
          kind: "cash",
          reason: "combat.repair",
        });
      }

      await tx.db
        .insert(weaponCondition)
        .values({ playerId: player.id, itemId: body.itemId, condition: PRISTINE, updatedAt: now })
        .onConflictDoUpdate({
          target: [weaponCondition.playerId, weaponCondition.itemId],
          set: { condition: PRISTINE, updatedAt: now },
        });

      return { status: 200, body: { condition: PRISTINE, cost: cost.toString() } };
    });
  },
});

export default definePlugin({
  id: "combat",
  version: "1.0.0",
  basePaths: ["/api/combat"],
  migrations: COMBAT_MIGRATIONS,
  routes: [attackRoute, logRoute, targetsRoute, weaponRoute, repairRoute],
  provides: [killResolved],
});
