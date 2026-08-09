import { definePlugin } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { validatePlugins } from "../src/plugins/validate.js";

const plugin = (id: string, basePaths: string[], tables: Record<string, string> = {}) =>
  definePlugin({ id, version: "1.0.0", basePaths, tables });

describe("validatePlugins", () => {
  it("accepts a well-formed set", () => {
    expect(() =>
      validatePlugins([
        plugin("hello", ["/api/hello"], { greetings: "p_hello_greetings" }),
        plugin("bounties", ["/api/bounties"], { bounties: "p_bounties_bounties" }),
      ]),
    ).not.toThrow();
  });

  it("rejects two plugins claiming the same id", () => {
    expect(() =>
      validatePlugins([plugin("hello", ["/api/hello"]), plugin("hello", ["/api/hi"])]),
    ).toThrow(/hello/);
  });

  it("rejects a table without the plugin's prefix, naming the plugin", () => {
    expect(() => validatePlugins([plugin("hello", ["/api/hello"], { players: "players" })])).toThrow(
      /hello.*p_hello_/s,
    );
  });

  // The ids here are load-bearing, not incidental. The prefix rule does not on
  // its own make a cross-plugin table collision impossible: one plugin's prefix
  // can be a prefix of another's, so `p_hello_x_t` is legitimately claimable by
  // both "hello" (p_hello_) and "hello-x" (p_hello_x_). Pick two ids whose
  // prefixes are unrelated — say "hello" and "hi" — and the *prefix* check
  // rejects the second plugin first, the collision check never runs, and the
  // test passes without ever reaching what it names.
  it("rejects a table claimed by two plugins", () => {
    expect(() =>
      validatePlugins([
        plugin("hello", ["/api/hello"], { t: "p_hello_x_t" }),
        plugin("hello-x", ["/api/hello-x"], { t: "p_hello_x_t" }),
      ]),
    ).toThrow(/p_hello_x_t.*claimed by both.*hello-x/s);
  });

  it("rejects overlapping basePaths naming both plugins", () => {
    expect(() =>
      validatePlugins([plugin("hello", ["/api/hello"]), plugin("hello-world", ["/api/hello/world"])]),
    ).toThrow(/hello.*hello-world|hello-world.*hello/s);
  });

  it("rejects a basePath reserved to core", () => {
    expect(() => validatePlugins([plugin("evil", ["/api/auth"])])).toThrow(/reserved/);
  });

  it("rejects a route path outside the plugin's declared basePaths", () => {
    const manifest = definePlugin({
      id: "hello",
      version: "1.0.0",
      basePaths: ["/api/hello"],
      routes: [
        { method: "GET", path: "/api/bounties", auth: "player", handler: async () => ({ status: 200 }) },
      ],
    });
    expect(() => validatePlugins([manifest])).toThrow(/\/api\/bounties/);
  });

  it("rejects two pages sharing an id", () => {
    const page = { id: "dup", path: "/dup", view: { kind: "text" as const, value: "x" } };
    expect(() =>
      validatePlugins([
        definePlugin({ id: "a", version: "1.0.0", basePaths: ["/api/a"], pages: [page] }),
        definePlugin({ id: "b", version: "1.0.0", basePaths: ["/api/b"], pages: [page] }),
      ]),
    ).toThrow(/dup/);
  });
});
