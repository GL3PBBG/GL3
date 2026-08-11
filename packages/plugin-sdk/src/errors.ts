import type { PluginBalanceChange, PluginGangBalanceChange } from "./ctx.js";

/**
 * The only error type a plugin route handler is expected to throw. The loader
 * maps it to `reply.code(status).send({ error: code, ...extra })`, which is how
 * ported modules keep their existing status codes and error strings byte for
 * byte (spec: "M5 changes no HTTP response").
 *
 * `headers` exists because a status line is not always the whole response:
 * core's travel route answers 429 with a `retry-after` header alongside the
 * body (`game/travel/routes.ts` before the port). The loader sets the 423
 * jail header itself; everything else a handler needs goes here.
 */
export class PluginError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
    this.name = "PluginError";
  }
}

/**
 * Thrown by a job-context `ctx.transaction` when `plugin_job_runs` already has
 * this (plugin_id, job_id). BullMQ is at-least-once, so this is the expected
 * outcome of a retry after a committed run — the worker wrapper treats it as
 * success, not failure (CLAUDE.md rule 1).
 */
export class JobAlreadyAppliedError extends Error {
  constructor(
    readonly pluginId: string,
    readonly jobId: string,
  ) {
    super(`job ${jobId} already applied for plugin ${pluginId}`);
    this.name = "JobAlreadyAppliedError";
  }
}

/**
 * Thrown by `tx.economy.applyBalanceChange` when a debit would take a balance
 * below zero. Core's own `InsufficientFundsError` (`economy/ledger.ts`) lives
 * in `apps/server`, which a plugin package may not import, so the ctx
 * translates it into this one on the way out.
 *
 * Deliberately NOT mapped to a status by the route loader: three modules
 * answer 409 `insufficient_funds` (bank, travel, bullets) and one answers 400
 * `insufficient_cash` (gangs, `game/gangs/routes.ts:789`). A central mapping
 * would have to change one of them, so each plugin catches this and throws its
 * own `PluginError`.
 */
export class InsufficientFundsError extends Error {
  constructor(
    readonly playerId: string,
    readonly kind: PluginBalanceChange["kind"],
  ) {
    super(`insufficient ${kind} for player ${playerId}`);
    this.name = "InsufficientFundsError";
  }
}

/**
 * Thrown by `tx.economy.applyGangBalanceChange` when a debit would take a
 * gang balance below zero — the gang-side twin of `InsufficientFundsError`.
 * Core's own `InsufficientGangFundsError` (`economy/ledger.ts`) lives in
 * `apps/server`, which a plugin package may not import, so the ctx translates
 * it into this one on the way out.
 *
 * Deliberately NOT mapped to a status by the route loader, for the same
 * reason `InsufficientFundsError` is not: the gang bank answers
 * `400 insufficient_gang_funds` (`game/gangs/routes.ts:833`) where the player
 * legs of other modules answer 409, so each plugin catches this and throws
 * its own `PluginError`.
 */
export class InsufficientGangFundsError extends Error {
  constructor(
    readonly gangId: string,
    readonly kind: PluginGangBalanceChange["kind"],
  ) {
    super(`insufficient gang ${kind} for gang ${gangId}`);
    this.name = "InsufficientGangFundsError";
  }
}
