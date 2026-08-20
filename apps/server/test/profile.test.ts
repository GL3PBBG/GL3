import { ProfileDtoSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Vito" }));
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

  it("returns exactly the ProfileDtoSchema keys and no others (locks out credential/balance columns AND any future unreviewed field)", async () => {
    const res = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
    const body = res.json() as Record<string, unknown>;
    // Parsed through the real, exported `ProfileDtoSchema.strict()` — not a
    // hand-copied literal that can drift out of sync with the schema it's
    // supposed to be checking. `.strict()` fails on any extra key (the
    // credential/balance-column leak this test exists for), and parsing
    // through the schema also checks VALUES, not just keys: `exp` must
    // actually be a MoneySchema-shaped decimal string and `createdAt` a
    // valid TimestampSchema, not merely present.
    expect(() => ProfileDtoSchema.strict().parse(body)).not.toThrow();
    // Kept alongside as an independent oracle: this literal is what fails
    // first, with a readable diff, if a column is ever added without
    // updating ProfileDtoSchema to match.
    expect(Object.keys(body).sort()).toEqual(
      [
        "playerId", "username", "bio", "avatarUrl", "gangId", "gangName", "exp", "rankName",
        "moneyRankLabel", "backfire", "createdAt", "lastSeenAt", "extras",
      ].sort(),
    );
  });

  it("includes the money-rank bracket (null, no ranks seeded) and lifetime backfire count", async () => {
    const res = await app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moneyRankLabel: null, backfire: 0 });
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

  it("400s a schemeless avatarUrl instead of 500ing (URL constructor throws on unparseable input)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: "example.com/pic.png" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s an empty-string avatarUrl instead of 500ing", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a body with no recognized fields instead of 500ing (drizzle .set({}) throws)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // Postgres `text` columns reject an embedded NUL byte outright (SQLSTATE
  // 22021), which `z.string()` alone has no opinion on — a legal,
  // well-formed JSON string carrying "\u0000" passes zod, reaches drizzle,
  // and comes back from Postgres as an uncaught PostgresError: a 500 with
  // the raw DB error in the body, for what should be a clean 400.
  it("400s a NUL byte in bio instead of 500ing (Postgres text rejects it, SQLSTATE 22021)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { bio: `Family${String.fromCharCode(0)}man.` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s a NUL byte in avatarUrl instead of 500ing", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: `https://example.com/${String.fromCharCode(0)}pic.png` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("stores the normalized avatarUrl, not the client's raw string (leading/trailing whitespace stripped)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: " https://example.com/vito.png \n" },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await db.select({ avatarUrl: playerStats.avatarUrl }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.avatarUrl).toBe("https://example.com/vito.png");
  });

  it("rejects a schemeless avatarUrl that a browser would resolve against a scheme (https:evil.com)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: "https:evil.com" },
    });
    // WHATWG URL resolves this to https://evil.com/ — a valid http(s) URL,
    // so this 200s. What matters is that the PERSISTED value is the
    // canonical, re-parseable form, not the ambiguous original string.
    expect(res.statusCode).toBe(200);
    const [row] = await db.select({ avatarUrl: playerStats.avatarUrl }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.avatarUrl).toBe("https://evil.com/");
  });

  it("rejects an avatarUrl with embedded credentials (phishing shape, e.g. https://paypal.com@evil.com/logo.png)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: "https://paypal.com@evil.com/logo.png" },
    });
    expect(res.statusCode).toBe(400);
    const [row] = await db.select({ avatarUrl: playerStats.avatarUrl }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.avatarUrl).toBeNull();
  });

  it("rejects an avatarUrl with a bare embedded password (https://user:pass@evil.com/x.png)", async () => {
    const res = await app.inject({
      method: "PUT", url: "/api/profile", headers: { authorization: `Bearer ${token}` },
      payload: { avatarUrl: "https://user:pass@evil.com/x.png" },
    });
    expect(res.statusCode).toBe(400);
  });
});
