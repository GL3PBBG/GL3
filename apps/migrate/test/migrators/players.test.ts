import { and, eq, sum } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createDb } from "../../../server/src/db/client.js";
import { players, playerStats, transactions } from "../../../server/src/db/schema/index.js";
import { createIsolatedMysqlFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";
import { createReport } from "../../src/report.js";
import { migrateRanks } from "../../src/migrators/ranks.js";
import { migrateLocations } from "../../src/migrators/locations.js";
import { migrateItems } from "../../src/migrators/items.js";
import { migrateRoles } from "../../src/migrators/roles.js";
import { migrateRounds } from "../../src/migrators/rounds.js";
import { migratePlayers } from "../../src/migrators/players.js";
import { lookupV3Id } from "../../src/id-map.js";

describe("migratePlayers", () => {
  it("migrates users + userStats core columns, copying the legacy password verbatim", async () => {
    const fixture = await createIsolatedMysqlFixture();
    const target = await createIsolatedPgTarget();
    try {
      const pool = mysql.createPool(fixture.url);
      const { db, sql } = createDb(target.url);

      // FK targets, in real pipeline order (Task 29 will do this for real).
      await migrateRoles(pool, db, createReport(false));
      await migrateRounds(pool, db, createReport(false));
      await migrateRanks(pool, db, createReport(false));
      await migrateLocations(pool, db, createReport(false));
      await migrateItems(pool, db, createReport(false));

      const report = createReport(false);
      await migratePlayers(pool, db, report);

      const playerRows = await db.select().from(players);
      expect(playerRows).toHaveLength(6);

      const vito = playerRows.find((p) => p.username === "DonVito");
      expect(vito?.legacyV2Id).toBe(1);
      expect(vito?.legacyPasswordSha256).toBe("d62a234e0d9f59d8240292e2042e50e7d1da3c668a0636bf5930fcaac5b52224");
      expect(vito?.passwordHash).toBeNull();
      expect(vito?.email).toBe("vito@family.test");

      const oldTimer = playerRows.find((p) => p.username === "OldTimer");
      const adminRoleId = await lookupV3Id(db, "userRoles", 2);
      expect(oldTimer?.roleId).toBe(adminRoleId); // U_userLevel=2 -> role 2

      // U_status=1 (active) -> email_verified_at set; U_status=2 (awaiting
      // validation, GhostGangMember in the fixture) -> left NULL.
      expect(vito?.emailVerifiedAt).not.toBeNull();
      const ghost = playerRows.find((p) => p.username === "GhostGangMember");
      expect(ghost?.emailVerifiedAt).toBeNull();

      const vitoStats = (await db.select().from(playerStats).where(eq(playerStats.playerId, vito!.id)))[0];
      expect(vitoStats?.cash).toBe(2100000000n); // above the V2 int32 comfort zone, exact
      expect(vitoStats?.gangId).toBeNull(); // deferred to the gangs migrator (Task 23)
      expect(vitoStats?.avatarUrl).toBeNull();
      expect(vitoStats?.bio).toBe("Head of the family");

      const usersTable = report.tables.find((t) => t.table === "users");
      expect(usersTable).toEqual({ table: "users", read: 6, written: 6, skipped: 0 });

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });

  it("seeds an opening-balance ledger row per non-zero balance kind and preserves sum(ledger) == balance", async () => {
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

      const allPlayers = await db.select().from(players);
      const vito = allPlayers.find((p) => p.username === "DonVito")!;
      const soldier = allPlayers.find((p) => p.username === "Soldier")!; // points=0 -> no points row

      // DonVito: cash 2100000000, bank 500000, points 100 -> 3 opening rows.
      const vitoRows = await db.select().from(transactions).where(eq(transactions.playerId, vito.id));
      expect(vitoRows).toHaveLength(3);
      expect(vitoRows.every((r) => r.reason === "migration.opening_balance")).toBe(true);
      expect(vitoRows.every((r) => r.refId === null)).toBe(true);
      expect(vitoRows.every((r) => r.jobId !== null)).toBe(true);
      const byKind = Object.fromEntries(vitoRows.map((r) => [r.balanceKind, r.amount]));
      expect(byKind.cash).toBe(2100000000n);
      expect(byKind.bank).toBe(500000n);
      expect(byKind.points).toBe(100n);

      // Soldier: cash 15000, bank 5000, points 0 -> 2 rows (points omitted).
      const soldierRows = await db.select().from(transactions).where(eq(transactions.playerId, soldier.id));
      expect(soldierRows).toHaveLength(2);

      // The invariant: for every player, sum(transactions.amount) per kind == player_stats.<kind>.
      for (const p of allPlayers) {
        const [stats] = await db.select().from(playerStats).where(eq(playerStats.playerId, p.id));
        for (const kind of ["cash", "bank", "points"] as const) {
          const [agg] = await db.select({ total: sum(transactions.amount) })
            .from(transactions)
            .where(and(eq(transactions.playerId, p.id), eq(transactions.balanceKind, kind)));
          const ledgerSum = agg?.total ? BigInt(agg.total) : 0n;
          const balance = stats[kind];
          expect(ledgerSum).toBe(balance);
        }
      }

      await pool.end();
      await sql.end();
    } finally {
      await fixture.teardown();
      await target.teardown();
    }
  });
});
