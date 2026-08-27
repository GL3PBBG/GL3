import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPage as housesAdminPage } from "@gl3/plugin-houses";
import { houses } from "./helpers/plugin-tables.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

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

describe("houses board route", () => {
  it("serves rows + values, and gains houseName/houseWill only once the player owns an upgrade", async () => {
    const before = await app.inject({
      method: "GET", url: "/api/houses/board", headers: auth(),
    });
    expect(before.statusCode).toBe(200);
    const beforeBody = before.json() as { rows: { id: string; name: string; price: string; will: string }[]; values: Record<string, string> };
    expect(beforeBody.rows.some((r) => r.name === "Default House")).toBe(true);
    expect(beforeBody.values.houseName).toBeUndefined();
    expect(beforeBody.values.houseWill).toBeUndefined();
    expect(beforeBody.values.willMax).toBe("100");

    const upgradeId = uuidv7();
    await db.insert(houses).values({ id: upgradeId, name: "Shack", price: 0n, will: 150 });
    const buy = await app.inject({
      method: "POST", url: "/api/houses/buy", headers: auth(), payload: { houseId: upgradeId },
    });
    expect(buy.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: "/api/houses/board", headers: auth() });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json() as { values: Record<string, string> };
    expect(afterBody.values.houseName).toBe("Shack");
    expect(afterBody.values.houseWill).toBe("150");
  });

  it("declares its page in /api/plugins", async () => {
    const res = await app.inject({ method: "GET", url: "/api/plugins", headers: auth() });
    const pages = (res.json() as { pages: { pluginId: string; id: string }[] }).pages;
    expect(pages.some((p) => p.pluginId === "houses" && p.id === "houses.index")).toBe(true);
  });
});

describe("houses admin", () => {
  it("403s a non-admin on every one of the four routes", async () => {
    const pleb = await registerVerifiedPlayer({ app, redis }, { username: "Pleb" });
    const headers = { authorization: `Bearer ${pleb.token}` };
    const routes: { method: "GET" | "POST" | "DELETE"; url: string }[] = [
      { method: "GET", url: "/api/admin/houses/list" },
      { method: "POST", url: "/api/admin/houses" },
      { method: "POST", url: "/api/admin/houses/update" },
      { method: "DELETE", url: `/api/admin/houses/${uuidv7()}` },
    ];
    for (const { method, url } of routes) {
      const res = await app.inject({ method, url, headers, payload: method === "GET" || method === "DELETE" ? undefined : {} });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("creates a house and lists it as a TableRowsResponse", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/houses", headers: auth(),
      payload: { name: "Cottage", price: "1000", will: 200 },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(houses).where(eq(houses.id, id));
    expect(row).toMatchObject({ name: "Cottage", price: 1000n, will: 200 });

    const list = await app.inject({ method: "GET", url: "/api/admin/houses/list", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows).toContainEqual({ id, name: "Cottage", price: "1000", will: "200" });
  });

  it("updates a house with a blank name and keeps the old name", async () => {
    const id = uuidv7();
    await db.insert(houses).values({ id, name: "Cottage", price: 1000n, will: 200 });

    const res = await app.inject({
      method: "POST", url: "/api/admin/houses/update", headers: auth(),
      payload: { id, name: "", price: "1500", will: 220 },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(houses).where(eq(houses.id, id));
    expect(row).toMatchObject({ name: "Cottage", price: 1500n, will: 220 });
  });

  it("404s an update to an unknown house id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/houses/update", headers: auth(),
      payload: { id: uuidv7(), name: "", price: "1", will: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a house", async () => {
    const id = uuidv7();
    await db.insert(houses).values({ id, name: "Doomed", price: 1n, will: 999 });
    const del = await app.inject({ method: "DELETE", url: `/api/admin/houses/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(houses).where(eq(houses.id, id))).toEqual([]);
  });

  it("404s deleting an unknown house id", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/admin/houses/${uuidv7()}`, headers: auth() });
    expect(res.statusCode).toBe(404);
  });

  it("declares its section in /api/admin/plugins", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/plugins", headers: auth() });
    const sections = (res.json() as { sections: { pluginId: string; pages: { id: string }[] }[] }).sections;
    const houseSection = sections.find((s) => s.pluginId === "houses");
    expect(houseSection?.pages.some((p) => p.id === "houses-admin")).toBe(true);
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
    walk(housesAdminPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
    expect(valueKeys).toContain("id");
  });
});
