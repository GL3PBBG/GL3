import { describe, expect, it } from "vitest";
import { definePlugin, parsePluginManifest, PLUGIN_API_VERSION, route } from "../src/index.js";

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

  // A duplicate name is unrecoverable downstream: the runner claims each
  // (plugin_id, name) with onConflictDoNothing(), so the second copy's insert
  // conflicts and its DDL is skipped in silence — a boot that succeeds while
  // leaving a table uncreated.
  //
  // Built by spreading `valid` and replacing only `migrations`: a manifest that
  // is invalid for some *other* reason would satisfy the assertion without the
  // refinement existing at all. And the whole message is anchored with ^…$
  // rather than matched on a fragment, so a later rule whose message merely
  // contains "duplicate" cannot satisfy it either.
  it("rejects two migrations with the same name, naming the plugin and the name", () => {
    const duplicated = {
      ...valid,
      migrations: [
        { name: "0001_init", sql: "CREATE TABLE p_bounties_a (id text)" },
        { name: "0001_init", sql: "CREATE TABLE p_bounties_b (id text)" },
      ],
    };
    expect(() => definePlugin(duplicated)).toThrow(
      /^invalid plugin manifest for "bounties" — migrations\.1: duplicate migration name "0001_init"$/,
    );
  });

  it("accepts distinct migration names", () => {
    const manifest = definePlugin({
      ...valid,
      migrations: [
        { name: "0001_init", sql: "CREATE TABLE p_bounties_a (id text)" },
        { name: "0002_more", sql: "CREATE TABLE p_bounties_b (id text)" },
      ],
    });
    expect(manifest.migrations.map((m) => m.name)).toEqual(["0001_init", "0002_more"]);
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

describe("apiVersion", () => {
  it("defaults an absent apiVersion to the SDK's contract version", () => {
    // Every plugin authored before the field existed lands here — including
    // out-of-repo ones, which is why absence must default rather than fail.
    expect(definePlugin(valid).apiVersion).toBe(PLUGIN_API_VERSION);
  });

  it("accepts an explicit match and carries it through", () => {
    expect(definePlugin({ ...valid, apiVersion: PLUGIN_API_VERSION }).apiVersion).toBe(1);
  });

  // The ORDERING is the feature, and the v2-only field is what proves it: a
  // plugin written against a newer contract typically carries fields this
  // schema has never heard of, and without the pre-parse check `.strict()`
  // would win the race with "Unrecognized key 'category'" — the stale-image
  // crash-loop of 2026-08-24, operationally useless precisely because it
  // names the field instead of the contract. Bound to a variable first so
  // excess-property checking cannot reject the literal at compile time; the
  // point is the runtime guard against manifests TypeScript never saw.
  it("rejects a newer apiVersion with the contract error, not the first unknown field", () => {
    const fromTheFuture = { ...valid, apiVersion: 2, category: "weapons" };
    expect(() => definePlugin(fromTheFuture)).toThrow(
      /^invalid plugin manifest for "bounties" — apiVersion: plugin declares 2 but this build of @gl3\/plugin-sdk implements 1; install a plugin release built for apiVersion 1, or update the server$/,
    );
  });

  // Only a well-formed integer ≥ 1 claims a version; a malformed value is an
  // ordinary schema failure and must keep the schema's own message. These run
  // through `parsePluginManifest` because its `unknown` parameter is the
  // seam that admits them without a cast. The lookahead matters: the contract
  // error shares this prefix, so without it a pre-check that wrongly claimed
  // a malformed value would still pass.
  it("reports a malformed apiVersion through the schema, not the contract error", () => {
    for (const malformed of ["1", 1.5, 0, -1]) {
      expect(() => parsePluginManifest({ ...valid, apiVersion: malformed })).toThrow(
        /invalid plugin manifest for "bounties" — apiVersion: (?!plugin declares)/,
      );
    }
  });
});

describe("adminPages", () => {
  it("normalizes absent adminPages to []", () => {
    const m = definePlugin({ id: "hello", version: "1.0.0", basePaths: ["/api/hello"] });
    expect(m.adminPages).toEqual([]);
  });

  it("accepts a valid admin page and preserves it", () => {
    const m = definePlugin({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "panel", title: "Hello Admin", children: [{ kind: "text", value: "hi" }] },
      }],
    });
    expect(m.adminPages).toHaveLength(1);
    expect(m.adminPages[0]?.path).toBe("/admin/hello");
  });

  it("rejects an admin page whose path is outside /admin/", () => {
    expect(() => definePlugin({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello"],
      adminPages: [{
        id: "hello-admin", path: "/hello",
        view: { kind: "text", value: "hi" },
      }],
    })).toThrow(/admin page path must start with \/admin\//);
  });

  it("rejects a malformed admin page view at definition time", () => {
    expect(() => definePlugin({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "nonsense" },
      }],
    })).toThrow(/invalid plugin manifest/);
  });
});

describe("route auth admin", () => {
  it("route() accepts auth admin and carries it through", () => {
    const r = route({
      method: "GET", path: "/api/admin/hello/things", auth: "admin",
      handler: async () => ({ status: 200 }),
    });
    expect(r.auth).toBe("admin");
  });
});
