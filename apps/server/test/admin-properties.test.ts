import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPage as propertiesAdminPage } from "@gl3/plugin-properties";
import { locations as coreLocations } from "../src/db/schema/index.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let adminToken: string;
let locationId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const founder = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Founder", password: "hunter2hunter2" },
  });
  adminToken = founder.json().token;

  // Seed a location — resetDb truncates all tables including locations.
  locationId = uuidv7();
  await db.insert(coreLocations).values({ id: locationId, name: "Testville" });
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

const ADMIN_ROUTES: { method: "GET" | "POST"; url: string }[] = [
  { method: "GET", url: "/api/admin/properties" },
  { method: "GET", url: "/api/admin/properties/locations" },
  { method: "POST", url: "/api/admin/properties" },
  { method: "POST", url: "/api/admin/properties/update" },
];

describe("properties admin", () => {
  it("403s a non-admin on every admin route", async () => {
    // One pleb per route, distinct IP (N2): a shared IP risks a rate-limit
    // 429 instead of the 403 under test.
    for (let i = 0; i < ADMIN_ROUTES.length; i++) {
      const pleb = await app.inject({
        method: "POST", url: "/api/auth/register",
        remoteAddress: `10.99.1.${i + 1}`,
        payload: { username: `Pleb${i}`, password: "hunter2hunter2" },
      });
      const headers = { authorization: `Bearer ${pleb.json().token}` };
      const { method, url } = ADMIN_ROUTES[i];
      const res = await app.inject({ method, url, headers, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("creates a property and lists it as a TableRowsResponse", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "city-bank", cost: "10000", rate: "500" },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.id, id));
    expect(row).toMatchObject({ locationId, pluginId: "city-bank", cost: 10000n, rate: 500n });

    const list = await app.inject({ method: "GET", url: "/api/admin/properties", headers: auth() });
    expect(list.statusCode).toBe(200);
    const match = (list.json().rows as Record<string, string>[]).find((r) => r.id === id);
    expect(match).toBeDefined();
    expect(match!.locationId).toBe(locationId);
    expect(match!.plugin).toBe("city-bank");
    expect(match!.cost).toBe("10000");
    expect(match!.rate).toBe("500");
  });

  it("409s a create for a location that already has a property", async () => {
    await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "first", cost: "1000", rate: "100" },
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "second", cost: "2000", rate: "200" },
    });
    expect(res.statusCode).toBe(409);

    // Only one row for this location.
    const rows = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.locationId, locationId));
    expect(rows).toHaveLength(1);
  });

  it("lists only unclaimed locations in the locations endpoint", async () => {
    // Seed a second location so we can claim one and leave the other.
    const locationId2 = uuidv7();
    await db.insert(coreLocations).values({ id: locationId2, name: "Othertown" });

    // Claim locationId.
    await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bank", cost: "1000", rate: "100" },
    });

    const res = await app.inject({ method: "GET", url: "/api/admin/properties/locations", headers: auth() });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Record<string, string>[];
    const ids = rows.map((r) => r.locationId);
    // locationId is claimed, so only locationId2 should appear.
    expect(ids).not.toContain(locationId);
    expect(ids).toContain(locationId2);
  });

  it("updates a property with a blank pluginId and keeps the old value", async () => {
    const propId = uuidv7();
    await db.insert(propertiesPlugin).values({
      id: propId, locationId, pluginId: "city-bank", cost: 10000n, rate: 500n, profit: 0n,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/properties/update", headers: auth(),
      payload: { id: propId, pluginId: "", cost: "15000", rate: "600" },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.id, propId));
    expect(row).toMatchObject({ pluginId: "city-bank", cost: 15000n, rate: 600n });
  });

  it("404s an update to an unknown id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/properties/update", headers: auth(),
      payload: { id: uuidv7(), pluginId: "", cost: "1", rate: "1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a create with a negative cost and leaves the DB unchanged", async () => {
    const before = await db.select().from(propertiesPlugin);
    const beforeCount = before.length;

    const res = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bad", cost: "-5", rate: "100" },
    });
    expect(res.statusCode).toBe(400);

    const after = await db.select().from(propertiesPlugin);
    expect(after).toHaveLength(beforeCount);
  });

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
    walk(propertiesAdminPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
    expect(valueKeys).toContain("id");
  });
});
