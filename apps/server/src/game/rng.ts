import { createHash, randomBytes } from "node:crypto";

/** Generated at enqueue time and carried in the job payload (spec §7). */
export function newSeed(): string {
  return randomBytes(16).toString("hex");
}

export interface Rng {
  /** min inclusive, max exclusive. */
  int(minInclusive: number, maxExclusive: number): number;
  /** Both bounds inclusive — payout ranges in V2 are inclusive. */
  bigint(min: bigint, max: bigint): bigint;
}

export function createRng(seed: string): Rng {
  let counter = 0;
  let buffer = Buffer.alloc(0);
  let offset = 0;

  const refill = (): void => {
    buffer = createHash("sha256").update(`${seed}:${counter}`).digest();
    counter += 1;
    offset = 0;
  };

  const nextUint32 = (): number => {
    if (offset + 4 > buffer.length) refill();
    const value = buffer.readUInt32BE(offset);
    offset += 4;
    return value;
  };

  const int = (minInclusive: number, maxExclusive: number): number => {
    const range = maxExclusive - minInclusive;
    if (range <= 0) return minInclusive;
    // Rejection sampling removes modulo bias.
    const limit = Math.floor(0x1_0000_0000 / range) * range;
    let draw = nextUint32();
    while (draw >= limit) draw = nextUint32();
    return minInclusive + (draw % range);
  };

  const bigintDraw = (min: bigint, max: bigint): bigint => {
    if (max <= min) return min;
    const range = max - min + 1n;
    let bits = 0n;
    let acc = 0n;
    while ((1n << bits) < range) bits += 32n;
    do {
      acc = 0n;
      for (let i = 0n; i < bits; i += 32n) acc = (acc << 32n) | BigInt(nextUint32());
    } while (acc >= (1n << bits) - ((1n << bits) % range));
    return min + (acc % range);
  };

  return { int, bigint: bigintDraw };
}
