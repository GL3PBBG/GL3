import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

interface Player { token: string; playerId: string }

async function register(name: string): Promise<Player> {
  return registerVerifiedPlayer({ app, redis }, { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}` });
}

let townA: string;
let townB: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  townA = uuidv7();
  townB = uuidv7();
  await db.insert(locations).values([
    { id: townA, name: `Town A ${townA.slice(0, 8)}` },
    { id: townB, name: `Town B ${townB.slice(0, 8)}` },
  ]);
});
afterAll(async () => { await closeServer(); await conn.end(); });

const auth = (p: Player) => ({ authorization: `Bearer ${p.token}` });

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

describe("GET /api/hospital/local", () => {
  it("lists a patient in the same town, and never the caller", async () => {
    const viewer = await register("Viewer");
    const patient = await register("Patient");
    await place(viewer, townA);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 120_000) });
    // The caller is hospitalised too — they must still not appear in their own list.
    await place(viewer, townA, { health: 0, hospitalUntil: new Date(Date.now() + 120_000) });

    const res = await app.inject({ method: "GET", url: "/api/hospital/local", headers: auth(viewer) });

    expect(res.statusCode).toBe(200);
    const { patients } = res.json();
    expect(patients).toHaveLength(1);
    expect(patients[0].playerId).toBe(patient.playerId);
    expect(patients[0].remainingSeconds).toBeGreaterThan(110);
    // 120s × the 1000/second default.
    expect(BigInt(patients[0].dischargeCost)).toBeGreaterThan(110_000n);
  });

  it("does not list a patient in another town", async () => {
    const viewer = await register("Viewer");
    const patient = await register("Patient");
    await place(viewer, townA);
    await place(patient, townB, { health: 0, hospitalUntil: new Date(Date.now() + 120_000) });

    const res = await app.inject({ method: "GET", url: "/api/hospital/local", headers: auth(viewer) });
    expect(res.json().patients).toHaveLength(0);
  });

  it("filters out an elapsed stay without settling it", async () => {
    const viewer = await register("Viewer");
    const patient = await register("Patient");
    await place(viewer, townA);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() - 1000) });

    const res = await app.inject({ method: "GET", url: "/api/hospital/local", headers: auth(viewer) });
    expect(res.json().patients).toHaveLength(0);

    // A roster read must not take write locks on strangers: the row is still
    // dirty, and the sweeper or the patient's own next request clears it.
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, patient.playerId));
    expect(row?.hospitalUntil).not.toBeNull();
  });

  it("answers an empty list for a caller with no location", async () => {
    const viewer = await register("Viewer");
    const patient = await register("Patient");
    await place(viewer, null);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 120_000) });

    const res = await app.inject({ method: "GET", url: "/api/hospital/local", headers: auth(viewer) });
    expect(res.statusCode).toBe(200);
    expect(res.json().patients).toHaveLength(0);
  });
});

describe("GET /api/jail/local", () => {
  it("lists a local inmate with a bail price and excludes other towns", async () => {
    const viewer = await register("Viewer");
    const inmate = await register("Inmate");
    const elsewhere = await register("Elsewhere");
    await place(viewer, townA);
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 300_000) });
    await place(elsewhere, townB, { jailedUntil: new Date(Date.now() + 300_000) });

    const res = await app.inject({ method: "GET", url: "/api/jail/local", headers: auth(viewer) });

    expect(res.statusCode).toBe(200);
    const { inmates } = res.json();
    expect(inmates).toHaveLength(1);
    expect(inmates[0].playerId).toBe(inmate.playerId);
    expect(BigInt(inmates[0].bailCost)).toBeGreaterThan(290_000n);
    expect(inmates[0].rankName).toEqual(expect.any(String));
  });
});
