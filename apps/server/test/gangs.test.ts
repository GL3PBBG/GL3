import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangLogs, gangs, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
  const reg = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username: "Vito", password: "hunter2hunter2" },
  });
  ({ token, playerId } = reg.json());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("POST /api/gangs", () => {
  it("creates a gang, makes the creator boss and member, and logs it", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "The Corleones", description: "Family business" },
    });
    expect(res.statusCode).toBe(201);
    const gang = res.json();
    expect(gang.bossPlayerId).toBe(playerId);
    expect(gang.memberCount).toBe(1);

    const [stats] = await db.select({ gangId: playerStats.gangId }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(stats?.gangId).toBe(gang.id);

    const logs = await app.inject({
      method: "GET", url: `/api/gangs/${gang.id}/logs`, headers: { authorization: `Bearer ${token}` },
    });
    expect(logs.json().logs).toHaveLength(1);
  });

  it("409s a duplicate gang name", async () => {
    await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "The Corleones" },
    });
    const other = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Sonny", password: "hunter2hunter2" },
    });
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${other.json().token}` },
      payload: { name: "The Corleones" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("409s a player who is already in a gang", async () => {
    await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "The Corleones" },
    });
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "Second Gang" },
    });
    expect(res.statusCode).toBe(409);
  });

  // Guards the fix for the check-then-act race found in review: an unlocked
  // pre-check SELECT before the transaction let two concurrent creates from
  // the same player both pass before either committed, producing two gangs
  // with one permanently orphaned. See routes.ts's AlreadyInGangError.
  it("under two concurrent creates from the same player, lets exactly one succeed and leaves exactly one gang", async () => {
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
        payload: { name: "The Corleones" },
      }),
      app.inject({
        method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
        payload: { name: "Second Gang" },
      }),
    ]);
    const statusCodes = [a.statusCode, b.statusCode].sort();
    expect(statusCodes).toEqual([201, 409]);

    const rows = await db.select({ id: gangs.id }).from(gangs).where(eq(gangs.bossPlayerId, playerId));
    expect(rows).toHaveLength(1);
  });

  // Postgres `text` columns reject an embedded NUL byte outright (SQLSTATE
  // 22021); z.string() alone doesn't, so an otherwise-legal request 500s
  // instead of a clean 400. See packages/shared/src/primitives.ts#noNulByte.
  it("400s a NUL byte in description instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "The Corleones", description: `Family${String.fromCharCode(0)}business` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a NUL byte in info instead of 500ing", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name: "The Corleones", info: `Some${String.fromCharCode(0)}info` },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/gangs/:gangId", () => {
  it("404s an unknown gang", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/gangs/018f8e2a-0000-7000-8000-0000000000ff",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * This route shipped in M3 with no test of its own on either side of the
 * plugin port — the create-gang case above only asserts that *a* log exists.
 * Its ordering, its cap and its openness to non-members were all
 * unconstrained: dropping the `desc`, dropping the `limit(50)`, or adding a
 * membership gate would each have left the whole suite green.
 *
 * Log rows are inserted directly here rather than driven through the routes
 * that write them. `gang_logs.created_at` defaults to `now()`, which in
 * Postgres is TRANSACTION start time, so every entry appended inside one
 * request shares a timestamp to the microsecond and could not evidence an
 * ordering at all.
 */
describe("GET /api/gangs/:gangId/logs", () => {
  const createGang = async (name = "The Corleones"): Promise<string> => {
    const res = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${token}` },
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  };

  const fetchLogs = async (gangId: string, as = token): ReturnType<typeof app.inject> =>
    app.inject({
      method: "GET", url: `/api/gangs/${gangId}/logs`, headers: { authorization: `Bearer ${as}` },
    });

  it("returns entries newest first, serialising createdAt as an ISO string", async () => {
    const gangId = await createGang();
    const base = Date.now();
    const newerAt = new Date(base + 60_000);
    await db.insert(gangLogs).values([
      { id: uuidv7(), gangId, playerId, message: "older", createdAt: new Date(base - 60_000) },
      { id: uuidv7(), gangId, playerId, message: "newer", createdAt: newerAt },
    ]);

    const res = await fetchLogs(gangId);
    expect(res.statusCode).toBe(200);
    const { logs } = res.json();

    // The founding entry sits between the two planted ones, so this pins the
    // direction rather than merely "some order": a reversed sort inverts it.
    expect(logs.map((l: { message: string }) => l.message))
      .toEqual(["newer", "founded the gang", "older"]);
    expect(logs[0]).toEqual({
      id: expect.any(String), playerId, message: "newer", createdAt: newerAt.toISOString(),
    });
  });

  it("caps the list at 50 and keeps the newest, not the first 50 rows scanned", async () => {
    const gangId = await createGang();
    const base = Date.now();
    await db.insert(gangLogs).values(
      Array.from({ length: 60 }, (_, i) => ({
        id: uuidv7(), gangId, playerId, message: `entry ${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    );

    const { logs } = (await fetchLogs(gangId)).json();
    expect(logs).toHaveLength(50);
    // The length alone would pass on a cap applied before the sort. These two
    // are what make it a test of "the newest 50".
    expect(logs[0].message).toBe("entry 59");
    expect(logs[logs.length - 1].message).toBe("entry 10");
  });

  // Deliberately NOT members-only, unlike GET /api/gangs/:gangId/members —
  // that roster carries each member's permission grants, a map of who can
  // kick and who can empty the bank, where the log is public history. Pinned
  // so that narrowing it later is a decision someone makes on purpose.
  it("is readable by a player who is not in the gang", async () => {
    const gangId = await createGang();
    const outsider = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Sonny", password: "hunter2hunter2" },
    });

    const res = await fetchLogs(gangId, outsider.json().token);
    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toHaveLength(1);
  });

  // Answers 200 with an empty list, where GET /api/gangs/:gangId 404s the
  // same id — the route never reads the `gangs` row.
  it("200s an unknown gang with an empty list", async () => {
    const res = await fetchLogs("018f8e2a-0000-7000-8000-0000000000ff");
    expect(res.statusCode).toBe(200);
    expect(res.json().logs).toEqual([]);
  });
});
