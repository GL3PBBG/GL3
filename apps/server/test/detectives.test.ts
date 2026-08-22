import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { activeReportTargetIds } from "@gl3/plugin-detectives";
import type { PluginTx } from "@gl3/plugin-sdk";
import { loadConfig } from "../src/config.js";
import {
  locations, playerStats, players, settings, transactions,
} from "../src/db/schema/index.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { detectiveSearches } from "./helpers/plugin-tables.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let hirerToken: string;
let hirerId: string;
let targetId: string;
let chicagoId: string;
let miamiId: string;

const hire = (token: string, body: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/detectives",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });

const list = (token: string) =>
  app.inject({
    method: "GET",
    url: "/api/detectives",
    headers: { authorization: `Bearer ${token}` },
  });

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());

  ({ token: hirerToken, playerId: hirerId } = await registerVerifiedPlayer({ app, redis }, { username: "Gumshoe" }));

  // Never authenticates as the target below, just needs a real player row.
  const target = await app.inject({
    method: "POST",
    url: "/api/auth/register",
    payload: { username: "Fugitive", email: "fugitive@example.test", password: "hunter2hunter2" },
  });
  ({ playerId: targetId } = target.json());

  chicagoId = uuidv7();
  miamiId = uuidv7();
  await db.insert(locations).values([
    { id: chicagoId, name: "Chicago", travelCost: 100n, travelCooldownSeconds: 60, bulletStock: 500, bulletCost: 5n },
    { id: miamiId, name: "Miami", travelCost: 250n, travelCooldownSeconds: 120, bulletStock: 300, bulletCost: 8n },
  ]);
});

afterAll(async () => {
  await closeServer();
  await conn.end();
  redis.disconnect();
});

