import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pluginJobRuns, pluginMigrations } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { pgErrorCode, pgErrorConstraint } from "./helpers/pg-error.js";

const { db, sql: conn } = testDb();

// isolated-db.setup.ts gives this file its own database but does not clear it
// between tests, so the first test's row would otherwise be counted by the
// second test's `name = '0001_init'` select.
beforeEach(async () => { await resetDb(db); });
afterAll(async () => { await conn.end(); });

/**
 * The constraint name, but only for a genuine unique violation — a different
 * SQLSTATE that happens to carry a `constraint_name` must not be reported as
 * one. The narrowing itself lives in helpers/pg-error.ts, which explains why
 * the Postgres detail is on `cause` rather than on the thrown message.
 */
function violatedConstraint(error: unknown): string | undefined {
  return pgErrorCode(error) === "23505" ? pgErrorConstraint(error) : undefined;
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
