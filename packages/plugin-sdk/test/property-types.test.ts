import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/index.js";

const base = { id: "casino", version: "1.0.0", basePaths: ["/api/casino"] };

describe("providesProperties", () => {
  it("defaults to an empty array", () => {
    expect(definePlugin({ ...base }).providesProperties).toEqual([]);
  });

  it("normalises a declaration through", () => {
    const manifest = definePlugin({
      ...base,
      providesProperties: [
        { id: "casino", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" },
      ],
    });
    expect(manifest.providesProperties).toEqual([
      { id: "casino", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" },
    ]);
  });

  it("rejects a declaration whose id is not the plugin's own id", () => {
    expect(() =>
      definePlugin({
        ...base,
        providesProperties: [
          { id: "bullets", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" },
        ],
      }),
    ).toThrow(/providesProperties/);
  });

  it("rejects more than one declaration", () => {
    expect(() =>
      definePlugin({
        ...base,
        providesProperties: [
          { id: "casino", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" },
          { id: "casino", name: "Other", price: 1n, leverLabel: "x" },
        ],
      }),
    ).toThrow(/at most one/);
  });

  it("rejects a non-positive price", () => {
    expect(() =>
      definePlugin({
        ...base,
        providesProperties: [{ id: "casino", name: "Casino", price: 0n, leverLabel: "Max bet" }],
      }),
    ).toThrow();
  });

  it("rejects an empty leverLabel", () => {
    expect(() =>
      definePlugin({
        ...base,
        providesProperties: [{ id: "casino", name: "Casino", price: 1n, leverLabel: "" }],
      }),
    ).toThrow();
  });
});
