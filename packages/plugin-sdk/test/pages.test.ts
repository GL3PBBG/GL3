import { describe, expect, it } from "vitest";
import { MAX_VIEW_DEPTH, MAX_VIEW_NODES } from "@gl3/shared";
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

  it("rejects a node kind outside the v1 vocabulary", () => {
    const bad = {
      ...page,
      view: { kind: "panel", title: "x", children: [{ kind: "chart", data: [] }] },
    };
    expect(() => PageSchemaSchema.parse(bad)).toThrow(/Invalid discriminator value/);
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

/** The dotted path of the first issue, for a value the schema must reject. */
function firstIssuePath(value: unknown): string {
  const result = PageSchemaSchema.safeParse(value);
  if (result.success) throw new Error("expected the page to be rejected, but it parsed");
  return result.error.issues[0]?.path.join(".") ?? "<no issues>";
}

// `ViewNodeSchema` dispatches on `kind` rather than being
// `union([Leaf, panel, list])`. Both accept and reject exactly the same pages;
// only the diagnostics differ. `ZodUnion` aborts and emits a single
// `invalid_union` issue at the outermost path — always `view` — with the real
// cause in `unionErrors`, which `definePlugin` discards because it maps only
// `error.issues`. So every authoring mistake below the top surfaced as
// `pages.0.view: Invalid input`.
//
// These paths are the whole point of that change, and nothing else in this file
// would notice it being undone: a refactor back to `z.union` keeps every
// accept/reject assertion green. Hence pinning the path itself.
describe("ViewNodeSchema diagnostics", () => {
  it("reports the path of the offending node, not the top of the view", () => {
    const shallow = { ...page, view: { kind: "panel", title: "x", children: [{ kind: "text" }] } };
    expect(firstIssuePath(shallow)).toBe("view.children.0.value");
  });

  it("keeps reporting the real path through four levels of nesting", () => {
    const deep = {
      ...page,
      view: {
        kind: "panel",
        title: "Outer",
        children: [
          {
            kind: "list",
            items: [{ kind: "panel", title: "Inner", children: [{ kind: "text" }] }],
          },
        ],
      },
    };
    expect(firstIssuePath(deep)).toBe("view.children.0.items.0.children.0.value");
  });

  it("names the bad discriminator on the node that carries it", () => {
    const bad = {
      ...page,
      view: { kind: "panel", title: "x", children: [{ kind: "chart" }] },
    };
    expect(firstIssuePath(bad)).toBe("view.children.0.kind");
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

/**
 * `to`, `action`, `cooldownAction` and `money.value` are the four strings a view
 * hands straight to a sink: an `href`, a `fetch` target, the middle segment of
 * `cooldown:<action>:<playerId>`, and the argument to `formatAmount`. A plugin
 * is third-party code by definition, so each is constrained here — at authoring
 * time, where a bad value fails the boot that loads the plugin rather than the
 * browser that renders it.
 */
describe("view sink constraints", () => {
  function withNode(node: unknown): unknown {
    return { ...page, view: { kind: "panel", title: "x", children: [node] } };
  }

  it.each([
    ["a javascript: URI", "javascript:alert(1)"],
    ["an absolute http URL", "https://evil.example/steal"],
    ["a protocol-relative URL", "//evil.example/steal"],
    // `\` is `/` in WHATWG's relative-slash state, so these two resolve
    // cross-origin exactly like `//evil.example` does.
    ["a backslash-relative URL", "/\\evil.example/steal"],
    ["a backslash-then-slash URL", "/\\/evil.example"],
    ["a relative path", "hello"],
  ])("rejects a link.to that is %s", (_label, to) => {
    expect(() => PageSchemaSchema.parse(withNode({ kind: "link", label: "L", to }))).toThrow(
      /link\.to must be an app-internal absolute path/,
    );
  });

  it("accepts a link.to that is an app-internal absolute path", () => {
    expect(() =>
      PageSchemaSchema.parse(withNode({ kind: "link", label: "L", to: "/gang/1" })),
    ).not.toThrow();
  });

  it.each([
    ["a bare path with no method", "/api/hello/go"],
    ["an absolute URL", "POST https://evil.example/steal"],
    ["a protocol-relative target", "POST //evil.example/steal"],
    ["a backslash-relative target", "POST /\\evil.example/steal"],
    ["an unknown method", "TRACE /api/hello/go"],
  ])("rejects a button action that is %s", (_label, action) => {
    expect(() => PageSchemaSchema.parse(withNode({ kind: "button", label: "B", action }))).toThrow(
      /action must be `METHOD \/absolute\/path`/,
    );
  });

  it("applies the same action constraint to form nodes", () => {
    const bad = withNode({
      kind: "form",
      action: "POST https://evil.example/steal",
      submitLabel: "Go",
      fields: [{ name: "who", label: "Who", type: "text" }],
    });
    expect(() => PageSchemaSchema.parse(bad)).toThrow(/action must be `METHOD \/absolute\/path`/);
  });

  // A `:` here would let a view name `cooldown:crime:<someone-else>` — a key
  // that belongs to another action, or another player.
  it.each([
    ["contains a colon", "crime:other"],
    ["is empty", ""],
    ["starts with a digit", "1crime"],
  ])("rejects a cooldownAction that %s", (_label, cooldownAction) => {
    const bad = withNode({
      kind: "cooldownButton",
      label: "Greet",
      action: "POST /api/hello/greet",
      cooldownAction,
    });
    expect(() => PageSchemaSchema.parse(bad)).toThrow(
      /cooldownAction must be a bare cooldown key segment/,
    );
  });

  // `money.value` is not merely displayed — the web renderer passes it to
  // `formatAmount`, which throws on anything outside `/^-?\d+$/` rather than
  // rendering NaN. `apps/web` has no ErrorBoundary, so an unconstrained value
  // here is a blank page: React unmounts the root and takes the nav with it.
  // MoneySchema is the same predicate, applied where a bad value fails the
  // plugin's boot instead.
  it.each([
    ["has a decimal point", "10.00"],
    ["is empty", ""],
    ["is not numeric at all", "lots"],
    ["carries a thousands separator", "1,000"],
  ])("rejects a money value that %s", (_label, value) => {
    expect(() => PageSchemaSchema.parse(withNode({ kind: "money", value }))).toThrow(
      /must be an integer string/,
    );
  });

  it.each([["a positive integer", "1000"], ["a negative integer", "-50"]])(
    "accepts a money value that is %s",
    (_label, value) => {
      expect(() => PageSchemaSchema.parse(withNode({ kind: "money", value }))).not.toThrow();
    },
  );
});

/**
 * `ViewNodeSchema` is recursive, so an over-deep view would overflow the stack
 * inside `z.lazy` before any refinement could reject it. `checkViewBounds` runs
 * ahead of it in a pipeline and walks the raw value iteratively, which is what
 * makes these two cases a rejection rather than a crash.
 */
describe("view size bounds", () => {
  function nest(depth: number): unknown {
    let node: unknown = { kind: "text", value: "leaf" };
    for (let i = 1; i < depth; i += 1) node = { kind: "panel", title: "p", children: [node] };
    return node;
  }

  function fanOut(width: number): unknown {
    return {
      kind: "panel",
      title: "wide",
      children: Array.from({ length: width }, () => ({ kind: "text", value: "leaf" })),
    };
  }

  it(`accepts a view exactly ${MAX_VIEW_DEPTH} levels deep`, () => {
    expect(() => PageSchemaSchema.parse({ ...page, view: nest(MAX_VIEW_DEPTH) })).not.toThrow();
  });

  it("rejects a view one level deeper than the bound", () => {
    expect(() => PageSchemaSchema.parse({ ...page, view: nest(MAX_VIEW_DEPTH + 1) })).toThrow(
      new RegExp(`view nests deeper than ${MAX_VIEW_DEPTH} levels`),
    );
  });

  it(`accepts a view of exactly ${MAX_VIEW_NODES} nodes`, () => {
    const view = fanOut(MAX_VIEW_NODES - 1);
    expect(() => PageSchemaSchema.parse({ ...page, view })).not.toThrow();
  });

  it("rejects a view one node over the bound", () => {
    expect(() => PageSchemaSchema.parse({ ...page, view: fanOut(MAX_VIEW_NODES) })).toThrow(
      new RegExp(`view has more than ${MAX_VIEW_NODES} nodes`),
    );
  });

  // The bound has to hold against a value deep enough to blow the stack if the
  // recursive schema ever saw it — that is the failure mode it exists to stop.
  it("rejects a pathologically deep view without overflowing the stack", () => {
    expect(() => PageSchemaSchema.parse({ ...page, view: nest(50_000) })).toThrow(
      new RegExp(`view nests deeper than ${MAX_VIEW_DEPTH} levels`),
    );
  });

  // Same failure mode in the other direction, and it is not the recursive
  // schema that is at risk: enqueueing children with `push(...children)` throws
  // a RangeError past V8's argument limit (~124k), before the node bound is
  // ever consulted. The 513-child case above is three orders of magnitude too
  // small to reach it.
  it("rejects a pathologically wide view without overflowing the stack", () => {
    expect(() => PageSchemaSchema.parse({ ...page, view: fanOut(200_000) })).toThrow(
      new RegExp(`view has more than ${MAX_VIEW_NODES} nodes`),
    );
  });
});

/**
 * A page path the DTO rejects would boot here and then break the client, where
 * one bad page fails the parse of the whole `/api/plugins` payload. The two
 * rules therefore have to nest: whatever this schema accepts, the DTO accepts.
 */
describe("page path constraints", () => {
  it.each([
    ["is protocol-relative", "//evil.example"],
    ["is backslash-relative", "/\\evil.example"],
    ["is an absolute URL", "https://evil.example"],
    ["is relative", "hello"],
  ])("rejects a page path that %s", (_label, path) => {
    expect(() => PageSchemaSchema.parse({ ...page, path })).toThrow(
      /page path must be an app-internal absolute path/,
    );
  });

  it("still rejects an uppercase page path", () => {
    expect(() => PageSchemaSchema.parse({ ...page, path: "/Hello" })).toThrow(
      /page path must be lowercase/,
    );
  });
});
