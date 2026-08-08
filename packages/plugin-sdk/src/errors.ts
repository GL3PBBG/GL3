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
