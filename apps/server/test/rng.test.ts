import { describe, expect, it } from "vitest";
import { createRng, newSeed } from "../src/game/rng.js";

describe("seeded rng", () => {
  it("produces 32 hex chars per seed and never repeats", () => {
    const a = newSeed();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newSeed());
  });

  it("is deterministic for a given seed — a retried job re-rolls identically", () => {
    const seed = "0123456789abcdef0123456789abcdef";
    const first = Array.from({ length: 10 }, () => createRng(seed).int(0, 100));
    const second = Array.from({ length: 10 }, () => createRng(seed).int(0, 100));
    expect(first).toEqual(second);
  });

  it("advances within a single rng instance", () => {
    const rng = createRng("0123456789abcdef0123456789abcdef");
    const draws = Array.from({ length: 20 }, () => rng.int(0, 1_000_000));
    expect(new Set(draws).size).toBeGreaterThan(1);
  });

  it("respects bounds, min inclusive and max exclusive", () => {
    const rng = createRng(newSeed());
    for (let i = 0; i < 500; i += 1) {
      const n = rng.int(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThan(10);
    }
  });

  it("draws bigints inclusively for money payouts", () => {
    const rng = createRng(newSeed());
    for (let i = 0; i < 200; i += 1) {
      const n = rng.bigint(100n, 200n);
      expect(n).toBeGreaterThanOrEqual(100n);
      expect(n).toBeLessThanOrEqual(200n);
    }
  });

  it("returns the bound when min equals max", () => {
    expect(createRng(newSeed()).bigint(7n, 7n)).toBe(7n);
  });
});
