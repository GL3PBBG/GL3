import type { Db } from "../../../server/src/db/client.js";

/**
 * The type Drizzle infers for the `tx` parameter inside
 * `db.transaction(async (tx) => { ... })`. Every migrator and id-map
 * function is typed to accept `Executor` (this or the outer `Db`) so the
 * exact same function runs unmodified whether it's called directly in a
 * test or from inside the orchestrator's per-phase transaction.
 */
export type Tx = Parameters<Db["transaction"]>[0] extends (tx: infer T, ...args: never[]) => unknown ? T : never;

export type Executor = Db | Tx;
