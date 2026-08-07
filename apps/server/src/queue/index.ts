import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const CRIME_QUEUE = "crime";

export interface CrimeJobData {
  playerId: string;
  crimeId: string;
  /** Generated at enqueue time so retries resolve identically (spec §7). */
  seed: string;
}

export function createCrimeQueue(redis: Redis): Queue<CrimeJobData> {
  return new Queue<CrimeJobData>(CRIME_QUEUE, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}
