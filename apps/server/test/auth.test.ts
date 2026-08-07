import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { legacyHash } from "../src/auth/password.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});
afterAll(async () => { await closeServer(); await conn.end(); });

describe("POST /api/auth/register", () => {
  it("creates a player with stats and returns a session token", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/register",
      payload: { username: "Vito", password: "hunter2hunter2" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.username).toBe("Vito");
    expect(body.token).toEqual(expect.any(String));

    const stats = await db.select().from(playerStats);
    expect(stats).toHaveLength(1);
    expect(stats[0]?.cash).toBe(0n);
  });

  it("rejects a duplicate username case-insensitively", async () => {
    await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "vito", password: "hunter2hunter2" } });
    expect(res.statusCode).toBe(409);
  });

  it("rejects a short password with 400", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "short" } });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/auth/login — legacy V2 upgrade (SPEC §4.3)", () => {
  const legacyPlayerId = uuidv7();

  beforeEach(async () => {
    await db.insert(players).values({
      id: legacyPlayerId,
      username: "OldTimer",
      passwordHash: null,
      legacyPasswordSha256: legacyHash(42, "oldpassword"),
      legacyV2Id: 42,
    });
    await db.insert(playerStats).values({ playerId: legacyPlayerId });
  });

  it("logs in with the V2 password and upgrades the hash to argon2id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "OldTimer", password: "oldpassword" },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select().from(players).where(sql`${players.id} = ${legacyPlayerId}`);
    expect(row?.passwordHash?.startsWith("$argon2id$")).toBe(true);
    expect(row?.legacyPasswordSha256).toBeNull();
  });

  it("accepts the same password on the second login, now via argon2id", async () => {
    await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "OldTimer", password: "oldpassword" } });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "OldTimer", password: "oldpassword" } });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong legacy password without clearing the legacy column", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "OldTimer", password: "nope" } });
    expect(res.statusCode).toBe(401);
    const [row] = await db.select().from(players).where(sql`${players.id} = ${legacyPlayerId}`);
    expect(row?.legacyPasswordSha256).not.toBeNull();
  });
});

describe("GET /api/auth/me", () => {
  it("returns the player behind a bearer token and 401 without one", async () => {
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
    const { token } = reg.json();

    const ok = await app.inject({ method: "GET", url: "/api/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().cash).toBe("0");

    const anon = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(anon.statusCode).toBe(401);
  });
});
