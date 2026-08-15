import { describe, expect, it } from "vitest";
import { readPropertiesSettings } from "@gl3/plugin-properties";

const from = (rows: Record<string, string>) => (key: string): string | null => rows[key] ?? null;

describe("readPropertiesSettings", () => {
  it("defaults every key on an empty settings table", () => {
    const s = readPropertiesSettings(from({}));
    expect(s.income.cap).toBe(1_000_000n);
    expect(s.income.defaultRate).toBe(500n);
    expect(s.admin.canEditRate).toBe(true);
  });

  it("reads BARE keys, not plugin-prefixed ones", () => {
    // The SDK namespaces: ctx.settings.get looks up `properties.<key>`. A parser
    // that asked for "properties.income.cap" would resolve
    // "properties.properties.income.cap" — never present, so every setting would
    // silently fall back with no error anywhere.
    expect(readPropertiesSettings(from({ "income.cap": "2000" })).income.cap).toBe(2000n);
    expect(readPropertiesSettings(from({ "properties.income.cap": "2000" })).income.cap).toBe(1_000_000n);
  });

  it("treats a blank value as absent rather than as zero", () => {
    // Number("") === 0 and BigInt("") === 0n, both of which pass a >= 0
    // guard. Without the blank check a cleared admin field would mean
    // "rate is zero" instead of "use the default".
    expect(readPropertiesSettings(from({ "income.cap": "   " })).income.cap).toBe(1_000_000n);
    expect(readPropertiesSettings(from({ "income.default_rate": "" })).income.defaultRate).toBe(500n);
  });

  it("falls back rather than throwing on a malformed value", () => {
    expect(readPropertiesSettings(from({ "income.cap": "not a number" })).income.cap).toBe(1_000_000n);
  });

  it("falls back on a negative value", () => {
    expect(readPropertiesSettings(from({ "income.default_rate": "-100" })).income.defaultRate).toBe(500n);
  });

  it("reads can_edit_rate false", () => {
    expect(readPropertiesSettings(from({ "admin.can_edit_rate": "false" })).admin.canEditRate).toBe(false);
  });

  it("falls back can_edit_rate on garbage", () => {
    expect(readPropertiesSettings(from({ "admin.can_edit_rate": "yes" })).admin.canEditRate).toBe(true);
  });
});
