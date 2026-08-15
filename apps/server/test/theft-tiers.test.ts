import theftPlugin from "@gl3/plugin-theft";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, describe, expect, it } from "vitest";
import { runPluginMigrations } from "../src/plugins/migrate.js";
import { testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => {
  await conn.end();
});

describe("theft migrations", () => {
  it("creates all three owned tables and the garage index", async () => {
    await runPluginMigrations(db, [theftPlugin]);

    const tables = await db.execute(sql`
      SELECT tablename FROM pg_tables
      WHERE tablename IN ('p_theft_cars', 'p_theft_tiers', 'p_theft_garage')
      ORDER BY tablename`);
    expect(tables.map((r) => r.tablename)).toEqual(["p_theft_cars", "p_theft_garage", "p_theft_tiers"]);

    const idx = await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE indexname = 'p_theft_garage_player_idx'`);
    expect(idx).toHaveLength(1);
  });
});

describe("GET /api/theft/tiers", () => {
  let app: FastifyInstance;
  let closeServer: () => Promise<void>;

  afterAll(async () => {
    await closeServer?.();
  });

  /** Registers a player and returns their id plus a bearer token. */
  async function register(): Promise<{ id: string; token: string }> {
    const username = `thief_${randomUUID().slice(0, 8)}`;
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { username, password: "correct horse battery staple" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ playerId: string; token: string }>();
    return { id: body.playerId, token: body.token };
  }

  it("lists tiers with their car counts and does not spend the cooldown", async () => {
    ({ app, close: closeServer } = await bootTestServer());

    const cheapId = uuidv7();
    await db.execute(sql`
      INSERT INTO p_theft_cars (id, name, value, theft_weight)
      VALUES (${cheapId}, 'Beater', 1000, 3)`);
    const tierId = uuidv7();
    await db.execute(sql`
      INSERT INTO p_theft_tiers (id, name, success_chance, max_damage, min_car_value, max_car_value)
      VALUES (${tierId}, 'Backstreet', 60, 20, 500, 5000)`);

    const player = await register();

    const first = await app.inject({
      method: "GET",
      url: "/api/theft/tiers",
      headers: { authorization: `Bearer ${player.token}` },
    });
    expect(first.statusCode).toBe(200);
    const row = first.json<{ rows: Array<{ id: string; name: string; cars: string; cooldownRemaining: string }> }>()
      .rows.find((r) => r.id === tierId);
    expect(row).toMatchObject({ name: "Backstreet", cars: "1", cooldownRemaining: "0" });

    // Listing is not an action: a second call still reports no cooldown.
    const second = await app.inject({
      method: "GET",
      url: "/api/theft/tiers",
      headers: { authorization: `Bearer ${player.token}` },
    });
    const row2 = second.json<{ rows: Array<{ id: string; cooldownRemaining: string }> }>()
      .rows.find((r) => r.id === tierId);
    expect(row2?.cooldownRemaining).toBe("0");
  });
});
