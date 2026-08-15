import { eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "./helpers/db.js";
import { players, playerStats } from "../src/db/schema/index.js";

const { db, sql: conn } = testDb();

const columnType = async (table: string, column: string): Promise<string | undefined> => {
  const rows = await db.execute<{ data_type: string }>(sql`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = ${table} AND column_name = ${column}
  `);
  return rows[0]?.data_type;
};

describe("core schema", () => {
  beforeAll(async () => {
    // Migrations must already be applied: `npm run db:up && npm --workspace @gl3/server run db:migrate`
  });
  afterAll(async () => { await conn.end(); });

  it("creates every table named in spec §2.5", async () => {
    const rows = await db.execute<{ tablename: string }>(sql`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `);
    const names = new Set(rows.map((r) => r.tablename));
    for (const expected of [
      "players", "player_stats", "player_timers", "player_crime_skill", "transactions",
      "crimes", "locations", "weapons", "items", "player_items",
      "gangs", "gang_members", "gang_permissions", "gang_invites", "gang_logs",
      // No "bounties" / "detective_searches" / "combat_log": core relinquished
      // all three in 0007_relinquish_plugin_tables. No "cars" / "theft_tiers" /
      // "garage": core relinquished those three in 0009_relinquish_car_tables.
      // No "properties": core relinquished it in 0010_relinquish_properties.
      // All seven are spec §2.5 tables still, but the plugins that are their
      // only consumers create them now (p_bounties_bounties,
      // p_detectives_searches, p_combat_log, p_theft_cars, p_theft_tiers,
      // p_theft_garage, p_properties_properties) and this file never boots
      // plugins — see combat-log-schema.test.ts for the plugin-owned
      // equivalent of this assertion.
      "mail_messages", "notifications",
      "game_news", "ranks", "money_ranks", "roles", "role_module_access", "rounds",
      "settings", "crime_log", "id_map",
    ]) {
      expect(names, `missing table ${expected}`).toContain(expected);
    }
  });

  it("stores money as bigint, never integer", async () => {
    expect(await columnType("player_stats", "cash")).toBe("bigint");
    expect(await columnType("player_stats", "bank")).toBe("bigint");
    expect(await columnType("player_stats", "exp")).toBe("bigint");
    expect(await columnType("transactions", "amount")).toBe("bigint");
    expect(await columnType("gangs", "bank")).toBe("bigint");
  });

  it("makes usernames case-insensitively unique", async () => {
    expect(await columnType("players", "username")).toBe("USER-DEFINED"); // citext
  });

  it("keeps the legacy password columns required by spec §4.3", async () => {
    expect(await columnType("players", "legacy_password_sha256")).toBe("text");
    expect(await columnType("players", "legacy_v2_id")).toBe("integer");
  });

  /**
   * Column DDL default was switched from a raw JS `0n` literal to `sql`0`` to work around a
   * drizzle-kit bug serializing BigInt defaults (see task-4-report.md, fix round 2). Only the
   * DDL default's *expression* changed — `mode: "bigint"` still governs how the driver reads and
   * writes the column, so this proves that switch didn't quietly regress into JS `number`
   * (the exact V2 signed-32-bit ceiling this schema exists to prevent) or a `string`.
   */
  it("round-trips player_stats.cash as a JS bigint, not number or string", async () => {
    const playerId = uuidv7();
    await db.insert(players).values({ id: playerId, username: `bigint-test-${playerId}` });
    try {
      await db.insert(playerStats).values({ playerId });
      const [defaulted] = await db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, playerId));
      expect(typeof defaulted?.cash).toBe("bigint");
      expect(defaulted?.cash).toBe(0n);

      const aboveInt32 = 5_000_000_000n; // > 2^31-1
      await db.update(playerStats).set({ cash: aboveInt32 }).where(eq(playerStats.playerId, playerId));
      const [updated] = await db
        .select({ cash: playerStats.cash })
        .from(playerStats)
        .where(eq(playerStats.playerId, playerId));
      expect(typeof updated?.cash).toBe("bigint");
      expect(updated?.cash).toBe(aboveInt32);
    } finally {
      await db.delete(players).where(eq(players.id, playerId)); // cascades to player_stats
    }
  });

  /**
   * Table/column-existence and data-type checks above would not notice a
   * migration that silently dropped a foreign key, an index, or downgraded
   * an ON DELETE rule. Hand-enumerating all ~44 FKs and ~29 indexes would be
   * unwieldy and would itself need updating every time a later task adds a
   * table, so this asserts the *counts* (which move only when the schema
   * genuinely changes) plus a targeted sample of high-value constraints:
   * one CASCADE FK (players -> player_stats, the hot-row split this schema
   * exists to support), one SET NULL FK (players.role_id, a nullable
   * reference that must not take the whole row down with it), and one
   * leaderboard-shaped index (player_stats.exp, used to rank players).
   */
  it("keeps every foreign key and its ON DELETE rule intact", async () => {
    const rows = await db.execute<{ confdeltype: string; count: string }>(sql`
      SELECT confdeltype, count(*)::text AS count
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public'
      GROUP BY confdeltype
    `);
    const byRule = Object.fromEntries(rows.map((r) => [r.confdeltype, Number(r.count)]));
    const totalForeignKeys = Object.values(byRule).reduce((sum, n) => sum + n, 0);

    // 47 through 0006. 0007_relinquish_plugin_tables dropped three tables and
    // the eight FKs they carried — bounties (placed_by, target cascade;
    // claimed_by set null), detective_searches (player_id, target_player_id
    // cascade) and combat_log (attacker_id, target_id cascade;
    // weapon_item_id set null). The constraints did not disappear from the
    // game, only from core: the plugins that own those tables now recreate
    // them, which combat-log-schema.test.ts pins for its share.
    // 0009_relinquish_car_tables dropped garage and its three FKs —
    // player_id, car_id cascade; location_id set null. cars and theft_tiers
    // carried none. p_theft_garage recreates all three under the theft
    // plugin, which theft-tiers.test.ts pins for its share.
    // 0010_relinquish_properties dropped properties and its two FKs —
    // location_id cascade; owner_player_id set null.
    // p_properties_properties recreates both under the properties plugin.
    expect(totalForeignKeys).toBe(34);
    expect(byRule["c"]).toBe(21); // ON DELETE CASCADE
    expect(byRule["n"]).toBe(13); // ON DELETE SET NULL

    const [cascadeSample] = await db.execute<{ confdeltype: string }>(sql`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'player_stats_player_id_players_id_fk'
    `);
    expect(cascadeSample?.confdeltype).toBe("c");

    const [setNullSample] = await db.execute<{ confdeltype: string }>(sql`
      SELECT confdeltype FROM pg_constraint WHERE conname = 'players_role_id_roles_id_fk'
    `);
    expect(setNullSample?.confdeltype).toBe("n");
  });

  it("keeps every non-primary-key index, including the leaderboard sample", async () => {
    const [{ count }] = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM pg_indexes i
      WHERE i.schemaname = 'public'
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.contype = 'p' AND c.conname = i.indexname
      )
    `);
    // 31 shipped through 0005; migration 0006 dropped crime_log_job_id_unique
    // (a core-era idempotency key the crimes plugin's job ids collide with);
    // 0007 dropped three more with the tables that owned them —
    // bounties_target_idx, combat_log_target_idx and combat_log_attacker_idx.
    // detective_searches had none beyond its primary key. 0008 added two
    // partial indexes for the sentence sweeper's candidate scan —
    // player_stats_jailed_until_idx and player_stats_hospital_until_idx,
    // each `WHERE ... IS NOT NULL` so only active sentences are indexed.
    // 0009_relinquish_car_tables dropped garage_player_idx with the table
    // that owned it; cars and theft_tiers had no indexes beyond their
    // primary key. p_theft_garage_player_idx recreates it under the theft
    // plugin, which theft-tiers.test.ts pins for its share.
    // 0010_relinquish_properties dropped properties_location_idx with the
    // table that owned it. p_properties_properties recreates it under the
    // properties plugin.
    expect(Number(count)).toBe(27);

    const [leaderboardIndex] = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'player_stats_exp_idx'
    `);
    expect(leaderboardIndex?.indexdef).toContain("(exp)");
  });

  it("gives crimes an explicit jail-on-failure risk (spec: GL3 model addition, see M2 plan Decision 2)", async () => {
    expect(await columnType("crimes", "jail_chance_percent")).toBe("integer");
    expect(await columnType("crimes", "jail_seconds")).toBe("integer");
  });
});
