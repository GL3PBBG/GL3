import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const CRIME_QUEUE = "crime";

export interface CrimeJobData {
  playerId: string;
  crimeId: string;
  /** Generated at enqueue time so retries resolve identically (spec §7). */
  seed: string;
}

/**
 * `queueName` defaults to the production {@link CRIME_QUEUE} name but is
 * overridable so tests can give each isolated server its own private queue
 * — see `test/helpers/server.ts` for why that isolation matters.
 */
export function createCrimeQueue(redis: Redis, queueName: string = CRIME_QUEUE): Queue<CrimeJobData> {
  return new Queue<CrimeJobData>(queueName, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}
