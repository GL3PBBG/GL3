import { and, eq, sql as sqlTag } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../../../server/src/db/client.js";
import {
  locations, playerTimers, players, playerStats, roleModuleAccess, roles, transactions,
} from "../../../server/src/db/schema/index.js";
import { createReport } from "../../src/report.js";
import { runMigration } from "../../src/orchestrator.js";
import { createIsolatedMccodesFixture, createIsolatedPgTarget } from "../helpers/fixtures.js";

/**
 * B2 (plan Tasks 8-9): roles, locations and the players migrator against the
 * 63-table fixture. Every assertion maps to a spec §4 decision — the bank
 * fold, the NULL regen stamps, the never-clobber upserts, the timers.
 */

async function runOnce(): Promise<{
  db: ReturnType<typeof createDb>["db"];
  sql: ReturnType<typeof createDb>["sql"];
  report: ReturnType<typeof createReport>;
  teardown: () => Promise<void>;
}> {
  const fixture = await createIsolatedMccodesFixture();
  const target = await createIsolatedPgTarget({ plugins: "mccodes" });
  const { db, sql } = createDb(target.url);
  const report = createReport(false);
  const pool = (await import("mysql2/promise")).createPool(fixture.url);
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

describe("mccodes dialect — B2 (roles, locations, players)", () => {
  it("imports staff_roles with the wildcard and verbatim module keys", async () => {
    const run = await runOnce();
    try {
      const all = await run.db.select().from(roles);
      expect(all.map((r) => r.name).sort()).toEqual(["Administrator", "Assistant", "Secretary"]);

      const admin = all.find((r) => r.name === "Administrator")!;
      const adminKeys = (await run.db.select().from(roleModuleAccess)
        .where(eq(roleModuleAccess.roleId, admin.id))).map((a) => a.moduleKey);
      expect(adminKeys).toContain("*");

      const secretary = all.find((r) => r.name === "Secretary")!;
      const secretaryKeys = (await run.db.select().from(roleModuleAccess)
        .where(eq(roleModuleAccess.roleId, secretary.id))).map((a) => a.moduleKey).sort();
      expect(secretaryKeys).toEqual(["manage_punishments", "use_staff_forums", "view_user_inventory"]);
    } finally {
      await run.teardown();
    }
  });

  it("imports cities with the level gate and the flat monorail fare", async () => {
    const run = await runOnce();
    try {
      const towns = await run.db.select().from(locations).orderBy(locations.minLevel);
      expect(towns).toHaveLength(2);
      expect(towns[1]).toMatchObject({ name: "Uptown", minLevel: 5, travelCost: 1000n, travelCooldownSeconds: 0 });
      expect(towns[0]).toMatchObject({ name: "Default City", minLevel: 0 });
    } finally {
      await run.teardown();
    }
  });

  it("imports players: hashes, folds, pools, stamps, timers, bans", async () => {
    const run = await runOnce();
    try {
      const rows = await run.db.select().from(players);
      expect(rows).toHaveLength(3);

      const u1 = rows.find((p) => p.username === "Muggy")!;
      expect(u1.legacyMccodesHash).toBe("hash_muggy_salted");
      expect(u1.legacyMccodesSalt).toBe("abcd1234");
      expect(u1.email).toBe("muggy@example.com");
      expect(u1.bannedAt).toBeNull();

      const u2 = rows.find((p) => p.username === "BigSal")!;
      expect(u2.legacyMccodesSalt).toBeNull(); // empty salt = unsalted form
      // users_roles pointed u2 at staff_roles 1 = Administrator.
      const adminRole = (await run.db.select().from(roles)).find((r) => r.name === "Administrator")!;
      expect(u2.roleId).toBe(adminRole.id);

      const u3 = rows.find((p) => p.username === "Newbie")!;
      // fedjail: banned at migration, expiring after 2 days, reason verbatim.
      expect(u3.bannedAt).not.toBeNull();
      expect(u3.banReason).toBe("Cheating");
      const banSpan = u3.banExpiresAt!.getTime() - u3.bannedAt!.getTime();
      expect(banSpan).toBe(2 * 86_400_000);

      // --- stats ---------------------------------------------------------
      const stats = await run.db.select().from(playerStats);
      const s1 = stats.find((s) => s.playerId === u1.id)!;
      // The fold: 5000 bank + (-1 cyber -> 0).
      expect(s1.bank).toBe(5000n);
      expect(s1.cash).toBe(2500n);
      expect(s1.points).toBe(40n);
      // Pools verbatim; all four regen stamps NULL (no retroactive regen).
      expect(s1).toMatchObject({ energy: 7, energyMax: 12, will: 60, willMax: 100, brave: 3, braveMax: 5 });
      expect(s1.energyRegenAt).toBeNull();
      expect(s1.willRegenAt).toBeNull();
      expect(s1.braveRegenAt).toBeNull();
      expect(s1.healthRegenAt).toBeNull();
      expect(s1).toMatchObject({
        health: 84, healthMax: 100, level: 5, crimeExp: 8500n, exp: 1235n, // round(1234.5678)
        strength: 124n, agility: 80n, guard: 60n, labour: 91n, iq: 43n, // round(.5) up
      });

      const s2 = stats.find((s) => s.playerId === u2.id)!;
      expect(s2.bank).toBe(20000n); // cyber-only account folds whole
      expect(s2.health).toBe(1);
      expect(s2.healthMax).toBe(150);
      expect(s2.jailedUntil).not.toBeNull();
      expect(s2.jailedUntil!.getTime() - Date.now()).toBeGreaterThan(11 * 60_000);
      expect(s2.jailedUntil!.getTime() - Date.now()).toBeLessThan(13 * 60_000);

      const s3 = stats.find((s) => s.playerId === u3.id)!;
      expect(s3.bank).toBe(0n);
      expect(s3.hospitalUntil).not.toBeNull();
      expect(s3.locationId).not.toBeNull();

      // --- timers --------------------------------------------------------
      const timers = await run.db.select().from(playerTimers);
      const t1 = timers.filter((t) => t.playerId === u1.id);
      expect(t1.find((t) => t.key === "bank.opened")).toBeDefined(); // bankmoney 5000 > -1
      const member = t1.find((t) => t.key === "membership")!; // donatordays 3
      expect(member.expiresAt.getTime() - Date.now()).toBeGreaterThan(2 * 86_400_000);
      expect(member.expiresAt.getTime() - Date.now()).toBeLessThan(3 * 86_400_000 + 60_000);
      const t2 = timers.filter((t) => t.playerId === u2.id);
      expect(t2.find((t) => t.key === "bank.opened")).toBeDefined(); // cybermoney > -1
      expect(t2.find((t) => t.key === "membership")).toBeUndefined(); // donatordays 0
      const t3 = timers.filter((t) => t.playerId === u3.id);
      expect(t3.find((t) => t.key === "bank.opened")).toBeUndefined(); // both -1

      // --- ledger: opening balances only, never fabricated history --------
      const ledger = await run.db.select().from(transactions);
      const u1Rows = ledger.filter((t) => t.playerId === u1.id);
      expect(u1Rows.map((t) => `${t.balanceKind}:${t.amount}`).sort())
        .toEqual(["bank:5000", "cash:2500", "points:40"]);
      expect(ledger.filter((t) => t.playerId === u2.id)).toHaveLength(2); // cash + bank; points was 0

      // --- report --------------------------------------------------------
      expect(run.report.bankFoldSplits).toHaveLength(2); // u1, u2
      expect(run.report.bankFoldSplits.find((b) => b.v2Id === 2)).toMatchObject({ cyber: 20000 });
      expect(run.report.loginNameDivergences).toEqual([
        { v2Id: 3, username: "Newbie", loginName: "newbie_login" },
      ]);
      expect(run.report.orphans.filter((o) => o.table === "userstats"))
        .toEqual([{ table: "userstats", v2Id: 99, reason: expect.any(String) }]);
      // B3's content phase runs before players, so equipped items resolve —
      // no "was not migrated" orphans from the classifier any more (the
      // B2-era assertion of the opposite is retired with the phase order).
      expect(run.report.orphans.some((o) => o.table === "users" && o.reason.includes("was not migrated"))).toBe(false);
      expect(run.report.droppedColumns.find((d) => d.table === "users")!.columns)
        .toContain("staffnotes");
    } finally {
      await run.teardown();
    }
  });

  it("re-running converges: one opening-balance row per kind, no duplicate roles", async () => {
    const fixture = await createIsolatedMccodesFixture();
    const target = await createIsolatedPgTarget({ plugins: "mccodes" });
    const { db, sql } = createDb(target.url);
    const mysql = (await import("mysql2/promise")).default;
    const pool = mysql.createPool(fixture.url);
    try {
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false, dialect: "mccodes" });
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false, dialect: "mccodes" });

      expect(await db.select().from(players)).toHaveLength(3);
      expect(await db.select().from(roles)).toHaveLength(3);
      const ledger = await db.select().from(transactions);
      const jobIds = ledger.map((t) => t.jobId);
      expect(new Set(jobIds).size).toBe(jobIds.length); // deterministic jobIds
      expect(ledger.filter((t) => t.balanceKind === "bank")).toHaveLength(2); // u1 + u2, once each
      const timers = await db.select().from(playerTimers)
        .where(and(eq(playerTimers.key, "bank.opened")));
      expect(timers).toHaveLength(2);
      // And the never-clobber upsert survives a simulated argon2id upgrade.
      const [u1] = await db.select().from(players).where(eq(players.username, "Muggy"));
      await db.execute(sqlTag`UPDATE players SET password_hash = 'argon2id$…',
        legacy_mccodes_hash = NULL, legacy_mccodes_salt = NULL WHERE id = ${u1!.id}`);
      await runMigration({ mysql: pool, db, report: createReport(false), dryRun: false, dialect: "mccodes" });
      const [after] = await db.select().from(players).where(eq(players.username, "Muggy"));
      expect(after!.passwordHash).toBe("argon2id$…"); // untouched
      expect(after!.legacyMccodesHash).toBeNull(); // NOT resurrected
    } finally {
      await pool.end();
      await sql.end();
      await target.teardown();
      await fixture.teardown();
    }
  });
});
