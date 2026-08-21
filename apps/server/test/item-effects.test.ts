import { MAX_CASH_PER_USE, MAX_EXP_PER_USE, MIN_HEALTH_AFTER_USE } from "@gl3/plugin-inventory";
import { InventoryResponseSchema, UseItemResponseSchema } from "@gl3/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { LightMyRequestResponse } from "light-my-request";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { items, playerItems, playerStats, transactions } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { itemEffectsPlugin } from "./helpers/item-effects-plugin.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The open item effect registry (`inventory.itemEffects`). The built-in `heal`
 * def is the base of the map and never goes through the filter chain, so every
 * item that existed before the registry — including every V2-migrated one,
 * none of which carries a `kind` — must behave exactly as it did. Everything
 * else here is about what a THIRD-PARTY def can and cannot do: it states
 * figures, and this plugin bounds them and writes every row.
 *
 * The pure half — registry assembly, the duplicate-kind refusal, `guardEffect`
 * and every bound `boundOutcome` places — is `item-effect-registry.test.ts`,
 * which needs no database. This file is what proves the route wires them up.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

async function seedItem(
  effects: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(items).values({
    id, name: `consumable-${id.slice(-8)}`, itemType: "consumable", effects, meta,
  });
  return id;
}

async function grant(itemId: string, qty: number): Promise<void> {
  await db.insert(playerItems).values({ playerId, itemId, qty });
}

async function use(itemId: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST", url: `/api/inventory/use/${itemId}`,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function qtyOf(itemId: string): Promise<number | undefined> {
  const [row] = await db
    .select({ qty: playerItems.qty })
    .from(playerItems)
    .where(and(eq(playerItems.playerId, playerId), eq(playerItems.itemId, itemId)));
  return row?.qty;
}

async function statsOf(): Promise<{ health: number; exp: bigint; cash: bigint }> {
  const [row] = await db
    .select({ health: playerStats.health, exp: playerStats.exp, cash: playerStats.cash })
    .from(playerStats)
    .where(eq(playerStats.playerId, playerId));
  if (!row) throw new Error("no player_stats row");
  return row;
}

beforeEach(async () => {
  await resetDb(db);
  if (!app) {
    ({ app, close: closeServer, redis } = await bootTestServer({ plugins: [itemEffectsPlugin] }));
  }
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Doc" }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

describe("the built-in heal def", () => {
  it("still heals an item with no kind, exactly as before the registry", async () => {
    const medkit = await seedItem({ heal: 30 });
    await grant(medkit, 2);
    await db.update(playerStats).set({ health: 50 }).where(eq(playerStats.playerId, playerId));

    const res = await use(medkit);

    expect(res.statusCode).toBe(200);
    const body = UseItemResponseSchema.parse(res.json());
    expect(body).toMatchObject({ health: 80, healed: 30, qty: 1 });
    expect(body.message).toBeUndefined();
    expect((await statsOf()).health).toBe(80);
  });

  it("still refuses a consumable whose jsonb states no heal figure", async () => {
    const dud = await seedItem({});
    await grant(dud, 1);
    await db.update(playerStats).set({ health: 50 }).where(eq(playerStats.playerId, playerId));

    const res = await use(dud);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "wrong_slot" });
    expect(await qtyOf(dud)).toBe(1);
  });
});

describe("an unregistered kind", () => {
  it("400s and does NOT spend the item", async () => {
    // Resolved before the decrement, which is the whole point: an item naming
    // a def this deployment does not have must survive being clicked.
    const mystery = await seedItem({ kind: "no-such-def", heal: 10 });
    await grant(mystery, 3);
    await db.update(playerStats).set({ health: 50 }).where(eq(playerStats.playerId, playerId));

    const res = await use(mystery);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "unknown_effect" });
    expect(await qtyOf(mystery)).toBe(3);
    expect((await statsOf()).health).toBe(50);
  });
});

