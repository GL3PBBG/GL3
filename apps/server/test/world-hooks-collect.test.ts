import { definePlugin } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { collectWorldHooks } from "../src/plugins/world-hooks.js";
import { validatePlugins } from "../src/plugins/validate.js";

const page = (id: string, path: string) => ({ id, path, view: { kind: "list" as const, items: [] } });

const travel = definePlugin({
  id: "travel", version: "1.0.0", basePaths: ["/api/travel"],
  pages: [page("travel.index", "/travel")],
  providesAssets: [{ slot: "sign", label: "Sign", singleton: true }, { slot: "poster", label: "Poster" }],
  worldHooks: [
    { id: "station", kind: "building", label: "Station", page: "travel.index", model: "station", order: 10, signageSlot: "sign" },
  ],
});
const crimes = definePlugin({
  id: "crimes", version: "1.0.0", basePaths: ["/api/crimes"],
  pages: [page("crimes.index", "/crimes")],
  worldHooks: [
    { id: "corner", kind: "npc", label: "Corner", page: "crimes.index", model: "npc-coat", order: 10 },
    { id: "alley", kind: "npc", label: "Alley", page: "crimes.index", model: "npc-coat", order: 5 },
  ],
});

describe("collectWorldHooks", () => {
  it("flattens, stamps pluginId and sorts by (order, pluginId, id)", () => {
    const hooks = collectWorldHooks([travel, crimes]);
    expect(hooks.map((h) => `${h.pluginId}.${h.id}`)).toEqual(["crimes.alley", "crimes.corner", "travel.station"]);
    expect(hooks[2]).toMatchObject({ pluginId: "travel", id: "station", signageSlot: "sign" });
  });
  it("is empty with no declarations", () => {
    expect(collectWorldHooks([definePlugin({ id: "bank", version: "1.0.0", basePaths: ["/api/bank"] })])).toEqual([]);
  });
});

describe("validatePlugins world hooks", () => {
  it("accepts the fixture set", () => {
    expect(() => validatePlugins([travel, crimes])).not.toThrow();
  });
  it("rejects a duplicate hook id within one plugin", () => {
    const dup = definePlugin({
      ...crimes, worldHooks: [crimes.worldHooks[0]!, crimes.worldHooks[0]!],
    });
    expect(() => validatePlugins([dup])).toThrow(/world hook "corner" is declared more than once/);
  });
  it("rejects a page that is not one of the plugin's own player pages", () => {
    const foreign = definePlugin({
      id: "bank", version: "1.0.0", basePaths: ["/api/bank"],
      worldHooks: [{ id: "bank", kind: "building", label: "Bank", page: "travel.index", model: "bank", order: 1 }],
    });
    expect(() => validatePlugins([travel, foreign])).toThrow(/world hook "bank" opens page "travel.index", which is not one of its own player pages/);
    const admin = definePlugin({
      id: "bank", version: "1.0.0", basePaths: ["/api/bank", "/api/admin/bank"],
      adminPages: [page("bank-admin", "/admin/bank")],
      worldHooks: [{ id: "bank", kind: "building", label: "Bank", page: "bank-admin", model: "bank", order: 1 }],
    });
    expect(() => validatePlugins([admin])).toThrow(/not one of its own player pages/);
  });
  it("rejects a signage slot that is missing or not a singleton", () => {
    const missing = definePlugin({ ...travel, worldHooks: [{ ...travel.worldHooks[0]!, signageSlot: "nope" }] });
    expect(() => validatePlugins([missing])).toThrow(/signageSlot "nope", which is not one of its own singleton asset slots/);
    const perRow = definePlugin({ ...travel, worldHooks: [{ ...travel.worldHooks[0]!, signageSlot: "poster" }] });
    expect(() => validatePlugins([perRow])).toThrow(/signageSlot "poster", which is not one of its own singleton asset slots/);
  });
});
