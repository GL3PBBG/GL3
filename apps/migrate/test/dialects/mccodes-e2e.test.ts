import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import {
  crimes, gameNews, gangs as gangsTable, idMap, mailMessages, notifications,
  playerItems, players, playerStats, playerTimers, roles, roleModuleAccess,
  locations, items, settings,
} from "../../../server/src/db/schema/index.js";
import { bootTestServer } from "../../../server/test/helpers/server.js";
import {
  combatLog, coursesDone, coursesPlugin, educationProgress, forumPosts, forumTopics, forums,
  housesPlugin, jobRanks, jobsPlugin, playerJobs, shopStock,
} from "../../src/pg/plugin-tables.js";
import { createIsolatedMccodesFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { runMigration } from "../../src/orchestrator.js";
import { lookupV3Id } from "../../src/id-map.js";

/**
 * B4 Task 17 — the end-to-end acceptance for the MCCodes dialect: one full
 * `--mccodes`-shaped run into a family-booted target, the load-bearing rows
 * of every phase asserted, a second run proving convergence (the same two
 * SPEC §6 criteria the V2 dialect proves in orchestrator-idempotency and
 * legacy-login), and a real-Fastify login by a migrated MCCodes player
 * through the legacy md5 branch, then the crimes listing — the B-contract
 * smoke that migrated content is PLAYABLE, not merely present.
 */

const MCCODES_TABLES = [
  roles, roleModuleAccess, locations, items, crimes,
  players, playerStats, playerTimers,
  gangsTable, playerItems, mailMessages, notifications, gameNews,
  forums, forumTopics, forumPosts, settings,
  housesPlugin, coursesPlugin, coursesDone, educationProgress,
  jobsPlugin, jobRanks, playerJobs, shopStock, combatLog,
  idMap,
] as const;

describe("mccodes dialect — end to end (plan Task 17)", () => {
  it("migrates the whole fixture, converges on a re-run, and the game is playable", async () => {
    const fixture = await createIsolatedMccodesFixture();
    const target = await createIsolatedPgTarget({ plugins: "mccodes" });
    const savedDatabaseUrl = process.env.DATABASE_URL;
    let closeServer: (() => Promise<void>) | undefined;
    const pool = mysql.createPool(fixture.url);
    const { db, sql } = createDb(target.url);
    try {
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false, dialect: "mccodes" });

      // --- the load-bearing rows, one per phase ---------------------------
      const [muggy] = await db.select().from(players).where(eq(players.username, "Muggy"));
      const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, muggy!.id));
      expect(stats!.bank).toBe(5000n); // bankmoney 5000 + cybermoney -1 folded
      expect(stats!.energyRegenAt).toBeNull(); // no retroactive regen
      expect(stats!.weaponItemId).toBeNull(); // both MCCodes weapons are melee
      expect(stats!.weaponMeleeItemId).not.toBeNull();
      const timerKeys = (await db.select().from(playerTimers)
        .where(eq(playerTimers.playerId, muggy!.id))).map((t) => t.key).sort();
      expect(timerKeys).toEqual(["bank.opened", "membership"]);

      const [pick] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
      expect(pick!.successFormula).toBe("min(95, 10 + CRIMEXP / 100)"); // verbatim

      expect(await db.select().from(housesPlugin)).toHaveLength(2); // seeded default adopted
      expect(await db.select().from(coursesDone)).toHaveLength(1);
      expect(await db.select().from(educationProgress)).toHaveLength(1);
      expect(await db.select().from(playerJobs)).toHaveLength(2);

      const [gang] = await db.select().from(gangsTable);
      expect(gang).toMatchObject({ bank: 750000n, points: 30n, respect: 240n });

      expect(await db.select().from(shopStock)).toHaveLength(2);
      expect(await db.select().from(combatLog)).toHaveLength(3);
      const settingRows = await db.select().from(settings);
      expect(settingRows.find((s) => s.key === "temple.refill_points")?.value).toBe("12");

      // --- convergence: the second run is a no-op -------------------------
      const countsAfterFirstRun = await Promise.all(
        MCCODES_TABLES.map((t) => db.select().from(t).then((r) => r.length)));
      const muggyIdAfterFirstRun = await lookupV3Id(db, "users", 1);
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false, dialect: "mccodes" });
      const countsAfterSecondRun = await Promise.all(
        MCCODES_TABLES.map((t) => db.select().from(t).then((r) => r.length)));
      expect(countsAfterSecondRun).toEqual(countsAfterFirstRun);
      expect(await lookupV3Id(db, "users", 1)).toBe(muggyIdAfterFirstRun);
      // No duplicate opening balances: one bank.opened timer per opened player.
      const bankTimers = await db.select().from(playerTimers)
        .where(and(eq(playerTimers.key, "bank.opened")));
      expect(bankTimers).toHaveLength(2); // u1 + u2, once each, still

      // --- the B-contract smoke: boot GL3 on the migrated database --------
      process.env.DATABASE_URL = target.url;
      const server = await bootTestServer();
      closeServer = server.close;

      // BigSal's fixture hash is the REAL unsalted md5('password') — the
      // older MCCodes form (empty pass_salt). Newbie can't be the login
      // subject: the fixture fed-jails user 3, and a fed ban refuses login.
      const bad = await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "BigSal", password: "wrongpassword" },
      });
      expect(bad.statusCode).toBe(401); // not a passwordless fallback

      const login = await server.app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { username: "BigSal", password: "password" },
      });
      expect(login.statusCode).toBe(200); // the legacy unsalted md5 branch
      const { token } = login.json() as { token: string };
      expect(token).toBeDefined();

      // Lazy argon2id upgrade happened on that login.
      const [sal] = await db.select().from(players).where(eq(players.username, "BigSal"));
      expect(sal!.passwordHash?.startsWith("$argon2id$")).toBe(true);
      expect(sal!.legacyMccodesHash).toBeNull();

      // The migrated formula crime is served to the migrated player.
      const listing = await server.app.inject({
        method: "GET", url: "/api/crimes",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(listing.statusCode).toBe(200);
      const body = listing.json() as { crimes: Array<{ name: string }> };
      expect(body.crimes.map((c) => c.name)).toContain("Pickpocket");
    } finally {
      if (closeServer) await closeServer();
      process.env.DATABASE_URL = savedDatabaseUrl;
      await pool.end();
      await sql.end();
      await target.teardown();
      await fixture.teardown();
    }
  });
});
