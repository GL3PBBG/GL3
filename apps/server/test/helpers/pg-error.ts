/**
 * Reading the Postgres detail out of a drizzle failure.
 *
 * drizzle wraps the driver error: the thrown `Error.message` is only
 * "Failed query: ...\nparams: ...", and the SQLSTATE code and constraint name
 * live on `.cause` (a postgres.js `PostgresError`). Two consequences shape
 * every assertion built on this:
 *
 *   - a regex against the Postgres text never matches the thrown message, and
 *   - `.rejects.toThrow()` with no matcher passes on *any* failure — a missing
 *     table, an unresolved import, a typo in the test itself — which is a test
 *     that cannot distinguish the behaviour under test from its own breakage.
 *
 * Narrowed with `in` checks rather than casts, per the repo's no-cast rule.
 */

function pgCause(error: unknown): object | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  return cause;
}

/** The SQLSTATE code behind a drizzle failure — `"42P07"`, `"23505"`, … */
export function pgErrorCode(error: unknown): string | undefined {
  const cause = pgCause(error);
  if (cause === undefined || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

/** The constraint a Postgres error names, when it names one. */
export function pgErrorConstraint(error: unknown): string | undefined {
  const cause = pgCause(error);
  if (cause === undefined || !("constraint_name" in cause)) return undefined;
  return typeof cause.constraint_name === "string" ? cause.constraint_name : undefined;
}

/**
 * The error a promise rejected with, or a failure if it resolved. Lets a test
 * assert on *which* error was thrown while still failing loudly when nothing
 * was thrown at all — the case `try { await p } catch { … }` silently passes.
 */
export async function rejectionOf(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}
