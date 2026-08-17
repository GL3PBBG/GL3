import { describe, expect, it } from "vitest";
import { readBulletSettings } from "@gl3/plugin-bullets";

const from = (rows: Record<string, string>) => (key: string): string | null => rows[key] ?? null;

describe("readBulletSettings", () => {
  it("defaults every key on an empty settings table", () => {
    const s = readBulletSettings(from({}));
    expect(s.stockMinPerHour).toBe(2250);
    expect(s.stockMaxPerHour).toBe(2750);
    expect(s.maxStock).toBe(40000);
    expect(s.maxCost).toBeNull();
    expect(s.maxBuy).toBeNull();
  });

  it("reads BARE keys, not plugin-prefixed ones", () => {
    // The SDK namespaces: ctx.settings.get looks up `bullets.<key>`. A parser
    // asking for "bullets.max_stock" would resolve "bullets.bullets.max_stock",
    // never present, and every setting would silently fall back with no error.
    expect(readBulletSettings(from({ max_stock: "500" })).maxStock).toBe(500);
    expect(readBulletSettings(from({ "bullets.max_stock": "500" })).maxStock).toBe(40000);
  });

  it("treats a blank value as absent rather than as zero", () => {
    // Number("") === 0 and BigInt("") === 0n, both of which pass a >= 0 guard.
    // Without the blank check a cleared admin field would mean "no bullets are
    // ever restocked" instead of "use the default".
    expect(readBulletSettings(from({ stock_min_per_hour: "   " })).stockMinPerHour).toBe(2250);
    expect(readBulletSettings(from({ max_stock: "" })).maxStock).toBe(40000);
  });

  it("reads an unset max_cost and max_buy as unlimited, not as zero", () => {
    // V2's loadSetting passes no default for either (adminModule::method_options).
    // Zero would mean "bullets are free" and "no purchase is ever allowed".
    const s = readBulletSettings(from({ max_cost: "", max_buy: "  " }));
    expect(s.maxCost).toBeNull();
    expect(s.maxBuy).toBeNull();
  });

  it("reads a set max_cost as bigint money and max_buy as a count", () => {
    const s = readBulletSettings(from({ max_cost: "25", max_buy: "500" }));
    expect(s.maxCost).toBe(25n);
    expect(s.maxBuy).toBe(500);
  });

  it("keeps a zero max_cost and max_buy, which are limits and not absences", () => {
    // Distinct from the blank case above: an admin who types 0 means it.
    const s = readBulletSettings(from({ max_cost: "0", max_buy: "0" }));
    expect(s.maxCost).toBe(0n);
    expect(s.maxBuy).toBe(0);
  });

  it("raises the hourly max to the min when an admin inverts them", () => {
    // randomInt(min, max + 1) THROWS when min > max, which would 500 every
    // shop view. combat/src/settings.ts:109 records the same trap. The min the
    // admin typed is honoured; the max follows it.
    const s = readBulletSettings(from({ stock_min_per_hour: "5000", stock_max_per_hour: "2750" }));
    expect(s.stockMinPerHour).toBe(5000);
    expect(s.stockMaxPerHour).toBe(5000);
  });

  it("falls back on negative and non-numeric values", () => {
    const s = readBulletSettings(from({
      stock_min_per_hour: "-1",
      stock_max_per_hour: "lots",
      max_stock: "-40000",
      max_cost: "-5",
      max_buy: "abc",
    }));
    expect(s.stockMinPerHour).toBe(2250);
    expect(s.stockMaxPerHour).toBe(2750);
    expect(s.maxStock).toBe(40000);
    expect(s.maxCost).toBeNull();
    expect(s.maxBuy).toBeNull();
  });
});
