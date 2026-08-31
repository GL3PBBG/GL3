import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations, playerStats, playerTimers } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";
import { bustSucceeds } from "../src/game/jail/bust.js";
import { breakoutPercent, SUPER_MAX_KEY } from "../src/game/jail/breakout.js";
import { escapeAttempt } from "../src/game/jail/attempts.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let appRedis: import("ioredis").Redis;
let townA: string;

interface Player { token: string; playerId: string; username: string }

async function registerOn(name: string): Promise<Player> {
  return registerVerifiedPlayer({ app, redis: appRedis }, {
    username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}`,
  });
}

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

/** First seed from a fixed enumeration with the wanted outcome — deterministic across runs. */
function seedWhere(percent: number, wanted: boolean): string {
  for (let i = 0; i < 10_000; i++) {
    const s = `jail-parity-seed-${i}`;
    if (bustSucceeds(s, percent) === wanted) return s;
  }
  throw new Error(`no seed found for ${percent}% → ${wanted}`);
}

async function superMaxRow(playerId: string): Promise<Date | null> {
  const [row] = await db.select({ expiresAt: playerTimers.expiresAt }).from(playerTimers)
    .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, SUPER_MAX_KEY)));
  return row?.expiresAt ?? null;
}

const auth = (p: Player) => ({ authorization: `Bearer ${p.token}` });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis: appRedis } = await bootTestServer());
  townA = uuidv7();
  await db.insert(locations).values([{ id: townA, name: `Town A ${townA.slice(0, 8)}` }]);
});
afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("jail escape — super max parity", () => {
  it("sets super max co-expiring with the extended sentence on a failed escape", async () => {
    const p = await registerOn("Failer");
    const jailedUntil = new Date(Date.now() + 600_000);
    await place(p, townA, { jailedUntil, level: 1 });

    const percent = breakoutPercent(1, true, false);
    const result = await escapeAttempt(db, {}, p.playerId, seedWhere(percent, false));

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failed");
    expect(result.until.getTime()).toBe(jailedUntil.getTime() + 90_000);

    const sm = await superMaxRow(p.playerId);
    expect(sm?.getTime()).toBe(result.until.getTime());
  });

  it("blocks the next escape attempt while super max is live", async () => {
    const p = await registerOn("Blocked");
    const jailedUntil = new Date(Date.now() + 600_000);
    await place(p, townA, { jailedUntil, level: 1 });

    const percent = breakoutPercent(1, true, false);
    const first = await escapeAttempt(db, {}, p.playerId, seedWhere(percent, false));
    expect(first.kind).toBe("failed");

    const second = await escapeAttempt(db, {}, p.playerId, "any-seed-at-all");
    expect(second.kind).toBe("super_max");

    const res = await app.inject({ method: "POST", url: "/api/jail/escape", headers: auth(p) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "in_super_max" });
  });

  it("clears the sentence and never writes super max on a successful escape", async () => {
    const p = await registerOn("Escaper");
    const jailedUntil = new Date(Date.now() + 600_000);
    await place(p, townA, { jailedUntil, level: 1 });

    const result = await escapeAttempt(db, {}, p.playerId, seedWhere(45, true));

    expect(result.kind).toBe("escaped");
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, p.playerId));
    expect(row?.jailedUntil).toBeNull();
    expect(await superMaxRow(p.playerId)).toBeNull();
  });

  it("blocks escape on first touch of a migrated/imported future super max row", async () => {
    const p = await registerOn("Imported");
    const jailedUntil = new Date(Date.now() + 600_000);
    await place(p, townA, { jailedUntil, level: 1 });

    // Simulates M4's import: a live super max row that never went through escapeAttempt.
    await db.insert(playerTimers).values({
      playerId: p.playerId, key: SUPER_MAX_KEY, expiresAt: jailedUntil,
    });

    const result = await escapeAttempt(db, {}, p.playerId, "any-seed");
    expect(result.kind).toBe("super_max");
  });

  it("treats an expired or orphaned super max row as inert", async () => {
    const p = await registerOn("Orphaned");
    const jailedUntil = new Date(Date.now() + 600_000);
    await place(p, townA, { jailedUntil, level: 1 });

    await db.insert(playerTimers).values({
      playerId: p.playerId, key: SUPER_MAX_KEY, expiresAt: new Date(Date.now() - 60_000),
    });

    const result = await escapeAttempt(db, {}, p.playerId, "any-seed");
    expect(result.kind === "failed" || result.kind === "escaped").toBe(true);
  });
});
