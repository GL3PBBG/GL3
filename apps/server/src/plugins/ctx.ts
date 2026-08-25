import type {
  AssetSlot, AttributePoolDecl, BoundFilterSubscription, CoreEventInput, JobContext,
  PlayerAttributes, PlayerSnapshot, PluginCtx, PluginEventInput, PluginTx, Pool,
  PropertyTypeDecl, TrainedAttr,
} from "@gl3/plugin-sdk";
import {
  InsufficientFundsError as SdkInsufficientFundsError,
  InsufficientGangFundsError as SdkInsufficientGangFundsError,
  JobAlreadyAppliedError,
  PluginError,
  runFilterChain,
  settlePool,
} from "@gl3/plugin-sdk";
import { GameEventSchema, type GameEvent, type LeaderboardKind } from "@gl3/shared";
import type { Queue } from "bullmq";
import { and, eq, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { StorageDriver } from "../assets/driver.js";
import { resolveAssets, resolveSingletonAsset } from "../assets/service.js";
import { publishEvent } from "../bus/publish.js";
import type { Db } from "../db/client.js";
import { players, playerStats, playerTimers, pluginJobRuns } from "../db/schema/index.js";
import {
  addExp, applyBalanceChange, applyGangBalanceChange, InsufficientFundsError,
  InsufficientGangFundsError, lockGangAndPlayerForUpdate, lockLocationForUpdate,
  lockLocationsForUpdate, lockPlayersForUpdate, type Tx,
} from "../economy/ledger.js";
import { applyExpAndRankUp } from "../economy/ranks.js";
import { appendGangLog } from "../game/gangs/logs.js";
import { GANG_PERMISSIONS, hasGangPermission, type GangPermission } from "../game/gangs/permissions.js";
import {
  acquireCooldown, cooldownKey, peekCooldown, releaseCooldown,
} from "../game/cooldown.js";
import { sendToHospital } from "../game/hospital/status.js";
import { sendToJail } from "../game/jail/status.js";
import { recordScore } from "../game/leaderboard/service.js";
import { insertNotification } from "../game/notifications/service.js";
import { newSeed } from "../game/rng.js";
import { slotKey } from "./asset-slots.js";

export interface PluginCtxDeps {
  db: Db;
  redis: Redis;
  /** Per-plugin BullMQ queues, keyed `<pluginId>:<jobName>`. Task 11 fills it. */
  queues: Map<string, Queue>;
  settings: Record<string, string>;
  /**
   * Required, not optional-with-a-default: an omitted prefix silently means
   * the production `leaderboard:*` keys, and `bootTestServer` namespaces its
   * own per boot so concurrent test files do not collide on shared Redis.
   * `buildApp` applies the `?? DEFAULT_LEADERBOARD_PREFIX` default at the one
   * place that already owns that decision.
   */
  leaderboardPrefix: string;
  /**
   * Object storage behind `ctx.assets`. Reads only from a plugin's side — the
   * driver is here rather than a whole asset service because `resolveAssets`
   * needs `urlFor` to turn a stored hash into something a browser can fetch.
   */
  assetDriver: StorageDriver;
}

export interface PluginCtxOptions {
  pluginId: string;
  player: PlayerSnapshot | null;
  job: JobContext | null;
  filters: readonly BoundFilterSubscription[];
  propertyTypes: ReadonlyMap<string, PropertyTypeDecl>;
  attributePools: ReadonlyMap<Pool, AttributePoolDecl>;
  installedPluginIds: ReadonlySet<string>;
  /** Keyed `<scope>:<slot>` by `slotKey`, from `collectAssetSlots`. */
  assetSlots: ReadonlyMap<string, AssetSlot>;
}

/**
 * One buffer holds both kinds so a handler's relative call order survives to
 * the wire. `game/crimes/worker.ts` publishes `crime.resolved` before
 * `player.jailed` deliberately — "so a client that reacts to player.jailed can
 * already cross-reference the crime that caused it" — and a ported crimes
 * module must be able to keep that.
 */
type BufferedEvent =
  | { kind: "plugin"; event: PluginEventInput }
  | { kind: "core"; event: CoreEventInput };

export function createPluginCtx(deps: PluginCtxDeps, options: PluginCtxOptions): PluginCtx {
  // Built once per ctx and memoized, so two filter subscribers owned by the
  // same plugin (or two calls into the same one) reuse the same sibling ctx
  // rather than each paying a fresh `createPluginCtx` — and, because the
  // Map is closed over rather than module-level, siblings never leak across
  // requests. Self short-circuits to the ctx already under construction
  // instead of recursing into a second copy of it.
  const siblings = new Map<string, PluginCtx>();
  const ctxFor = (ownerId: string): PluginCtx => {
    if (ownerId === options.pluginId) return ctx;
    let sibling = siblings.get(ownerId);
    if (sibling === undefined) {
      sibling = createPluginCtx(deps, { ...options, pluginId: ownerId });
      siblings.set(ownerId, sibling);
    }
    return sibling;
  };

  const ctx: PluginCtx = {
    pluginId: options.pluginId,
    player: options.player,
    job: options.job,

    async transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> {
      // The buffer lives in this call's closure, so two concurrent requests on
      // the same ctx factory cannot see each other's pending events.
      const buffered: BufferedEvent[] = [];

      // Keyed so a second change to the same player+kind replaces the first:
      // the leaderboard wants the FINAL balance, not each intermediate one.
      const scores = new Map<string, { kind: LeaderboardKind; playerId: string; score: bigint }>();
      const bufferScore = (kind: LeaderboardKind, playerId: string, score: bigint): void => {
        scores.set(`${kind}:${playerId}`, { kind, playerId, score });
      };

      const result = await deps.db.transaction(async (tx) => {
        if (options.job !== null) {
          // NOTES.md rule 1, made structural: FIRST statement in the
          // transaction, before any handler code. A retry of an already-
          // committed job conflicts here and aborts before re-applying
          // anything. A plugin cannot forget this because it never writes it.
          const claimed = await tx
            .insert(pluginJobRuns)
            .values({ pluginId: options.pluginId, jobId: options.job.id })
            .onConflictDoNothing()
            .returning({ jobId: pluginJobRuns.jobId });
          if (claimed.length === 0) {
            throw new JobAlreadyAppliedError(options.pluginId, options.job.id);
          }
        }
        const pluginTx: PluginTx = {
          db: tx,
          economy: {
            applyBalanceChange: async (change) => {
              let after: bigint;
              try {
                after = await applyBalanceChange(tx, change);
              } catch (error) {
                // Only this call is wrapped, and only this one error is
                // translated: a plugin package cannot import core's class, so
                // without this every overdraft escapes the loader's
                // PluginError catch and Fastify 500s. Everything else
                // propagates untouched.
                if (error instanceof InsufficientFundsError) {
                  throw new SdkInsufficientFundsError(change.playerId, change.kind);
                }
                throw error;
              }
              // Deliberately outside the try: a leg that threw must buffer no
              // score. `points` has no leaderboard — LeaderboardKind is
              // cash/bank/exp.
              if (change.kind !== "points") bufferScore(change.kind, change.playerId, after);
              return after;
            },
            // The gang-side mirror of the applyBalanceChange wrap above, and
            // the same reason: a plugin package cannot import core's class,
            // so without this every gang overdraft escapes the loader's
            // PluginError catch and Fastify 500s where core's withdraw route
            // answered 400 insufficient_gang_funds. Everything else
            // propagates untouched.
            //
            // No bufferScore, unlike the player wrap: gang balances have no
            // leaderboard — LeaderboardKind is cash/bank/exp on a PLAYER.
            applyGangBalanceChange: async (change) => {
              try {
                return await applyGangBalanceChange(tx, change);
              } catch (error) {
                if (error instanceof InsufficientGangFundsError) {
                  throw new SdkInsufficientGangFundsError(change.gangId, change.kind);
                }
                throw error;
              }
            },
            addExp: async (playerId, amount) => {
              await addExp(tx, playerId, amount);
              // A zero gain is core's own no-op (economy/ledger.ts) — no
              // UPDATE runs, so no row lock is taken. Reading playerStats
              // here anyway would be an unlocked read that can observe a
              // stale snapshot and ZADD it over a newer value after commit.
              // Nothing was written, so there is nothing to record.
              if (amount === 0n) return;
              const fresh = await freshStats(tx, playerId);
              if (fresh) bufferScore("exp", playerId, fresh.exp);
            },
            applyExpAndRankUp: async (playerId, expGain) => {
              const result = await applyExpAndRankUp(tx, playerId, expGain);
              // Same reasoning as addExp above: core's applyExpAndRankUp
              // (economy/ranks.ts) is itself a no-op on a zero gain — no
              // UPDATE, no row lock — so skip the unlocked read/buffer here
              // too and return core's own null unchanged.
              if (expGain === 0n) return result;
              // Both kinds: a rank-up pays its cash reward through core's own
              // internal applyBalanceChange (economy/ranks.ts), which this
              // wrapper never sees, so buffering exp alone leaves cash stale.
              const fresh = await freshStats(tx, playerId);
              if (fresh) {
                bufferScore("exp", playerId, fresh.exp);
                bufferScore("cash", playerId, fresh.cash);
              }
              return result;
            },
          },
          jail: { sendToJail: (playerId, seconds) => sendToJail(tx, playerId, seconds) },
          hospital: { sendToHospital: (playerId, seconds) => sendToHospital(tx, playerId, seconds) },
          locks: {
            player: (playerIds) => lockPlayersForUpdate(tx, playerIds),
            gangAndPlayer: (gangId, playerId) => lockGangAndPlayerForUpdate(tx, gangId, playerId),
            location: (locationId) => lockLocationForUpdate(tx, locationId),
            locations: (locationIds) => lockLocationsForUpdate(tx, locationIds),
          },
          timers: {
            get: async (playerId, key) => {
              const [row] = await tx
                .select({ expiresAt: playerTimers.expiresAt })
                .from(playerTimers)
                .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, key)));
              return row?.expiresAt ?? null;
            },
            set: async (playerId, key, expiresAt) => {
              await tx
                .insert(playerTimers)
                .values({ playerId, key, expiresAt })
                .onConflictDoUpdate({
                  target: [playerTimers.playerId, playerTimers.key],
                  set: { expiresAt },
                });
            },
            clear: async (playerId, key) => {
              const deleted = await tx
                .delete(playerTimers)
                .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, key)))
                .returning({ playerId: playerTimers.playerId });
              return deleted.length > 0;
            },
          },
          // See PluginTx's `attributes` doc comment (packages/plugin-sdk/src/ctx.ts):
          // the caller already holds the player row via `tx.locks.player`, so
          // nothing here takes a lock of its own. Written as explicit
          // per-pool/per-attr blocks rather than a loop over computed column
          // names — a dynamic `row[pool]` / `row[`${pool}Max`]` lookup fights
          // strict mode for no real gain here, and four short blocks are
          // easier to typecheck AND read than one clever one.
          attributes: (() => {
            const settleAll = async (playerId: string): Promise<PlayerAttributes> => {
              const [row] = await tx.select().from(playerStats).where(eq(playerStats.playerId, playerId));
              if (!row) throw new Error(`player_stats row missing for ${playerId}`);

              const now = new Date();
              const energyOut = settlePool(row.energy, row.energyMax, row.energyRegenAt, now, options.attributePools.get("energy") ?? null);
              const willOut = settlePool(row.will, row.willMax, row.willRegenAt, now, options.attributePools.get("will") ?? null);
              const braveOut = settlePool(row.brave, row.braveMax, row.braveRegenAt, now, options.attributePools.get("brave") ?? null);
              const nerveOut = settlePool(row.nerve, row.nerveMax, row.nerveRegenAt, now, options.attributePools.get("nerve") ?? null);

              const patch: Partial<{
                energy: number; energyMax: number; energyRegenAt: Date | null;
                will: number; willMax: number; willRegenAt: Date | null;
                brave: number; braveMax: number; braveRegenAt: Date | null;
                nerve: number; nerveMax: number; nerveRegenAt: Date | null;
              }> = {};
              if (energyOut.value !== row.energy) patch.energy = energyOut.value;
              if (energyOut.max !== row.energyMax) patch.energyMax = energyOut.max;
              if (energyOut.stamp?.getTime() !== row.energyRegenAt?.getTime()) patch.energyRegenAt = energyOut.stamp;
              if (willOut.value !== row.will) patch.will = willOut.value;
              if (willOut.max !== row.willMax) patch.willMax = willOut.max;
              if (willOut.stamp?.getTime() !== row.willRegenAt?.getTime()) patch.willRegenAt = willOut.stamp;
              if (braveOut.value !== row.brave) patch.brave = braveOut.value;
              if (braveOut.max !== row.braveMax) patch.braveMax = braveOut.max;
              if (braveOut.stamp?.getTime() !== row.braveRegenAt?.getTime()) patch.braveRegenAt = braveOut.stamp;
              if (nerveOut.value !== row.nerve) patch.nerve = nerveOut.value;
              if (nerveOut.max !== row.nerveMax) patch.nerveMax = nerveOut.max;
              if (nerveOut.stamp?.getTime() !== row.nerveRegenAt?.getTime()) patch.nerveRegenAt = nerveOut.stamp;

              if (Object.keys(patch).length > 0) {
                await tx.update(playerStats).set(patch).where(eq(playerStats.playerId, playerId));
              }

              return {
                energy: energyOut.value, energyMax: energyOut.max,
                will: willOut.value, willMax: willOut.max,
                brave: braveOut.value, braveMax: braveOut.max,
                nerve: nerveOut.value, nerveMax: nerveOut.max,
                level: row.level,
                strength: row.strength, agility: row.agility,
                guard: row.guard, labour: row.labour,
              };
            };

            return {
              read: settleAll,
              spend: async (playerId: string, pool: Pool, amount: number) => {
                if (amount < 0) throw new PluginError("invalid_amount", 400);
                if (amount === 0) return;
                const current = await settleAll(playerId);
                switch (pool) {
                  case "energy": {
                    if (current.energy < amount) throw new PluginError("insufficient_energy", 409);
                    await tx.update(playerStats).set({ energy: current.energy - amount }).where(eq(playerStats.playerId, playerId));
                    return;
                  }
                  case "will": {
                    if (current.will < amount) throw new PluginError("insufficient_will", 409);
                    await tx.update(playerStats).set({ will: current.will - amount }).where(eq(playerStats.playerId, playerId));
                    return;
                  }
                  case "brave": {
                    if (current.brave < amount) throw new PluginError("insufficient_brave", 409);
                    await tx.update(playerStats).set({ brave: current.brave - amount }).where(eq(playerStats.playerId, playerId));
                    return;
                  }
                  case "nerve": {
                    if (current.nerve < amount) throw new PluginError("insufficient_nerve", 409);
                    await tx.update(playerStats).set({ nerve: current.nerve - amount }).where(eq(playerStats.playerId, playerId));
                    return;
                  }
                }
              },
              grant: async (playerId: string, pool: Pool, amount: number) => {
                if (amount < 0) throw new PluginError("invalid_amount", 400);
                if (amount === 0) return;
                const current = await settleAll(playerId);
                switch (pool) {
                  case "energy": {
                    const next = Math.min(current.energyMax, current.energy + amount);
                    await tx.update(playerStats).set({ energy: next }).where(eq(playerStats.playerId, playerId));
                    return;
                  }
                  case "will": {
                    const next = Math.min(current.willMax, current.will + amount);
                    await tx.update(playerStats).set({ will: next }).where(eq(playerStats.playerId, playerId));
                    return;
                  }
                  case "brave": {
                    const next = Math.min(current.braveMax, current.brave + amount);
                    await tx.update(playerStats).set({ brave: next }).where(eq(playerStats.playerId, playerId));
                    return;
                  }
                  case "nerve": {
                    const next = Math.min(current.nerveMax, current.nerve + amount);
                    await tx.update(playerStats).set({ nerve: next }).where(eq(playerStats.playerId, playerId));
                    return;
                  }
                }
              },
              setMax: async (playerId: string, pool: Pool, value: number) => {
                if (value < 0) throw new PluginError("invalid_amount", 400);
                switch (pool) {
                  case "energy":
                    await tx.update(playerStats).set({ energyMax: value }).where(eq(playerStats.playerId, playerId));
                    return;
                  case "will":
                    await tx.update(playerStats).set({ willMax: value }).where(eq(playerStats.playerId, playerId));
                    return;
                  case "brave":
                    await tx.update(playerStats).set({ braveMax: value }).where(eq(playerStats.playerId, playerId));
                    return;
                  case "nerve":
                    await tx.update(playerStats).set({ nerveMax: value }).where(eq(playerStats.playerId, playerId));
                    return;
                }
              },
              train: async (playerId: string, attr: TrainedAttr, delta: bigint) => {
                switch (attr) {
                  case "strength": {
                    const [updated] = await tx.update(playerStats)
                      .set({ strength: sql`${playerStats.strength} + ${delta}` })
                      .where(eq(playerStats.playerId, playerId))
                      .returning({ value: playerStats.strength });
                    if (!updated) throw new Error(`player_stats row missing for ${playerId}`);
                    return updated.value;
                  }
                  case "agility": {
                    const [updated] = await tx.update(playerStats)
                      .set({ agility: sql`${playerStats.agility} + ${delta}` })
                      .where(eq(playerStats.playerId, playerId))
                      .returning({ value: playerStats.agility });
                    if (!updated) throw new Error(`player_stats row missing for ${playerId}`);
                    return updated.value;
                  }
                  case "guard": {
                    const [updated] = await tx.update(playerStats)
                      .set({ guard: sql`${playerStats.guard} + ${delta}` })
                      .where(eq(playerStats.playerId, playerId))
                      .returning({ value: playerStats.guard });
                    if (!updated) throw new Error(`player_stats row missing for ${playerId}`);
                    return updated.value;
                  }
                  case "labour": {
                    const [updated] = await tx.update(playerStats)
                      .set({ labour: sql`${playerStats.labour} + ${delta}` })
                      .where(eq(playerStats.playerId, playerId))
                      .returning({ value: playerStats.labour });
                    if (!updated) throw new Error(`player_stats row missing for ${playerId}`);
                    return updated.value;
                  }
                }
              },
            };
          })(),
          /**
           * `tx`, never `db`. Defined inside this closure, so every call
           * reads through the live transaction — which is what makes a
           * post-lock recheck observe post-lock state (SDK ctx.ts, and
           * core's former withdraw route, now ported to @gl3/plugin-gangs).
           *
           * A guard rather than a cast: `hasGangPermission` takes core's
           * `GangPermission` union, the SDK hands over a `string`, and
           * `packages/*` forbids casts. An unknown permission answers false,
           * which is what the underlying query would have answered.
           */
          gangs: {
            hasPermission: async (gangId, playerId, permission) => {
              if (!isGangPermission(permission)) return false;
              return await hasGangPermission(tx, gangId, playerId, permission);
            },
          },
          gangLog: (entry) => appendGangLog(tx, entry.gangId, entry.playerId, entry.message),
          /**
           * The row AND the event, always. `events.ts` documents
           * notification.created as "actor = the notified player" — the
           * recipient, not whoever triggered it — matching every other
           * privately-audienced event, and matching what core's own gang
           * routes publish. `awaitOwnEvent(subscriber, actorId)` is the
           * mandated rule-4 filter, so the wrong actor here silently breaks
           * every caller waiting on the recipient's own id.
           */
          notify: async (playerId, body) => {
            const notificationId = uuidv7();
            await insertNotification(tx, { id: notificationId, playerId, body });
            const [target] = await tx
              .select({ username: players.username })
              .from(players)
              .where(eq(players.id, playerId));
            buffered.push({
              kind: "core",
              event: {
                type: "notification.created",
                actorId: playerId,
                // "unknown" is the fallback every other event-publishing site
                // in this codebase uses (gangs/routes.ts).
                actorName: target?.username ?? "unknown",
                audience: { kind: "player", playerId },
                notificationId,
                body,
              },
            });
          },
          events: {
            publish: async (event) => { buffered.push({ kind: "plugin", event }); },
            publishCore: async (event) => { buffered.push({ kind: "core", event }); },
          },
        };
        return await fn(pluginTx);
      });

      // Only reached on commit — a throw above propagates and `buffered`/
      // `scores` are discarded with the closure (NOTES.md rule 5).

      // Leaderboard first, then events — the order game/crimes/worker.ts uses.
      // Deliberately not wrapped in try/catch, for the reason that file states:
      // the balance that committed is correct, and the next boot's
      // rebuildLeaderboards repairs the index, so failing loudly beats a
      // silently stale one. The existing event flush already behaves this way.
      for (const entry of scores.values()) {
        await recordScore(deps.redis, entry.kind, entry.playerId, entry.score, deps.leaderboardPrefix);
      }

      for (const entry of buffered) {
        await publishEvent(
          deps.redis,
          entry.kind === "plugin"
            ? toEnvelope(options.pluginId, entry.event)
            : toCoreEvent(entry.event),
        );
      }
      return result;
    },

    // Delegates to the core helpers rather than re-deriving the key, so a
    // ported module's Redis keys are unchanged and `SET NX EX` stays the
    // only write shape available (NOTES.md rule 2 — there is no read-then-
    // write pair on this surface to misuse).
    cooldown: {
      acquire: (action, playerId, ttlSeconds) =>
        acquireCooldown(deps.redis, cooldownKey(playerId, action), ttlSeconds),
      peek: (action, playerId) =>
        peekCooldown(deps.redis, cooldownKey(playerId, action)),
      release: (action, playerId) =>
        releaseCooldown(deps.redis, cooldownKey(playerId, action)),
    },
    jobs: {
      enqueue: async (name, data) => {
        const queue = deps.queues.get(`${options.pluginId}:${name}`);
        if (queue === undefined) throw new Error(`plugin "${options.pluginId}" has no job "${name}"`);
        // The seed is generated here, at enqueue time (spec: ctx API), so a
        // retry replays the same seed and the outcome is reproducible.
        const job = await queue.add(name, { ...data, seed: newSeed() });
        return String(job.id);
      },
    },

    filters: {
      apply: (point, value) => runFilterChain(options.filters, point, ctxFor, value),
    },
    settings: {
      get: (key) => deps.settings[`${options.pluginId}.${key}`] ?? null,
    },
    propertyTypes: {
      get: (id) => options.propertyTypes.get(id) ?? null,
      list: () => [...options.propertyTypes.values()],
    },
    attributePools: {
      get: (pool) => options.attributePools.get(pool) ?? null,
      list: () => [...options.attributePools.values()],
    },
    installedPluginIds: options.installedPluginIds,
    assetSlots: {
      get: (scope, slot) => options.assetSlots.get(slotKey(scope, slot)) ?? null,
      list: () => [...options.assetSlots.values()],
    },
    assets: {
      resolve: (scope, entityIds, slot) => resolveAssets(deps.db, deps.assetDriver, scope, entityIds, slot),
      mine: (entityIds, slot) => resolveAssets(deps.db, deps.assetDriver, options.pluginId, entityIds, slot),
      singleton: (scope, slot) => resolveSingletonAsset(deps.db, deps.assetDriver, scope, slot),
    },
    log: {
      info: (message, fields) => console.log({ plugin: options.pluginId, ...fields }, message),
      warn: (message, fields) => console.warn({ plugin: options.pluginId, ...fields }, message),
      error: (message, fields) => console.error({ plugin: options.pluginId, ...fields }, message),
    },
  };
  return ctx;
}

