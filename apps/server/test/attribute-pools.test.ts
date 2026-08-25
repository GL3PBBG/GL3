import { describe, expect, it } from "vitest";
import { definePlugin } from "@gl3/plugin-sdk";
import { collectAttributePools } from "../src/plugins/attribute-pools.js";
import { attributesTestPlugin } from "./helpers/attributes-plugin.js";

describe("collectAttributePools", () => {
  it("keys every declaration by its pool", () => {
    const registry = collectAttributePools([attributesTestPlugin]);
    expect(registry.get("energy")?.defaultMax).toBe(10);
    expect(registry.get("will")).toBeUndefined();
  });

  it("is empty when no plugin declares anything", () => {
    const bare = definePlugin({ id: "bare-attr", version: "1.0.0", basePaths: ["/api/bare-attr"] });
    expect(collectAttributePools([bare]).size).toBe(0);
  });

  it("rejects two plugins declaring the same pool", () => {
    const rival = definePlugin({
      id: "rival-attr",
      version: "1.0.0",
      basePaths: ["/api/rival-attr"],
      providesAttributes: [
        { pool: "energy", defaultMax: 999, regenAmount: 1, regenIntervalSeconds: 1 },
      ],
    });
    expect(() => collectAttributePools([attributesTestPlugin, rival]))
      .toThrow(/pool "energy" is declared by more than one plugin/);
  });
});
