import type { PluginBalanceChange, PluginGangBalanceChange } from "./ctx.js";

/**
 * Cross-instance brands.
 *
 * A plugin installed into an operator-controlled directory and loaded through
 * `PLUGIN_PACKAGES` brings its OWN copy of `@gl3/plugin-sdk`. Two module
 * instances means `error instanceof PluginError` is `false` for an error the
 * plugin threw and core caught — and `plugins/routes.ts` used exactly that
 * check to map a plugin's deliberate 400/409/423 to its status, so every such
 * error would have surfaced as a 500 instead.
 *
 * `Symbol.for` keys live in the per-process global symbol registry, so both
 * instances mint the identical symbol and the check survives the boundary.
 * The SDK already reached for duck-typing over `instanceof` for this exact
 * reason on zod schemas (`events.ts`); this states it once, structurally.
 *
 * Each guard accepts ONLY the brand — no pre-brand duck-type fallback. The
 * compatibility regime allows deletion of that arm; no plugin published against
 * `0.1.0`-`0.1.8` will be installed after this SDK version.
 */
const PLUGIN_ERROR = Symbol.for("gl3.plugin-sdk.PluginError");
const INSUFFICIENT_FUNDS = Symbol.for("gl3.plugin-sdk.InsufficientFundsError");
const INSUFFICIENT_GANG_FUNDS = Symbol.for("gl3.plugin-sdk.InsufficientGangFundsError");
const JOB_ALREADY_APPLIED = Symbol.for("gl3.plugin-sdk.JobAlreadyAppliedError");

/** True when `value` carries `brand` as an own property set to `true`. */
function branded(value: unknown, brand: symbol): boolean {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[brand] === true;
}

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
    Object.defineProperty(this, PLUGIN_ERROR, { value: true });
  }
}

/**
 * Thrown by a job-context `ctx.transaction` when `plugin_job_runs` already has
 * this (plugin_id, job_id). BullMQ is at-least-once, so this is the expected
 * outcome of a retry after a committed run — the worker wrapper treats it as
 * success, not failure (NOTES.md rule 1).
 */
export class JobAlreadyAppliedError extends Error {
  constructor(
    readonly pluginId: string,
    readonly jobId: string,
  ) {
    super(`job ${jobId} already applied for plugin ${pluginId}`);
    this.name = "JobAlreadyAppliedError";
    Object.defineProperty(this, JOB_ALREADY_APPLIED, { value: true });
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
 * `insufficient_cash` (gangs' bank-deposit route, `packages/plugins/gangs/src/index.ts`'s
 * `depositRoute`). A central mapping would have to change one of them, so
 * each plugin catches this and throws its own `PluginError`.
 */
export class InsufficientFundsError extends Error {
  constructor(
    readonly playerId: string,
    readonly kind: PluginBalanceChange["kind"],
  ) {
    super(`insufficient ${kind} for player ${playerId}`);
    this.name = "InsufficientFundsError";
    Object.defineProperty(this, INSUFFICIENT_FUNDS, { value: true });
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
 * `400 insufficient_gang_funds` (`packages/plugins/gangs/src/index.ts`'s
 * `withdrawRoute`) where the player legs of other modules answer 409, so
 * each plugin catches this and throws its own `PluginError`.
 */
export class InsufficientGangFundsError extends Error {
  constructor(
    readonly gangId: string,
    readonly kind: PluginGangBalanceChange["kind"],
  ) {
    super(`insufficient gang ${kind} for gang ${gangId}`);
    this.name = "InsufficientGangFundsError";
    Object.defineProperty(this, INSUFFICIENT_GANG_FUNDS, { value: true });
  }
}

/**
 * Identifies a `PluginError` thrown by ANY instance of this package. Use this
 * rather than `instanceof` anywhere an error crosses the plugin/core boundary
 * — which is every route handler and every job.
 */
export function isPluginError(value: unknown): value is PluginError {
  return branded(value, PLUGIN_ERROR);
}

/** The gang-side and player-side fund guards, and the job-retry guard. */
export function isInsufficientFundsError(value: unknown): value is InsufficientFundsError {
  return branded(value, INSUFFICIENT_FUNDS);
}

export function isInsufficientGangFundsError(value: unknown): value is InsufficientGangFundsError {
  return branded(value, INSUFFICIENT_GANG_FUNDS);
}

export function isJobAlreadyAppliedError(value: unknown): value is JobAlreadyAppliedError {
  return branded(value, JOB_ALREADY_APPLIED);
}
