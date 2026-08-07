import { Redis } from "ioredis";

/** For commands: sessions, cooldowns, rate limits, publishing. */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/** Dedicated subscriber — a subscribed client cannot run other commands. */
export function createSubscriber(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
