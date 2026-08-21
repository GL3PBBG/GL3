import { isPluginError, on, PluginError } from "@gl3/plugin-sdk";
import {
  boundOutcome,
  buildEffectRegistry,
  consumableKind,
  guardEffect,
  HEAL_EFFECT_KIND,
  itemEffects,
  MAX_CASH_PER_USE,
  MAX_EXP_PER_USE,
  MIN_HEALTH_AFTER_USE,
  readConsumableUse,
  type ItemEffectDef,
  type ItemEffectOutcome,
} from "@gl3/plugin-inventory";
import { describe, expect, it } from "vitest";

/**
 * The pure half of the open item effect registry — assembly, bounding and
 * config resolution. None of it touches Postgres, Redis or a route, so it runs
 * in the unit project; `item-effects.test.ts` covers the same ground through a
 * live server.
 *
 * `casino-registry.test.ts` is the model, including the fake ctx below.
 */

/** The registry only needs `filters.apply`; the rest of PluginCtx is unused. */
function ctxWith(subs: ReturnType<typeof on>[]) {
  return { filters: { apply: async (point, value) => {
    let cur = value;
    for (const s of subs.filter((x) => x.pointName === point.name)) cur = await s.run(ctxWith(subs), cur);
    return cur;
  } } };
}

function fakeDef(kind: string, outcome: ItemEffectOutcome = {}): ItemEffectDef {
  return { kind, label: `${kind} label`, apply: () => outcome };
}

const snapshot = { health: 50, maxHealth: 100, exp: 0, cash: "1000" };

describe("buildEffectRegistry", () => {
  it("always carries the built-in heal, with no subscriber involved", async () => {
    const registry = await buildEffectRegistry(ctxWith([]));
    expect(registry.get(HEAL_EFFECT_KIND)?.label).toBe("Heal");
    expect(registry.size).toBe(1);
  });

  it("collects a subscribed def", async () => {
    const subs = [on(itemEffects, (_c, list) => [...list, fakeDef("tonic")])];
    const registry = await buildEffectRegistry(ctxWith(subs));
    expect(registry.get("tonic")?.label).toBe("tonic label");
  });

  it("refuses two defs claiming the same kind", async () => {
    // Refuse rather than first-wins, mirroring casino's `buildRegistry`:
    // first-wins would make which def runs depend on subscriber order.
    const subs = [
      on(itemEffects, (_c, list) => [...list, fakeDef("tonic")]),
      on(itemEffects, (_c, list) => [...list, fakeDef("tonic")]),
    ];
    await expect(buildEffectRegistry(ctxWith(subs))).rejects.toThrow(/duplicate item effect kind/);
  });

  it("refuses a def that would shadow the built-in heal", async () => {
    // The collision that matters: it would silently rewrite the behaviour of
    // every legacy and V2-migrated item at once.
    const subs = [on(itemEffects, (_c, list) => [...list, fakeDef(HEAL_EFFECT_KIND)])];
    await expect(buildEffectRegistry(ctxWith(subs))).rejects.toThrow(/"heal"/);
  });
});

describe("the built-in heal def", () => {
  it("turns a heal figure into a health delta", async () => {
    const registry = await buildEffectRegistry(ctxWith([]));
    const heal = registry.get(HEAL_EFFECT_KIND);
    expect(heal?.apply({ heal: 25 }, snapshot)).toEqual({ healthDelta: 25 });
  });

  it("refuses a config with no usable heal figure, the way the route always has", async () => {
    const registry = await buildEffectRegistry(ctxWith([]));
    const heal = registry.get(HEAL_EFFECT_KIND);
    for (const config of [{}, { heal: 0 }, { heal: -5 }, { heal: 2.5 }, { heal: "20" }]) {
      expect(() => heal?.apply(config, snapshot)).toThrow(
        expect.objectContaining({ code: "wrong_slot" }),
      );
    }
  });
});

describe("guardEffect", () => {
  it("turns a def's own throw into a clean 400 rather than a 500", () => {
    try {
      guardEffect("cursed", () => { throw new Error("the vial was empty"); });
      expect.unreachable("guardEffect should have thrown");
    } catch (error) {
      expect(isPluginError(error)).toBe(true);
      if (!isPluginError(error)) return;
      expect(error.status).toBe(400);
      expect(error.code).toBe("effect_failed");
      expect(error.extra).toMatchObject({ kind: "cursed", detail: "the vial was empty" });
    }
  });

  it("truncates a detail a def could otherwise make arbitrarily long", () => {
    try {
      guardEffect("windbag", () => { throw new Error("x".repeat(5000)); });
      expect.unreachable("guardEffect should have thrown");
    } catch (error) {
      if (!isPluginError(error)) throw error;
      expect((error.extra as { detail: string }).detail).toHaveLength(200);
    }
  });

  it("passes a def's own PluginError through with its status intact", () => {
    // How the built-in heal keeps answering `wrong_slot` 400 rather than
    // being relabelled `effect_failed`.
    const thrown = new PluginError("wrong_slot", 400);
    expect(() => guardEffect("heal", () => { throw thrown; })).toThrow(thrown);
  });
});

