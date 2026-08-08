import { describe, expect, it } from "vitest";
import { definePlugin, PageSchemaSchema } from "../src/index.js";

const page = {
  id: "hello.index",
  path: "/hello",
  menu: { label: "Hello", order: 50 },
  view: {
    kind: "panel",
    title: "Hello",
    children: [
      { kind: "text", value: "Say hello to the server." },
      { kind: "keyValue", rows: [{ label: "Greetings", value: "0" }] },
      { kind: "money", value: "1000" },
      {
        kind: "cooldownButton",
        label: "Greet",
        action: "POST /api/hello/greet",
        cooldownAction: "hello",
      },
    ],
  },
};

describe("PageSchemaSchema", () => {
  it("accepts a page built from the v1 vocabulary", () => {
    expect(PageSchemaSchema.parse(page).id).toBe("hello.index");
  });

  it("rejects a node kind outside the v1 vocabulary", () => {
    const bad = {
      ...page,
      view: { kind: "panel", title: "x", children: [{ kind: "chart", data: [] }] },
    };
    expect(() => PageSchemaSchema.parse(bad)).toThrow();
  });

  it("rejects a page whose path is not absolute", () => {
    expect(() => PageSchemaSchema.parse({ ...page, path: "hello" })).toThrow();
  });

  it("makes menu optional so a page can exist without a nav entry", () => {
    const { menu: _menu, ...noMenu } = page;
    expect(PageSchemaSchema.parse(noMenu).menu).toBeUndefined();
  });

  it("rejects unknown fields on a node", () => {
    const bad = { ...page, view: { kind: "text", value: "x", colour: "red" } };
    expect(() => PageSchemaSchema.parse(bad)).toThrow();
  });
});

// Pages are pure data, so the manifest schema validates them for real rather
// than holding a placeholder `z.unknown()`. That is what makes a malformed view
// node fail on `import` of the plugin, naming it, instead of surfacing later as
// a page that renders wrong. Asserting on the message rather than merely that
// it throws is deliberate: `pages` reverted to `z.array(z.unknown())` still
// throws for other reasons on other inputs, and a bare `.toThrow()` would not
// tell the two apart.
//
// The bad page is bound to a variable first, and deliberately has a shape
// `definePlugin`'s signature forbids — the same reasoning as the invalid-input
// tests in `manifest.test.ts`: this guard exists for manifests TypeScript never
// saw, and cannot be reached any other way.
describe("definePlugin pages validation", () => {
  it("rejects a page whose view is outside the v1 vocabulary, naming the plugin", () => {
    const withBadPage = {
      id: "hello",
      version: "1.0.0",
      basePaths: ["/api/hello"],
      pages: [{ ...page, view: { kind: "chart", data: [] } }],
    };

    expect(() => definePlugin(withBadPage)).toThrow(/invalid plugin manifest for "hello"/);
    expect(() => definePlugin(withBadPage)).toThrow(/pages\.0\.view/);
  });
});
