import { describe, expect, it } from "vitest";
import { readTheftSettings } from "@gl3/plugin-theft";

const from = (rows: Record<string, string>) => (key: string): string | null => rows[key] ?? null;

describe("readTheftSettings", () => {
  it("defaults every key on an empty settings table", () => {
    const s = readTheftSettings(from({}));
    expect(s.cooldownSeconds).toBe(300);
    expect(s.chase.escapeChance).toBe(40);
    expect(s.chase.jailSeconds).toBe(600);
    expect(s.repair.costPerPoint).toBe(500n);
  });

  it("reads BARE keys, not plugin-prefixed ones", () => {
    // The SDK namespaces: ctx.settings.get looks up `theft.<key>`. A parser
    // that asked for "theft.cooldown_seconds" would resolve
    // "theft.theft.cooldown_seconds" — never present, so every setting would
    // silently fall back with no error anywhere.
    expect(readTheftSettings(from({ cooldown_seconds: "45" })).cooldownSeconds).toBe(45);
    expect(readTheftSettings(from({ "theft.cooldown_seconds": "45" })).cooldownSeconds).toBe(300);
  });

  it("floors the cooldown at 1 so Redis SET ... EX 0 can never be issued", () => {
    expect(readTheftSettings(from({ cooldown_seconds: "0" })).cooldownSeconds).toBe(1);
  });

  it("treats a blank value as absent rather than as zero", () => {
    // Number("") === 0 and BigInt("") === 0n, both of which pass a >= 0
    // guard. Without the blank check a cleared admin field would mean
    // "escape is impossible" instead of "use the default".
    expect(readTheftSettings(from({ "chase.escape_chance": "   " })).chase.escapeChance).toBe(40);
    expect(readTheftSettings(from({ "repair.cost_per_point": "" })).repair.costPerPoint).toBe(500n);
  });

  it("clamps the escape chance into 0..100", () => {
    expect(readTheftSettings(from({ "chase.escape_chance": "250" })).chase.escapeChance).toBe(100);
    expect(readTheftSettings(from({ "chase.escape_chance": "-5" })).chase.escapeChance).toBe(40);
  });

  it("falls back rather than throwing on a malformed value", () => {
    expect(readTheftSettings(from({ "repair.cost_per_point": "not a number" })).repair.costPerPoint).toBe(500n);
  });
});
