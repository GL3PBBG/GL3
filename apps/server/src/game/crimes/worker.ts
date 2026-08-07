import { Worker } from "bullmq";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import type { GameEvent } from "@gl3/shared";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { crimeLog, crimes, playerCrimeSkill, players } from "../../db/schema/index.js";
import { addExp, applyBalanceChange } from "../../economy/ledger.js";
import { CRIME_QUEUE, type CrimeJobData } from "../../queue/index.js";
import { createRng } from "../rng.js";
import { DEFAULT_CRIME_CHANCE } from "./routes.js";

export interface CrimeWorkerDeps { db: Db; connection: Redis; publisher: Redis }

export function startCrimeWorker({ db, connection, publisher }: CrimeWorkerDeps): Worker<CrimeJobData> {
  return new Worker<CrimeJobData>(CRIME_QUEUE, async (job) => {
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
    const rng = createRng(seed);
    const roll = rng.int(0, 10_000); // two decimals of precision
    const success = roll < Math.round(chance * 100);

    const payout = success ? rng.bigint(crime.minPayout, crime.maxPayout) : 0n;
    const bullets = success ? BigInt(rng.int(crime.minBullets, crime.maxBullets + 1)) : 0n;
    const exp = success ? crime.expReward : 0n;

    await db.transaction(async (tx) => {
      if (payout > 0n) {
        await applyBalanceChange(tx, {
          playerId, amount: payout, kind: "cash", reason: "crime.payout", refId: crimeId,
        });
      }
      if (exp > 0n) await addExp(tx, playerId, exp);
      await tx.insert(crimeLog).values({
        id: uuidv7(), playerId, crimeId, success, payout,
      });
    });

    // SPEC §3: events are facts, not commands — published only AFTER the
    // transaction above commits. Never publish inside db.transaction(...).
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
    await publishEvent(publisher, event);
  }, { connection, concurrency: 5 });
}
