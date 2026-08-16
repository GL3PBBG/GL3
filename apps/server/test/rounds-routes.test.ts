import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RoundListResponseSchema, RoundStandingsResponseSchema } from "@gl3/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { playerStats, roundEntries, rounds } from "../src/db/schema/index.js";
import { recordScore } from "../src/game/leaderboard/service.js";
import { withCorePlugins } from "../src/plugins/core-plugins.js";
import { loadPlugins, type LoadedPlugins } from "../src/plugins/loader.js";
import { loadSettings } from "../src/settings/load.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
const redis = createRedis(config.redisUrl);

// Same isolation pattern as leaderboard.test.ts / bootTestServer: leaderboard
// ZSET keys and BullMQ queue names are global by design in production, but
// Redis is one shared instance across every concurrently-running test file.
const PREFIX = `leaderboard-test-${randomUUID()}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let loadedPlugins: LoadedPlugins;

beforeAll(async () => {
  const settings = await loadSettings(db);
  loadedPlugins = await loadPlugins(
    { db, redis, settings, leaderboardPrefix: PREFIX },
    withCorePlugins([]),
    `plugin-rounds-routes-test-${uuidv7()}-`,
  );
  app = await buildApp(config, { db, redis, leaderboardPrefix: PREFIX, plugins: loadedPlugins });
});

afterAll(async () => {
  await app.close();
  for (const w of loadedPlugins.workers) await w.close();
  for (const q of loadedPlugins.queues.values()) await q.close();
  await conn.end();
  redis.disconnect();
});

beforeEach(async () => {
  await resetDb(db);
  await redis.del(`${PREFIX}:cash`, `${PREFIX}:bank`, `${PREFIX}:exp`);
});

async function register(username: string): Promise<{ token: string; playerId: string }> {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "correct horse battery" },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { token: body.token as string, playerId: body.playerId as string };
}

async function seedRound(
  name: string, startsAt: Date | null, endsAt: Date | null,
  stamps?: { snapshottedAt?: Date; finalizedAt?: Date },
): Promise<string> {
  const id = uuidv7();
  await db.insert(rounds).values({
    id, name, startsAt, endsAt,
    snapshottedAt: stamps?.snapshottedAt ?? null,
    finalizedAt: stamps?.finalizedAt ?? null,
  });
  return id;
}

const ago = (ms: number): Date => new Date(Date.now() - ms);
const ahead = (ms: number): Date => new Date(Date.now() + ms);

describe("GET /api/rounds", () => {
  it("401s with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/rounds" });
    expect(res.statusCode).toBe(401);
  });

  it("200s with the active round and the finished rounds ordered ends_at DESC NULLS LAST, id DESC", async () => {
    const { token } = await register(`rounds_a_${Date.now()}`);
    const active = await seedRound("Live One", ago(60_000), ahead(3_600_000));
    // Finalized, dated newest first: descending ends_at puts a smaller "ago"
    // (a more recent end) ahead of a larger one.
    const datedNewer = await seedRound("Dated Newer", ago(200_000), ago(1_000), { finalizedAt: ago(1_000) });
    const datedOlder = await seedRound("Dated Older", ago(300_000), ago(100_000), { finalizedAt: ago(100_000) });
    // NULL ends_at (an open-ended round, exactly what the V2 migrator brings
    // over) must sort LAST under NULLS LAST, not first as bare DESC would.
    const openEnded = await seedRound("Open Ended", ago(400_000), null, { finalizedAt: ago(50_000) });

    const res = await app.inject({ method: "GET", url: "/api/rounds", headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const parsed = RoundListResponseSchema.parse(res.json());

    expect(parsed.active?.id).toBe(active);
    expect(parsed.active?.name).toBe("Live One");
    expect(parsed.active?.secondsRemaining).not.toBeNull();
    expect(parsed.active!.secondsRemaining!).toBeGreaterThan(3590);
    expect(parsed.active!.secondsRemaining!).toBeLessThanOrEqual(3600);

    expect(parsed.finished.map((r) => r.id)).toEqual([datedNewer, datedOlder, openEnded]);
  });
});

describe("GET /api/rounds/:id/standings", () => {
  it("parses for kind=cash/bank/exp and defaults to exp when kind is omitted", async () => {
    const { token, playerId } = await register(`standings_${Date.now()}`);
    const roundId = await seedRound("Standings Round", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });
    await db.insert(roundEntries).values({ roundId, playerId, expAtStart: 0n, cashAtStart: 0n, bankAtStart: 0n });

    for (const kind of ["cash", "bank", "exp"] as const) {
      const res = await app.inject({
        method: "GET", url: `/api/rounds/${roundId}/standings?kind=${kind}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const parsed = RoundStandingsResponseSchema.parse(res.json());
      expect(parsed.kind).toBe(kind);
      expect(parsed.roundId).toBe(roundId);
      expect(parsed.roundName).toBe("Standings Round");
      expect(parsed.finalized).toBe(false);
    }

    const noKind = await app.inject({
      method: "GET", url: `/api/rounds/${roundId}/standings`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(noKind.statusCode).toBe(200);
    expect(RoundStandingsResponseSchema.parse(noKind.json()).kind).toBe("exp");
  });

  it("400s invalid_kind for an unknown kind", async () => {
    const { token } = await register(`badkind_${Date.now()}`);
    const roundId = await seedRound("Bad Kind Round", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });
    const res = await app.inject({
      method: "GET", url: `/api/rounds/${roundId}/standings?kind=nope`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_kind" });
  });

  it("400s invalid_request for a malformed round id — not 500", async () => {
    const { token } = await register(`badid_${Date.now()}`);
    const res = await app.inject({
      method: "GET", url: "/api/rounds/not-a-uuid/standings",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_request" });
  });

  it("404s round_not_found for a well-formed but unknown round id", async () => {
    const { token } = await register(`unknownid_${Date.now()}`);
    const res = await app.inject({
      method: "GET", url: `/api/rounds/${uuidv7()}/standings`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "round_not_found" });
  });
});

describe("GET /api/leaderboard/:kind — scope", () => {
  it("with no query string, behaves exactly as it does today (the ZSET-backed board)", async () => {
    const { token, playerId } = await register(`lb_default_${Date.now()}`);
    await recordScore(redis, "exp", playerId, 42n, PREFIX);

    const res = await app.inject({
      method: "GET", url: "/api/leaderboard/exp",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("exp");
    expect(body.entries.some((e: { playerId: string; score: string }) =>
      e.playerId === playerId && e.score === "42")).toBe(true);
  });

  it("?scope=all is identical to the no-query form", async () => {
    const { token, playerId } = await register(`lb_all_${Date.now()}`);
    await recordScore(redis, "exp", playerId, 77n, PREFIX);

    const noScope = await app.inject({
      method: "GET", url: "/api/leaderboard/exp",
      headers: { authorization: `Bearer ${token}` },
    });
    const allScope = await app.inject({
      method: "GET", url: "/api/leaderboard/exp?scope=all",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(allScope.statusCode).toBe(200);
    expect(allScope.json()).toEqual(noScope.json());
  });

  it("?scope=round returns the active round's standings, not the ZSET board", async () => {
    const { token, playerId } = await register(`lb_round_${Date.now()}`);
    const roundId = await seedRound("Scope Round", ago(60_000), ahead(3_600_000), { snapshottedAt: ago(60_000) });
    await db.insert(roundEntries).values({ roundId, playerId, expAtStart: 0n });
    await db.update(playerStats).set({ exp: 500n }).where(eq(playerStats.playerId, playerId));
    // The ZSET board must NOT reflect this round-only delta, so a regression
    // that fell through to topN instead of roundStandings would fail below.
    await recordScore(redis, "exp", playerId, 1n, PREFIX);

    const res = await app.inject({
      method: "GET", url: "/api/leaderboard/exp?scope=round",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries.some((e: { playerId: string; score: string }) =>
      e.playerId === playerId && e.score === "500")).toBe(true);
  });

  it("?scope=bogus 400s invalid_scope", async () => {
    const { token } = await register(`lb_bogus_${Date.now()}`);
    const res = await app.inject({
      method: "GET", url: "/api/leaderboard/exp?scope=bogus",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_scope" });
  });
});

describe("zero rounds", () => {
  it("answers empty/null rather than 404 or 500 on an install with no rounds at all", async () => {
    const { token } = await register(`zero_rounds_${Date.now()}`);

    const list = await app.inject({ method: "GET", url: "/api/rounds", headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ active: null, finished: [] });

    const scopeRound = await app.inject({
      method: "GET", url: "/api/leaderboard/exp?scope=round",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(scopeRound.statusCode).toBe(200);
    expect(scopeRound.json()).toEqual({ kind: "exp", entries: [] });

    const scopeAll = await app.inject({
      method: "GET", url: "/api/leaderboard/exp?scope=all",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(scopeAll.statusCode).toBe(200);
    expect(scopeAll.json()).toEqual({ kind: "exp", entries: [] });
  });
});
