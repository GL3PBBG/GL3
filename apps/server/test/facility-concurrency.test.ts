import { eq } from "drizzle-orm";
import type { FastifyInstance, InjectOptions } from "fastify";
import type { Redis } from "ioredis";
import type { LightMyRequestResponse } from "light-my-request";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { locations, playerStats, transactions } from "../src/db/schema/index.js";
import { applyBalanceChange } from "../src/economy/ledger.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * Two payers, ONE target, both paid-rescue routes in flight at once.
 *
 * `POST /api/jail/bail` and `POST /api/hospital/discharge-player` each open
 * their transaction with ONE sorted `lockPlayersForUpdate(tx, [caller,
 * target])` as the FIRST statement, before either row is read (NOTES.md
 * rule 6). Without that lock, both requests read the target as still
 * jailed/hospitalised, both queue on the ledger's own lock when they debit
 * the payer, and both charge: one release, two ledger rows, twice the money
 * gone — the exact shape `test/hospital-concurrency.test.ts` guards on the
 * single-player discharge route, now proven for the two-player routes that
 * copied its lock line.
 *
 * `economy-invariant.test.ts` cannot catch this: both charges are ledgered,
 * so `sum(ledger) == balance` holds throughout. Only the COUNT of rows with
 * the route's `reason` gives it away.
 *
 * The blocker connection is a barrier, not an adversary — same shape as
 * `hospital-concurrency.test.ts` and `combat-concurrency.test.ts`. It parks
 * both requests on the target's row so they are provably concurrent before
 * either proceeds, instead of a bare `Promise.all` that may or may not
 * overlap on any given run.
 */

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let townA: string;

interface Player { token: string; playerId: string }

async function register(name: string): Promise<Player> {
  return registerVerifiedPlayer({ app, redis }, { username: `${name}${Date.now()}${Math.floor(Math.random() * 1000)}` });
}

async function place(p: Player, locationId: string | null, patch: Record<string, unknown> = {}): Promise<void> {
  await db.update(playerStats).set({ locationId, ...patch }).where(eq(playerStats.playerId, p.playerId));
}

async function fund(p: Player, amount: bigint): Promise<void> {
  await db.transaction((tx) => applyBalanceChange(tx, {
    playerId: p.playerId, amount, kind: "cash", reason: "test.seed",
  }));
}

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

beforeAll(async () => {
  await resetDb(db);
  ({ app, close: closeServer, redis } = await bootTestServer());
  townA = crypto.randomUUID();
  await db.insert(locations).values({ id: townA, name: `Town A ${townA.slice(0, 8)}` });
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

const auth = (p: Player) => ({ authorization: `Bearer ${p.token}` });

describe("two payers racing one contested target", () => {
  it("charges exactly one of two concurrent bails", async () => {
    const payerA = await register("PayerA");
    const payerB = await register("PayerB");
    const inmate = await register("Inmate");
    await place(payerA, townA);
    await place(payerB, townA);
    await place(inmate, townA, { jailedUntil: new Date(Date.now() + 600_000) });
    await fund(payerA, 5_000_000n);
    await fund(payerB, 5_000_000n);

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];

    try {
      // Hold the inmate's row. The shipped code needs it for its sorted
      // player lock, so this parks both requests before either can proceed.
      await t0`BEGIN`;
      await t0`SELECT player_id FROM player_stats WHERE player_id = ${inmate.playerId}::uuid FOR UPDATE`;

      const bail = (payer: Player): InjectOptions => ({
        method: "POST", url: "/api/jail/bail", headers: auth(payer),
        payload: { playerId: inmate.playerId },
      });
      const r1 = fire(bail(payerA));
      const r2 = fire(bail(payerB));
      inFlight.push(r1, r2);
      await waitForLockWaiters(2);

      await t0`ROLLBACK`;
      const [resA, resB] = await Promise.all([r1, r2]);

      const codes = [resA.statusCode, resB.statusCode].sort();
      expect(codes, `bodies: ${resA.body} | ${resB.body}`).toEqual([200, 409]);
      const loser = resA.statusCode === 409 ? resA : resB;
      expect(loser.json()).toMatchObject({ error: "not_jailed" });

      const bailRows = await db.select().from(transactions)
        .where(eq(transactions.reason, "jail.bail"));
      expect(bailRows).toHaveLength(1);

      const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, inmate.playerId));
      expect(target?.jailedUntil).toBeNull();
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

  it("charges exactly one of two concurrent paid discharges", async () => {
    const payerA = await register("PayerC");
    const payerB = await register("PayerD");
    const patient = await register("Patient");
    await place(payerA, townA);
    await place(payerB, townA);
    await place(patient, townA, { health: 0, hospitalUntil: new Date(Date.now() + 600_000) });
    await fund(payerA, 5_000_000n);
    await fund(payerB, 5_000_000n);

    const blocker = postgres(loadConfig(process.env).databaseUrl, { max: 1 });
    const t0 = await blocker.reserve();
    const inFlight: Promise<LightMyRequestResponse>[] = [];

    try {
      // Hold the patient's row. The shipped code needs it for its sorted
      // player lock, so this parks both requests before either can proceed.
      await t0`BEGIN`;
      await t0`SELECT player_id FROM player_stats WHERE player_id = ${patient.playerId}::uuid FOR UPDATE`;

      const discharge = (payer: Player): InjectOptions => ({
        method: "POST", url: "/api/hospital/discharge-player", headers: auth(payer),
        payload: { playerId: patient.playerId },
      });
      const r1 = fire(discharge(payerA));
      const r2 = fire(discharge(payerB));
      inFlight.push(r1, r2);
      await waitForLockWaiters(2);

      await t0`ROLLBACK`;
      const [resA, resB] = await Promise.all([r1, r2]);

      const codes = [resA.statusCode, resB.statusCode].sort();
      expect(codes, `bodies: ${resA.body} | ${resB.body}`).toEqual([200, 409]);
      const loser = resA.statusCode === 409 ? resA : resB;
      expect(loser.json()).toMatchObject({ error: "not_hospitalised" });

      const dischargeRows = await db.select().from(transactions)
        .where(eq(transactions.reason, "hospital.discharge"));
      expect(dischargeRows).toHaveLength(1);

      const [target] = await db.select().from(playerStats).where(eq(playerStats.playerId, patient.playerId));
      expect(target?.hospitalUntil).toBeNull();
      expect(target?.health).toBeGreaterThan(0);
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
