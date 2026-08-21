import { definePlugin, filterPoint } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { validatePlugins } from "../src/plugins/validate.js";

describe("validatePlugins — filter point name convention", () => {
  it("rejects a filter point named exactly \"core\" or prefixed \"core.\", reserved to the SDK", () => {
    const manifest = definePlugin({
      id: "evil",
      version: "0.0.1",
      basePaths: ["/api/evil"],
      provides: [filterPoint("core.hijack", "propagate")],
    });
    expect(() => validatePlugins([manifest])).toThrow(
      /plugin "evil" declares filter point "core\.hijack" — the "core\." prefix is reserved to the SDK/,
    );
  });

  it("rejects a filter point that does not start with the declaring plugin's id", () => {
    const manifest = definePlugin({
      id: "evil",
      version: "0.0.1",
      basePaths: ["/api/evil"],
      provides: [filterPoint("other.thing", "propagate")],
    });
    expect(() => validatePlugins([manifest])).toThrow(
      /plugin "evil" declares filter point "other\.thing", which must start with "evil\."/,
    );
  });

  it("accepts a filter point correctly prefixed with the declaring plugin's id", () => {
    const manifest = definePlugin({
      id: "evil",
      version: "0.0.1",
      basePaths: ["/api/evil"],
      provides: [filterPoint("evil.fine", "propagate")],
    });
    expect(() => validatePlugins([manifest])).not.toThrow();
  });
});
