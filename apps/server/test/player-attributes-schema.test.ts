import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();

describe("player_attributes migration", () => {
  afterAll(async () => { await conn.end(); });

  it("backfills every existing row to an inert state", async () => {
    const playerId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO players (id, username, email, password_hash)
      VALUES (${playerId}, ${"attr_backfill_" + playerId.slice(0, 8)}, NULL, NULL)
    `);
    await db.execute(sql`INSERT INTO player_stats (player_id) VALUES (${playerId})`);

    const rows = (await db.execute(sql`
      SELECT energy, energy_max, will, will_max, brave, brave_max,
             strength, agility, guard, labour, iq, crime_exp, level, health_max,
             energy_regen_at, will_regen_at, brave_regen_at, health_regen_at
      FROM player_stats WHERE player_id = ${playerId}
    `)) as unknown as Record<string, unknown>[];

    const row = rows[0];
    expect(row).toBeDefined();
    for (const col of ["energy", "energy_max", "will", "will_max", "brave", "brave_max"]) {
      expect(Number(row![col])).toBe(0);
    }
    for (const col of ["strength", "agility", "guard", "labour", "iq", "crime_exp"]) {
      expect(String(row![col])).toBe("0");
    }
    expect(Number(row!["level"])).toBe(1);
    expect(row!["health_max"]).toBeNull();
    for (const col of ["energy_regen_at", "will_regen_at", "brave_regen_at", "health_regen_at"]) {
      expect(row![col]).toBeNull();
    }
  });

  it("defaults crimes.brave_cost to 0 (unpriced for GL3-native games)", async () => {
    const rows = (await db.execute(sql`
      INSERT INTO crimes (id, name, cooldown_seconds, min_payout, max_payout)
      VALUES (${crypto.randomUUID()}, ${"brave_cost_default"}, 60, 10, 20)
      RETURNING brave_cost
    `)) as unknown as { brave_cost: number }[];
    expect(Number(rows[0]!.brave_cost)).toBe(0);
  });

  it("adds no foreign key and no index", async () => {
    const fks = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'f' AND t.relname = 'player_stats'
    `)) as unknown as { n: number }[];
    const idx = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'player_stats'
        AND indexname LIKE 'player_stats_%_idx'
    `)) as unknown as { n: number }[];
    // Unchanged by 0016. Measured empirically against the pre-migration
    // schema (2026-08-25), not trusted from the brief, per the controller's
    // ruling that the brief's printed FK count was wrong:
    //   FKs (6): player_id->players (the primary key is ALSO a foreign key,
    //     omitted by the brief's enumeration), rank, gang, location,
    //     weapon item, armor item.
    //   Indexes (7): cash, exp, gang, rank, location, jailed_until,
    //     hospital_until.
    // Restate if a LATER migration moves them; never loosen.
    expect(fks[0]!.n).toBe(6);
    expect(idx[0]!.n).toBe(7);
  });
});
