import {
  clampDiscountBp, coreActionCost, coreHospitalStay, definePlugin, filterPoint, hospitalDiscountFor, on,
  type PageSchema, PluginError, type Pool, type PluginCtx, type PluginTx, type ProgressionModel, route,
} from "@gl3/plugin-sdk";
import { and, desc, eq, gt, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { itemActions, itemPriceAt } from "@gl3/plugin-inventory";
import { activeReportTargetIds } from "@gl3/plugin-detectives";
import { backfireChanceFor, effectiveCondition, PRISTINE, repairCostFor } from "./condition.js";
import { cooldownSecondsFor } from "./cooldown.js";
import { ArmorEffectsSchema, ITEM_TYPE_ARMOR, ITEM_TYPE_WEAPON, MeleeEffectsSchema, WeaponEffectsSchema } from "./effects.js";
import { COMBAT_MIGRATIONS } from "./migrations.js";
import { resolveMeleeStrike, resolveShot, rollFor, rollMelee, type WeaponProfile } from "./resolve.js";
import { combatLog, items, locations, playerItems, players, playerStats, ranks, settings, weaponCondition } from "./schema.js";
import { type CombatSettings, readCombatSettings } from "./settings.js";

// Re-exported from the manifest module rather than through an `exports`
// subpath: no other plugin has one, and the resolver is the only part of
// combat worth importing from outside (its tests run in the no-DB
// `@gl3/server:unit` project because it touches neither Postgres nor Redis).
export { resolveMeleeStrike, resolveShot, rollFor, rollMelee } from "./resolve.js";
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
export const killResolved = filterPoint<KillResolved>("combat.killResolved", "propagate");

/**
 * Who in an UNDERGROUND town is visible without a detective report. The
 * attack gate and the targets list seed `{ locationId, exposed: [] }` and a
 * subscriber appends player ids that are fair game there — territory adds
 * every member of a gang whose heat in that town is over its threshold:
 * holding turf makes you visible. Ids not standing in `locationId` are
 * harmless (the list query is already town-scoped; the attack gate has
 * already refused `target_elsewhere`). "collect": a throwing subscriber
 * exposes nobody, which is the town's own rule.
 */
export interface ExposureQuote { readonly locationId: string; readonly exposed: readonly string[] }
export const exposure = filterPoint<ExposureQuote>("combat.exposure", "collect");

/**
 * A hospital stay after `core.hospitalStay` has had its say — the discount a
 * subscriber quotes (territory's speakeasy perk), clamped, floored, never
 * below one second. Applied in-transaction on the two paths that sentence
 * someone, not per shot: a chain per hospitalisation, not per trigger pull.
 */
async function hospitalStayFor(ctx: PluginCtx, playerId: string, baseSeconds: number): Promise<number> {
  const quoted = await ctx.filters.apply(coreHospitalStay, { entries: [{ playerId, discountBp: 0 }] });
  const bp = clampDiscountBp(hospitalDiscountFor(quoted, playerId));
  return Math.max(1, Math.floor((baseSeconds * (10_000 - bp)) / 10_000));
}

/**
 * How long one attacker→target engagement lasts for alert purposes. Events
 * over the WS are ephemeral (Redis pubsub drops them for an offline victim),
 * so the opening shot of an engagement and a death each write a persistent
 * notification via `tx.notify` — and ONLY those two, because combat is
 * multi-shot whittling and per-shot alerts would bury the feed the combat
 * log already serves. A quiet hour against the same target starts a new
 * engagement and alerts again.
 */
const ENGAGEMENT_WINDOW_MS = 30 * 60 * 1000;

/**
 * Duplicated from `@gl3/plugin-crimes` rather than shared through the SDK —
 * two implementations of one small job, not worth widening the SDK's public
 * surface (and the version bump that would come with it) for. Keep the two
 * in sync by hand if the pool set ever changes.
 */
const POOLS = ["energy", "will", "brave"] as const satisfies readonly Pool[];

/**
 * Positive-amount entries only, in fixed pool order. `costs` comes back from
 * `core.actionCost` with whatever subscribers chose to add; an empty or
 * all-zero map is what "no attribute plugin installed" (or "installed but
 * this action is unpriced") looks like. Typed against the fixed `POOLS`
 * tuple rather than `Object.entries` + a cast — `packages/*` forbids casts,
 * and `Object.entries` widens the key back to `string` regardless.
 */
function pricedEntries(costs: Partial<Record<Pool, number>>): [Pool, number][] {
  return POOLS
    .map((pool) => [pool, costs[pool]] as const)
    .filter((entry): entry is [Pool, number] => typeof entry[1] === "number" && entry[1] > 0);
}

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
    .select({
      hospitalUntil: playerStats.hospitalUntil,
      healthMaxOverride: playerStats.healthMax,
      maxHealth: ranks.maxHealth,
    })
    .from(playerStats)
    .leftJoin(ranks, eq(ranks.id, playerStats.rankId))
    .where(eq(playerStats.playerId, targetId));
  if (!row?.hospitalUntil) return;
  if (row.hospitalUntil.getTime() > Date.now()) return;
  await tx.db
    .update(playerStats)
    // health_max ?? rank cap ?? 100 — core's resolution order (auth/routes.ts,
    // hospital/status.ts); discharging a gym-trained 500-cap player at the
    // rank's 100 sent them out at a fifth of their real health.
    .set({ hospitalUntil: null, health: row.healthMaxOverride ?? row.maxHealth ?? 100 })
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
  // Fists as a melee model (`combat.unarmed.model = melee`, seeded on gl3):
  // the stat-driven arm with `unarmed.power`, no bullets, no wear, no
  // backfire — a trained player's bare hands scale like a knife would.
  // No name: the response reports "fists" by `weaponUsedItemId === null`.
  const fists: WeaponProfile = config.unarmed.model === "melee"
    ? {
      accuracy: 100, damageMin: 0, damageMax: 0, bulletsPerShot: 0,
      critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
      backfireChance: 0, model: "melee", power: config.unarmed.power,
    }
    : unarmed;
  if (weaponItemId === null) return fists;

  const [row] = await tx.db
    .select({ effects: items.effects, itemType: items.itemType, name: items.name })
    .from(items)
    .where(eq(items.id, weaponItemId));
  if (!row || row.itemType !== ITEM_TYPE_WEAPON) return fists;

  // Melee first (C6): `power` in the effects IS the melee marker — those
  // items have no damage range for the firearm schema to require. A melee
  // weapon consumes no ammunition and never wears or backfires (MCCodes
  // parity: melee never ran dry or rusted); the zeroed firearm fields keep
  // every shared downstream read inert.
  const melee = MeleeEffectsSchema.safeParse(row.effects);
  if (melee.success) {
    return {
      accuracy: 100, damageMin: 0, damageMax: 0, bulletsPerShot: 0,
      critChance: 0, critMultiplier: 1, armorPierce: 0, minRankExp: 0,
      backfireChance: 0,
      model: "melee" as const,
      power: melee.data.power,
      name: row.name,
    };
  }

  const parsed = WeaponEffectsSchema.safeParse(row.effects);
  // A malformed weapon falls back to unarmed rather than 500ing: the jsonb is
  // an external boundary.
  if (!parsed.success) return fists;

  // The one field a migrated V2 item never carries — `itemEffects` has no
  // accuracy column. `??`, not `||`: a weapon that states `accuracy: 0` means
  // it, and `||` would silently upgrade it to the default.
  return {
    ...parsed.data,
    name: row.name,
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
    // Melee-model fists have no damage range or dps to pace by — flat
    // cooldown, exactly like a melee weapon below.
    dps: config.unarmed.model === "melee" ? undefined : config.unarmed.dps,
  };

  const profile = await ctx.transaction(async (tx) => {
    const [row] = await tx.db
      .select({ effects: items.effects, itemType: items.itemType })
      .from(playerStats)
      .leftJoin(items, eq(items.id, playerStats.weaponItemId))
      .where(eq(playerStats.playerId, playerId));
    if (!row || row.itemType !== ITEM_TYPE_WEAPON) return unarmed;
    // A melee weapon has no dps or damage range to pace by — it falls to
    // the flat cooldown, exactly like a migrated V2 weapon (loadWeapon's
    // fallback shape).
    if (MeleeEffectsSchema.safeParse(row.effects).success) return unarmed;
    const parsed = WeaponEffectsSchema.safeParse(row.effects);
    if (!parsed.success) return unarmed;
    return parsed.data;
  });

  return cooldownSecondsFor(profile, config);
}

