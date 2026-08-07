import { GameEventSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats, transactions } from "../src/db/schema/index.js";
import { InsufficientFundsError } from "../src/economy/ledger.js";
import { performBankTransaction } from "../src/game/bank/service.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `p${Date.now()}` });
  await db.insert(playerStats).values({ playerId, cash: 1000n });
});
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

const waitForEvent = (): Promise<unknown> =>
  new Promise((resolve) => {
    subscriber.once("message", (channel, raw) => { if (channel === GAME_EVENTS_CHANNEL) resolve(JSON.parse(raw)); });
  });

describe("performBankTransaction", () => {
  it("moves cash into the bank in one transaction with two ledger rows", async () => {
    await subscriber.subscribe(GAME_EVENTS_CHANNEL);
    const received = waitForEvent();

    const result = await performBankTransaction(db, redis, playerId, "deposit", 400n);
    expect(result).toEqual({ cash: 600n, bank: 400n });

    const event = GameEventSchema.parse(await received);
    expect(event.type).toBe("bank.transacted");
    if (event.type !== "bank.transacted") throw new Error("unreachable");
    expect(event.direction).toBe("deposit");
    expect(event.amount).toBe("400");

    const ledger = await db.select().from(transactions).orderBy(transactions.balanceKind);
    expect(ledger).toHaveLength(2);
    expect(ledger.find((r) => r.balanceKind === "cash")?.amount).toBe(-400n);
    expect(ledger.find((r) => r.balanceKind === "bank")?.amount).toBe(400n);
  });

  it("moves bank cash back to cash on withdraw", async () => {
    await performBankTransaction(db, redis, playerId, "deposit", 400n);
    const result = await performBankTransaction(db, redis, playerId, "withdraw", 150n);
    expect(result).toEqual({ cash: 750n, bank: 250n });
  });

  it("rejects an overdraft on either leg and leaves both balances untouched", async () => {
    await expect(performBankTransaction(db, redis, playerId, "withdraw", 1n)).rejects.toBeInstanceOf(InsufficientFundsError);
    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.cash).toBe(1000n);
    expect(row?.bank).toBe(0n);
    expect(await db.select().from(transactions)).toHaveLength(0);
  });

  it("serializes two concurrent withdrawals so only one can succeed against a tight balance", async () => {
    await performBankTransaction(db, redis, playerId, "deposit", 100n);
    const results = await Promise.allSettled([
      performBankTransaction(db, redis, playerId, "withdraw", 60n),
      performBankTransaction(db, redis, playerId, "withdraw", 60n),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const [row] = await db.select({ bank: playerStats.bank }).from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.bank).toBe(40n);
  });
});

describe("POST /api/bank/deposit and /withdraw", () => {
  it("deposits, withdraws, and rejects an overdraft over HTTP", async () => {
    const { buildApp } = await import("../src/app.js");
    const { createCrimeQueue } = await import("../src/queue/index.js");

    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const app = await buildApp(config, { db, redis, crimeQueue: createCrimeQueue(createRedis(config.redisUrl)) });
    const reg = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: `Bank${Date.now()}`, password: "hunter2hunter2" } });
    const { token, playerId: registeredId } = reg.json();
    // registration starts a player at 0 cash — fund them directly so the
    // deposit below has something to move.
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, registeredId));

    const deposit = await app.inject({
      method: "POST", url: "/api/bank/deposit",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "300" },
    });
    expect(deposit.statusCode).toBe(200);
    expect(deposit.json()).toEqual({ cash: "700", bank: "300" });

    const withdraw = await app.inject({
      method: "POST", url: "/api/bank/withdraw",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "100" },
    });
    expect(withdraw.statusCode).toBe(200);
    expect(withdraw.json()).toEqual({ cash: "800", bank: "200" });

    const overdraft = await app.inject({
      method: "POST", url: "/api/bank/withdraw",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "999999" },
    });
    expect(overdraft.statusCode).toBe(409);
    expect(overdraft.json()).toEqual({ error: "insufficient_funds" });

    const zero = await app.inject({
      method: "POST", url: "/api/bank/deposit",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "0" },
    });
    expect(zero.statusCode).toBe(400);

    const negative = await app.inject({
      method: "POST", url: "/api/bank/deposit",
      headers: { authorization: `Bearer ${token}` }, payload: { amount: "-50" },
    });
    expect(negative.statusCode).toBe(400);

    const unauthenticated = await app.inject({ method: "POST", url: "/api/bank/deposit", payload: { amount: "10" } });
    expect(unauthenticated.statusCode).toBe(401);

    await app.close();
  });
});
