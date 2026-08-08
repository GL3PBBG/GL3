import { describe, expect, it } from "vitest";
import { filterPoint, on, runFilterChain } from "../src/index.js";
import type { PluginCtx } from "../src/index.js";

interface Crime { name: string; cooldownSeconds: number }
const beforeResolve = filterPoint<Crime>("crimes.beforeResolve");
const other = filterPoint<Crime>("crimes.afterResolve");

// The chain never reads ctx in these tests; the cast documents that rather
// than building a fake server (no mocks for DB/queue/bus paths — this is
// neither, it is an unused argument).
const ctx = {} as unknown as PluginCtx;

describe("runFilterChain", () => {
  it("returns the input unchanged when nothing subscribes", async () => {
    const crime: Crime = { name: "Pickpocket", cooldownSeconds: 30 };
    expect(await runFilterChain([], beforeResolve, ctx, crime)).toEqual(crime);
  });

  it("feeds each subscriber the previous one's return value", async () => {
    const subs = [
      on(beforeResolve, (_c, crime) => ({ ...crime, cooldownSeconds: crime.cooldownSeconds * 2 })),
      on(beforeResolve, (_c, crime) => ({ ...crime, cooldownSeconds: crime.cooldownSeconds + 1 })),
    ];
    const out = await runFilterChain(subs, beforeResolve, ctx, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(61);
  });

  it("runs subscribers in declared sort order, not registration order", async () => {
    const seen: number[] = [];
    const subs = [
      on(beforeResolve, (_c, crime) => { seen.push(2); return crime; }, 20),
      on(beforeResolve, (_c, crime) => { seen.push(1); return crime; }, 10),
    ];
    await runFilterChain(subs, beforeResolve, ctx, { name: "P", cooldownSeconds: 1 });
    expect(seen).toEqual([1, 2]);
  });

  it("ignores subscribers registered against a different point", async () => {
    const subs = [on(other, (_c, crime) => ({ ...crime, cooldownSeconds: 999 }))];
    const out = await runFilterChain(subs, beforeResolve, ctx, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(30);
  });

  it("awaits async subscribers", async () => {
    const subs = [on(beforeResolve, async (_c, crime) => ({ ...crime, cooldownSeconds: 7 }))];
    const out = await runFilterChain(subs, beforeResolve, ctx, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(7);
  });

  it("rejects two points sharing a name", () => {
    expect(() => filterPoint<Crime>("crimes.beforeResolve")).toThrow(/already declared/);
  });
});
