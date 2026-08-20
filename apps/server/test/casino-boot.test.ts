import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { locations } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

// testDb() returns { db, sql } — createDb's pair, module-scoped and closed
// once in afterAll, as combat-log-schema.test.ts:10 does. `casino` is a
// CORE_PLUGIN (core-plugins.ts), so a bare bootTestServer() with no
// `plugins` option already migrates it via withCorePlugins — no explicit
// runPluginMigrations call needed here.
const { db, sql: conn } = testDb();

afterAll(async () => {
  await conn.end();
});

// casino-play.test.ts's seedLocation, duplicated rather than imported: this
// file has no shared beforeAll-booted server to hang a module-level helper
// off, and each `it` here boots and closes its own.
async function seedLocation(): Promise<string> {
  const id = uuidv7();
  await db.insert(locations).values({
    id,
    name: `city-${id.slice(-8)}`,
    travelCost: 0n,
    travelCooldownSeconds: 60,
    bulletStock: 0,
    bulletCost: 1n,
  });
  return id;
}

describe("casino plugin boot", () => {
  it("creates its table and its one-open-session partial index", async () => {
    const { close } = await bootTestServer();
    try {
      const cols = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'p_casino_sessions' ORDER BY column_name`);
      expect(cols.map((r) => r.column_name)).toContain("property_id");

      const idx = await db.execute(sql`
        SELECT indexdef FROM pg_indexes WHERE indexname = 'p_casino_sessions_one_open'`);
      expect(idx).toHaveLength(1);
      expect(String(idx[0]?.indexdef)).toContain("WHERE (status = 'open'");
    } finally {
      await close();
    }
  });

  it("creates p_casino_tables and p_casino_seats with their indexes", async () => {
    const { close } = await bootTestServer();
    try {
      const tables = await conn<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('p_casino_tables', 'p_casino_seats')`;
      expect(tables.map((r) => r.table_name).sort()).toEqual(["p_casino_seats", "p_casino_tables"]);

      const indexes = await conn<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'p_casino_seats'`;
      const names = indexes.map((r) => r.indexname);
      expect(names).toContain("p_casino_seats_table_seat");
      expect(names).toContain("p_casino_seats_one_seat");
    } finally {
      await close();
    }
  });

  it("refuses a seat_no outside 0..4 with the CHECK, not an FK", async () => {
    const { app, redis, close } = await bootTestServer();
    try {
      // Both FK parents must be REAL rows, or the insert dies on 23503 before
      // the CHECK is ever the reason and this test passes with the CHECK
      // deleted. Seed a location, a player and a table row first, then assert
      // the SQLSTATE is check_violation.
      const locationId = await seedLocation();
      const { playerId } = await registerVerifiedPlayer({ app, redis });
      const tableId = uuidv7();
      await conn`INSERT INTO p_casino_tables (id, game_id, location_id, seed)
                 VALUES (${tableId}::uuid, 'blackjack', ${locationId}::uuid, 'x')`;
      const err: unknown = await conn`
        INSERT INTO p_casino_seats (id, table_id, player_id, seat_no)
        VALUES (${uuidv7()}::uuid, ${tableId}::uuid, ${playerId}::uuid, 5)
      `.catch((e: unknown) => e);
      expect((err as { code?: string }).code).toBe("23514");
      // Control: seat_no 4 with the same parents succeeds.
      await conn`
        INSERT INTO p_casino_seats (id, table_id, player_id, seat_no)
        VALUES (${uuidv7()}::uuid, ${tableId}::uuid, ${playerId}::uuid, 4)`;
    } finally {
      await close();
    }
  });
});
