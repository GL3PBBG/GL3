import { InventoryResponseSchema } from "@gl3/shared";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { items, playerItems } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

async function seedItem(itemType: string, effects: Record<string, unknown>): Promise<string> {
  const id = uuidv7();
  await db.insert(items).values({ id, name: `${itemType}-${id.slice(-8)}`, itemType, effects });
  return id;
}

async function grant(playerId: string, itemId: string, qty: number): Promise<void> {
  await db.insert(playerItems).values({ playerId, itemId, qty });
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Gunny" }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("GET /api/inventory — inventory.itemActions", () => {
  it("carries combat's gunsmith repair action on a weapon row and none on a consumable", async () => {
    const pistol = await seedItem("weapon", { accuracy: 60, damageMin: 5, damageMax: 15 });
    const medkit = await seedItem("consumable", { heal: 20 });
    await grant(playerId, pistol, 1);
    await grant(playerId, medkit, 1);

    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = InventoryResponseSchema.parse(res.json());

    const weaponRow = body.items.find((i) => i.itemId === pistol);
    const consumableRow = body.items.find((i) => i.itemId === medkit);

    expect(weaponRow?.actions).toEqual([
      { pluginId: "combat", label: "Repair at gunsmith", to: "/combat" },
    ]);
    expect(consumableRow?.actions ?? []).toEqual([]);
  });
});
