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
      "crimes", "locations", "cars", "theft_tiers", "weapons", "items", "player_items",
      "garage", "gangs", "gang_members", "gang_permissions", "gang_invites", "gang_logs",
      "properties", "bounties", "detective_searches", "mail_messages", "notifications",
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
});
