import { uuidv7 } from "uuidv7";
import type { Db } from "./client.js";
import { crimes } from "./schema/index.js";

export async function seedCrimes(db: Db): Promise<void> {
  const existing = await db.select({ id: crimes.id }).from(crimes).limit(1);
  if (existing.length > 0) return;

  await db.insert(crimes).values([
    { id: uuidv7(), name: "Pickpocket", description: "Lift a wallet in a crowd.", cooldownSeconds: 30, minPayout: 50n, maxPayout: 250n, minBullets: 0, maxBullets: 0, expReward: 5n, minRank: 0, sort: 10 },
    { id: uuidv7(), name: "Rob a Store", description: "Hold up the corner shop.", cooldownSeconds: 60, minPayout: 200n, maxPayout: 900n, minBullets: 0, maxBullets: 2, expReward: 12n, minRank: 0, sort: 20 },
    { id: uuidv7(), name: "Armoured Van", description: "Take the van on the freeway.", cooldownSeconds: 300, minPayout: 2000n, maxPayout: 9000n, minBullets: 1, maxBullets: 5, expReward: 40n, minRank: 0, sort: 30 },
  ]);
}
