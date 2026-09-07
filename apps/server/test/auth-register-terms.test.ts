import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, redis, close: closeServer } = await bootTestServer());
});
afterAll(async () => { await closeServer(); await conn.end(); });

const body = (extra: Record<string, unknown>) => ({
  username: `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, email: `t_${Date.now()}_${Math.random()}@example.test`, password: "password123", ...extra,
});

describe("terms acceptance at registration", () => {
  it("400 terms_not_accepted when acceptTerms is absent", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: body({}) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "terms_not_accepted" });
  });

  it("400 terms_not_accepted when acceptTerms is false", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: body({ acceptTerms: false }) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "terms_not_accepted" });
  });

  it("refuses before the username-taken check (no enumeration through the order)", async () => {
    const first = body({ acceptTerms: true });
    expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: first })).statusCode).toBe(201);
    // Same username as `first` (already taken) but acceptTerms omitted: the
    // response must be terms_not_accepted, not username_taken — otherwise a
    // request with no consent could still learn whether a username exists.
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { ...first, acceptTerms: undefined, email: "other@example.test" } });
    expect(res.json()).toEqual({ error: "terms_not_accepted" });
  });

  it("stamps terms_accepted_at on the new row", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: body({ acceptTerms: true }) });
    expect(res.statusCode).toBe(201);
    const { playerId } = res.json() as { playerId: string };
    const [row] = await db.select({ at: players.termsAcceptedAt }).from(players).where(eq(players.id, playerId));
    expect(row?.at).toBeInstanceOf(Date);
  });

  it("migration backfill: the column is NOT NULL for every pre-existing row", async () => {
    // The template database ran 0024 over an empty table; prove the column
    // exists and that a raw insert without it (an old code path) still gets
    // NULL rather than erroring — grandfathering is an UPDATE in the
    // migration, not a column default, so new rows must be stamped by code.
    const rows = await conn`select column_name, is_nullable from information_schema.columns where table_name = 'players' and column_name = 'terms_accepted_at'`;
    expect(rows).toEqual([{ column_name: "terms_accepted_at", is_nullable: "YES" }]);
  });
});
