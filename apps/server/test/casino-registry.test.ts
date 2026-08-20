import { describe, expect, it } from "vitest";
import { z } from "zod";
import { on } from "@gl3/plugin-sdk";
import {
  buildRegistry,
  buildTableRegistry,
  games,
  tableGames,
  type GameDef,
  type TableGameDef,
} from "@gl3/plugin-casino";

function fakeGame(id: string): GameDef<{ n: number }> {
  return {
    id, name: id, maxPayoutMultiplier: 2,
    action: z.literal("go"),
    start: () => ({ state: { n: 0 }, view: { kind: "text", value: "" }, done: false }),
    act: (state) => ({ state, view: { kind: "text", value: "" }, done: true }),
    settle: () => 0n,
  };
}

function fakeTableGame(id: string): TableGameDef<unknown> {
  return {
    id,
    name: id,
    maxPayoutMultiplier: 2.5,
    action: z.unknown(),
    deal: () => ({ state: {}, done: false, turn: 0 }),
    act: () => ({ state: {}, done: true, turn: null }),
    autoAct: () => ({ state: {}, done: true, turn: null }),
    view: () => ({ kind: "text", value: "stub" }),
    settle: () => [],
  };
}

/** The registry only needs `filters.apply`; the rest of PluginCtx is unused. */
function ctxWith(subs: ReturnType<typeof on>[]) {
  return { filters: { apply: async (point, value) => {
    let cur = value;
    for (const s of subs.filter((x) => x.pointName === point.name)) cur = await s.run(ctxWith(subs), cur);
    return cur;
  } } };
}

describe("casino game registry", () => {
  it("collects a subscribed game", async () => {
    const subs = [on(games, (_c, list) => [...list, fakeGame("blackjack")])];
    const registry = await buildRegistry(ctxWith(subs), new Set(["blackjack"]));
    expect(registry.get("blackjack")?.name).toBe("blackjack");
  });

  it("rejects a game whose id is not an installed plugin id", async () => {
    // The SDK checks this for providesProperties at definePlugin time. A
    // GameDef arrives inside a filter subscription, so the hub is the only
    // place it can be checked (spec §3).
    const subs = [on(games, (_c, list) => [...list, fakeGame("nonesuch")])];
    await expect(buildRegistry(ctxWith(subs), new Set(["blackjack"]))).rejects.toThrow(/nonesuch/);
  });

  it("rejects two games claiming one id", async () => {
    const subs = [
      on(games, (_c, list) => [...list, fakeGame("blackjack")]),
      on(games, (_c, list) => [...list, fakeGame("blackjack")]),
    ];
    await expect(buildRegistry(ctxWith(subs), new Set(["blackjack"]))).rejects.toThrow(/duplicate/i);
  });
});

describe("casino table game registry", () => {
  it("collects a subscribed table game", async () => {
    const subs = [on(tableGames, (_c, list) => [...list, fakeTableGame("blackjack")])];
    const registry = await buildTableRegistry(ctxWith(subs), new Set(["blackjack"]));
    expect(registry.get("blackjack")?.name).toBe("blackjack");
  });

  it("rejects a table game whose id is not an installed plugin id", async () => {
    const subs = [on(tableGames, (_c, list) => [...list, fakeTableGame("nonesuch")])];
    await expect(buildTableRegistry(ctxWith(subs), new Set(["blackjack"]))).rejects.toThrow(/nonesuch/);
  });

  it("rejects two table games claiming one id", async () => {
    const subs = [
      on(tableGames, (_c, list) => [...list, fakeTableGame("blackjack")]),
      on(tableGames, (_c, list) => [...list, fakeTableGame("blackjack")]),
    ];
    await expect(buildTableRegistry(ctxWith(subs), new Set(["blackjack"]))).rejects.toThrow(/duplicate/i);
  });
});