describe("a registered third-party def", () => {
  it("reads its config from effects laid over meta, effects winning", async () => {
    // `street` comes from meta (where the M4 migrator puts V2's itemMeta) and
    // `kick` from effects; the duplicated key proves which half wins.
    const tonic = await seedItem(
      { kind: "tonic", kick: 15 },
      { street: 40, kick: 1 },
    );
    await grant(tonic, 1);
    await db.update(playerStats).set({ health: 50 }).where(eq(playerStats.playerId, playerId));

    const res = await use(tonic);

    expect(res.statusCode).toBe(200);
    const body = UseItemResponseSchema.parse(res.json());
    expect(body).toMatchObject({ health: 65, healed: 15, qty: 0 });
    expect(body.message).toBe("The tonic burns going down.");
    const stats = await statsOf();
    expect(stats.health).toBe(65);
    expect(stats.exp).toBe(40n);
  });

  it("clamps an absurd exp and cash claim to the caps", async () => {
    const jackpot = await seedItem({ kind: "jackpot" });
    await grant(jackpot, 1);
    await db.update(playerStats).set({ cash: 500n }).where(eq(playerStats.playerId, playerId));

    const res = await use(jackpot);

    expect(res.statusCode).toBe(200);
    const body = UseItemResponseSchema.parse(res.json());
    // The def asked for a billion exp and a trillion dollars.
    expect(body.exp).toBe(String(MAX_EXP_PER_USE));
    expect(body.cash).toBe((500n + MAX_CASH_PER_USE).toString());
    const stats = await statsOf();
    expect(stats.exp).toBe(BigInt(MAX_EXP_PER_USE));
    expect(stats.cash).toBe(500n + MAX_CASH_PER_USE);
  });

  it("is not blocked by full health when it does not touch health", async () => {
    // `already_full` is the built-in heal's refusal, not the registry's.
    const jackpot = await seedItem({ kind: "jackpot" });
    await grant(jackpot, 1);
    expect((await statsOf()).health).toBe(100);

    const res = await use(jackpot);

    expect(res.statusCode).toBe(200);
    expect(res.json().healed).toBe(0);
  });

  it("cannot kill: health floors above zero", async () => {
    const poison = await seedItem({ kind: "poison" });
    await grant(poison, 1);

    const res = await use(poison);

    expect(res.statusCode).toBe(200);
    expect(res.json().health).toBe(MIN_HEALTH_AFTER_USE);
    expect((await statsOf()).health).toBe(MIN_HEALTH_AFTER_USE);
  });

  it("writes a ledger row for every dollar it moves", async () => {
    const toll = await seedItem({ kind: "toll" });
    await grant(toll, 1);
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, playerId));

    const res = await use(toll);

    expect(res.statusCode).toBe(200);
    expect(res.json().cash).toBe("750");
    expect((await statsOf()).cash).toBe(750n);

    const rows = await db
      .select({ amount: transactions.amount, reason: transactions.reason, refId: transactions.refId })
      .from(transactions)
      .where(eq(transactions.playerId, playerId));
    // The registration bonus (if any) plus exactly one row for this use.
    const mine = rows.filter((r) => r.reason === "inventory.effect.toll");
    expect(mine).toEqual([{ amount: -250n, reason: "inventory.effect.toll", refId: toll }]);
  });

  it("cannot charge more than the player holds", async () => {
    const shakedown = await seedItem({ kind: "shakedown" });
    await grant(shakedown, 1);
    await db.update(playerStats).set({ cash: 300n }).where(eq(playerStats.playerId, playerId));

    const res = await use(shakedown);

    // Floored rather than refused: the item is spent by then, and an overdraft
    // would be a 409 the player has no way to act on.
    expect(res.statusCode).toBe(200);
    expect(res.json().cash).toBe("0");
    expect((await statsOf()).cash).toBe(0n);
  });

  it("turns its own throw into a clean 400 and does NOT spend the item", async () => {
    const cursed = await seedItem({ kind: "cursed" });
    await grant(cursed, 2);

    const res = await use(cursed);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "effect_failed" });
    // The decrement runs before `apply`, so this is the transaction rolling
    // back — not the check-first ordering `unknown_effect` relies on.
    expect(await qtyOf(cursed)).toBe(2);
  });
});

describe("GET /api/inventory", () => {
  it("labels a registered non-heal consumable and leaves a plain heal alone", async () => {
    const tonic = await seedItem({ kind: "tonic", kick: 5 });
    const mystery = await seedItem({ kind: "no-such-def" });
    const medkit = await seedItem({ heal: 20 });
    await grant(tonic, 1);
    await grant(mystery, 1);
    await grant(medkit, 1);

    const res = await app.inject({
      method: "GET", url: "/api/inventory",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = InventoryResponseSchema.parse(res.json());
    expect(body.items.find((i) => i.itemId === tonic)?.effectLabel).toBe("Bootleg Tonic");
    // No def, so no invented name — the page falls back to the raw kind.
    expect(body.items.find((i) => i.itemId === mystery)?.effectLabel).toBeUndefined();
    expect(body.items.find((i) => i.itemId === medkit)?.effectLabel).toBeUndefined();
    // The kind survives the round trip, which is what the page reads.
    expect(body.items.find((i) => i.itemId === tonic)?.effects)
      .toMatchObject({ kind: "tonic", kick: 5 });
  });
});
