import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { crimes } from "../src/db/schema/content.js";
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

  it("creates a crime and lists it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Bank job", description: "Walk in, walk out.",
        cooldownSeconds: 300, minPayout: "1000", maxPayout: "5000",
        minBullets: 0, maxBullets: 10, expReward: "50",
        jailChancePercent: 25, jailSeconds: 600,
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(crimes).where(eq(crimes.id, id));
    expect(row).toMatchObject({
      name: "Bank job", description: "Walk in, walk out.",
      cooldownSeconds: 300, minPayout: 1000n, maxPayout: 5000n,
      minBullets: 0, maxBullets: 10, expReward: 50n,
      jailChancePercent: 25, jailSeconds: 600,
    });

    const list = await app.inject({ method: "GET", url: "/api/admin/crimes/list", headers: auth() });
    expect(list.json().rows.map((r: { id: string }) => r.id)).toContain(id);
  });

  // `sort` is NOT NULL and orders the player-facing crime list, but the admin
  // form does not ask for it — so create has to derive one. Appending after
  // the current max is the only choice that never collides with a seeded row.
  it("appends a created crime after the highest existing sort", async () => {
    await db.insert(crimes).values({
      id: uuidv7(), name: "Pickpocket", description: "Lift a wallet.",
      cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n,
      minBullets: 0, maxBullets: 0, expReward: 5n,
      minRank: 0, sort: 42, jailChancePercent: 0, jailSeconds: 0,
    });
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Bank job", description: "", cooldownSeconds: 300,
        minPayout: "1000", maxPayout: "5000", minBullets: 0, maxBullets: 0,
        expReward: "50", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(crimes).where(eq(crimes.id, res.json().id));
    expect(row?.sort).toBe(43);
  });

  it("400s a create where maxPayout < minPayout", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Backwards", description: "", cooldownSeconds: 30,
        minPayout: "500", maxPayout: "100", minBullets: 0, maxBullets: 0,
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a create where maxBullets < minBullets", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Backwards bullets", description: "", cooldownSeconds: 30,
        minPayout: "50", maxPayout: "100", minBullets: 10, maxBullets: 1,
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403s a non-admin", async () => {
    const p = await registerVerifiedPlayer({ app, redis }, { username: "Pleb" });
    const res = await app.inject({
      method: "GET", url: "/api/admin/crimes/list",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("deletes a crime, cascading its log", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/crimes", headers: auth(),
      payload: {
        name: "Doomed caper", description: "", cooldownSeconds: 30,
        minPayout: "1", maxPayout: "2", minBullets: 0, maxBullets: 0,
        expReward: "1", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    const { id } = create.json();
    const del = await app.inject({ method: "DELETE", url: `/api/admin/crimes/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(crimes).where(eq(crimes.id, id))).toEqual([]);
  });

  it("404s deleting an unknown crime", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/admin/crimes/${uuidv7()}`, headers: auth() });
    expect(del.statusCode).toBe(404);
  });

  it("403s a non-admin creating a crime", async () => {
    const p = await registerVerifiedPlayer({ app, redis }, { username: "Pleb2" });
    const res = await app.inject({
      method: "POST", url: "/api/admin/crimes",
      headers: { authorization: `Bearer ${p.token}` },
      payload: {
        name: "Sneak", description: "", cooldownSeconds: 30,
        minPayout: "1", maxPayout: "2", minBullets: 0, maxBullets: 0,
        expReward: "1", jailChancePercent: 0, jailSeconds: 0,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  // B0 Task 2: the success_formula dialect's authoring-time validation —
  // invalid formulas 400 here, never silently at resolve time (audit §7
  // item 5). crimeExpReward rides the same optional-field pattern.
  describe("success formula + crime exp reward (B0)", () => {
    const base = {
      name: "Formula job", description: "", cooldownSeconds: 30,
      minPayout: "50", maxPayout: "100", minBullets: 0, maxBullets: 0,
      expReward: "5", jailChancePercent: 0, jailSeconds: 0,
    };

    it("400s a create whose formula is outside the dialect", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/crimes", headers: auth(),
        payload: { ...base, successFormula: "rand(1,100)" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_formula");
      expect(String(res.json().message)).toContain("rand");
    });

    it("creates with a valid formula + crime exp reward, defaults absent ones", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/admin/crimes", headers: auth(),
        payload: { ...base, successFormula: "min(95, 10 + CRIMEXP / 100)", crimeExpReward: "7" },
      });
      expect(res.statusCode).toBe(201);
      const [row] = await db.select().from(crimes).where(eq(crimes.id, res.json().id));
      expect(row?.successFormula).toBe("min(95, 10 + CRIMEXP / 100)");
      expect(row?.crimeExpReward).toBe(7n);
    });

    it("update sets and clears the formula; absent fields leave columns alone", async () => {
      const crimeId = uuidv7();
      await db.insert(crimes).values({
        id: crimeId, name: "Pickpocket", description: "", cooldownSeconds: 30,
        minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0,
        expReward: 5n, minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
        crimeExpReward: 9n, successFormula: "min(50, LEVEL * 10)",
      });
      const update = {
        id: crimeId, cooldownSeconds: 30, minPayout: "50", maxPayout: "250",
        expReward: "5", jailChancePercent: 0, jailSeconds: 0,
      };

      // Omitting both fields leaves them untouched.
      const keep = await app.inject({
        method: "POST", url: "/api/admin/crimes/update", headers: auth(), payload: update });
      expect(keep.statusCode).toBe(204);
      let [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
      expect(row?.successFormula).toBe("min(50, LEVEL * 10)");
      expect(row?.crimeExpReward).toBe(9n);

      // Empty string clears the formula back to the skill-chance path.
      const clear = await app.inject({
        method: "POST", url: "/api/admin/crimes/update", headers: auth(),
        payload: { ...update, successFormula: "" } });
      expect(clear.statusCode).toBe(204);
      [row] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
      expect(row?.successFormula).toBeNull();
      expect(row?.crimeExpReward).toBe(9n); // still untouched
    });

    it("400s an update whose formula does not parse", async () => {
      const crimeId = uuidv7();
      await db.insert(crimes).values({
        id: crimeId, name: "Pickpocket", description: "", cooldownSeconds: 30,
        minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0,
        expReward: 5n, minRank: 0, sort: 10, jailChancePercent: 0, jailSeconds: 0,
      });
      const res = await app.inject({
        method: "POST", url: "/api/admin/crimes/update", headers: auth(),
        payload: {
          id: crimeId, cooldownSeconds: 30, minPayout: "50", maxPayout: "250",
          expReward: "5", jailChancePercent: 0, jailSeconds: 0,
          successFormula: "LEVEL ~ 2",
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_formula");
    });
  });
});
