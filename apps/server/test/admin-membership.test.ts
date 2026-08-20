import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPage as membershipAdminPage } from "@gl3/plugin-membership";
import { membershipPackages } from "./helpers/plugin-tables.js";
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

const ADMIN_ROUTES: { method: "GET" | "POST"; url: string }[] = [
  { method: "GET", url: "/api/admin/membership/packages" },
  { method: "POST", url: "/api/admin/membership/packages" },
  { method: "POST", url: "/api/admin/membership/packages/update" },
];

describe("membership admin", () => {
  it("403s a non-admin on every one of the three routes", async () => {
    const pleb = await registerVerifiedPlayer({ app, redis }, { username: "Pleb" });
    const headers = { authorization: `Bearer ${pleb.token}` };
    for (const { method, url } of ADMIN_ROUTES) {
      const res = await app.inject({ method, url, headers, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    const del = await app.inject({
      method: "DELETE", url: `/api/admin/membership/packages/${uuidv7()}`, headers,
    });
    expect(del.statusCode).toBe(403);
  });

  describe("packages", () => {
    it("creates a package and lists it as a TableRowsResponse", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/membership/packages", headers: auth(),
        payload: { name: "Bronze", costPoints: 100, durationSeconds: 86400 },
      });
      expect(res.statusCode).toBe(201);
      const { id } = res.json() as { id: string };

      const [row] = await db.select().from(membershipPackages).where(eq(membershipPackages.id, id));
      expect(row).toMatchObject({ name: "Bronze", costPoints: 100n, durationSeconds: 86400 });

      const list = await app.inject({ method: "GET", url: "/api/admin/membership/packages", headers: auth() });
      expect(list.statusCode).toBe(200);
      expect(list.json().rows).toContainEqual({ id, name: "Bronze", costPoints: "100", durationSeconds: "86400" });
    });

    it("updates a package's name and cost, then deletes it", async () => {
      const packageId = uuidv7();
      await db.insert(membershipPackages).values({
        id: packageId, name: "Bronze", costPoints: 100n, durationSeconds: 86400,
      });

      const update = await app.inject({
        method: "POST", url: "/api/admin/membership/packages/update", headers: auth(),
        payload: { id: packageId, name: "Gold", costPoints: 500, durationSeconds: 604800 },
      });
      expect(update.statusCode).toBe(204);

      const [row] = await db.select().from(membershipPackages).where(eq(membershipPackages.id, packageId));
      expect(row).toMatchObject({ name: "Gold", costPoints: 500n, durationSeconds: 604800 });

      const del = await app.inject({
        method: "DELETE", url: `/api/admin/membership/packages/${packageId}`, headers: auth(),
      });
      expect(del.statusCode).toBe(204);
      expect(await db.select().from(membershipPackages).where(eq(membershipPackages.id, packageId))).toEqual([]);
    });

    it("updates costs and duration without renaming when name is omitted", async () => {
      const packageId = uuidv7();
      await db.insert(membershipPackages).values({
        id: packageId, name: "Bronze", costPoints: 100n, durationSeconds: 86400,
      });

      const res = await app.inject({
        method: "POST", url: "/api/admin/membership/packages/update", headers: auth(),
        payload: { id: packageId, costPoints: 250, durationSeconds: 172800 },
      });
      expect(res.statusCode).toBe(204);

      const [row] = await db.select().from(membershipPackages).where(eq(membershipPackages.id, packageId));
      expect(row).toMatchObject({ name: "Bronze", costPoints: 250n, durationSeconds: 172800 });
    });

    it("404s an update to an unknown package id", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/membership/packages/update", headers: auth(),
        payload: { id: uuidv7(), costPoints: 1, durationSeconds: 60 },
      });
      expect(res.statusCode).toBe(404);
    });

    it("404s deleting an unknown package id", async () => {
      const res = await app.inject({
        method: "DELETE", url: `/api/admin/membership/packages/${uuidv7()}`, headers: auth(),
      });
      expect(res.statusCode).toBe(404);
    });
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
    walk(membershipAdminPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
    expect(valueKeys).toContain("id");
  });
});
