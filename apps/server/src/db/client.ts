import { appendFileSync } from "node:fs";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;

/**
 * Per-connection ring of the most recent statements this process sent, kept
 * ALWAYS (a few KB per connection — bounded, in memory, no I/O). A Postgres
 * deadlock report names only the two statements that were BLOCKED when the
 * detector fired; the locks that formed the cycle were taken by earlier
 * statements in each transaction, which nothing was recording. The casino
 * ABBA `40P01` flake was chased blind four separate times, then survived a
 * ~45,000-race instrumented reproduction hunt on 2026-08-29 without firing
 * once — so instead of reproducing it, the next natural occurrence documents
 * itself: `dumpRecentQueries()` is printed by the `40P01` branch of the
 * plugin-route driver-error logging (`plugins/routes.ts`).
 */
const RING_SIZE = 120;
const recentQueries = new Map<number, string[]>();

// Params carry bigints (money), which plain JSON.stringify rejects — and a
// throw inside the driver's debug hook fails the QUERY. Everything in here is
// wrapped and bigint-safe for that reason.
function safeParams(parameters: unknown[]): string {
  try {
    return JSON.stringify(parameters, (_k, v: unknown) => (typeof v === "bigint" ? `${v}n` : v)).slice(0, 160);
  } catch {
    return "[unserializable]";
  }
}

function record(connection: number, query: string, parameters: unknown[]): void {
  try {
    let ring = recentQueries.get(connection);
    if (ring === undefined) recentQueries.set(connection, (ring = []));
    ring.push(`${Date.now()} ${query.replace(/\s+/g, " ").slice(0, 240)} :: ${safeParams(parameters)}`);
    if (ring.length > RING_SIZE) ring.shift();
  } catch {
    /* diagnostics must never break the pool */
  }
}

/** Every pool connection's recent statement history, newest last — the datum
 *  a deadlock post-mortem needs. Read-only snapshot. */
export function dumpRecentQueries(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [conn, ring] of recentQueries) out[`c${conn}`] = [...ring];
  return out;
}

export function createDb(databaseUrl: string): { db: Db; sql: postgres.Sql } {
  // GL3_PG_DEBUG_LOG additionally appends every statement to a file (heavy;
  // deadlock-hunt loops only). The in-memory ring above is always on.
  const debugLog = process.env.GL3_PG_DEBUG_LOG;
  const sql = postgres(databaseUrl, {
    max: 10,
    debug: (connection: number, query: string, parameters: unknown[]) => {
      record(connection, query, parameters);
      if (debugLog) {
        try {
          appendFileSync(
            debugLog,
            `${Date.now()} p${process.pid} c${connection} ${query.replace(/\s+/g, " ").slice(0, 300)} :: ${safeParams(parameters)}\n`,
          );
        } catch {
          /* diagnostics must never break the pool */
        }
      }
    },
  });
  return { db: drizzle(sql, { schema }), sql };
}
