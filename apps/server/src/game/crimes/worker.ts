import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import postgres from "postgres";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { crimeLog, crimes, playerCrimeSkill, players, playerStats } from "../../db/schema/index.js";
import { applyBalanceChange } from "../../economy/ledger.js";
import { applyExpAndRankUp, type RankUpResult } from "../../economy/ranks.js";
import { CRIME_QUEUE, type CrimeJobData } from "../../queue/index.js";
import { sendToJail } from "../jail/status.js";
import { recordScore } from "../leaderboard/service.js";
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

  // A second, independent draw from the SAME seeded stream — deterministic
  // per job, so a retry re-derives the identical jail outcome instead of
  // re-rolling a luckier one (spec §7). Only a failed crime carries jail
  // risk (M2 plan Decision 2 — GL3 model addition, not audited from V2).
  const jailRoll = !success && crime.jailChancePercent > 0 ? rng.int(0, 100) : 100;
  const jailed = jailRoll < crime.jailChancePercent;

  let rankUp: RankUpResult | null = null;
  let alreadyProcessed = false;
  try {
    // Returned from the callback (rather than assigned to the outer `rankUp`
    // from inside it) so the result flows back through `db.transaction`'s own
    // return type — TS can't carry a flow-narrowed type for a `let` mutated
    // inside a nested async closure back out to this scope, and reading it
    // that way type-checks as always `null` here.
    rankUp = await db.transaction(async (tx) => {
      // Insert the idempotency marker FIRST, keyed to job.id. A BullMQ retry
      // re-runs this whole handler with the same job.id; the unique index
      // on crime_log.job_id rejects the second insert, the error propagates
      // out of this callback, and drizzle rolls the transaction back before
      // any crediting below ever runs. Doing the insert last would let the
      // retry's payout/exp/jail/rank-reward commit and only the log row
      // collide — the double-pay this exists to prevent. Everything this
      // task adds (jail, exp, rank-up and its cash reward) therefore lives
      // in this same transaction, after this insert.
      await tx.insert(crimeLog).values({
        id: uuidv7(), playerId, crimeId, success, payout, jobId: job.id,
      });
      if (payout > 0n) {
        await applyBalanceChange(tx, {
          playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId,
        });
      }
      let promotion: RankUpResult | null = null;
      if (exp > 0n) promotion = await applyExpAndRankUp(tx, playerId, exp);
      if (jailed) await sendToJail(tx, playerId, crime.jailSeconds);
      return promotion;
    });
  } catch (err) {
    if (uniqueViolation(err)?.constraint_name === "crime_log_job_id_unique") {
      alreadyProcessed = true; // this job.id already paid out — do not re-credit, re-jail, or re-promote
    } else {
      throw err;
    }
  }

  // Re-read jail state after the transaction rather than trust this
  // invocation's local `jailed` flag: on an idempotent replay, the actual
  // jail (if any) was written by the ORIGINAL attempt, not this call, and
  // crime.resolved must still report the player's real state either way.
  const [freshStats] = await db.select({ jailedUntil: playerStats.jailedUntil })
    .from(playerStats).where(eq(playerStats.playerId, playerId));
  const effectiveJailedUntil = freshStats?.jailedUntil ?? null;

  // Leaderboard updates happen here, AFTER the transaction commits (or is
  // recognised as already committed) — same rule as event publishing below.
  // Redis is not transactional with Postgres, so a leaderboard write can
  // never be folded into the db.transaction above without either blocking
  // the crediting on Redis being up, or risking a Redis update for a
  // transaction that then rolls back. Doing it out here means Postgres
  // (the source of truth) is never at risk from a Redis hiccup: on a
  // failure the balance/exp already committed are correct, and the next
  // `rebuildLeaderboards` boot sweep repairs the index. Deliberately not
  // wrapped in try/catch — see the "let a publish failure fail the job"
  // reasoning below; the idempotency guard already makes a BullMQ retry of
  // this whole handler safe (crime_log_job_id_unique short-circuits
  // re-crediting), so retrying is preferable to silently leaving the
  // leaderboard stale until the next boot.
  if (exp > 0n) {
    const [freshExp] = await db.select({ exp: playerStats.exp }).from(playerStats).where(eq(playerStats.playerId, playerId));
    if (freshExp) await recordScore(publisher, "exp", playerId, freshExp.exp);
  }
  if (payout > 0n) {
    const [freshCash] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, playerId));
    if (freshCash) await recordScore(publisher, "cash", playerId, freshCash.cash);
  }

  // SPEC §3: events are facts, not commands — published only AFTER the
  // transaction above commits (or is recognised as already committed).
  // Never publish inside db.transaction(...).
  //
  // Decision 1: publish crime.resolved on the "already processed" path too,
  // not just on a fresh success. The retry that lands here almost always
  // exists BECAUSE the first attempt committed its transaction and then
  // died before (or during) publishEvent — that's the whole reason this job
  // was retried. Staying silent on this path would leave a client waiting
  // forever for an event that already happened. The one cost is a possible
  // duplicate event if the retry was for some unrelated reason after a
  // publish that actually succeeded; a client double-toast is far cheaper
  // than a client that never learns its crime resolved, and downstream
  // consumers can dedupe on `event.id` if this ever matters.
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
    jailedUntil: effectiveJailedUntil ? effectiveJailedUntil.toISOString() : null,
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

  // player.jailed and player.rankedUp are supplementary notifications, not
  // the primary fact (crime.resolved already carries jailedUntil above, and
  // GET /api/ranks already reflects a promotion) — published only on the
  // fresh path, and only AFTER crime.resolved, so a client that reacts to
  // player.jailed can already cross-reference the crime that caused it.
  // Unlike crime.resolved, deliberately NOT republished on an idempotent
  // replay: reconstructing "did THIS attempt newly cross a rank threshold"
  // from a cold read after the fact isn't cheaply knowable, and a client
  // that already holds crime.resolved's jailedUntil has the essential fact
  // regardless (M2 plan Task 6).
  if (!alreadyProcessed && jailed) {
    const jailedEvent: GameEvent = {
      id: uuidv7(), type: "player.jailed", at: new Date().toISOString(),
      actorId: playerId, actorName: actor.username,
      audience: { kind: "player", playerId },
      until: effectiveJailedUntil!.toISOString(), reason: "crime.failed",
    };
    await publishEvent(publisher, jailedEvent);
  }
  if (!alreadyProcessed && rankUp) {
    const rankedUpEvent: GameEvent = {
      id: uuidv7(), type: "player.rankedUp", at: new Date().toISOString(),
      actorId: playerId, actorName: actor.username,
      audience: { kind: "player", playerId },
      rankId: rankUp.rankId, rankName: rankUp.rankName,
      cashReward: rankUp.cashReward.toString(), bulletReward: rankUp.bulletReward.toString(), maxHealth: rankUp.maxHealth,
    };
    await publishEvent(publisher, rankedUpEvent);
  }
}

export function startCrimeWorker({ db, connection, publisher, queueName = CRIME_QUEUE }: CrimeWorkerDeps): Worker<CrimeJobData> {
  return new Worker<CrimeJobData>(queueName, async (job) => {
    if (job.id === undefined) throw new Error("crime job has no id — cannot guarantee idempotency");
    await processCrimeJob(db, publisher, { id: job.id, data: job.data });
  }, { connection, concurrency: 5 });
}
