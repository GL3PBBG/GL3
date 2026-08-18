import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { forumPosts, forumTopics, forums } from "../../src/pg/plugin-tables.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateForum } from "../../src/migrators/forum.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateForum", () => {
  it("migrates the positive forum's topic and posts, skips the gang forum, and recomputes topic aggregates", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));
      await migratePlayers(pool, db, createReport(false));

      const report = createReport(false);
      await migrateForum(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;

      // Only the positive forum (F_id 1) lands; the gang forum (F_id -1) is
      // reported skipped, not migrated.
      const forumRows = await db.select().from(forums);
      expect(forumRows).toHaveLength(1);
      expect(forumRows[0]).toMatchObject({ name: "General Discussion", sort: 1 });
      expect(report.tables.find((t) => t.table === "forums")).toMatchObject({ written: 1, skipped: 1 });

      const topicRows = await db.select().from(forumTopics);
      expect(topicRows).toHaveLength(1);
      expect(topicRows[0]).toMatchObject({
        forumId: forumRows[0]!.id,
        authorId: vitoId,
        subject: "Read this first",
        status: "locked", // T_status 1
        type: "sticky", // T_type 3 (sticky|important bits) collapses to GL3's one tier
        postCount: 2, // recomputed from migrated posts, not read from V2
      });
      expect(topicRows[0]!.lastPostAt.getTime()).toBe(new Date(1700000800 * 1000).getTime());

      const postRows = (await db.select().from(forumPosts)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      expect(postRows).toHaveLength(2);
      expect(postRows[0]).toMatchObject({ authorId: vitoId, body: "Welcome. Read the rules." });
      expect(postRows[1]).toMatchObject({ authorId: null, body: "From a ghost." });
      expect(report.orphans.some((o) => o.table === "posts" && o.reason === "author 999 does not exist")).toBe(true);

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
