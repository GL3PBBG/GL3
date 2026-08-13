import type { Db } from "../../../server/src/db/client.js";
import type { Tx } from "./types.js";

/** Sentinel thrown to force Postgres to roll back a `--dry-run` phase's
 * transaction. Never escapes `runPhase` — caught and treated as a normal
 * (rolled-back) completion, not a failure. */
export class DryRunRollback extends Error {}

export async function runPhase<T>(db: Db, dryRun: boolean, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let outcome: T | undefined;
  try {
    await db.transaction(async (tx) => {
      outcome = await fn(tx);
      if (dryRun) throw new DryRunRollback();
    });
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }
  // Reached only if the transaction callback resolved without throwing a
  // real error — `outcome` is guaranteed assigned by that point; the cast
  // documents an invariant `db.transaction`'s control flow can't express to
  // the type checker across the try/catch boundary.
  return outcome as T;
}
