import type {
  CoreEventInput, FilterSubscription, JobContext, PlayerSnapshot, PluginCtx, PluginEventInput,
  PluginTx,
} from "@gl3/plugin-sdk";
import {
  InsufficientFundsError as SdkInsufficientFundsError,
  JobAlreadyAppliedError,
  runFilterChain,
} from "@gl3/plugin-sdk";
import { GameEventSchema, type GameEvent, type LeaderboardKind } from "@gl3/shared";
import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { publishEvent } from "../bus/publish.js";
import type { Db } from "../db/client.js";
import { players, playerStats, pluginJobRuns } from "../db/schema/index.js";
import {
  addExp, applyBalanceChange, applyGangBalanceChange, InsufficientFundsError,
  lockGangAndPlayerForUpdate, lockLocationForUpdate, lockLocationsForUpdate, lockPlayersForUpdate,
  type Tx,
} from "../economy/ledger.js";
import { applyExpAndRankUp } from "../economy/ranks.js";
import { appendGangLog } from "../game/gangs/logs.js";
import {
  acquireCooldown, cooldownKey, peekCooldown, releaseCooldown,
} from "../game/cooldown.js";
import { sendToJail } from "../game/jail/status.js";
import { recordScore } from "../game/leaderboard/service.js";
import { insertNotification } from "../game/notifications/service.js";
import { newSeed } from "../game/rng.js";

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
}

export interface PluginCtxOptions {
  pluginId: string;
  player: PlayerSnapshot | null;
  job: JobContext | null;
  filters: readonly FilterSubscription[];
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
            applyGangBalanceChange: (change) => applyGangBalanceChange(tx, change),
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
          locks: {
            player: (playerIds) => lockPlayersForUpdate(tx, playerIds),
            gangAndPlayer: (gangId, playerId) => lockGangAndPlayerForUpdate(tx, gangId, playerId),
            location: (locationId) => lockLocationForUpdate(tx, locationId),
            locations: (locationIds) => lockLocationsForUpdate(tx, locationIds),
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
                // in this codebase uses (gangs/routes.ts, mail/routes.ts).
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
      apply: (point, value) => runFilterChain(options.filters, point, ctx, value),
    },
    settings: {
      get: (key) => deps.settings[`${options.pluginId}.${key}`] ?? null,
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

/**
 * `id`/`at` are built exactly as core's own emitters build them (see
 * game/mail/routes.ts) — uuidv7 and an ISO string — so a plugin event is
 * indistinguishable in shape from a core one on the wire.
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