describe("boundOutcome", () => {
  it("leaves health exactly alone for a zero delta", () => {
    // Not the same as clamping to maxHealth: a player whose maxHealth just
    // dropped can be ABOVE it, and an unrelated item must not trim them.
    const over = { health: 140, maxHealth: 100, exp: 0, cash: "0" };
    expect(boundOutcome({ expDelta: 5 }, over).health).toBe(140);
    expect(boundOutcome({}, over).healed).toBe(0);
  });

  it("clamps a heal at maxHealth and a hit at MIN_HEALTH_AFTER_USE", () => {
    expect(boundOutcome({ healthDelta: 9999 }, snapshot)).toMatchObject({ health: 100, healed: 50 });
    expect(boundOutcome({ healthDelta: -9999 }, snapshot)).toMatchObject({
      health: MIN_HEALTH_AFTER_USE, healed: MIN_HEALTH_AFTER_USE - 50,
    });
  });

  it("refuses to let a def take exp, and caps what it can grant", () => {
    expect(boundOutcome({ expDelta: -100 }, snapshot).expDelta).toBe(0n);
    expect(boundOutcome({ expDelta: 1e9 }, snapshot).expDelta).toBe(BigInt(MAX_EXP_PER_USE));
    expect(boundOutcome({ expDelta: 25 }, snapshot).expDelta).toBe(25n);
  });

  it("caps a payout and floors a charge at the player's own cash", () => {
    expect(boundOutcome({ cashDelta: "999999999999" }, snapshot).cashDelta).toBe(MAX_CASH_PER_USE);
    expect(boundOutcome({ cashDelta: "-999999999999" }, snapshot).cashDelta).toBe(-1000n);
    expect(boundOutcome({ cashDelta: "-250" }, snapshot).cashDelta).toBe(-250n);
  });

  it("reads a figure that is not a figure as zero", () => {
    // A def controls these values entirely; NaN, Infinity and a non-decimal
    // string are each a way of being wrong without throwing.
    expect(boundOutcome({ healthDelta: Number.NaN }, snapshot).health).toBe(50);
    expect(boundOutcome({ expDelta: Number.POSITIVE_INFINITY }, snapshot).expDelta).toBe(0n);
    expect(boundOutcome({ cashDelta: "1e6" }, snapshot).cashDelta).toBe(0n);
    expect(boundOutcome({ cashDelta: "12.5" }, snapshot).cashDelta).toBe(0n);
    expect(boundOutcome({ healthDelta: 10.9 }, snapshot).health).toBe(60);
  });

  it("truncates a message and drops an empty one", () => {
    expect(boundOutcome({ message: "x".repeat(500) }, snapshot).message).toHaveLength(200);
    expect(boundOutcome({ message: "" }, snapshot).message).toBeNull();
    expect(boundOutcome({}, snapshot).message).toBeNull();
  });
});

describe("consumableKind", () => {
  it("reads absent, null and empty as the built-in heal", () => {
    // The state of every item in every existing database, migrated or not.
    expect(consumableKind({ heal: 20 })).toBe(HEAL_EFFECT_KIND);
    expect(consumableKind({ kind: null })).toBe(HEAL_EFFECT_KIND);
    expect(consumableKind({ kind: "" })).toBe(HEAL_EFFECT_KIND);
  });

  it("answers null for jsonb it cannot read", () => {
    expect(consumableKind({ kind: 7 })).toBeNull();
    expect(consumableKind("not an object")).toBeNull();
    expect(consumableKind(null)).toBeNull();
    expect(consumableKind([1, 2])).toBeNull();
  });
});

describe("readConsumableUse", () => {
  it("lays effects over meta, effects winning, and drops the kind key", () => {
    const use = readConsumableUse({ kind: "tonic", kick: 15 }, { street: 40, kick: 1 });
    expect(use).toEqual({ kind: "tonic", config: { street: 40, kick: 15 } });
  });

  it("tolerates meta that is not an object", () => {
    // `items.meta` defaults to `{}` in core, but it is jsonb and an operator
    // with psql can put anything there.
    expect(readConsumableUse({ heal: 20 }, null)?.config).toEqual({ heal: 20 });
    expect(readConsumableUse({ heal: 20 }, "junk")?.config).toEqual({ heal: 20 });
  });
});
