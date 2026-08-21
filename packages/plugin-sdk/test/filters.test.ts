import { describe, expect, it } from "vitest";
import { filterPoint, on, runFilterChain } from "../src/index.js";
import type { PluginCtx } from "../src/index.js";

interface Crime { name: string; cooldownSeconds: number }
const beforeResolve = filterPoint<Crime>("crimes.beforeResolve", "propagate");
const other = filterPoint<Crime>("crimes.afterResolve", "propagate");

// The chain never reads ctx in these tests; the cast documents that rather
// than building a fake server (no mocks for DB/queue/bus paths — this is
// neither, it is an unused argument).
const ctx = {} as unknown as PluginCtx;
const ctxFor = () => ctx;

describe("runFilterChain", () => {
  it("returns the input unchanged when nothing subscribes", async () => {
    const crime: Crime = { name: "Pickpocket", cooldownSeconds: 30 };
    expect(await runFilterChain([], beforeResolve, ctxFor, crime)).toEqual(crime);
  });

  it("feeds each subscriber the previous one's return value", async () => {
    const bound = [
      { ownerId: "a", subscription: on(beforeResolve, (_c, crime) => ({ ...crime, cooldownSeconds: crime.cooldownSeconds * 2 })) },
      { ownerId: "b", subscription: on(beforeResolve, (_c, crime) => ({ ...crime, cooldownSeconds: crime.cooldownSeconds + 1 })) },
    ];
    const out = await runFilterChain(bound, beforeResolve, ctxFor, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(61);
  });

  it("runs subscribers in declared sort order, not registration order", async () => {
    const seen: number[] = [];
    const bound = [
      { ownerId: "a", subscription: on(beforeResolve, (_c, crime) => { seen.push(2); return crime; }, 20) },
      { ownerId: "b", subscription: on(beforeResolve, (_c, crime) => { seen.push(1); return crime; }, 10) },
    ];
    await runFilterChain(bound, beforeResolve, ctxFor, { name: "P", cooldownSeconds: 1 });
    expect(seen).toEqual([1, 2]);
  });

  it("ignores subscribers registered against a different point", async () => {
    const bound = [{ ownerId: "a", subscription: on(other, (_c, crime) => ({ ...crime, cooldownSeconds: 999 })) }];
    const out = await runFilterChain(bound, beforeResolve, ctxFor, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(30);
  });

  it("awaits async subscribers", async () => {
    // Two subscribers, the second reading what the first wrote. One is not
    // enough: `runFilterChain` is itself async, so a missing `await` in its loop
    // leaves `current` a Promise that the outer promise unwraps on return, and a
    // single-subscriber assertion still sees 7. Chaining puts the Promise where
    // the next subscriber reads `.cooldownSeconds` off it, yielding NaN.
    const bound = [
      { ownerId: "a", subscription: on(beforeResolve, async (_c, crime) => ({ ...crime, cooldownSeconds: 7 })) },
      { ownerId: "b", subscription: on(beforeResolve, async (_c, crime) => ({ ...crime, cooldownSeconds: crime.cooldownSeconds * 3 })) },
    ];
    const out = await runFilterChain(bound, beforeResolve, ctxFor, { name: "P", cooldownSeconds: 30 });
    expect(out.cooldownSeconds).toBe(21);
  });

  it("rejects two points sharing a name", () => {
    expect(() => filterPoint<Crime>("crimes.beforeResolve", "propagate")).toThrow(/already declared/);
  });

  it("hands each subscriber its own plugin's ctx, not the applier's", async () => {
    const point = filterPoint<string[]>("t1.ownerCtx", "propagate");
    const seen: string[] = [];
    const sub = on(point, async (ctx, value) => { seen.push(ctx.pluginId); return value; });
    const ctxFor = (ownerId: string) => ({ pluginId: ownerId } as unknown as PluginCtx);
    await runFilterChain([{ ownerId: "bounties", subscription: sub }], point, ctxFor, []);
    expect(seen).toEqual(["bounties"]);
  });

  it("collect policy drops a throwing subscriber and continues the chain", async () => {
    const point = filterPoint<number[]>("t1.collect", "collect");
    const bad = on(point, async () => { throw new Error("boom"); });
    const good = on(point, async (_ctx, value) => [...value, 1]);
    const ctxFor = (ownerId: string) =>
      ({ pluginId: ownerId, log: { error: () => {} } } as unknown as PluginCtx);
    const result = await runFilterChain(
      [{ ownerId: "a", subscription: bad }, { ownerId: "b", subscription: good }],
      point, ctxFor, [],
    );
    expect(result).toEqual([1]);
  });

  it("propagate policy rethrows a subscriber's error", async () => {
    const point = filterPoint<number>("t1.propagate", "propagate");
    const bad = on(point, async () => { throw new Error("boom"); });
    const ctxFor = () => ({ pluginId: "a", log: { error: () => {} } } as unknown as PluginCtx);
    await expect(runFilterChain([{ ownerId: "a", subscription: bad }], point, ctxFor, 0))
      .rejects.toThrow("boom");
  });
});
