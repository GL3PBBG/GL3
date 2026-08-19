import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { players } from "../db/schema/index.js";

export const PRESENCE_KEY = "presence";

/**
 * Called on every authenticated request. The ZADD is unconditional and cheap;
 * the DB stamp is throttled by SET NX EX — the NX *outcome* is the decision
 * (rule 2), so concurrent requests agree without a read.
 */
export async function touchPresence(redis: Redis, db: Db, playerId: string, now = new Date()): Promise<void> {
  await redis.zadd(PRESENCE_KEY, now.getTime(), playerId);
  const marked = await redis.set(`lastseenmark:${playerId}`, "1", "EX", 60, "NX");
  if (marked === "OK") {
    await db.update(players).set({ lastSeenAt: now }).where(eq(players.id, playerId));
  }
}
