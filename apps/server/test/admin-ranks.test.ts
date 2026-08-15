import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ranks } from "../src/db/schema/identity.js";
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

describe("ranks admin", () => {
  it("lists seeded ranks", async () => {
    const rankId = uuidv7();
    await db.insert(ranks).values({
      id: rankId, name: "Associate",
      expRequired: 0n, cashReward: 0n, bulletReward: 0, maxHealth: 100,
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/ranks/list", headers: auth() });
    expect(list.statusCode).toBe(200);
    const row = list.json().rows.find((r: { id: string }) => r.id === rankId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      id: rankId, name: "Associate",
      expRequired: "0", cashReward: "0",
      bulletReward: "0", maxHealth: "100",
    });
  });

  it("updates a rank and persists the change", async () => {
    const rankId = uuidv7();
    await db.insert(ranks).values({
      id: rankId, name: "Associate",
      expRequired: 0n, cashReward: 0n, bulletReward: 0, maxHealth: 100,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks/update", headers: auth(),
      payload: {
        id: rankId, name: "Associate",
        expRequired: "100", cashReward: "500",
        bulletReward: 5, maxHealth: 110,
      },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(ranks).where(eq(ranks.id, rankId));
    expect(row?.expRequired).toBe(100n);
    expect(row?.cashReward).toBe(500n);
    expect(row?.bulletReward).toBe(5);
    expect(row?.maxHealth).toBe(110);
  });

  it("404s an update to an unknown id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks/update", headers: auth(),
      payload: {
        id: "00000000-0000-7000-8000-000000000000",
        name: "Nobody", expRequired: "0", cashReward: "0",
        bulletReward: 0, maxHealth: 100,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a negative expRequired", async () => {
    const rankId = uuidv7();
    await db.insert(ranks).values({
      id: rankId, name: "Associate",
      expRequired: 0n, cashReward: 0n, bulletReward: 0, maxHealth: 100,
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks/update", headers: auth(),
      payload: {
        id: rankId, name: "Associate",
        expRequired: "-1", cashReward: "0",
        bulletReward: 0, maxHealth: 100,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates a rank and lists it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks", headers: auth(),
      payload: {
        name: "Enforcer", expRequired: "5000", cashReward: "2500",
        bulletReward: 25, maxHealth: 150,
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(ranks).where(eq(ranks.id, id));
    expect(row).toMatchObject({
      name: "Enforcer", expRequired: 5000n, cashReward: 2500n,
      bulletReward: 25, maxHealth: 150,
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/ranks/list", headers: auth() });
    expect(list.json().rows.map((r: { id: string }) => r.id)).toContain(id);
  });

  it("400s a create with a negative expRequired", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks", headers: auth(),
      payload: {
        name: "Broken", expRequired: "-1", cashReward: "0",
        bulletReward: 0, maxHealth: 100,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a create with an empty name", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks", headers: auth(),
      payload: {
        name: "", expRequired: "0", cashReward: "0",
        bulletReward: 0, maxHealth: 100,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403s a non-admin", async () => {
    const p = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Pleb", password: "hunter2hunter2" },
    });
    const res = await app.inject({
      method: "GET", url: "/api/admin/ranks/list",
      headers: { authorization: `Bearer ${p.json().token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("403s a non-admin creating a rank", async () => {
    const p = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Pleb2", password: "hunter2hunter2" },
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks",
      headers: { authorization: `Bearer ${p.json().token}` },
      payload: {
        name: "Sneak", expRequired: "0", cashReward: "0",
        bulletReward: 0, maxHealth: 100,
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("money ranks admin", () => {
  it("creates, lists and updates a money rank", async () => {
    const created = await app.inject({
      method: "POST", url: "/api/admin/ranks/money", headers: auth(),
      payload: { label: "Loaded", threshold: "5000" },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json() as { id: string };

    const list = await app.inject({ method: "GET", url: "/api/admin/ranks/money/list", headers: auth() });
    const rows = list.json().rows as { id: string; label: string; threshold: string }[];
    expect(rows.find((r) => r.id === id)?.threshold).toBe("5000");

    const updated = await app.inject({
      method: "POST", url: "/api/admin/ranks/money/update", headers: auth(),
      payload: { id, label: "Very loaded", threshold: "6000" },
    });
    expect(updated.statusCode).toBe(204);
  });

  it("404s on updating a money rank that does not exist", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks/money/update", headers: auth(),
      payload: { id: uuidv7(), label: "Ghost", threshold: "1" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "money_rank_not_found" });
  });

  it("refuses a non-admin", async () => {
    const p = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Pleb3", password: "hunter2hunter2" },
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/ranks/money",
      headers: { authorization: `Bearer ${p.json().token}` },
      payload: { label: "X", threshold: "1" },
    });
    expect(res.statusCode).toBe(403);
  });
});