/**
 * Read inside the transaction, so the buffered score is the one the
 * transaction is about to commit rather than whatever a concurrent writer
 * leaves behind. `addExp` returns void and `applyExpAndRankUp` returns only
 * the promotion, so there is nothing to buffer without this read.
 */
async function freshStats(tx: Tx, playerId: string): Promise<{ exp: bigint; cash: bigint } | undefined> {
  const [row] = await tx
    .select({ exp: playerStats.exp, cash: playerStats.cash })
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  return row;
}

/** Narrows the SDK's `string` to core's `GangPermission` without a cast. */
function isGangPermission(value: string): value is GangPermission {
  return GANG_PERMISSIONS.some((permission) => permission === value);
}

/**
 * `id`/`at` are built exactly as core's own emitters built them — uuidv7 and
 * an ISO string — so a plugin event is indistinguishable in shape from a
 * core one on the wire.
 */
function toEnvelope(pluginId: string, event: PluginEventInput): GameEvent {
  return {
    id: uuidv7(),
    at: new Date().toISOString(),
    actorId: event.actorId,
    actorName: event.actorName,
    audience: event.audience,
    type: "plugin.event",
    pluginId,
    name: event.name,
    payload: event.payload,
  };
}

/**
 * `id`/`at` are built exactly as `toEnvelope` and core's own emitters build
 * them. The `GameEventSchema.parse` is what supplies the `GameEvent` return
 * type without a cast — `Omit` distributed over a union does not spread back
 * into the union by inference, and `apps/*` prefers a zod parse to a cast.
 * `publishEvent` parses again; that second parse is a few microseconds and
 * buys the type honesty here.
 */
function toCoreEvent(event: CoreEventInput): GameEvent {
  return GameEventSchema.parse({ id: uuidv7(), at: new Date().toISOString(), ...event });
}
