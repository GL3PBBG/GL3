import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { crimeLog, crimes, playerCrimeSkill, players } from "../../db/schema/index.js";
import { addExp, applyBalanceChange } from "../../economy/ledger.js";
import { CRIME_QUEUE, type CrimeJobData } from "../../queue/index.js";
import { createRng } from "../rng.js";
import { DEFAULT_CRIME_CHANCE } from "./routes.js";

export interface CrimeWorkerDeps {
  db: Db;
  connection: Redis;
  publisher: Redis;
  /** Overridable so tests can pair a worker with a test-private queue name — see createCrimeQueue. */
  queueName?: string;
}

/** The slice of a BullMQ `Job` the processor needs — lets tests drive it directly. */
export interface CrimeJob { id: string; data: CrimeJobData }

/**
 * PostgreSQL SQLSTATE 23505 = unique_violation. Mirrors auth/routes.ts's
 * `uniqueViolation` guard: drizzle-orm wraps the raw driver error in its own
 * `DrizzleQueryError`, with the real `PostgresError` attached as `.cause` —
 * so the check has to look one level down the `Error.cause` chain, not just
 * at the thrown error itself.
 */
function uniqueViolation(err: unknown): postgres.PostgresError | null {
  const candidate = err instanceof postgres.PostgresError ? err
    : err instanceof Error && err.cause instanceof postgres.PostgresError ? err.cause
    : null;
  return candidate?.code === "23505" ? candidate : null;
}

/**
 * Resolves one crime-commit job. Exported (rather than left as the inline
 * `Worker` callback) so tests can invoke it directly with a fixed `job.id`
 * to prove retries can't double-pay — see crime-worker-idempotency.test.ts.
 */
export async function processCrimeJob(db: Db, publisher: Redis, job: CrimeJob): Promise<void> {
  const { playerId, crimeId, seed } = job.data;

  const [crime] = await db.select().from(crimes).where(eq(crimes.id, crimeId));
  if (!crime) return; // crime deleted between enqueue and resolve — drop the job

  // SPEC §3: every event carries the acting player's id *and display name*.
  const [actor] = await db.select({ username: players.username })
    .from(players).where(eq(players.id, playerId));
  if (!actor) return; // player deleted between enqueue and resolve

  const [skill] = await db.select().from(playerCrimeSkill)
    .where(eq(playerCrimeSkill.playerId, playerId));
  const chance = Number(skill?.chance ?? DEFAULT_CRIME_CHANCE);

  // All randomness lives here, derived from the enqueue-time seed (spec §7).
  // Seed-determinism makes this OUTCOME reproducible on a retry — it does
  // nothing on its own about re-running the side effects below, which is
  // exactly what the job.id-keyed insert guards against.
  const rng = createRng(seed);
  const roll = rng.int(0, 10_000); // two decimals of precision
  const success = roll < Math.round(chance * 100);

  const payout = success ? rng.bigint(crime.minPayout, crime.maxPayout) : 0n;
  const bullets = success ? BigInt(rng.int(crime.minBullets, crime.maxBullets + 1)) : 0n;
  const exp = success ? crime.expReward : 0n;

  let alreadyProcessed = false;
  try {
    await db.transaction(async (tx) => {
      // Insert the idempotency marker FIRST, keyed to job.id. A BullMQ retry
      // re-runs this whole handler with the same job.id; the unique index
      // on crime_log.job_id rejects the second insert, the error propagates
      // out of this callback, and drizzle rolls the transaction back before
      // any crediting below ever runs. Doing the insert last would let the
      // retry's payout/exp commit and only the log row collide — the
      // double-pay this exists to prevent.
      await tx.insert(crimeLog).values({
        id: uuidv7(), playerId, crimeId, success, payout, jobId: job.id,
      });
      if (payout > 0n) {
        await applyBalanceChange(tx, {
          playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId,
        });
      }
      if (exp > 0n) await addExp(tx, playerId, exp);
    });
  } catch (err) {
    if (uniqueViolation(err)?.constraint_name === "crime_log_job_id_unique") {
      alreadyProcessed = true; // this job.id already paid out — do not credit again
    } else {
      throw err;
    }
  }

  // SPEC §3: events are facts, not commands — published only AFTER the
  // transaction above commits (or is recognised as already committed).
  // Never publish inside db.transaction(...).
  //
  // Decision 1: publish on the "already processed" path too, not just on a
  // fresh success. The retry that lands here almost always exists BECAUSE
  // the first attempt committed its transaction and then died before (or
  // during) publishEvent — that's the whole reason this job was retried.
  // Staying silent on this path would leave a client waiting forever for an
  // event that already happened. The one cost is a possible duplicate event
  // if the retry was for some unrelated reason after a publish that actually
  // succeeded; a client double-toast is far cheaper than a client that never
  // learns its crime resolved, and downstream consumers can dedupe on
  // `event.id` if this ever matters.
  const event: GameEvent = {
    id: uuidv7(),
    type: "crime.resolved",
    at: new Date().toISOString(),
    actorId: playerId,
    actorName: actor.username,
    audience: { kind: "player", playerId },
    crimeId,
    crimeName: crime.name,
    success,
    payout: payout.toString(),
    bullets: bullets.toString(),
    exp: exp.toString(),
    jailedUntil: null, // jail lands in M2
  };

  // Decision 2: let a publish failure fail the job (no try/catch here). With
  // the idempotency guard above in place, a BullMQ retry after a publish
  // failure is now SAFE — it will detect crime_log_job_id_unique, skip
  // crediting, and simply retry the publish. That turns "publish failed"
  // into "keep retrying delivery, up to `attempts: 3`, without ever
  // double-paying" instead of a silent drop. If all attempts are exhausted
  // the job lands in BullMQ's failed set (removeOnFail keeps it around) —
  // an inspectable trace, not a silently swallowed event.
  await publishEvent(publisher, event);
}

export function startCrimeWorker({ db, connection, publisher, queueName = CRIME_QUEUE }: CrimeWorkerDeps): Worker<CrimeJobData> {
  return new Worker<CrimeJobData>(queueName, async (job) => {
    if (job.id === undefined) throw new Error("crime job has no id — cannot guarantee idempotency");
    await processCrimeJob(db, publisher, { id: job.id, data: job.data });
  }, { connection, concurrency: 5 });
}
