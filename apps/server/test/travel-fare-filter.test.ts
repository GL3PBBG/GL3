import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import travelPlugin, { fares, travelCompleted, type FareQuoteBatch, type TravelCompleted } from "@gl3/plugin-travel";
import { on, type PluginCtx, type RouteResult } from "@gl3/plugin-sdk";
import type { BoundFilterSubscription } from "@gl3/plugin-sdk";
import { loadConfig } from "../src/config.js";
import { locations, players, playerStats, transactions } from "../src/db/schema/index.js";
import { cooldownKey } from "../src/game/cooldown.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { loadSnapshot } from "../src/plugins/routes.js";
import { createRedis } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";
import { testAssetDriver } from "./helpers/assets.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const leaderboardPrefix = `travel-fare-filter-${uuidv7()}`;

let playerId: string;
let homeId: string;
let awayId: string;

const FARE = 1000n;

/**
 * Drives a travel-plugin route with EXTRA bound filter subscriptions from a
 * foreign plugin id — the seam `callPluginRoute` deliberately lacks (it binds
 * only the manifest's own filters). Same hand-built-ctx technique as
 * travel.test.ts's `travelWithTransactionHook`; `createPluginCtx` is the real
 * ctx factory, so `runFilterChain`'s ctxFor attribution runs for real here.
 */
async function callTravelRoute(
  method: "GET" | "POST",
  path: string,
  params: unknown,
  extra: readonly BoundFilterSubscription[],
): Promise<RouteResult> {
  const pluginRoute = travelPlugin.routes.find((r) => r.method === method && r.path === path);
  if (pluginRoute === undefined) throw new Error(`travel has no ${method} ${path}`);
  const deps = {
    db, redis, queues: new Map(), settings: {}, leaderboardPrefix,
    assetDriver: testAssetDriver(),
  };
  const player = await loadSnapshot(deps, playerId);
  const ctx: PluginCtx = createPluginCtx(deps, {
    pluginId: travelPlugin.id, player, job: null,
    filters: [
      ...travelPlugin.filters.map((subscription) => ({ ownerId: travelPlugin.id, subscription })),
      ...extra,
    ],
    propertyTypes: new Map(),
    installedPluginIds: new Set([travelPlugin.id, "fareprobe"]),
  });
  const parsedParams = pluginRoute.params.parse(params ?? {});
  const body = pluginRoute.body.parse({});
  const query = pluginRoute.query.parse({});
  return pluginRoute.handler(ctx, { params: parsedParams, body, query });
}

function bind(subscription: BoundFilterSubscription["subscription"]): BoundFilterSubscription {
  return { ownerId: "fareprobe", subscription };
}

async function cashOf(id: string): Promise<bigint> {
  const [row] = await db.select({ cash: playerStats.cash }).from(playerStats)
    .where(eq(playerStats.playerId, id));
  if (row === undefined) throw new Error("player_stats row missing");
  return row.cash;
}

async function freeCooldown(): Promise<void> {
  await redis.del(cooldownKey(playerId, "travel"));
}

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `fare_${uuidv7().slice(-10)}` });
  homeId = uuidv7();
  awayId = uuidv7();
  await db.insert(locations).values([
    { id: homeId, name: "Home", travelCost: 0n, travelCooldownSeconds: 60, bulletCost: 5n, bulletStock: 100 },
    { id: awayId, name: "Away", travelCost: FARE, travelCooldownSeconds: 60, bulletCost: 5n, bulletStock: 100 },
  ]);
  await db.insert(playerStats).values({ playerId, cash: 10_000n, locationId: homeId });
  await freeCooldown();
});

afterAll(async () => {
  await conn.end();
  redis.disconnect();
});

