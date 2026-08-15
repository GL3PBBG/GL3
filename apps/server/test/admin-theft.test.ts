import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPage as theftAdminPage } from "@gl3/plugin-theft";
import { theftCars, theftTiers } from "./helpers/plugin-tables.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

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

const ADMIN_ROUTES: { method: "GET" | "POST"; url: string }[] = [
  { method: "GET", url: "/api/admin/theft/cars" },
  { method: "POST", url: "/api/admin/theft/cars" },
  { method: "POST", url: "/api/admin/theft/cars/update" },
  { method: "GET", url: "/api/admin/theft/tiers" },
  { method: "POST", url: "/api/admin/theft/tiers" },
  { method: "POST", url: "/api/admin/theft/tiers/update" },
];

describe("theft admin", () => {
  it("403s a non-admin on every one of the six routes", async () => {
    const pleb = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Pleb", password: "hunter2hunter2" },
    });
    const headers = { authorization: `Bearer ${pleb.json().token}` };
    for (const { method, url } of ADMIN_ROUTES) {
      const res = await app.inject({ method, url, headers, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  describe("cars", () => {
    it("creates a car and lists it as a TableRowsResponse", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/theft/cars", headers: auth(),
        payload: { name: "Beater", value: "500", theftWeight: 3 },
      });
      expect(res.statusCode).toBe(201);
      const { id } = res.json() as { id: string };

      const [row] = await db.select().from(theftCars).where(eq(theftCars.id, id));
      expect(row).toMatchObject({ name: "Beater", value: 500n, theftWeight: 3 });

      const list = await app.inject({ method: "GET", url: "/api/admin/theft/cars", headers: auth() });
      expect(list.statusCode).toBe(200);
      expect(list.json().rows).toContainEqual({ id, name: "Beater", value: "500", theftWeight: "3" });
    });

    it("updates a car with a blank name and keeps the old name", async () => {
      const carId = uuidv7();
      await db.insert(theftCars).values({ id: carId, name: "Beater", value: 500n, theftWeight: 3 });

      const res = await app.inject({
        method: "POST", url: "/api/admin/theft/cars/update", headers: auth(),
        payload: { id: carId, name: "", value: "750", theftWeight: 5 },
      });
      expect(res.statusCode).toBe(204);

      const [row] = await db.select().from(theftCars).where(eq(theftCars.id, carId));
      expect(row).toMatchObject({ name: "Beater", value: 750n, theftWeight: 5 });
    });

    it("404s an update to an unknown car id", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/theft/cars/update", headers: auth(),
        payload: { id: uuidv7(), name: "", value: "1", theftWeight: 1 },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("tiers", () => {
    it("creates a tier and lists it as a TableRowsResponse", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/theft/tiers", headers: auth(),
        payload: {
          name: "Junkers", successChance: 80, maxDamage: 10,
          minCarValue: "0", maxCarValue: "1000",
        },
      });
      expect(res.statusCode).toBe(201);
      const { id } = res.json() as { id: string };

      const [row] = await db.select().from(theftTiers).where(eq(theftTiers.id, id));
      expect(row).toMatchObject({
        name: "Junkers", successChance: 80, maxDamage: 10,
        minCarValue: 0n, maxCarValue: 1000n,
      });

      const list = await app.inject({ method: "GET", url: "/api/admin/theft/tiers", headers: auth() });
      expect(list.statusCode).toBe(200);
      expect(list.json().rows).toContainEqual({
        id, name: "Junkers", successChance: "80", maxDamage: "10",
        minCarValue: "0", maxCarValue: "1000",
      });
    });

    // An inverted bracket silently means "no cars in this tier forever" —
    // the create route rejects it rather than accept a value no car can ever
    // satisfy.
    it("400s a create where minCarValue > maxCarValue", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/theft/tiers", headers: auth(),
        payload: {
          name: "Backwards", successChance: 50, maxDamage: 10,
          minCarValue: "1000", maxCarValue: "500",
        },
      });
      expect(res.statusCode).toBe(400);
      const [row] = await db.select().from(theftTiers);
      expect(row).toBeUndefined();
    });

    it("400s an update where minCarValue > maxCarValue", async () => {
      const tierId = uuidv7();
      await db.insert(theftTiers).values({
        id: tierId, name: "Junkers", successChance: 80, maxDamage: 10,
        minCarValue: 0n, maxCarValue: 1000n,
      });
      const res = await app.inject({
        method: "POST", url: "/api/admin/theft/tiers/update", headers: auth(),
        payload: {
          id: tierId, name: "", successChance: 80, maxDamage: 10,
          minCarValue: "1000", maxCarValue: "500",
        },
      });
      expect(res.statusCode).toBe(400);
      const [row] = await db.select().from(theftTiers).where(eq(theftTiers.id, tierId));
      expect(row?.minCarValue).toBe(0n);
      expect(row?.maxCarValue).toBe(1000n);
    });

    it("updates a tier with a blank name and keeps the old name", async () => {
      const tierId = uuidv7();
      await db.insert(theftTiers).values({
        id: tierId, name: "Junkers", successChance: 80, maxDamage: 10,
        minCarValue: 0n, maxCarValue: 1000n,
      });
      const res = await app.inject({
        method: "POST", url: "/api/admin/theft/tiers/update", headers: auth(),
        payload: {
          id: tierId, name: "", successChance: 60, maxDamage: 20,
          minCarValue: "100", maxCarValue: "2000",
        },
      });
      expect(res.statusCode).toBe(204);
      const [row] = await db.select().from(theftTiers).where(eq(theftTiers.id, tierId));
      expect(row).toMatchObject({
        name: "Junkers", successChance: 60, maxDamage: 20,
        minCarValue: 100n, maxCarValue: 2000n,
      });
    });

    it("404s an update to an unknown tier id", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/theft/tiers/update", headers: auth(),
        payload: {
          id: uuidv7(), name: "", successChance: 50, maxDamage: 10,
          minCarValue: "0", maxCarValue: "100",
        },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // No admin table shows a raw id — every select carries it only as a
  // valueKey. `test/admin-ids-hidden.test.ts` enforces this across every
  // loaded plugin's `adminPages`; re-checked here directly against this
  // plugin's own manifest object rather than by inference.
  it("never renders id as a table column, only as a select's valueKey", () => {
    const idKeys: string[] = [];
    const valueKeys: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const n = node as Record<string, unknown>;
      if (n.kind === "table" && Array.isArray(n.columns)) {
        for (const c of n.columns as { key: string }[]) idKeys.push(c.key);
      }
      if (n.kind === "form" && Array.isArray(n.fields)) {
        for (const f of n.fields as { type: string; valueKey?: string }[]) {
          if (f.type === "select" && f.valueKey !== undefined) valueKeys.push(f.valueKey);
        }
      }
      for (const key of ["children", "items"]) {
        if (Array.isArray(n[key])) for (const child of n[key] as unknown[]) walk(child);
      }
    };
    walk(theftAdminPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
    expect(valueKeys).toContain("id");
  });
});
