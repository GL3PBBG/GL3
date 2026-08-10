import type { PluginBalanceChange } from "./ctx.js";

/**
 * The only error type a plugin route handler is expected to throw. The loader
 * maps it to `reply.code(status).send({ error: code, ...extra })`, which is how
 * ported modules keep their existing status codes and error strings byte for
 * byte (spec: "M5 changes no HTTP response").
 */
export class PluginError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
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
