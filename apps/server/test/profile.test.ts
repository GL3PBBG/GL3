import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats } from "../src/db/schema/index.js";
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
  const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
  ({ token, playerId } = reg.json());
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("GET /api/players/:playerId/profile", () => {
  it("returns a public profile with no auth required", async () => {
    const res = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ playerId, username: "Vito", gangId: null, bio: null });
  });

  it("404s an unknown player", async () => {
    const res = await app.inject({ method: "GET", url: "/api/players/018f8e2a-0000-7000-8000-0000000000ff/profile" });
    expect(res.statusCode).toBe(404);
  });

  it("400s a malformed playerId", async () => {
    const res = await app.inject({ method: "GET", url: "/api/players/not-a-uuid/profile" });
    expect(res.statusCode).toBe(400);
  });

  it("never leaks credential or balance columns", async () => {
    const res = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
    const body = res.json() as Record<string, unknown>;
    for (const forbidden of ["passwordHash", "legacyPasswordSha256", "legacyV2Id", "cash", "bank", "points"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe("PUT /api/profile", () => {
  it("updates the caller's own bio and avatar", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { bio: "Family man.", avatarUrl: "https://example.com/vito.png" },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select({ bio: playerStats.bio, avatarUrl: playerStats.avatarUrl }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.bio).toBe("Family man.");
    expect(row?.avatarUrl).toBe("https://example.com/vito.png");
  });

  it("401s without a token", async () => {
    const res = await app.inject({ method: "PUT", url: "/api/profile", payload: { bio: "x" } });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a javascript: avatarUrl with a clean 400 (stored-XSS guard)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { bio: "x", avatarUrl: "javascript:alert(1)" },
    });
    expect(res.statusCode).toBe(400);

    const [row] = await db.select({ avatarUrl: playerStats.avatarUrl }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.avatarUrl).toBeNull();
  });

  it("rejects a data: avatarUrl with a clean 400", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" },
    });
    expect(res.statusCode).toBe(400);
  });
});