describe("POST /api/detectives — hire", () => {
  it("debits cost x detectives x hours, inserts the search row, ledgers detectives.hire", async () => {
    await db.update(playerStats).set({ cash: 10_000_000n })
      .where(eq(playerStats.playerId, hirerId));

    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 2, hours: 3 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // 125000 (default cost) x 2 x 3 = 750000
    expect(body.cash).toBe("9250000");

    const [row] = await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, body.searchId));
    expect(row).toMatchObject({ playerId: hirerId, targetPlayerId: targetId, detectives: 2 });
    // ends_at = started_at + duration(3600s) x hours(3). started_at is the DB
    // clock, ends_at the app clock — allow 5s of skew, not equality.
    // `succeeded` is NOT asserted: bootTestServer runs real workers and the
    // resolve job may have already landed.
    const spanMs = row!.endsAt.getTime() - row!.startedAt.getTime();
    expect(Math.abs(spanMs - 3 * 3600 * 1000)).toBeLessThan(5_000);

    const [ledgerRow] = await db.select().from(transactions)
      .where(eq(transactions.reason, "detectives.hire"));
    expect(ledgerRow!.amount).toBe(-750_000n);
    expect(ledgerRow!.playerId).toBe(hirerId);
  });

  it("honours a detectives.cost settings override", async () => {
    // Settings are snapshotted at boot — insert before starting a fresh server.
    await db.insert(settings).values({ key: "detectives.cost", value: "10" });
    const { app: freshApp, close } = await bootTestServer();
    try {
      await db.update(playerStats).set({ cash: 1_000n })
        .where(eq(playerStats.playerId, hirerId));
      const res = await freshApp.inject({
        method: "POST", url: "/api/detectives",
        headers: { authorization: `Bearer ${hirerToken}` },
        payload: { targetUsername: "Fugitive", detectives: 1, hours: 1 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().cash).toBe("990");
    } finally {
      await close();
    }
  });

  it("rejects a self-search with 400 cannot_search_self", async () => {
    const res = await hire(hirerToken, { targetUsername: "Gumshoe", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_search_self");
  });

  it("rejects an unknown username with 400 target_not_found", async () => {
    const res = await hire(hirerToken, { targetUsername: "Nobody", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("target_not_found");
  });

  it("rejects detectives/hours outside 1-5 at the zod boundary", async () => {
    for (const payload of [
      { targetUsername: "Fugitive", detectives: 0, hours: 1 },
      { targetUsername: "Fugitive", detectives: 6, hours: 1 },
      { targetUsername: "Fugitive", detectives: 1, hours: 0 },
      { targetUsername: "Fugitive", detectives: 1, hours: 6 },
      { targetUsername: "Fugitive", detectives: 1.5, hours: 1 },
    ]) {
      expect((await hire(hirerToken, payload)).statusCode).toBe(400);
    }
  });

  it("409s insufficient_funds leaving no row", async () => {
    await db.update(playerStats).set({ cash: 100n })
      .where(eq(playerStats.playerId, hirerId));
    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("insufficient_funds");
    expect(await db.select().from(detectiveSearches)).toHaveLength(0);
    expect(await db.select().from(transactions)
      .where(eq(transactions.reason, "detectives.hire"))).toHaveLength(0);
  });

  it("is allowed from jail (V2 gated only on login)", async () => {
    await db.update(playerStats)
      .set({ cash: 10_000_000n, jailedUntil: new Date(Date.now() + 60_000) })
      .where(eq(playerStats.playerId, hirerId));
    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(201);
  });

  it("401s without auth", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/detectives",
      payload: { targetUsername: "Fugitive", detectives: 1, hours: 1 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("stamps expires_at at hire and the tracker reports the same instant", async () => {
    await db.update(playerStats).set({ cash: 10_000_000n })
      .where(eq(playerStats.playerId, hirerId));
    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    expect(res.statusCode).toBe(201);
    const { searchId } = res.json<{ searchId: string }>();

    const [row] = await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, searchId));
    expect(row?.expiresAt).not.toBeNull();
    expect(row?.expiresAt?.getTime()).toBeGreaterThan(row!.endsAt.getTime());

    // Two read paths cannot diverge: the tracker's expiresAt IS the column.
    const listRes = await list(hirerToken);
    const mine = listRes.json<{ searches: { id: string; expiresAt: string }[] }>()
      .searches.find((s) => s.id === searchId);
    expect(mine?.expiresAt).toBe(row?.expiresAt?.toISOString());
  });

  it("computes a legacy NULL expires_at row's deadline from the expire setting", async () => {
    await db.update(playerStats).set({ cash: 10_000_000n })
      .where(eq(playerStats.playerId, hirerId));
    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    const { searchId } = res.json<{ searchId: string }>();
    await db.update(detectiveSearches).set({ expiresAt: null })
      .where(eq(detectiveSearches.id, searchId));

    const listRes = await list(hirerToken);
    const mine = listRes.json<{ searches: { id: string; endsAt: string; expiresAt: string }[] }>()
      .searches.find((s) => s.id === searchId);
    // Old behaviour preserved: ends_at + expire, not epoch/absent.
    expect(new Date(mine!.expiresAt).getTime()).toBeGreaterThan(new Date(mine!.endsAt).getTime());
  });
});

describe("GET /api/detectives — reveal gating and live tracking", () => {
  /** Insert a search row directly so no resolve job races the assertions. */
  const insertSearch = async (over: {
    endsAt: Date; succeeded?: boolean | null; playerId?: string;
  }): Promise<string> => {
    const id = uuidv7();
    await db.insert(detectiveSearches).values({
      id,
      playerId: over.playerId ?? hirerId,
      targetPlayerId: targetId,
      detectives: 3,
      endsAt: over.endsAt,
      succeeded: over.succeeded ?? null,
    });
    return id;
  };

  it("hides `succeeded` while pending, even when the roll is already recorded", async () => {
    // The worker resolves minutes early by design (time-gated reveal, spec
    // §2): the row knows, the API must not say.
    await insertSearch({ endsAt: new Date(Date.now() + 60_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));

    const res = await list(hirerToken);
    expect(res.statusCode).toBe(200);
    const { searches } = res.json();
    expect(searches).toHaveLength(1);
    expect(searches[0].succeeded).toBeNull();
    expect(searches[0].targetLocationId).toBeNull();
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("reveals success and the target's CURRENT location after ends_at", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));

    const first = list(hirerToken);
    expect((await first).json().searches[0]).toMatchObject({
      succeeded: true, targetLocationId: chicagoId, targetLocationName: "Chicago",
    });

    // Live tracking: the target travels; the next read shows the new place.
    await db.update(playerStats).set({ locationId: miamiId })
      .where(eq(playerStats.playerId, targetId));
    const second = await list(hirerToken);
    expect(second.json().searches[0]).toMatchObject({
      targetLocationId: miamiId, targetLocationName: "Miami",
    });
  });

  it("reveals a failure after ends_at, with no location", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: false });
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(false);
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("reads a lost resolve (NULL past ends_at) as failed, never pending forever", async () => {
    await insertSearch({ endsAt: new Date(Date.now() - 10_000), succeeded: null });
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(false);
  });

  it("hides the location once the report expires (ends_at + expire)", async () => {
    // Default expire is 600s; 700s past ends_at is expired.
    await insertSearch({ endsAt: new Date(Date.now() - 700_000), succeeded: true });
    await db.update(playerStats).set({ locationId: chicagoId })
      .where(eq(playerStats.playerId, targetId));
    const { searches } = (await list(hirerToken)).json();
    expect(searches[0].succeeded).toBe(true);
    expect(searches[0].targetLocationId).toBeNull();
    expect(searches[0].targetLocationName).toBeNull();
  });

  it("lists only the caller's own searches, newest first, with cost", async () => {
    const older = await insertSearch({ endsAt: new Date(Date.now() + 30_000) });
    const newer = await insertSearch({ endsAt: new Date(Date.now() + 60_000) });
    // A foreign row must not appear — silent to everyone but the hirer.
    await insertSearch({ endsAt: new Date(Date.now() + 60_000), playerId: targetId });

    const body = (await list(hirerToken)).json();
    expect(body.cost).toBe("125000");
    // Seconds per duration unit, so the client can label the 1–5 dropdown
    // ("1 hour" at 3600, "1 second" at V2's shipped default of 1).
    expect(body.durationSeconds).toBe(3600);
    expect(body.searches).toHaveLength(2);
    expect(body.searches.map((s: { id: string }) => s.id)).toEqual([newer, older]);
    expect(body.searches[0].targetUsername).toBe("Fugitive");
    expect(typeof body.searches[0].startedAt).toBe("string");
    expect(typeof body.searches[0].endsAt).toBe("string");
    expect(typeof body.searches[0].expiresAt).toBe("string");
  });

  it("401s without auth", async () => {
    expect((await app.inject({ method: "GET", url: "/api/detectives" })).statusCode).toBe(401);
  });
});

describe("DELETE /api/detectives/:searchId — remove", () => {
  const remove = (token: string, id: string) =>
    app.inject({
      method: "DELETE",
      url: `/api/detectives/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

  const insertOwn = async (playerId: string): Promise<string> => {
    const id = uuidv7();
    await db.insert(detectiveSearches).values({
      id, playerId, targetPlayerId: playerId === hirerId ? targetId : hirerId,
      detectives: 1, endsAt: new Date(Date.now() - 1_000), succeeded: false,
    });
    return id;
  };

  it("removes the caller's own row", async () => {
    const id = await insertOwn(hirerId);
    const res = await remove(hirerToken, id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
    expect(await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, id))).toHaveLength(0);
  });

  it("404s a foreign row identically to a nonexistent one — no existence leak", async () => {
    const foreign = await insertOwn(targetId);
    const onForeign = await remove(hirerToken, foreign);
    const onMissing = await remove(hirerToken, uuidv7());
    expect(onForeign.statusCode).toBe(404);
    expect(onMissing.statusCode).toBe(404);
    expect(onForeign.json().error).toBe("not_found");
    expect(onForeign.json().error).toBe(onMissing.json().error);
    // The foreign row survives.
    expect(await db.select().from(detectiveSearches)
      .where(eq(detectiveSearches.id, foreign))).toHaveLength(1);
  });

  it("400s a non-UUID param at the zod boundary", async () => {
    expect((await remove(hirerToken, "not-a-uuid")).statusCode).toBe(400);
  });

  it("401s without auth", async () => {
    const res = await app.inject({ method: "DELETE", url: `/api/detectives/${uuidv7()}` });
    expect(res.statusCode).toBe(401);
  });
});

describe("activeReportTargetIds", () => {
  it("returns exactly the live successful reports", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 3_600_000);
    const future = new Date(now.getTime() + 3_600_000);
    const mk = (target: string, over: Partial<typeof detectiveSearches.$inferInsert> = {}) =>
      db.insert(detectiveSearches).values({
        id: uuidv7(), playerId: hirerId, targetPlayerId: target,
        detectives: 1, endsAt: past, succeeded: true, expiresAt: future, ...over,
      });

    // `p_detectives_searches` FKs both player_id and target_player_id to
    // `players` (migrations.ts), so these need real rows — inserted directly
    // rather than through the rate-limited `/api/auth/register` route, which
    // beforeEach's own two registrations have already spent part of the quota on.
    const [active, pending, failed, expired, legacy, foreign] =
      [uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7(), uuidv7()];
    await db.insert(players).values(
      [active, pending, failed, expired, legacy, foreign].map((id, i) => ({
        id, username: `ReportSubject${i}`,
      })),
    );

    await mk(active);
    await mk(pending, { endsAt: future, succeeded: null });      // still running
    await mk(failed, { succeeded: false });                      // roll lost
    await mk(expired, { expiresAt: past });                      // window over
    await mk(legacy, { expiresAt: null });                       // pre-upgrade row: counts as expired
    await db.insert(detectiveSearches).values({                  // someone ELSE's report
      id: uuidv7(), playerId: foreign, targetPlayerId: active,
      detectives: 1, endsAt: past, succeeded: true, expiresAt: future,
    });

    const set = await db.transaction(async (txDb) =>
      // Targeted cast: activeReportTargetIds only reads tx.db, and PluginTx's
      // other members (economy, jail, ...) are irrelevant to a read-only helper.
      activeReportTargetIds({ db: txDb } as PluginTx, hirerId, new Date()));
    expect(set).toEqual(new Set([active]));
  });
});

/**
 * Wealth-scaled unit pricing: the UNIT cost rises toward
 * detectives.wealth_percent (1% default) of the hirer's cash + bank, floored
 * at detectives.cost and capped at detectives.wealth_cap_multiplier × it —
 * then still multiplied by detectives × hours, so the client's preview
 * formula stays exact. Scaling the unit, not the total, is what keeps
 * listRoute's `cost` field honest for every dets/hours combination at once.
 */
describe("POST /api/detectives — wealth scaling", () => {
  it("scales the unit cost on the hirer's wealth", async () => {
    // 1% of 50M = 500k per unit-hour, above the 125k floor and below the
    // 1.25M cap. 2 dets x 3 hours = 6 units -> 3M exactly.
    await db.update(playerStats).set({ cash: 50_000_000n })
      .where(eq(playerStats.playerId, hirerId));

    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 2, hours: 3 });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().cash).toBe("47000000"); // 50M - 3M

    const [ledgerRow] = await db.select().from(transactions)
      .where(eq(transactions.reason, "detectives.hire"));
    expect(ledgerRow!.amount).toBe(-3_000_000n);
  });

  it("caps the unit at wealth_cap_multiplier x the flat unit", async () => {
    // 1% of 5B = 50M per unit, capped at 10 x 125k = 1.25M. 1 x 1 -> 1.25M.
    await db.update(playerStats).set({ cash: 5_000_000_000n })
      .where(eq(playerStats.playerId, hirerId));

    const res = await hire(hirerToken, { targetUsername: "Fugitive", detectives: 1, hours: 1 });
    expect(res.statusCode, res.body).toBe(201);
    // 5,000,000,000 - 1,250,000
    expect(res.json().cash).toBe("4998750000");
  });

  it("previews the scaled unit in the list route — caller-relative, like bail", async () => {
    // Broke hirer: floor (125k, the pre-scaling price). Rich hirer: 500k.
    await db.update(playerStats).set({ cash: 50_000_000n })
      .where(eq(playerStats.playerId, hirerId));
    const richList = await list(hirerToken);
    expect(richList.statusCode).toBe(200);
    expect(richList.json().cost).toBe("500000");

    const poor = await registerVerifiedPlayer({ app, redis }, { username: `Broke${Date.now()}` });
    const poorList = await list(poor.token);
    expect(poorList.json().cost).toBe("125000");
  });

  it("collapses to the flat unit when the percent is 0 — the rollback knob", async () => {
    await db.insert(settings).values({ key: "detectives.wealth_percent", value: "0" });
    const { app: freshApp, close } = await bootTestServer();
    try {
      await db.update(playerStats).set({ cash: 50_000_000n })
        .where(eq(playerStats.playerId, hirerId));
      const res = await freshApp.inject({
        method: "POST", url: "/api/detectives",
        headers: { authorization: `Bearer ${hirerToken}` },
        payload: { targetUsername: "Fugitive", detectives: 1, hours: 1 },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().cash).toBe("49875000"); // 50M - 125000
    } finally {
      await close();
    }
  });
});
