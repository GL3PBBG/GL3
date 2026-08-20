import { describe, expect, it } from "vitest";
import {
  DashboardWidgetSchema,
  DashboardWidgetsResponseSchema,
  HudEntrySchema,
  HudExtrasResponseSchema,
  ItemActionSchema,
  MenuBadgeSchema,
  MenuBadgesResponseSchema,
  ProfileExtraSchema,
  ProfileViewValueSchema,
} from "../src/dto/extensions.js";
// MoneyFormatSchema/DEFAULT_MONEY_FORMAT moved to primitives.ts — see the
// comment on MoneyFormatSchema there — so they're no longer exports of
// dto/extensions.js itself, even though @gl3/shared's barrel still re-exports
// both from the package root.
import { DEFAULT_MONEY_FORMAT, MoneyFormatSchema } from "../src/primitives.js";

describe("ProfileExtraSchema", () => {
  it("accepts a valid stat extra", () => {
    const value = { kind: "stat", pluginId: "membership", label: "Status", value: "Gold" };
    expect(ProfileExtraSchema.parse(value)).toEqual(value);
  });

  it("accepts a valid link extra", () => {
    const value = { kind: "link", pluginId: "detectives", label: "Reports", to: "/detectives" };
    expect(ProfileExtraSchema.parse(value)).toEqual(value);
  });

  it("rejects an extra with an unknown kind", () => {
    expect(() =>
      ProfileExtraSchema.parse({ kind: "banner", pluginId: "x", label: "L", value: "V" }),
    ).toThrow();
  });

  it("rejects a stat extra carrying an extra property", () => {
    expect(() =>
      ProfileExtraSchema.parse({
        kind: "stat", pluginId: "x", label: "L", value: "V", extra: "nope",
      }),
    ).toThrow();
  });
});

describe("DashboardWidgetSchema", () => {
  it("accepts a valid widget", () => {
    const value = {
      pluginId: "crimes",
      title: "Crime spree",
      view: { kind: "text", value: "3 crimes left" },
    };
    expect(DashboardWidgetSchema.parse(value)).toEqual(value);
  });
});

describe("HudEntrySchema", () => {
  it("accepts a valid entry without a countdown", () => {
    const value = { pluginId: "membership", label: "Membership", value: "Gold" };
    expect(HudEntrySchema.parse(value)).toEqual(value);
  });

  it("accepts a valid entry with a countdown", () => {
    const value = {
      pluginId: "membership", label: "Membership", value: "Gold",
      countdownTo: "2026-08-20T00:00:00.000Z",
    };
    expect(HudEntrySchema.parse(value)).toEqual(value);
  });
});

describe("MenuBadgeSchema", () => {
  it("accepts a valid badge", () => {
    const value = { path: "/mail", count: 3 };
    expect(MenuBadgeSchema.parse(value)).toEqual(value);
  });

  it("rejects a path not starting with /", () => {
    expect(() => MenuBadgeSchema.parse({ path: "mail", count: 3 })).toThrow();
  });

  it("rejects a negative count", () => {
    expect(() => MenuBadgeSchema.parse({ path: "/mail", count: -1 })).toThrow();
  });
});

describe("MoneyFormatSchema", () => {
  it("parses DEFAULT_MONEY_FORMAT", () => {
    expect(MoneyFormatSchema.parse(DEFAULT_MONEY_FORMAT)).toEqual(DEFAULT_MONEY_FORMAT);
  });

  it("rejects a position outside prefix/suffix", () => {
    expect(() =>
      MoneyFormatSchema.parse({ symbol: "$", position: "middle", thousandsSep: "," }),
    ).toThrow();
  });
});

describe("ItemActionSchema", () => {
  it("accepts a valid item action", () => {
    const value = { pluginId: "combat", label: "Repair", to: "/combat/gunsmith" };
    expect(ItemActionSchema.parse(value)).toEqual(value);
  });
});

describe("ProfileViewValueSchema", () => {
  it("accepts a target id with extras", () => {
    const value = {
      targetId: "0192f1c0-0000-7000-8000-000000000000",
      extras: [{ kind: "stat", pluginId: "x", label: "L", value: "V" }],
    };
    expect(ProfileViewValueSchema.parse(value)).toEqual(value);
  });
});

describe("response envelopes", () => {
  it("parses HudExtrasResponseSchema", () => {
    const value = { entries: [{ pluginId: "x", label: "L", value: "V" }] };
    expect(HudExtrasResponseSchema.parse(value)).toEqual(value);
  });

  it("parses MenuBadgesResponseSchema", () => {
    const value = { badges: [{ path: "/mail", count: 1 }] };
    expect(MenuBadgesResponseSchema.parse(value)).toEqual(value);
  });

  it("parses DashboardWidgetsResponseSchema", () => {
    const value = {
      widgets: [{ pluginId: "x", title: "T", view: { kind: "text", value: "V" } }],
    };
    expect(DashboardWidgetsResponseSchema.parse(value)).toEqual(value);
  });
});
