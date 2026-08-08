import { describe, expect, it } from "vitest";
import { PageSchemaSchema } from "../src/index.js";

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
