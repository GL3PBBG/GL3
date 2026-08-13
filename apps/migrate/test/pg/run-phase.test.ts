import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../../../server/src/db/client.js";
import { settings } from "../../../server/src/db/schema/index.js";
import { createIsolatedPgTarget } from "../helpers/fixtures.js";
import { runPhase } from "../../src/pg/run-phase.js";

describe("runPhase", () => {
  it("commits writes when dryRun is false", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      await runPhase(db, false, async (tx) => {
        await tx.insert(settings).values({ key: "a", value: "1" });
      });
      const rows = await db.select().from(settings).where(eq(settings.key, "a"));
      expect(rows).toHaveLength(1);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("rolls back every write when dryRun is true, leaving zero durable rows", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      await runPhase(db, true, async (tx) => {
        await tx.insert(settings).values({ key: "a", value: "1" });
      });
      const rows = await db.select().from(settings);
      expect(rows).toHaveLength(0);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("returns the callback's value even on a dry-run rollback", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      const result = await runPhase(db, true, async () => 42);
      expect(result).toBe(42);
      await sql.end();
    } finally {
      await target.teardown();
    }
  });

  it("propagates a real error (not swallowed as a dry-run rollback)", async () => {
    const target = await createIsolatedPgTarget();
    try {
      const { db, sql } = createDb(target.url);
      await expect(runPhase(db, false, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
      await sql.end();
    } finally {
      await target.teardown();
    }
  });
});
