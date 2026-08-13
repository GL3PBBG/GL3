import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { crimes } from "../src/db/schema/content.js";
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

describe("crimes admin", () => {
  it("lists seeded crimes", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/crimes/list", headers: auth() });
    expect(list.statusCode).toBe(200);
    const row = list.json().rows.find((r: { id: string }) => r.id === crimeId);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      id: crimeId, name: "Pickpocket",
      cooldownSeconds: "30", minPayout: "50", maxPayout: "250",
      expReward: "5", jailChancePercent: "0", jailSeconds: "0",
    });
  });

  it("updates a crime and persists the change", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: {
        id: crimeId,
        cooldownSeconds: 60, minPayout: "100", maxPayout: "500",
        expReward: "10", jailChancePercent: 10, jailSeconds: 45,
      },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
    expect(row?.cooldownSeconds).toBe(60);
    expect(row?.minPayout).toBe(100n);
    expect(row?.maxPayout).toBe(500n);
    expect(row?.expReward).toBe(10n);
    expect(row?.jailChancePercent).toBe(10);
    expect(row?.jailSeconds).toBe(45);
  });

  it("404s an update to an unknown id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: {
        id: "00000000-0000-7000-8000-000000000000",
        cooldownSeconds: 30, minPayout: "50", maxPayout: "100",
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when maxPayout < minPayout", async () => {
    const crimeId = uuidv7();
    await db.insert(crimes).values({
      id: crimeId, name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes/update", headers: auth(),
      payload: {
        id: crimeId,
        cooldownSeconds: 30, minPayout: "500", maxPayout: "100",
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
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
      method: "GET", url: "/api/admin/crimes/list",
      headers: { authorization: `Bearer ${p.json().token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
