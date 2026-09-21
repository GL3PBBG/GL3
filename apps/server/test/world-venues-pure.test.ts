import type { WorldHook } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { eligibleHooks, venueKeys } from "../src/world/venues.js";

const h = (pluginId: string, id: string, venue?: string): WorldHook => ({
  pluginId,
  id,
  kind: "building",
  label: id,
  page: `${pluginId}.index`,
  model: id,
  order: 1,
  ...(venue ? { venue } : {}),
});

describe("venue eligibility (spec 2026-09-21 town-venues §3.1)", () => {
  const hooks = [h("travel", "station"), h("casino", "casino", "blackjack"), h("brothel", "brothel", "brothel"), h("bank", "bank")];

  it("collects distinct venue keys", () => {
    expect(venueKeys([...hooks, h("x", "y", "blackjack")])).toEqual(["blackjack", "brothel"]);
    expect(venueKeys([h("travel", "station"), h("bank", "bank")])).toEqual([]);
  });

  it("keeps venue-less hooks and only present venues, in order", () => {
    expect(eligibleHooks(hooks, new Set(["blackjack"])).map((x) => x.id)).toEqual(["station", "casino", "bank"]);
    expect(eligibleHooks(hooks, new Set()).map((x) => x.id)).toEqual(["station", "bank"]);
    expect(eligibleHooks(hooks, new Set(["blackjack", "brothel"])).map((x) => x.id)).toEqual(["station", "casino", "brothel", "bank"]);
    // A present venue nothing declares changes nothing — eligibility is a
    // filter over the hooks, never a source of them.
    expect(eligibleHooks(hooks, new Set(["shooting-range"])).map((x) => x.id)).toEqual(["station", "bank"]);
  });
});