/**
 * The per-attack weapon choice. `firearm` is slot 1 whatever it holds —
 * fists when empty, exactly as an absent field resolves an empty slot 1 —
 * and `melee` is the melee slot, refused (`no_melee_weapon`) when it is
 * empty rather than silently falling back to slot 1: a player who chose to
 * strike must never be surprised by a gunshot and a bullet bill. Absent
 * keeps the B0 precedence below byte-identical. The whole body is optional
 * because every pre-existing caller sends none.
 */
const WeaponChoiceSchema = z.enum(["firearm", "melee"]);
const AttackBodySchema = z.object({ weapon: WeaponChoiceSchema.optional() }).optional();

const attackRoute = route({
  method: "POST",
  path: "/api/combat/attack/:targetId",
  accessInJail: false,
  accessInHospital: false,
  params: z.object({ targetId: z.string().uuid() }),
  body: AttackBodySchema,
  handler: async (ctx, { params, body }) => {
    const player = ctx.player;
    if (player === null) throw new PluginError("unauthorized", 401);
    if (params.targetId === player.id) throw new PluginError("self_attack", 400);
    const choice = body?.weapon ?? null;

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
      if (isNewbie(attacker, config, ctx.progression) || isNewbie(target, config, ctx.progression)) {
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
          // Second chance: the target may be EXPOSED (combat.exposure) —
          // applied only when the report set already said no, so a boot with
          // no subscriber pays nothing here.
          const quoted = await ctx.filters.apply(exposure, { locationId: attacker.locationId, exposed: [] });
          if (!quoted.exposed.includes(params.targetId)) {
            throw new PluginError("no_detective_report", 409);
          }
        }
      }

      // Plain SELECT on a table this transaction inserts into anyway — no
      // lock, no new edge. Read BEFORE this shot's own log row goes in, so
      // the shot cannot see itself as a prior engagement.
      const [priorShot] = await tx.db
        .select({ id: combatLog.id })
        .from(combatLog)
        .where(and(
          eq(combatLog.attackerId, player.id),
          eq(combatLog.targetId, params.targetId),
          gt(combatLog.createdAt, new Date(now - ENGAGEMENT_WINDOW_MS)),
        ))
        .limit(1);
      const opensEngagement = priorShot === undefined;

      // Read once, used three times: to scale backfire chance, to compute the
      // value written back after the shot, and to answer the response. `now`
      // is captured once so the decay a shot observes and the decay it writes
      // cannot straddle a period boundary.
      const shotAt = new Date();
      const currentCondition = attacker.weaponItemId === null
        ? PRISTINE
        : await readCondition(tx, player.id, attacker.weaponItemId, config, shotAt);

      // Initiation energy (C6, audit §7 item 13): MCCodes' charge — 50% of
      // max energy, ONCE per engagement (the opening shot), never per shot.
      // Registry-consulted self-pricing, exactly like crimes' brave: the
      // amount is a fraction of this player's own max, which no generic
      // actionCost subscriber could compute. Filter subscribers below stay
      // per-shot. Refused here, the cooldown stays burned — same anti-probe
      // rule every other 4xx in this route follows.
      if (opensEngagement && ctx.attributePools.get("energy") !== null) {
        const attrs = await tx.attributes.read(player.id);
        const initiation = Math.floor(attrs.energyMax / 2);
        if (attrs.energy < initiation) throw new PluginError("insufficient_energy", 409);
        await tx.attributes.spend(player.id, "energy", initiation);
      }

      const slot1 = await loadWeapon(tx, attacker.weaponItemId, config, currentCondition);

      // B0 §2.1 precedence: slot 1 (the firearm slot) is authoritative — a
      // weapon there decides the model (gun → firearm path; a melee item →
      // C6's melee arm). The melee slot fires only when slot 1 is EMPTY.
      // Both armed = the firearm resolves the action: MCCodes' random
      // both-weapons-per-round is dead by audit item 9, and this documented
      // divergence keeps every GL3-native and V2-migrated boot byte-identical
      // (their melee slot is forever NULL). The equip route gates this slot
      // to melee models; a hand-edited non-melee row is an external boundary
      // and means "unarmed", never a firearm firing from the melee slot.
      //
      // An explicit choice overrides that precedence: `melee` fires the
      // melee slot even beside a loaded gun (409 when the slot is empty —
      // the melee-slot equip gate means an armed slot always parses as
      // melee, so a non-parsing row there is the same external-boundary
      // case as above and reads as empty); `firearm` is slot 1, fists
      // included. The 409 is thrown inside the transaction like every other
      // refusal here, so the cooldown stays burned.
      let weapon = slot1;
      let meleeFired = false;
      if (choice === "melee") {
        const offhand = attacker.weaponMeleeItemId === null
          ? null
          : await loadWeapon(tx, attacker.weaponMeleeItemId, config, PRISTINE);
        if (offhand === null || offhand.model !== "melee") throw new PluginError("no_melee_weapon", 409);
        weapon = offhand;
        meleeFired = true;
      } else if (choice === null && attacker.weaponItemId === null && attacker.weaponMeleeItemId !== null) {
        const offhand = await loadWeapon(tx, attacker.weaponMeleeItemId, config, PRISTINE);
        if (offhand.model === "melee") { weapon = offhand; meleeFired = true; }
      }
      // Which item the log rows credit: the melee slot when it fired, else
      // slot 1 when armed, else fists.
      const weaponUsedItemId = meleeFired
        ? attacker.weaponMeleeItemId
        : attacker.weaponItemId;
      // What the response names. A melee item still sitting in slot 1 (a
      // row equipped before the slot-1 gate refused them) reports "melee":
      // the model is what resolved, and that is what the player is told.
      const weaponUsed: "firearm" | "melee" | "fists" = weaponUsedItemId === null
        ? "fists"
        : weapon.model === "melee" ? "melee" : "firearm";
      const weaponName = weaponUsedItemId === null ? null : weapon.name ?? null;

      if (attacker.bullets < BigInt(weapon.bulletsPerShot)) {
        throw new PluginError("insufficient_bullets", 409);
      }

      // Priced here, deliberately last: AFTER every check above that can
      // refuse with a 4xx (target/legality checks, the underground/
      // detective-report gate, and insufficient_bullets just above), and
      // immediately BEFORE the first mutation of game state (the bullets
      // deduction right below). Energy is a regenerating resource, not the
      // anti-probe cooldown — the cooldown was already claimed before this
      // transaction opened and deliberately burns on every one of those
      // refusals, so eligibility probing stays priced through that
      // mechanism without this pool being double-charged for a shot that
      // was never going to fire.
      const cost = await ctx.filters.apply(coreActionCost, { action: "combat.attack", costs: {} });
      const priced = pricedEntries(cost.costs);
      if (priced.length > 0) {
        // `tx.locks.player([player.id, params.targetId])` is already this
        // transaction's first statement, so the attacker's row is held
        // FOR UPDATE — no new lock, no new lock-graph edge.
        for (const [pool, amount] of priced) {
          await tx.attributes.spend(player.id, pool, amount);
        }
      }

      await tx.db
        .update(playerStats)
        .set({ bullets: sql`${playerStats.bullets} - ${weapon.bulletsPerShot}` })
        .where(eq(playerStats.playerId, player.id));

      const targetArmor = await loadArmor(tx, target.armorItemId);
      // The weapon carries its model (C6): firearms resolve by accuracy,
      // melee by the stats — power × strength ÷ (guard/1.5), agility-ratio
      // hit clamp, d40 crits. Same ShotOutcome shape downstream either way.
      const outcome = weapon.model === "melee"
        ? resolveMeleeStrike({
          power: weapon.power ?? 0,
          attStrength: Number(attacker.strength), attAgility: Number(attacker.agility),
          defGuard: Number(target.guard), defAgility: Number(target.agility),
          targetArmor,
        }, rollMelee())
        : resolveShot(weapon, targetArmor, rollFor(weapon));

      // Every shot wears the weapon, hit or miss or backfire: as with bullets,
      // the cost is firing, not connecting.
      //
      // `updated_at = shotAt` resets the time-decay clock, deliberately. Time
      // decay models rust from disuse and use decay models firing; a player
      // who shoots constantly accrues only the latter, one who never shoots
      // only the former. Both reach zero and neither double-counts.
      if (attacker.weaponItemId !== null && !meleeFired && weapon.model !== "melee") {
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
          await tx.hospital.sendToHospital(player.id, await hospitalStayFor(ctx, player.id, config.hospitalSeconds));
        }

        // The log answers "who shot at me", and someone did.
        await tx.db.insert(combatLog).values({
          id: uuidv7(),
          attackerId: player.id,
          targetId: params.targetId,
          hit: false,
          damage: 0,
          fatal: false,
          weaponItemId: weaponUsedItemId,
          payout: 0n,
        });

        // The log row above answers "who shot at me", so the opening-shot
        // alert carries that same fact and nothing more — the jam stays the
        // attacker's secret (the backfired EVENT below is attacker-only).
        if (opensEngagement) {
          await tx.notify(
            params.targetId,
            `${player.username} attacked you — check your combat log for details.`,
          );
        }

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
            weapon: weaponUsed, weaponName,
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
          // BOTH legs post under ONE reason: this is a transfer, and the
          // economy dashboard's net-by-reason can only see that if the pair
          // nets to ~0 on a single reason. Split reasons (the victim's leg
          // once posted as `combat.killed`) rendered one transfer as a giant
          // faucet AND a giant sink. Pre-fix ledger rows keep the old string;
          // they age out of the 30-day window on their own.
          await tx.economy.applyBalanceChange({
            playerId: params.targetId,
            amount: -payout,
            kind: "cash",
            reason: "combat.kill_payout",
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
        await tx.hospital.sendToHospital(
          params.targetId, await hospitalStayFor(ctx, params.targetId, config.hospitalSeconds),
        );
      }

      await tx.db.insert(combatLog).values({
        id: uuidv7(),
        attackerId: player.id,
        targetId: params.targetId,
        hit: outcome.hit,
        damage: outcome.damage,
        fatal: killed,
        weaponItemId: weaponUsedItemId,
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

      // Persistent, unlike everything published above: pubsub reaches only
      // live sockets, and the player most in need of these is offline. Death
      // supersedes the opening-shot alert — a one-shot kill sends ONE row.
      if (killed) {
        await tx.notify(
          params.targetId,
          `You were killed by ${player.username} and taken to hospital — check your combat log for details.`,
        );
      } else if (opensEngagement) {
        await tx.notify(
          params.targetId,
          `${player.username} attacked you — check your combat log for details.`,
        );
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
          weapon: weaponUsed,
          weaponName,
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
/**
 * The newbie gate, branched on the boot's progression model. On an unrouted
 * boot `exp` is lifetime and the exp threshold is the measure. On a routed
 * boot `exp` is WITHIN-level — it resets to 0 at every level-up — so the
 * same comparison made every player a permanent newbie and nobody could
 * shoot anyone; `level` is the figure that only ever grows there.
 */
function isNewbie(
  row: { exp: bigint; level: number },
  config: CombatSettings,
  progression: ProgressionModel,
): boolean {
  return progression === "level"
    ? row.level < config.newbieLevelThreshold
    : row.exp < config.newbieExpThreshold;
}

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
      // player ranked below 50th by exp in a crowded town. Nothing bounds
      // this set structurally, but it stays small in practice — reports cost
      // cash to place and expire on their own — so the IN list is cheap.
      let reportedIds: string[] | null = null;
      if (mode === "underground") {
        const reported = await activeReportTargetIds(tx, player.id, new Date());
        // Plus whoever the town exposes on its own (combat.exposure) — the
        // union is the visible set, and it goes into the SQL predicate
        // below for the same pre-LIMIT reason the report set does.
        const quoted = await ctx.filters.apply(exposure, { locationId: me.locationId, exposed: [] });
        const visible = new Set([...reported, ...quoted.exposed]);
        if (visible.size === 0) return { status: 200, body: { mode, targets: [] } };
        reportedIds = [...visible];
      }

      const rows = await tx.db
        .select({
          playerId: playerStats.playerId,
          username: players.username,
          rank: ranks.name,
          health: playerStats.health,
          healthMaxOverride: playerStats.healthMax,
          maxHealth: ranks.maxHealth,
          gangId: playerStats.gangId,
          exp: playerStats.exp,
          level: playerStats.level,
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
      const selfProtected = isNewbie(me, config, ctx.progression);

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
              : isNewbie(row, config, ctx.progression) ? "newbie_protected"
              : null;
            return {
              playerId: row.playerId,
              username: row.username,
              rank: row.rank,
              health: row.health,
              // health_max ?? rank cap ?? 100 — core's resolution order
              // (auth/routes.ts, hospital/status.ts). 100 matches core's
              // ranks.max_health default, used when the player has no rank
              // row yet; a plugin cannot import that constant from
              // apps/server, so the sites are kept in step by hand.
              maxHealth: row.healthMaxOverride ?? row.maxHealth ?? 100,
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
        .select({
          weaponItemId: playerStats.weaponItemId,
          weaponMeleeItemId: playerStats.weaponMeleeItemId,
          strength: playerStats.strength,
          locationId: playerStats.locationId,
        })
        .from(playerStats)
        .where(eq(playerStats.playerId, player.id));
      const itemId = stats?.weaponItemId ?? null;
      const strength = stats?.strength ?? 0n;
      const melee = await describeMeleeSlot(tx, stats?.weaponMeleeItemId ?? null, strength);
      const fists = describeFists(config, strength);
      if (itemId === null) {
        return {
          status: 200,
          body: {
            itemId: null, name: null, condition: PRISTINE,
            backfireChance: 0, repairCost: "0",
            firearm: null, melee, fists,
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
      // The firearm block only when slot 1 parses as one. A melee item still
      // in slot 1 (equipped before the gate) keeps the legacy top-level
      // fields — name and a pristine bar — and no block of its own.
      const firearm = parsed?.success === true && item !== undefined
        ? {
          itemId, name: item.name,
          damageMin: parsed.data.damageMin, damageMax: parsed.data.damageMax,
          bulletsPerShot: parsed.data.bulletsPerShot,
        }
        : null;
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
          firearm,
          melee,
          fists,
        },
      };
    });
  },
});

/**
 * What bare hands would do under the melee model — `describeMeleeSlot`'s
 * arithmetic with `unarmed.power` — or null under the firearm model, where
 * fists are the settings profile and the page has nothing stat-driven to
 * say. Present whether or not a slot is armed: it describes the fallback.
 */
function describeFists(
  config: CombatSettings,
  strength: bigint,
): { power: number; strength: string; estimate: string } | null {
  if (config.unarmed.model !== "melee") return null;
  const estimate = (BigInt(config.unarmed.power) * strength * 3n) / 2n;
  return { power: config.unarmed.power, strength: strength.toString(), estimate: estimate.toString() };
}

/**
 * The melee slot for the combat page: the weapon, the stat it multiplies
 * and one honest figure. `estimate` is `resolveMeleeStrike`'s raw damage
 * against guard 1, no armor, no swing and no crit —
 * `floor(power × strength ÷ (1 / 1.5))` — the ceiling a strike reaches on
 * an unguarded target. Real damage divides by the target's guard, which a
 * self-describing read cannot know, so the page labels it as such rather
 * than pretending it is a range. Bigint throughout: `strength` is a trained
 * bigint column, and the wire form is the decimal string every bigint uses.
 *
 * `null` for an empty slot and for a row that no longer parses as melee —
 * the equip gate refuses those, so only a hand-edited row lands here, and
 * combat treats it as empty (fists) too.
 */
async function describeMeleeSlot(
  tx: PluginTx,
  meleeItemId: string | null,
  strength: bigint,
): Promise<{ itemId: string; name: string; power: number; strength: string; estimate: string } | null> {
  if (meleeItemId === null) return null;
  const [row] = await tx.db
    .select({ name: items.name, itemType: items.itemType, effects: items.effects })
    .from(items)
    .where(eq(items.id, meleeItemId));
  if (!row || row.itemType !== ITEM_TYPE_WEAPON) return null;
  const parsed = MeleeEffectsSchema.safeParse(row.effects);
  if (!parsed.success) return null;
  const estimate = (BigInt(parsed.data.power) * strength * 3n) / 2n;
  return {
    itemId: meleeItemId,
    name: row.name,
    power: parsed.data.power,
    strength: strength.toString(),
    estimate: estimate.toString(),
  };
}

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

/**
 * Makes the gunsmith discoverable from `/inventory` rather than only from
 * `/combat` itself. `item.itemType` comes straight off inventory's `items`
 * row (the DTO's own literal), compared against combat's own `ITEM_TYPE_WEAPON`
 * — combat already reads that table this way (`loadWeapon` above), and never
 * imports inventory's `effects.js`, which is internal to that package.
 */
const gunsmithLink = on(itemActions, (ctx, value) => ({
  ...value,
  actions: [...value.actions, ...value.items
    .filter((item) => item.itemType === ITEM_TYPE_WEAPON)
    .map((item) => ({
      itemId: item.itemId, pluginId: ctx.pluginId, label: "Repair at gunsmith", to: "/combat",
    }))],
}));

// ---------------------------------------------------------------------------
// Admin — the settings panel, detectives' shape. Reads and writes the settings
// TABLE, not `ctx.settings`: the snapshot is boot-time, so the panel shows
// what the next boot will read and an edit takes effect on restart (which the
// panel says out loud). Keys are the bare names `readCombatSettings` reads,
// stored prefixed `combat.<key>` exactly as the SDK's namespacing expects.
// ---------------------------------------------------------------------------

const ADMIN_SETTING_KEYS = [
  "newbie_exp_threshold", "newbie_level_threshold", "cooldown_seconds", "cooldown_max_seconds",
  "hospital_seconds", "default_weapon_accuracy", "unarmed.accuracy", "unarmed.damage_min",
  "unarmed.damage_max", "unarmed.bullets_per_shot", "unarmed.dps", "unarmed.model", "unarmed.power",
  "condition.wear_per_shot",
  "condition.decay_period_seconds", "condition.decay_per_period", "backfire.base_chance",
  "backfire.wear_factor", "repair.cost_per_point", "repair.cost_multiplier",
] as const;
type AdminSettingKey = (typeof ADMIN_SETTING_KEYS)[number];

const ADMIN_SETTING_LABELS: Record<AdminSettingKey, string> = {
  "newbie_exp_threshold": "Newbie protection: lifetime exp below this is protected (exp boots)",
  "newbie_level_threshold": "Newbie protection: level below this is protected (level boots)",
  "cooldown_seconds": "Attack cooldown for a weapon declaring no dps (seconds)",
  "cooldown_max_seconds": "Ceiling on a dps-derived cooldown (seconds)",
  "hospital_seconds": "Hospital stay on a kill (seconds)",
  "default_weapon_accuracy": "Accuracy for a weapon declaring none (0–100)",
  "unarmed.accuracy": "Unarmed accuracy (0–100)",
  "unarmed.damage_min": "Unarmed minimum damage",
  "unarmed.damage_max": "Unarmed maximum damage",
  "unarmed.bullets_per_shot": "Unarmed bullets per shot",
  "unarmed.dps": "Unarmed dps (blank = flat cooldown)",
  "unarmed.model": "Unarmed model: firearm (the settings above) or melee (power × strength, no bullets)",
  "unarmed.power": "Unarmed power (melee model only)",
  "condition.wear_per_shot": "Weapon wear per shot (condition points)",
  "condition.decay_period_seconds": "Weapon decay period (seconds)",
  "condition.decay_per_period": "Weapon decay per period (condition points)",
  "backfire.base_chance": "Backfire base chance (0–100)",
  "backfire.wear_factor": "Backfire wear factor",
  "repair.cost_per_point": "Repair cost per condition point (no shop listing)",
  "repair.cost_multiplier": "Full repair costs this many times the shop price",
};

/** Form fields (the admin form posts strings). The order is the form's. */
const ADMIN_FIELDS: Record<AdminSettingKey, "number" | "money" | "select"> = {
  "newbie_exp_threshold": "money",
  "newbie_level_threshold": "number",
  "cooldown_seconds": "number",
  "cooldown_max_seconds": "number",
  "hospital_seconds": "number",
  "default_weapon_accuracy": "number",
  "unarmed.accuracy": "number",
  "unarmed.damage_min": "number",
  "unarmed.damage_max": "number",
  "unarmed.bullets_per_shot": "number",
  "unarmed.dps": "number",
  "unarmed.model": "select",
  "unarmed.power": "number",
  "condition.wear_per_shot": "number",
  "condition.decay_period_seconds": "number",
  "condition.decay_per_period": "number",
  "backfire.base_chance": "number",
  "backfire.wear_factor": "number",
  "repair.cost_per_point": "money",
  "repair.cost_multiplier": "number",
};

/**
 * Every field is optional and blank-tolerant. A blank means "use the default"
 * to `readCombatSettings` (its `blank` guard) and is stored as a DELETE, not
 * an empty row, so the table never carries a value the reader would treat as
 * absent anyway. An ABSENT key is left untouched: the form posts every field
 * it renders, but the two newbie thresholds are gated by
 * `when: { progression }` and the server prunes the other model's field
 * before the view reaches the wire, so on a routed boot no client can ever
 * send `newbie_exp_threshold` (and on an exp boot never
 * `newbie_level_threshold`). Requiring it 400'd every save of the panel.
 * Numeric fields are validated as the reader would floor them; the money
 * fields as non-negative integers.
 */
const nonNegInt = z.string().trim().regex(/^\d+$/, "non-negative integer").or(z.literal("")).optional();
const nonNegNumber = z.string().trim().refine(
  (v) => v === "" || (Number.isFinite(Number(v)) && Number(v) >= 0),
  "non-negative number",
).optional();
/**
 * The one select on the form. Its options are the reader's own vocabulary,
 * served by `adminUnarmedModelsRoute` below — the declared-form renderer
 * takes options only from a GET the manifest names, so the enum has to be
 * a route even with two static rows. A blank still means "default".
 */
const UNARMED_MODELS = [
  { id: "firearm", name: "Firearm — accuracy and damage range from the settings above" },
  { id: "melee", name: "Melee — power × strength, no bullets (the gl3 default)" },
] as const;
const unarmedModel = z.enum(["firearm", "melee"]).or(z.literal("")).optional();
const AdminSettingsBodySchema = z.object(
  Object.fromEntries(
    ADMIN_SETTING_KEYS.map((key) => [
      key,
      ADMIN_FIELDS[key] === "money" ? nonNegInt : ADMIN_FIELDS[key] === "select" ? unarmedModel : nonNegNumber,
    ]),
  ) as Record<AdminSettingKey, typeof nonNegInt | typeof nonNegNumber | typeof unarmedModel>,
).strict();

const adminUnarmedModelsRoute = route({
  method: "GET", path: "/api/admin/combat/unarmed-models", auth: "admin",
  handler: async () => ({ status: 200, body: UNARMED_MODELS }),
});

const adminSettingsListRoute = route({
  method: "GET", path: "/api/admin/combat/settings", auth: "admin",
  handler: async (ctx) => {
    const rows = await ctx.transaction(async (tx) => tx.db.select().from(settings));
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    const get = (key: string): string | null => stored.get(`combat.${key}`) ?? null;
    // Effective values: what the reader resolves each raw value to, defaults
    // included, so the table shows the number that will actually apply.
    const effective = readCombatSettings(get);
    const values: Record<AdminSettingKey, string> = {
      "newbie_exp_threshold": effective.newbieExpThreshold.toString(),
      "newbie_level_threshold": String(effective.newbieLevelThreshold),
      "cooldown_seconds": String(effective.cooldownSeconds),
      "cooldown_max_seconds": String(effective.cooldownMaxSeconds),
      "hospital_seconds": String(effective.hospitalSeconds),
      "default_weapon_accuracy": String(effective.defaultWeaponAccuracy),
      "unarmed.accuracy": String(effective.unarmed.accuracy),
      "unarmed.damage_min": String(effective.unarmed.damageMin),
      "unarmed.damage_max": String(effective.unarmed.damageMax),
      "unarmed.bullets_per_shot": String(effective.unarmed.bulletsPerShot),
      "unarmed.dps": effective.unarmed.dps === undefined ? "" : String(effective.unarmed.dps),
      "unarmed.model": effective.unarmed.model,
      "unarmed.power": String(effective.unarmed.power),
      "condition.wear_per_shot": String(effective.condition.wearPerShot),
      "condition.decay_period_seconds": String(effective.condition.decayPeriodSeconds),
      "condition.decay_per_period": String(effective.condition.decayPerPeriod),
      "backfire.base_chance": String(effective.backfire.baseChance),
      "backfire.wear_factor": String(effective.backfire.wearFactor),
      "repair.cost_per_point": effective.repair.costPerPoint.toString(),
      "repair.cost_multiplier": String(effective.repair.costMultiplier),
    };
    return {
      status: 200,
      body: {
        rows: ADMIN_SETTING_KEYS.map((key) => ({
          key, label: ADMIN_SETTING_LABELS[key], value: values[key], stored: get(key) ?? "",
        })),
        // Form prefill — field names equal these keys exactly.
        values,
      },
    };
  },
});

const adminSettingsWriteRoute = route({
  method: "POST", path: "/api/admin/combat/settings", auth: "admin",
  body: AdminSettingsBodySchema,
  handler: async (ctx, { body }) => {
    await ctx.transaction(async (tx) => {
      for (const key of ADMIN_SETTING_KEYS) {
        const raw = body[key];
        // Not on this boot's form (pruned by progression model): leave the
        // stored row as it is — it is dormant here, not the form's to erase.
        if (raw === undefined) continue;
        const value = raw.trim();
        const row = `combat.${key}`;
        if (value === "") {
          await tx.db.delete(settings).where(eq(settings.key, row));
        } else {
          await tx.db.insert(settings).values({ key: row, value })
            .onConflictDoUpdate({ target: settings.key, set: { value } });
        }
      }
    });
    return { status: 204 };
  },
});

const adminPage: PageSchema = {
  id: "combat-admin",
  path: "/admin/combat",
  view: {
    kind: "panel", title: "Combat",
    children: [
      { kind: "text", value: "Newbie protection is mutual — a protected player can neither be shot nor shoot. Which threshold applies depends on the boot: an exp game compares lifetime exp against the exp threshold; a level game (a progression plugin is loaded) compares level against the level threshold, because exp there resets on every level-up. Blank a field to fall back to its default. Edits take effect on the next server restart." },
      { kind: "table", source: "GET /api/admin/combat/settings", columns: [
        { key: "label", label: "Setting" },
        { key: "value", label: "Effective value" },
        { key: "stored", label: "Stored" },
      ] },
      { kind: "form", action: "POST /api/admin/combat/settings", submitLabel: "Update settings",
        valuesSource: "GET /api/admin/combat/settings", fields: [
        { name: "newbie_exp_threshold", label: "Newbie exp threshold", type: "money", when: { progression: "exp" } },
        { name: "newbie_level_threshold", label: "Newbie level threshold", type: "number", when: { progression: "level" } },
        { name: "cooldown_seconds", label: "Cooldown (seconds, no-dps weapons)", type: "number" },
        { name: "cooldown_max_seconds", label: "Cooldown ceiling (seconds)", type: "number" },
        { name: "hospital_seconds", label: "Hospital stay on kill (seconds)", type: "number" },
        { name: "default_weapon_accuracy", label: "Default weapon accuracy", type: "number" },
        { name: "unarmed.accuracy", label: "Unarmed accuracy", type: "number" },
        { name: "unarmed.damage_min", label: "Unarmed min damage", type: "number" },
        { name: "unarmed.damage_max", label: "Unarmed max damage", type: "number" },
        { name: "unarmed.bullets_per_shot", label: "Unarmed bullets per shot", type: "number" },
        { name: "unarmed.dps", label: "Unarmed dps (blank = flat)", type: "number" },
        { name: "unarmed.model", label: "Unarmed model", type: "select",
          optionsSource: "GET /api/admin/combat/unarmed-models", valueKey: "id", labelKey: "name", allowEmpty: true },
        { name: "unarmed.power", label: "Unarmed power (melee model)", type: "number" },
        { name: "condition.wear_per_shot", label: "Wear per shot", type: "number" },
        { name: "condition.decay_period_seconds", label: "Decay period (seconds)", type: "number" },
        { name: "condition.decay_per_period", label: "Decay per period", type: "number" },
        { name: "backfire.base_chance", label: "Backfire base chance", type: "number" },
        { name: "backfire.wear_factor", label: "Backfire wear factor", type: "number" },
        { name: "repair.cost_per_point", label: "Repair cost per point", type: "money" },
        { name: "repair.cost_multiplier", label: "Repair cost multiplier", type: "number" },
      ] },
    ],
  },
};

export default definePlugin({
  id: "combat",
  version: "1.0.0",
  apiVersion: 1,
  basePaths: ["/api/combat", "/api/admin/combat"],
  // Real import dependencies (see this package's package.json) —
  // enforced against the final boot set by plugins/validate.ts.
  requires: ["inventory", "detectives"],
  pages: [{
    id: "combat.index",
    path: "/combat",
    menu: { label: "Combat", order: 12, category: "crimes" },
    // Stub view: the client renders a hand-written override (apps/web
    // PAGE_OVERRIDES) for this id; the schema view exists because a
    // page declaration requires one.
    view: { kind: "list", items: [] },
  }],
  migrations: COMBAT_MIGRATIONS,
  routes: [attackRoute, logRoute, targetsRoute, weaponRoute, repairRoute, adminSettingsListRoute, adminSettingsWriteRoute, adminUnarmedModelsRoute],
  adminPages: [adminPage],
  provides: [killResolved, exposure],
  filters: [gunsmithLink],
});
