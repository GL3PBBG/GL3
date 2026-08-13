import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { gameNews, mailMessages, notifications } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { migrateSocial } from "../../src/migrators/social.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migrateSocial", () => {
  it("migrates mail with a flat thread_id walked to the root, notifications, and game news", async () => {
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
      await migrateSocial(pool, db, report);

      const vitoId = (await lookupV3Id(db, "users", 1))!;
      const soldierId = (await lookupV3Id(db, "users", 3))!;

      const mailRows = await db.select().from(mailMessages);
      expect(mailRows).toHaveLength(3); // recipient-999 orphan dropped
      const root = mailRows.find((m) => m.subject === "Hi")!;
      const reply = mailRows.find((m) => m.subject === "Re: Hi")!;
      expect(reply.threadId).toBe(root.id); // walked M_parent to the root message's own uuid
      expect(root.senderId).toBe(vitoId);
      expect(reply.senderId).toBe(soldierId);
      const systemMail = mailRows.find((m) => m.subject === "System notice")!;
      expect(systemMail.senderId).toBeNull(); // no sender = system mail, not an orphan
      expect(report.orphans).toContainEqual({ table: "mail", v2Id: 4, reason: "recipient 999 does not exist" });

      const notifRows = await db.select().from(notifications).where(eq(notifications.playerId, vitoId));
      expect(notifRows).toHaveLength(1);
      expect(report.orphans.some((o) => o.table === "notifications" && o.reason === "user 999 does not exist")).toBe(true);

      const newsRows = await db.select().from(gameNews);
      expect(newsRows).toHaveLength(2);
      expect(newsRows.some((n) => n.authorId === null)).toBe(true); // system announcement

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
