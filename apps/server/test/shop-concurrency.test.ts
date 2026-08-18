import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Redis } from "ioredis";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Two buyers released together against the LAST unit in stock. Exactly one
 * 200 and one 409 insufficient_stock; one player_items row incremented; stock
 * lands at 0 and never negative.
 *
 * The blocker holds the `locations` row FOR UPDATE — the first lock the buy
 * handler takes (tx.locks.location) — so both requests are parked at the same
 * point before release. `waitForLockWaiters(2)` polls pg_stat_activity for
 * wait_event_type = 'Lock' rather than sleeping, so the release is
 * deterministic rather than timing-dependent.
 *
 * Same shape as `hospital-concurrency.test.ts` and `combat-concurrency.test.ts`:
 * the blocker is a barrier, not an adversary, and it parks both requests on
 * the row the handler locks first so they are provably concurrent before
 * either proceeds.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

let tokenA: string;
let tokenB: string;
let locationId: string;
let itemId: string;

/** app.inject() is lazy — it dispatches only when something calls .then. */
function fire(opts: InjectOptions): Promise<LightMyRequestResponse> {
  return Promise.resolve(app.inject(opts));
}

async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
    `;
    const seen = row?.n ?? 0;
    if (seen >= n) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${n} lock-waiting backends (saw ${seen})`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

/** Registers a player and returns their id plus a bearer token. */
async function register(username: string): Promise<{ id: string; token: string }> {
  const body = await registerVerifiedPlayer({ app, redis }, { username });
  return { id: body.playerId, token: body.token };
}

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());

  const a = await register(`buyerA_${randomUUID().slice(0, 8)}`);
  const b = await register(`buyerB_${randomUUID().slice(0, 8)}`);
  tokenA = a.token;
  tokenB = b.token;

  locationId = uuidv7();
  itemId = uuidv7();
  await db.execute(sql`
    insert into locations (id, name) values (${locationId}, ${"Shopville " + locationId.slice(0, 8)})`);
  await db.execute(sql`
    insert into items (id, name, item_type, effects)
    values (${itemId}, ${"Test Pistol " + itemId.slice(0, 8)}, 'weapon',
            ${JSON.stringify({ accuracy: 55, damageMin: 8, damageMax: 18 })}::jsonb)`);
  // ONE unit of stock — the last unit both buyers race for.
  await db.execute(sql`
    insert into p_inventory_shop_stock (location_id, item_id, price, stock)
    values (${locationId}, ${itemId}, 100::bigint, 1)`);

  await db.execute(sql`
    update player_stats set location_id = ${locationId}, cash = 10000
    where player_id = ${a.id} or player_id = ${b.id}`);
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("two concurrent buyers racing for the last unit of stock", () => {
  it("sells to exactly one buyer and 409s the loser", async () => {
    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];

    try {
      // Hold the location row. `tx.locks.location(locationId)` is the first
      // lock the buy handler takes, so this parks both requests at the same
      // point before either can read stock.
      await t0`BEGIN`;
      await t0`SELECT id FROM locations WHERE id = ${locationId}::uuid FOR UPDATE`;

      const opts = (token: string): InjectOptions => ({
        method: "POST",
        url: "/api/shop/buy",
        headers: { authorization: `Bearer ${token}` },
        payload: { itemId, quantity: 1 },
      });
      const r1 = fire(opts(tokenA));
      const r2 = fire(opts(tokenB));
      inFlight.push(r1, r2);
      await waitForLockWaiters(2);

      await t0`ROLLBACK`;
      const [res1, res2] = await Promise.all([r1, r2]);

      expect(
        [res1.statusCode, res2.statusCode].sort(),
        `bodies: ${res1.body} | ${res2.body}`,
      ).toEqual([200, 409]);
      // Not any 409: the loser must lose because it re-read the stock under
      // the lock and found it already sold.
      const loser = res1.statusCode === 409 ? res1 : res2;
      expect(loser.json<{ error: string }>().error).toBe("insufficient_stock");

      const stock = await db.execute<{ stock: number }>(
        sql`select stock from p_inventory_shop_stock where item_id = ${itemId}`,
      );
      expect(stock[0]?.stock).toBe(0);

      const owned = await db.execute<{ n: string; total: string }>(
        sql`select count(*)::text as n, coalesce(sum(qty),0)::text as total
            from player_items where item_id = ${itemId}`,
      );
      expect(owned[0]?.n).toBe("1");
      expect(owned[0]?.total).toBe("1");

      // The economy ledger table is `transactions` (apps/server/src/db/schema/
      // economy.ts), not `ledger` — NOTES.md rule 3 calls it "the ledger" but
      // that is not the table's name.
      const ledger = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from transactions where reason = 'shop.purchase'`,
      );
      expect(ledger[0]?.n).toBe("1");
    } finally {
      try {
        await t0`ROLLBACK`;
      } catch {
        /* already rolled back */
      }
      await Promise.allSettled(inFlight);
      t0.release();
      await blocker.end();
    }
  }, 30_000);
});
