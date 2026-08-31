import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { players } from "../db/schema/index.js";

export const PRESENCE_KEY = "presence";

/** How recent a ZSET score has to be to count as "online now". */
export const PRESENCE_ONLINE_WINDOW_MS = 5 * 60 * 1000;
/** How far back `/api/online` lists at all; older members are trimmed lazily. */
export const PRESENCE_RECENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Called on every authenticated request. The ZADD is unconditional and cheap;
 * the DB stamp is throttled by SET NX EX — the NX *outcome* is the decision
 * (rule 2), so concurrent requests agree without a read.
 */
export async function touchPresence(
  redis: Redis, db: Db, playerId: string, ip: string | null = null, now = new Date(),
): Promise<void> {
  await redis.zadd(PRESENCE_KEY, now.getTime(), playerId);
  const marked = await redis.set(`lastseenmark:${playerId}`, "1", "EX", 60, "NX");
  if (marked === "OK") {
    // last_ip rides the throttled stamp — anti-bot layer 0 costs no write of
    // its own. Null keeps the column: a caller with no request context (jobs,
    // tests) must not blank a real address.
    await db.update(players)
      .set({ lastSeenAt: now, ...(ip !== null ? { lastIp: ip } : {}) })
      .where(eq(players.id, playerId));
  }
}