describe("travel.fares filter point", () => {
  it("the listing shows a subscriber's discounted fare", async () => {
    const halve = bind(on(fares, (_ctx, batch: FareQuoteBatch) => ({
      ...batch,
      quotes: batch.quotes.map((q) => ({ ...q, fare: q.fare / 2n })),
    })));
    const result = await callTravelRoute("GET", "/api/locations", undefined, [halve]);
    expect(result.status).toBe(200);
    const body = result.body as { locations: { id: string; travelCost: string }[] };
    const away = body.locations.find((l) => l.id === awayId);
    expect(away?.travelCost).toBe((FARE / 2n).toString());
  });

  it("a discounted row carries baseFare and the subscriber's label; others carry neither", async () => {
    const halveWithLabel = bind(on(fares, (_ctx, batch: FareQuoteBatch) => ({
      ...batch,
      quotes: batch.quotes.map((q) =>
        q.toLocationId === awayId ? { ...q, fare: q.fare / 2n, label: "Driving your Junker" } : q),
    })));
    const result = await callTravelRoute("GET", "/api/locations", undefined, [halveWithLabel]);
    const body = result.body as {
      locations: { id: string; travelCost: string; baseFare?: string; fareLabel?: string }[];
    };
    const away = body.locations.find((l) => l.id === awayId);
    expect(away).toMatchObject({
      travelCost: (FARE / 2n).toString(), baseFare: FARE.toString(), fareLabel: "Driving your Junker",
    });
    // The undiscounted row's payload is byte-identical to the pre-label shape.
    const home = body.locations.find((l) => l.id === homeId);
    expect(home).not.toHaveProperty("baseFare");
    expect(home).not.toHaveProperty("fareLabel");
  });

  it("a label without a real discount is dropped along with baseFare", async () => {
    const labelOnly = bind(on(fares, (_ctx, batch: FareQuoteBatch) => ({
      ...batch,
      quotes: batch.quotes.map((q) => ({ ...q, label: "free ride!" })),
    })));
    const result = await callTravelRoute("GET", "/api/locations", undefined, [labelOnly]);
    const body = result.body as {
      locations: { id: string; baseFare?: string; fareLabel?: string }[];
    };
    for (const row of body.locations) {
      expect(row).not.toHaveProperty("baseFare");
      expect(row).not.toHaveProperty("fareLabel");
    }
  });

  it("the fares batch carries the caller's origin", async () => {
    const seen: FareQuoteBatch[] = [];
    const probe = bind(on(fares, (_ctx, batch: FareQuoteBatch) => {
      seen.push(batch);
      return batch;
    }));
    await callTravelRoute("GET", "/api/locations", undefined, [probe]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.playerId).toBe(playerId);
    expect(seen[0]?.fromLocationId).toBe(homeId);
  });

  it("travel debits the quoted fare, and travel.completed fires after commit with it", async () => {
    const completed: TravelCompleted[] = [];
    const halve = bind(on(fares, (_ctx, batch: FareQuoteBatch) => ({
      ...batch,
      quotes: batch.quotes.map((q) => ({ ...q, fare: q.fare / 2n })),
    })));
    const record = bind(on(travelCompleted, (_ctx, value: TravelCompleted) => {
      completed.push(value);
      return value;
    }));
    const before = await cashOf(playerId);
    const result = await callTravelRoute("POST", "/api/travel/:locationId", { locationId: awayId }, [halve, record]);
    expect(result.status).toBe(200);
    expect(before - (await cashOf(playerId))).toBe(FARE / 2n);

    // The ledger row is the quoted figure too (rule 3: one movement, one row).
    const rows = await db.select().from(transactions).where(eq(transactions.playerId, playerId));
    const debit = rows.find((r) => r.reason === "travel.cost");
    expect(debit?.amount).toBe(-(FARE / 2n));

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      playerId, fromLocationId: homeId, toLocationId: awayId,
      baseFare: FARE, fare: FARE / 2n,
    });
  });

  it("a throwing fares subscriber is dropped (collect) and the full fare is charged", async () => {
    const bomb = bind(on(fares, () => { throw new Error("boom"); }));
    const before = await cashOf(playerId);
    const result = await callTravelRoute("POST", "/api/travel/:locationId", { locationId: awayId }, [bomb]);
    expect(result.status).toBe(200);
    expect(before - (await cashOf(playerId))).toBe(FARE);
  });

  it("a subscriber cannot raise the fare above baseFare nor push it below zero", async () => {
    const gouge = bind(on(fares, (_ctx, batch: FareQuoteBatch) => ({
      ...batch,
      quotes: batch.quotes.map((q) => ({ ...q, fare: q.fare * 10n })),
    })));
    const before = await cashOf(playerId);
    const result = await callTravelRoute("POST", "/api/travel/:locationId", { locationId: awayId }, [gouge]);
    expect(result.status).toBe(200);
    expect(before - (await cashOf(playerId))).toBe(FARE);

    // Back home, then a negative quote clamps to zero rather than crediting.
    await db.update(playerStats).set({ locationId: homeId }).where(eq(playerStats.playerId, playerId));
    await freeCooldown();
    const refund = bind(on(fares, (_ctx, batch: FareQuoteBatch) => ({
      ...batch,
      quotes: batch.quotes.map((q) => ({ ...q, fare: -500n })),
    })));
    const mid = await cashOf(playerId);
    const again = await callTravelRoute("POST", "/api/travel/:locationId", { locationId: awayId }, [refund]);
    expect(again.status).toBe(200);
    expect(await cashOf(playerId)).toBe(mid);
  });

  it("a failed travel never fires travel.completed", async () => {
    const completed: TravelCompleted[] = [];
    const record = bind(on(travelCompleted, (_ctx, value: TravelCompleted) => {
      completed.push(value);
      return value;
    }));
    await db.update(playerStats).set({ cash: 1n }).where(eq(playerStats.playerId, playerId));
    await expect(
      callTravelRoute("POST", "/api/travel/:locationId", { locationId: awayId }, [record]),
    ).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(completed).toHaveLength(0);
  });

  it("a throwing travel.completed subscriber does not un-travel the player", async () => {
    const bomb = bind(on(travelCompleted, () => { throw new Error("boom"); }));
    const result = await callTravelRoute("POST", "/api/travel/:locationId", { locationId: awayId }, [bomb]);
    expect(result.status).toBe(200);
    const [row] = await db.select({ locationId: playerStats.locationId }).from(playerStats)
      .where(eq(playerStats.playerId, playerId));
    expect(row?.locationId).toBe(awayId);
  });
});
