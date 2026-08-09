import { describe, expect, it } from "vitest";
import { MAX_VIEW_DEPTH, MAX_VIEW_NODES, PluginsPayloadSchema } from "../src/index.js";

describe("PluginsPayloadSchema", () => {
  it("accepts a well-formed payload with one page, menu entry and event", () => {
    const payload = {
      menu: [{ pageId: "hello.index", path: "/hello", label: "Hello", order: 90 }],
      pages: [{
        pluginId: "hello", id: "hello.index", path: "/hello",
        view: { kind: "panel", title: "Hello", children: [{ kind: "text", value: "Hi" }] },
      }],
      events: [{ pluginId: "hello", name: "greeted", describe: "{actorName} said hello", invalidates: ["hello"] }],
    };
    expect(PluginsPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("accepts an empty payload", () => {
    expect(PluginsPayloadSchema.parse({ menu: [], pages: [], events: [] }))
      .toEqual({ menu: [], pages: [], events: [] });
  });

  it("rejects a view node with an unknown kind", () => {
    const bad = {
      menu: [], events: [],
      pages: [{ pluginId: "hello", id: "hello.index", path: "/hello",
        view: { kind: "notARealKind", value: "x" } }],
    };
    expect(() => PluginsPayloadSchema.parse(bad)).toThrow();
  });

  it("rejects an order that is not an integer", () => {
    const bad = {
      pages: [], events: [],
      menu: [{ pageId: "x", path: "/x", label: "X", order: 1.5 }],
    };
    expect(() => PluginsPayloadSchema.parse(bad)).toThrow();
  });
});

/**
 * The DTO is the client's boundary against a payload it did not build, so the
 * three sink strings are constrained here as well as in the SDK. Constraining
 * only one side would leave whichever side was skipped as the way in.
 */
describe("PluginsPayloadSchema view sink constraints", () => {
  function payloadWith(node: unknown): unknown {
    return {
      menu: [],
      events: [],
      pages: [{
        pluginId: "hello", id: "hello.index", path: "/hello",
        view: { kind: "panel", title: "x", children: [node] },
      }],
    };
  }

  it.each([
    ["a javascript: URI", "javascript:alert(1)"],
    ["an absolute http URL", "https://evil.example/steal"],
    ["a protocol-relative URL", "//evil.example/steal"],
    // `\` is `/` in WHATWG's relative-slash state, so this resolves
    // cross-origin exactly like `//evil.example` does.
    ["a backslash-relative URL", "/\\evil.example/steal"],
  ])("rejects a link.to that is %s", (_label, to) => {
    expect(() => PluginsPayloadSchema.parse(payloadWith({ kind: "link", label: "L", to })))
      .toThrow(/link\.to must be an app-internal absolute path/);
  });

  it.each([
    ["a bare path with no method", "/api/hello/go"],
    ["an absolute URL", "POST https://evil.example/steal"],
    ["a backslash-relative target", "POST /\\evil.example/steal"],
  ])("rejects a button action that is %s", (_label, action) => {
    expect(() => PluginsPayloadSchema.parse(payloadWith({ kind: "button", label: "B", action })))
      .toThrow(/action must be `METHOD \/absolute\/path`/);
  });

  it("rejects a cooldownAction carrying a key separator", () => {
    const node = {
      kind: "cooldownButton", label: "Greet",
      action: "POST /api/hello/greet", cooldownAction: "crime:other",
    };
    expect(() => PluginsPayloadSchema.parse(payloadWith(node)))
      .toThrow(/cooldownAction must be a bare cooldown key segment/);
  });

  it("rejects a page path that is not an app-internal absolute path", () => {
    const bad = {
      menu: [], events: [],
      pages: [{
        pluginId: "hello", id: "hello.index", path: "https://evil.example",
        view: { kind: "text", value: "x" },
      }],
    };
    expect(() => PluginsPayloadSchema.parse(bad))
      .toThrow(/page path must be an app-internal absolute path/);
  });
});

/**
 * `ViewNodeDtoSchema` is recursive; the bound therefore has to be checked
 * before it, on the raw value, or a deep payload overflows the stack rather
 * than failing validation.
 */
describe("PluginsPayloadSchema view size bounds", () => {
  function pageWithView(view: unknown): unknown {
    return {
      menu: [], events: [],
      pages: [{ pluginId: "hello", id: "hello.index", path: "/hello", view }],
    };
  }

  function nest(depth: number): unknown {
    let node: unknown = { kind: "text", value: "leaf" };
    for (let i = 1; i < depth; i += 1) node = { kind: "panel", title: "p", children: [node] };
    return node;
  }

  it(`accepts a view exactly ${MAX_VIEW_DEPTH} levels deep`, () => {
    expect(() => PluginsPayloadSchema.parse(pageWithView(nest(MAX_VIEW_DEPTH)))).not.toThrow();
  });

  it("rejects a view one level deeper than the bound", () => {
    expect(() => PluginsPayloadSchema.parse(pageWithView(nest(MAX_VIEW_DEPTH + 1))))
      .toThrow(new RegExp(`view nests deeper than ${MAX_VIEW_DEPTH} levels`));
  });

  it("rejects a pathologically deep view without overflowing the stack", () => {
    expect(() => PluginsPayloadSchema.parse(pageWithView(nest(50_000))))
      .toThrow(new RegExp(`view nests deeper than ${MAX_VIEW_DEPTH} levels`));
  });

  function fanOut(width: number): unknown {
    return {
      kind: "panel", title: "wide",
      children: Array.from({ length: width }, () => ({ kind: "text", value: "leaf" })),
    };
  }

  it("rejects a view over the node-count bound", () => {
    expect(() => PluginsPayloadSchema.parse(pageWithView(fanOut(MAX_VIEW_NODES))))
      .toThrow(new RegExp(`view has more than ${MAX_VIEW_NODES} nodes`));
  });

  // Enqueueing children with `push(...children)` throws a RangeError past V8's
  // argument limit (~124k) before the bound is ever consulted, so the wide case
  // needs a payload far past the bound, not one node over it.
  it("rejects a pathologically wide view without overflowing the stack", () => {
    expect(() => PluginsPayloadSchema.parse(pageWithView(fanOut(200_000))))
      .toThrow(new RegExp(`view has more than ${MAX_VIEW_NODES} nodes`));
  });

  it("rejects a menu path that is not an app-internal absolute path", () => {
    const bad = {
      pages: [], events: [],
      menu: [{ pageId: "hello.index", path: "//evil.example", label: "Hello", order: 1 }],
    };
    expect(() => PluginsPayloadSchema.parse(bad))
      .toThrow(/menu path must be an app-internal absolute path/);
  });
});
