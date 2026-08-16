import { describe, expect, it } from "vitest";
import { definePlugin } from "@gl3/plugin-sdk";
import { collectPropertyTypes } from "../src/plugins/property-types.js";

const casino = definePlugin({
  id: "casino", version: "1.0.0", basePaths: ["/api/casino"],
  providesProperties: [{ id: "casino", name: "Casino", price: 100_000_000n, leverLabel: "Max bet" }],
});
const bullets = definePlugin({
  id: "bullets", version: "1.0.0", basePaths: ["/api/bullets"],
  providesProperties: [{ id: "bullets", name: "Bullet Factory", price: 100_000_000n, leverLabel: "Price per bullet" }],
});
const plain = definePlugin({ id: "mail", version: "1.0.0", basePaths: ["/api/mail"] });

describe("collectPropertyTypes", () => {
  it("keys every declaration by its id", () => {
    const registry = collectPropertyTypes([casino, bullets, plain]);
    expect([...registry.keys()].sort()).toEqual(["bullets", "casino"]);
    expect(registry.get("casino")?.name).toBe("Casino");
  });

  it("is empty when nothing declares a type", () => {
    expect(collectPropertyTypes([plain]).size).toBe(0);
  });

  it("throws on two plugins declaring the same type id", () => {
    // definePlugin forbids a decl id different from the plugin id, so the only
    // way two manifests collide is two plugins with the same id — which the
    // loader's own id check would also catch. Constructed here directly so the
    // registry carries its own guard rather than relying on that ordering.
    const clash = { ...casino, id: "casino" };
    expect(() => collectPropertyTypes([casino, clash])).toThrow(/casino/);
  });
});
