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

// Every one of the ten kinds, every `form` field type, and four levels of
// nesting (panel > list > panel > list > leaf). The vocabulary is declared
// closed, so this fixture is the pin on it: a kind quietly dropped from the
// union, or a mistyped prop on one of the kinds no other test parses, fails
// here instead of shipping green and surfacing as a plugin that throws on
// import.
const everyKind = {
  id: "hello.kitchen-sink",
  path: "/hello/kitchen-sink",
  menu: { label: "Kitchen sink", order: 0 },
  view: {
    kind: "panel",
    title: "Outer",
    children: [
      { kind: "text", value: "plain text" },
      { kind: "money", value: "1000" },
      { kind: "error", value: "something broke" },
      { kind: "link", label: "Home", to: "/" },
      { kind: "button", label: "Go", action: "POST /api/hello/go" },
      {
        kind: "cooldownButton",
        label: "Greet",
        action: "POST /api/hello/greet",
        cooldownAction: "hello",
      },
      { kind: "keyValue", rows: [{ label: "Greetings", value: "0" }] },
      {
        kind: "form",
        action: "POST /api/hello/say",
        submitLabel: "Say",
        fields: [
          { name: "who", label: "Who", type: "text" },
          { name: "times", label: "Times", type: "number" },
          { name: "stake", label: "Stake", type: "money" },
          { name: "secret", label: "Secret", type: "password" },
        ],
      },
      {
        kind: "list",
        items: [
          { kind: "text", value: "one level down" },
          {
            kind: "panel",
            title: "Inner",
            children: [{ kind: "list", items: [{ kind: "text", value: "four levels down" }] }],
          },
        ],
      },
    ],
  },
};

describe("PageSchemaSchema", () => {
  it("accepts a page built from the v1 vocabulary", () => {
    expect(PageSchemaSchema.parse(page).id).toBe("hello.index");
  });

  // Deep-equals rather than a spot check on one field: with no transforms in the
  // schema the parse output must match the input exactly, so this also catches a
  // node whose props are silently dropped rather than rejected.
  it("accepts every kind in the vocabulary, nested, unchanged", () => {
    expect(PageSchemaSchema.parse(everyKind)).toEqual(everyKind);
  });

  // `Invalid input` is all zod says for a union failure, and the path it reports
  // is `view` even though the offending node is `view.children.0` — the union
  // collapses both the reason and the location. Asserting the generic text is
  // therefore the most this case can assert today; it is recorded as a review
  // finding rather than papered over with a pattern that looks more precise
  // than the error actually is.
  it("rejects a node kind outside the v1 vocabulary", () => {
    const bad = {
      ...page,
      view: { kind: "panel", title: "x", children: [{ kind: "chart", data: [] }] },
    };
    expect(() => PageSchemaSchema.parse(bad)).toThrow(/Invalid input/);
  });

  it("rejects a page whose path is not absolute", () => {
    expect(() => PageSchemaSchema.parse({ ...page, path: "hello" })).toThrow(
      /page path must be absolute/,
    );
  });

  it("makes menu optional so a page can exist without a nav entry", () => {
    const { menu: _menu, ...noMenu } = page;
    expect(PageSchemaSchema.parse(noMenu).menu).toBeUndefined();
  });

  it("rejects unknown fields on a node", () => {
    const bad = { ...page, view: { kind: "text", value: "x", colour: "red" } };
    expect(() => PageSchemaSchema.parse(bad)).toThrow(/Unrecognized key/);
  });

  it("rejects an empty page id", () => {
    expect(() => PageSchemaSchema.parse({ ...page, id: "" })).toThrow(/at least 1 character/);
  });

  it("rejects an empty menu label", () => {
    const bad = { ...page, menu: { label: "", order: 50 } };
    expect(() => PageSchemaSchema.parse(bad)).toThrow(/at least 1 character/);
  });

  it("rejects a non-integer menu order", () => {
    const bad = { ...page, menu: { label: "Hello", order: 1.5 } };
    expect(() => PageSchemaSchema.parse(bad)).toThrow(/Expected integer/);
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
