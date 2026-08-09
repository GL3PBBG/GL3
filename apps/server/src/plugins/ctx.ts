import type {
  FilterSubscription, JobContext, PlayerSnapshot, PluginCtx, PluginEventInput, PluginTx,
} from "@gl3/plugin-sdk";
import { runFilterChain } from "@gl3/plugin-sdk";
import type { GameEvent } from "@gl3/shared";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { publishEvent } from "../bus/publish.js";
import type { Db } from "../db/client.js";
import {
  addExp, applyBalanceChange, applyGangBalanceChange,
  lockGangAndPlayerForUpdate, lockPlayersForUpdate,
} from "../economy/ledger.js";
import { appendGangLog } from "../game/gangs/logs.js";
import {
  acquireCooldown, cooldownKey, peekCooldown, releaseCooldown,
} from "../game/cooldown.js";

export interface PluginCtxDeps {
  db: Db;
  redis: Redis;
  /** Per-plugin BullMQ queues, keyed `<pluginId>:<jobName>`. Task 11 fills it. */
  queues: Map<string, Queue>;
  settings: Record<string, string>;
}

export interface PluginCtxOptions {
  pluginId: string;
  player: PlayerSnapshot | null;
  job: JobContext | null;
  filters: readonly FilterSubscription[];
}

export function createPluginCtx(deps: PluginCtxDeps, options: PluginCtxOptions): PluginCtx {
  const ctx: PluginCtx = {
    pluginId: options.pluginId,
    player: options.player,
    job: options.job,

    async transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> {
      // The buffer lives in this call's closure, so two concurrent requests on
      // the same ctx factory cannot see each other's pending events.
      const buffered: PluginEventInput[] = [];

      const result = await deps.db.transaction(async (tx) => {
        const pluginTx: PluginTx = {
          db: tx,
          economy: {
            applyBalanceChange: (change) => applyBalanceChange(tx, change),
            applyGangBalanceChange: (change) => applyGangBalanceChange(tx, change),
            addExp: (playerId, amount) => addExp(tx, playerId, amount),
          },
          locks: {
            player: (playerIds) => lockPlayersForUpdate(tx, playerIds),
            gangAndPlayer: (gangId, playerId) => lockGangAndPlayerForUpdate(tx, gangId, playerId),
          },
          gangLog: (entry) => appendGangLog(tx, entry.gangId, entry.playerId, entry.message),
          events: {
            publish: async (event) => { buffered.push(event); },
          },
        };
        return await fn(pluginTx);
      });

      // Only reached on commit — a throw above propagates and `buffered` is
      // discarded with the closure (CLAUDE.md rule 5).
      for (const event of buffered) {
        await publishEvent(deps.redis, toEnvelope(options.pluginId, event));
      }
      return result;
    },

    // Delegates to the core helpers rather than re-deriving the key, so a
    // ported module's Redis keys are unchanged and `SET NX EX` stays the
    // only write shape available (CLAUDE.md rule 2 — there is no read-then-
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
      enqueue: () => { throw new Error("ctx.jobs is wired in Task 11"); },
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
