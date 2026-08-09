import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pluginJobRuns, pluginMigrations } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();

// isolated-db.setup.ts gives this file its own database but does not clear it
// between tests, so the first test's row would otherwise be counted by the
// second test's `name = '0001_init'` select.
beforeEach(async () => { await resetDb(db); });
afterAll(async () => { await conn.end(); });

/**
 * drizzle wraps the driver error, so the thrown `Error.message` is only
 * "Failed query: insert into ..." — the constraint that actually rejected the
 * row is on `cause` (a postgres.js PostgresError). Narrowed with `in` checks
 * rather than a cast, per the repo's no-cast rule.
 */
function violatedConstraint(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause: unknown = error.cause;
  if (typeof cause !== "object" || cause === null) return undefined;
  if (!("code" in cause) || cause.code !== "23505") return undefined;
  if (!("constraint_name" in cause) || typeof cause.constraint_name !== "string") return undefined;
  return cause.constraint_name;
}

/**
 * Returns the unique constraint the insert violated, or undefined if it
 * succeeded or failed for any other reason. Asserting on the returned name
 * (rather than `.rejects.toThrow()`) is what makes these tests load-bearing:
 * a bare rejection assertion also passes when the insert fails because the
 * table is missing, which says nothing about the primary key being composite.
 */
async function constraintViolatedBy(insert: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await insert;
    return undefined;
  } catch (error: unknown) {
    return violatedConstraint(error);
  }
}

describe("plugin runtime tables", () => {
  it("records a migration once per (plugin_id, name)", async () => {
    await db.insert(pluginMigrations).values({ pluginId: "hello", name: "0001_init" });
    const violated = await constraintViolatedBy(
      db.insert(pluginMigrations).values({ pluginId: "hello", name: "0001_init" }),
    );
    expect(violated).toBe("plugin_migrations_plugin_id_name_pk");
  });

  it("allows the same migration name under a different plugin", async () => {
    await db.insert(pluginMigrations).values({ pluginId: "a", name: "0001_init" });
    await db.insert(pluginMigrations).values({ pluginId: "b", name: "0001_init" });
    const rows = await db.select().from(pluginMigrations).where(sql`name = '0001_init'`);
    expect(rows).toHaveLength(2);
  });

  it("records a job run once per (plugin_id, job_id)", async () => {
    await db.insert(pluginJobRuns).values({ pluginId: "hello", jobId: "job-1" });
    const violated = await constraintViolatedBy(
      db.insert(pluginJobRuns).values({ pluginId: "hello", jobId: "job-1" }),
    );
    expect(violated).toBe("plugin_job_runs_plugin_id_job_id_pk");
  });
});
