import { describe, expect, it } from "vitest";
import { createDb } from "../../../server/src/db/client.js";
import {
  gameNews, mailMessages, notifications, playerItems, players, settings,
} from "../../../server/src/db/schema/index.js";
import { createReport } from "../../src/report.js";
import { runMigration } from "../../src/orchestrator.js";
import { combatLog, forumPosts, forumTopics, forums } from "../../src/pg/plugin-tables.js";
import { createIsolatedMccodesFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";

/**
 * B4 (plan Tasks 14-16): inventory, social (mail/events/announcements +
 * relationship-table drops), the forum trilogy with the ff_auth gate, the
 * attacklogs import with its stole sentinels, the wholesale log/market/cron
 * drop sweep, and settings with the temple namespace mapping.
 */

async function runOnce() {
  const fixture = await createIsolatedMccodesFixture();
  const target = await createIsolatedPgTarget({ plugins: "mccodes" });
  const { db, sql } = createDb(target.url);
  const report = createReport(false);
  const mysql = (await import("mysql2/promise")).default;
  const pool = mysql.createPool(fixture.url);
  try {
    await runMigration({ mysql: pool, db, report, dryRun: false, dialect: "mccodes" });
  } finally {
    await pool.end();
  }
  return {
    db, sql, report,
    teardown: async () => { await sql.end(); await target.teardown(); await fixture.teardown(); },
  };
}

async function playerIdByName(run: Awaited<ReturnType<typeof runOnce>>, username: string) {
  const { eq } = await import("drizzle-orm");
  const [row] = await run.db.select().from(players).where(eq(players.username, username));
  return row!.id;
}

describe("mccodes dialect — B4 (inventory, social, logs, settings)", () => {
  it("imports the inventory with quantities and reports the orphan item", async () => {
    const run = await runOnce();
    try {
      const u1 = await playerIdByName(run, "Muggy");
      const u2 = await playerIdByName(run, "BigSal");
      const rows = await run.db.select().from(playerItems);
      expect(rows).toHaveLength(4);
      expect(rows.filter((r) => r.playerId === u1)).toHaveLength(3);
      expect(rows.filter((r) => r.playerId === u1).map((r) => r.qty).sort()).toEqual([1, 1, 3]);
      expect(rows.filter((r) => r.playerId === u2)).toHaveLength(1);
      // inv row 5 references item 99, which does not exist.
      expect(run.report.orphans.some((o) => o.table === "inventory" && o.reason.includes("item 99"))).toBe(true);
    } finally {
      await run.teardown();
    }
  });

  it("imports mail flat, events as notifications, announcements ordinal — and drops the relationship lists", async () => {
    const run = await runOnce();
    try {
      const u1 = await playerIdByName(run, "Muggy");
      const mail = await run.db.select().from(mailMessages);
      expect(mail).toHaveLength(2);
      // MCCodes mail has no threads — every message is its own thread root.
      expect(mail.every((m) => m.threadId === m.id)).toBe(true);
      const hello = mail.find((m) => m.subject === "Hello")!;
      expect(hello.recipientId).toBe(u1);
      expect(hello.senderId).not.toBeNull();
      expect(hello.readAt).not.toBeNull(); // mail_read = 1
      const system = mail.find((m) => m.subject === "System")!;
      expect(system.senderId).toBeNull(); // mail_from = 0, the system sentinel
      expect(system.readAt).toBeNull();

      const notifs = await run.db.select().from(notifications);
      expect(notifs).toHaveLength(2);
      const mugged = notifs.find((n) => n.body === "You were mugged.")!;
      expect(mugged.playerId).toBe(u1);
      expect(mugged.readAt).not.toBeNull(); // evREAD = 1

      const news = await run.db.select().from(gameNews);
      expect(news).toHaveLength(2);
      expect(news.every((n) => n.authorId === null)).toBe(true); // no author column
      expect(run.report.ordinalKeyedTables).toContain("announcements");

      const dropped = run.report.droppedColumns;
      expect(dropped.find((d) => d.table === "friendslist")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.find((d) => d.table === "blacklist")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.find((d) => d.table === "contactlist")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.find((d) => d.table === "polls")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.find((d) => d.table === "referals")).toMatchObject({ columns: ["*"], rows: 1 });
    } finally {
      await run.teardown();
    }
  });

  it("imports the public forum and skips ff_auth-restricted forums wholesale", async () => {
    const run = await runOnce();
    try {
      const forumRows = await run.db.select().from(forums);
      expect(forumRows.map((f) => f.name)).toEqual(["General"]);

      const topics = await run.db.select().from(forumTopics);
      expect(topics).toHaveLength(1);
      expect(topics[0]!).toMatchObject({ subject: "First topic", status: "open", type: "normal", postCount: 1 });

      const posts = await run.db.select().from(forumPosts);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body).toBe("First post!");

      // The staff forum and everything filed under it skip with a report.
      expect(run.report.droppedColumns.find((d) => d.table === "forum_forums (ff_auth != public)"))
        .toMatchObject({ columns: ["*"], rows: 1 });
    } finally {
      await run.teardown();
    }
  });

  it("imports attacklogs with stole sentinels and sweeps the log/market/cron tables", async () => {
    const run = await runOnce();
    try {
      const u1 = await playerIdByName(run, "Muggy");
      const u3 = await playerIdByName(run, "Newbie");
      const logs = await run.db.select().from(combatLog);
      expect(logs).toHaveLength(3);
      const mug = logs.find((l) => l.payout === 500n)!;
      expect(mug.attackerId).toBe(u1);
      expect(mug.targetId).toBe(u3);
      expect(mug.hit).toBe(true); // result = 'won'
      expect(logs.filter((l) => l.hit === false)).toHaveLength(1); // the 'lost' row
      expect(logs.filter((l) => l.payout === 0n)).toHaveLength(2); // the two sentinels

      expect(run.report.stoleSentinels).toHaveLength(3);
      expect(run.report.stoleSentinels.map((s) => s.stole).sort((a, b) => a - b)).toEqual([-2, -1, 500]);

      const dropped = run.report.droppedColumns;
      expect(dropped.find((d) => d.table === "attacklogs")).toMatchObject({ columns: ["attacklog"], rows: 3 });
      expect(dropped.find((d) => d.table === "cashxferlogs")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.find((d) => d.table === "jaillogs")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.find((d) => d.table === "crystalmarket")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.find((d) => d.table === "itemmarket")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.some((d) => d.table === "cron_times")).toBe(true);
      // Silently-unreported B3 leftovers, fixed in this milestone.
      expect(dropped.find((d) => d.table === "applications")).toMatchObject({ columns: ["*"], rows: 1 });
      expect(dropped.find((d) => d.table === "oclogs")).toMatchObject({ columns: ["*"], rows: 1 });
    } finally {
      await run.teardown();
    }
  });

  it("maps the temple settings into their namespace and drops the rest by name", async () => {
    const run = await runOnce();
    try {
      const rows = await run.db.select().from(settings);
      const byKey = new Map(rows.map((r) => [r.key, r.value]));
      // The C-era namespace trap: ctx.settings.get prefixes the plugin id,
      // so the stored key must carry it — a bare key silently reads as the
      // built-in default.
      expect(byKey.get("temple.refill_points")).toBe("12");
      expect(byKey.get("temple.iq_per_point")).toBe("5");
      expect(byKey.get("temple.money_per_point")).toBe("200");
      expect(byKey.has("refill_points")).toBe(false);
      expect(byKey.has("ct_refillprice")).toBe(false);
      expect(byKey.has("game_name")).toBe(false); // no GL3 surface

      const droppedSettings = run.report.droppedColumns.find((d) => d.table === "settings")!;
      expect(droppedSettings.columns).toEqual(
        expect.arrayContaining(["game_name", "game_owner", "jail_count"]));
      expect(droppedSettings.rows).toBe(3);
    } finally {
      await run.teardown();
    }
  });
});
