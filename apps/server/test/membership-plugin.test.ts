import membershipPlugin from "@gl3/plugin-membership";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
afterAll(async () => { await conn.end(); });

describe("membership migrations", () => {
  it("creates p_membership_packages", async () => {
    await runPluginMigrations(db, [membershipPlugin]);
    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables WHERE tablename = 'p_membership_packages'`);
    expect(tables).toHaveLength(1);
  });
});
