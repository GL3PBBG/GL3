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

  // The manifest must be built from the schema's output rather than the raw
  // input, so that any `.default()`, `.transform()` or coercion a later task
  // adds to a field schema actually reaches consumers instead of being parsed
  // and thrown away. No such transform exists yet, so the observable proxy is
  // zod returning fresh containers: a manifest built from `input` aliases the
  // caller's arrays, one built from the parse result does not.
  it("returns the parsed output, not the caller's own collections", () => {
    const src = { ...valid, migrations: [{ name: "0001_init", sql: "select 1" }] };
    const manifest = definePlugin(src);

    src.migrations.push({ name: "0002_late", sql: "select 2" });

    expect(manifest.migrations).toHaveLength(1);
    expect(manifest.basePaths).not.toBe(src.basePaths);
  });

  // A manifest can arrive from outside the type system entirely — a plugin
  // loaded from JS, or parsed from JSON — which is the same caller the strict
  // check above exists for. Reading `.id` off it to build the error message is
  // only safe behind a guard; without one these throw a TypeError and the
  // author never learns which manifest was malformed.
  //
  // These calls deliberately pass values `definePlugin`'s signature forbids:
  // that is the point of the guard, and it cannot be reached any other way.
  it("reports a non-object input as an invalid manifest rather than a TypeError", () => {
    for (const notAManifest of [null, undefined, 42, "bounties", []]) {
      expect(() => definePlugin(notAManifest)).toThrow(/invalid plugin manifest/);
    }
  });

  it("still reports an invalid manifest when id is present but not a string", () => {
    expect(() => definePlugin({ ...valid, id: 7 })).toThrow(/invalid plugin manifest/);
  });
});
