import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../server/src/db/client.js";
import { players } from "../../server/src/db/schema/index.js";
import { bootTestServer } from "../../server/test/helpers/server.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "./helpers/fixtures.js";
import { createReport } from "../src/report.js";
import { runMigration } from "../src/orchestrator.js";

describe("M4 acceptance: legacy V2 login after migration (SPEC §4.3, §6)", () => {
  it("a migrated player logs in with their old V2 password and is upgraded to argon2id", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    const savedDatabaseUrl = process.env.DATABASE_URL;
    let closeServer: (() => Promise<void>) | undefined;
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });
      await pool.end();
      await sql.end();

      // bootTestServer() reads DATABASE_URL from process.env — point it at
      // the database this test just migrated into, exactly as a real GL3
      // deploy boots its Fastify app against the database gl3-migrate
      // just populated.
      process.env.DATABASE_URL = target.url;
      const server = await bootTestServer();
      closeServer = server.close;

      const before = await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "OldTimer", password: "wrongpassword" },
      });
      expect(before.statusCode).toBe(401); // proves this isn't a passwordless fallback

      const res = await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "OldTimer", password: "oldpass6" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().username).toBe("OldTimer");

      const { db: verifyDb, sql: verifySql } = createDb(target.url);
      const [row] = await verifyDb.select().from(players).where(eq(players.username, "OldTimer"));
      expect(row?.passwordHash?.startsWith("$argon2id$")).toBe(true);
      expect(row?.legacyPasswordSha256).toBeNull();
      await verifySql.end();
    } finally {
      if (closeServer) await closeServer();
      process.env.DATABASE_URL = savedDatabaseUrl;
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("re-running the migrator after the upgrade does not revert the player back to legacy auth", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    const savedDatabaseUrl = process.env.DATABASE_URL;
    let closeServer: (() => Promise<void>) | undefined;
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });

      process.env.DATABASE_URL = target.url;
      const server = await bootTestServer();
      closeServer = server.close;
      await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "OldTimer", password: "oldpass6" },
      });

      // Re-run the migrator against the SAME MySQL source — its U_password
      // column still holds the original V2 hash, unaware the player
      // upgraded. The players migrator (Task 20) must not clobber the
      // now-null legacy column back to that stale hash.
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false });

      const [row] = await db.select().from(players).where(eq(players.username, "OldTimer"));
      expect(row?.passwordHash?.startsWith("$argon2id$")).toBe(true);
      expect(row?.legacyPasswordSha256).toBeNull();

      const stillWorks = await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "OldTimer", password: "oldpass6" },
      });
      expect(stillWorks.statusCode).toBe(200);

      await pool.end();
      await sql.end();
    } finally {
      if (closeServer) await closeServer();
      process.env.DATABASE_URL = savedDatabaseUrl;
      await fixture.teardown();
      await target.teardown();
    }
  });
});
