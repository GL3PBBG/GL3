import { describe, expect, it } from "vitest";
import { PluginsPayloadSchema } from "../src/index.js";

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
