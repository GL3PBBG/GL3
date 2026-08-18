import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations } from "../src/db/schema/content.js";
import { settings } from "../src/db/schema/identity.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { uuidv7 } from "uuidv7";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let adminToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  adminToken = (await registerVerifiedPlayer({ app, redis }, { username: "Founder" })).token;
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

  it("refuses a stock above the max_stock ceiling", async () => {
    // No settings row here, so this is the V2 default (40000) doing the work.
    const locationId = uuidv7();
    await db.insert(locations).values({
      id: locationId, name: "Palermo",
      travelCost: 0n, travelCooldownSeconds: 0,
      bulletStock: 0, bulletCost: 0n,
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/bullets/stock", headers: auth(),
      payload: { locationId, bulletStock: 40001, bulletCost: "1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("stock_above_max");
  });

  it("403s a non-admin", async () => {
    const p = await registerVerifiedPlayer({ app, redis }, { username: "Pleb" });
    const res = await app.inject({
      method: "GET", url: "/api/admin/bullets/stock",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * V2's `adminModule::method_options`. These write the `settings` table, which
 * is a boot-time snapshot everywhere else in the game — so a POST here changes
 * what the NEXT boot reads, not what this running server does. The read-back
 * proves the row was written; it deliberately does not prove the live server
 * changed behaviour, because it must not.
 */
describe("bullets admin options", () => {
  it("reports V2's defaults when nothing has been configured", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/bullets/options", headers: auth() });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ rows: { key: string; value: string }[] }>().rows).toEqual([
      { key: "stock_min_per_hour", label: "Stock min per hour", value: "2250" },
      { key: "stock_max_per_hour", label: "Stock max per hour", value: "2750" },
      { key: "max_stock", label: "Max stock", value: "40000" },
      { key: "max_cost", label: "Max bullet cost", value: "unlimited" },
      { key: "max_buy", label: "Max bullets per purchase", value: "unlimited" },
    ]);
  });

  it("writes all five settings rows and reads them back", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/bullets/options", headers: auth(),
      payload: {
        stockMinPerHour: 10, stockMaxPerHour: 20, maxStock: 999,
        maxCost: "75", maxBuy: "500",
      },
    });
    expect(res.statusCode).toBe(204);

    const rows = await db.select().from(settings);
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toMatchObject({
      "bullets.stock_min_per_hour": "10",
      "bullets.stock_max_per_hour": "20",
      "bullets.max_stock": "999",
      "bullets.max_cost": "75",
      "bullets.max_buy": "500",
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/bullets/options", headers: auth() });
    expect(list.json<{ rows: { key: string; value: string }[] }>().rows).toContainEqual(
      { key: "max_buy", label: "Max bullets per purchase", value: "500" },
    );
  });

  it("stores a blank max_cost and max_buy as unlimited rather than as zero", async () => {
    await app.inject({
      method: "POST", url: "/api/admin/bullets/options", headers: auth(),
      payload: { stockMinPerHour: 1, stockMaxPerHour: 2, maxStock: 3, maxCost: "", maxBuy: "" },
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/bullets/options", headers: auth() });
    const rows = list.json<{ rows: { key: string; value: string }[] }>().rows;
    expect(rows.find((r) => r.key === "max_cost")?.value).toBe("unlimited");
    expect(rows.find((r) => r.key === "max_buy")?.value).toBe("unlimited");
  });

  it("400s an hourly minimum above the maximum", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/bullets/options", headers: auth(),
      payload: { stockMinPerHour: 900, stockMaxPerHour: 100, maxStock: 1000, maxCost: "", maxBuy: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe("min_above_max");
  });

  it("403s a non-admin", async () => {
    const p = await registerVerifiedPlayer({ app, redis }, { username: "Pleb2" });
    const res = await app.inject({
      method: "GET", url: "/api/admin/bullets/options",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
