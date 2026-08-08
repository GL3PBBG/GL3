import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/index.js";

const valid = { id: "bounties", version: "1.0.0", basePaths: ["/api/bounties"] };

describe("definePlugin", () => {
  it("defaults every collection field so consumers never handle undefined", () => {
    const manifest = definePlugin(valid);
    expect(manifest.routes).toEqual([]);
    expect(manifest.migrations).toEqual([]);
    expect(manifest.pages).toEqual([]);
    expect(manifest.events).toEqual([]);
    expect(manifest.filters).toEqual([]);
    expect(manifest.provides).toEqual([]);
    expect(manifest.tables).toEqual({});
    expect(manifest.jobs).toEqual({});
  });

  it("rejects an id that is not lowercase kebab-case", () => {
    expect(() => definePlugin({ ...valid, id: "Bounties" })).toThrow(/plugin id/);
  });

  it("rejects a version that is not semver", () => {
    expect(() => definePlugin({ ...valid, version: "1.0" })).toThrow(/semver/);
  });

  it("rejects a basePath outside /api", () => {
    expect(() => definePlugin({ ...valid, basePaths: ["/bounties"] })).toThrow(/basePath/);
  });

  it("rejects an empty basePaths list", () => {
    expect(() => definePlugin({ ...valid, basePaths: [] })).toThrow();
  });

  it("names the plugin in the error message", () => {
    expect(() => definePlugin({ ...valid, version: "x" })).toThrow(/bounties/);
  });

  // The schema is `.strict()` because the M5 boot sequence requires a manifest to
  // reject unknown fields rather than silently ignore them: the typo'd key below
  // would otherwise leave the plugin quietly registering no routes at all.
  // Naming the offending key in the assertion is what stops `.strict()` being
  // dropped in a refactor without the suite noticing.
  //
  // Bound to a variable first, not passed as a fresh literal: excess-property
  // checking would reject the literal at compile time, and the point here is the
  // runtime guard against manifests TypeScript never saw.
  it("rejects an unknown top-level field, naming the offending key", () => {
    const typoed = { ...valid, rotues: [] };
    expect(() => definePlugin(typoed)).toThrow(/'rotues'/);
  });
});
