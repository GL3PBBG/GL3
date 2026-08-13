import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations } from "../src/db/schema/content.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";
import { uuidv7 } from "uuidv7";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let adminToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const founder = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Founder", password: "hunter2hunter2" },
  });
  adminToken = founder.json().token;
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe("bullets admin", () => {
  it("sets stock and price for a location and lists it", async () => {
    const locationId = uuidv7();
    await db.insert(locations).values({
      id: locationId, name: "Palermo",
      travelCost: 0n, travelCooldownSeconds: 0,
      bulletStock: 0, bulletCost: 0n,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/bullets/stock", headers: auth(),
      payload: { locationId, bulletStock: 500, bulletCost: "25" },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(locations).where(eq(locations.id, locationId));
    expect(row?.bulletStock).toBe(500);
    expect(row?.bulletCost).toBe(25n);

    const list = await app.inject({ method: "GET", url: "/api/admin/bullets/stock", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows).toEqual([
      { id: locationId, name: "Palermo", bulletStock: "500", bulletCost: "25" },
    ]);
  });

  it("404s an unknown location", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/bullets/stock", headers: auth(),
      payload: { locationId: "00000000-0000-7000-8000-000000000000", bulletStock: 1, bulletCost: "1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a negative bullet stock", async () => {
    const locationId = uuidv7();
    await db.insert(locations).values({
      id: locationId, name: "Palermo",
      travelCost: 0n, travelCooldownSeconds: 0,
      bulletStock: 0, bulletCost: 0n,
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/bullets/stock", headers: auth(),
      payload: { locationId, bulletStock: -5, bulletCost: "1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403s a non-admin", async () => {
    const p = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Pleb", password: "hunter2hunter2" },
    });
    const res = await app.inject({
      method: "GET", url: "/api/admin/bullets/stock",
      headers: { authorization: `Bearer ${p.json().token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
