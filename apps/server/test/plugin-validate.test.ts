import { definePlugin, type ViewNode } from "@gl3/plugin-sdk";
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

/**
 * `VIEW_ACTION_RE` constrains only the *shape* of a view action, so
 * `"POST /api/bank/withdraw"` is a well-formed action for any plugin — while a
 * plugin *route* outside its `basePaths` is already a hard boot failure. The two
 * halves of one manifest disagreed about what the plugin may reach.
 *
 * The stake is attribution rather than privilege: a plugin is in-process server
 * code and could call `/api/bank/withdraw` directly from a handler. What
 * containment buys is that a page rendered under a plugin's name cannot drive an
 * endpoint that plugin never declared, so `basePaths` stays a truthful account of
 * the surface a plugin touches.
 */
describe("validatePlugins view-action containment", () => {
  // Typed `ViewNode` rather than `unknown` + a cast: the parameter type is what
  // contextually types each fixture literal below, so a fixture that stops being
  // a legal node fails to compile instead of failing at `definePlugin`.
  const withPage = (view: ViewNode, basePaths = ["/api/hello"]) =>
    definePlugin({
      id: "hello",
      version: "1.0.0",
      basePaths,
      pages: [{ id: "hello.index", path: "/hello", view }],
    });

  it("accepts an action inside the plugin's basePaths", () => {
    const manifest = withPage({ kind: "button", label: "Greet", action: "POST /api/hello/greet" });
    expect(() => validatePlugins([manifest])).not.toThrow();
  });

  it("accepts an action on the basePath itself, with no trailing segment", () => {
    const manifest = withPage({ kind: "button", label: "Greet", action: "POST /api/hello" });
    expect(() => validatePlugins([manifest])).not.toThrow();
  });

  it("rejects an out-of-scope action, naming the plugin, the page and the action", () => {
    const manifest = withPage({ kind: "button", label: "Rob", action: "POST /api/bank/withdraw" });
    expect(() => validatePlugins([manifest])).toThrow(
      /plugin "hello".*page "hello\.index".*POST \/api\/bank\/withdraw/s,
    );
  });

  // `/api/hello` must not contain `/api/helloworld` — the same trap the
  // basePath-overlap check already guards, reached through a different field.
  it("rejects an action whose path only shares a prefix with the basePath", () => {
    const manifest = withPage({ kind: "button", label: "X", action: "POST /api/helloworld/greet" });
    expect(() => validatePlugins([manifest])).toThrow(/\/api\/helloworld\/greet/);
  });

  it("reaches an action nested inside a panel inside a list", () => {
    const manifest = withPage({
      kind: "list",
      items: [
        { kind: "text", value: "before" },
        {
          kind: "panel",
          title: "Deep",
          children: [{ kind: "button", label: "Rob", action: "POST /api/bank/withdraw" }],
        },
      ],
    });
    expect(() => validatePlugins([manifest])).toThrow(/POST \/api\/bank\/withdraw/);
  });

  it("checks a cooldownButton's HTTP action", () => {
    const manifest = withPage({
      kind: "cooldownButton",
      label: "Rob",
      action: "POST /api/bank/withdraw",
      cooldownAction: "hello_greet",
    });
    expect(() => validatePlugins([manifest])).toThrow(/POST \/api\/bank\/withdraw/);
  });

  it("checks a form's action", () => {
    const manifest = withPage({
      kind: "form",
      action: "POST /api/bank/withdraw",
      submitLabel: "Go",
      fields: [{ name: "amount", label: "Amount", type: "money" }],
    });
    expect(() => validatePlugins([manifest])).toThrow(/POST \/api\/bank\/withdraw/);
  });

  it("accepts a select field's optionsSource inside the plugin's basePaths", () => {
    const manifest = withPage({
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Go",
      fields: [{
        name: "thingId",
        label: "Thing",
        type: "select",
        optionsSource: "GET /api/hello/things",
        valueKey: "id",
        labelKey: "name",
      }],
    });
    expect(() => validatePlugins([manifest])).not.toThrow();
  });

  // `optionsSource` fetches on mount exactly like `table.source` — an
  // uncontained one would let a page read any endpoint in the app.
  it("rejects a select field's out-of-scope optionsSource, naming the source", () => {
    const manifest = withPage({
      kind: "form",
      action: "POST /api/hello/greet",
      submitLabel: "Go",
      fields: [{
        name: "thingId",
        label: "Thing",
        type: "select",
        optionsSource: "GET /api/bank/accounts",
        valueKey: "id",
        labelKey: "name",
      }],
    });
    expect(() => validatePlugins([manifest])).toThrow(/GET \/api\/bank\/accounts/);
  });

  // `link.to` is an app-internal client route (`/plugins/:pageId`), not an HTTP
  // endpoint, so it is deliberately outside containment — `INTERNAL_PATH_RE` is
  // the rule that applies to it. Containing it would forbid the one link the
  // reference page actually needs.
  it("leaves link.to alone — it is a client route, not an endpoint", () => {
    const manifest = withPage({ kind: "link", label: "Back", to: "/plugins/hello.index" });
    expect(() => validatePlugins([manifest])).not.toThrow();
  });

  // Likewise `cooldownAction`: the middle segment of `cooldown:<action>:<id>`,
  // a Redis key segment governed by COOLDOWN_ACTION_RE. It can never be a path.
  it("leaves cooldownAction alone — it is a Redis key segment", () => {
    const manifest = withPage({
      kind: "cooldownButton",
      label: "Greet",
      action: "POST /api/hello/greet",
      cooldownAction: "hello_greet",
    });
    expect(() => validatePlugins([manifest])).not.toThrow();
  });

  it("accepts an action under a later basePath of the same plugin", () => {
    const manifest = withPage({ kind: "button", label: "X", action: "POST /api/extra/go" }, [
      "/api/hello",
      "/api/extra",
    ]);
    expect(() => validatePlugins([manifest])).not.toThrow();
  });

  it("validates the shipped hello example clean", async () => {
    const { default: hello } = await import("@gl3/hello-plugin");
    expect(() => validatePlugins([hello])).not.toThrow();
  });

  // `VIEW_ACTION_RE` permits `.` in a path — it only fixes the shape, not the
  // segments — so `containedIn` was being asked whether the raw string
  // "/api/hello/../bank/withdraw" starts with "/api/hello/", which it does.
  // The browser's URL parser resolves the `..` before `fetch` sends anything,
  // so the request that actually leaves the page targets
  // "/api/bank/withdraw" — a path the raw check never saw. Rejecting outright
  // (rather than normalising and re-checking containment) means a page author
  // gets a traversal-shaped error message instead of a confusing "outside
  // basePaths" one, and it means the last case below fails even though a
  // normalised read of it would land back inside the basePath: this
  // vocabulary's endpoints are RPC verbs a plugin author writes literally, so
  // there is never a legitimate reason to route through a `..` segment, and a
  // blanket reject is simpler to reason about than "reject unless it
  // resolves back inside."
  it("rejects a `..` traversal that escapes the basePath, naming the plugin, page and action", () => {
    const manifest = withPage({
      kind: "button",
      label: "Rob",
      action: "POST /api/hello/../bank/withdraw",
    });
    expect(() => validatePlugins([manifest])).toThrow(
      /plugin "hello".*page "hello\.index".*POST \/api\/hello\/\.\.\/bank\/withdraw/s,
    );
  });

  it("rejects a single-dot segment the same way", () => {
    const manifest = withPage({ kind: "button", label: "X", action: "POST /api/hello/./greet" });
    expect(() => validatePlugins([manifest])).toThrow(/POST \/api\/hello\/\.\/greet/);
  });

  // Even a traversal that resolves back inside the plugin's own basePath is
  // rejected — see the comment above the first traversal test for why this
  // suite chose reject-outright over normalise-then-check.
  it("rejects a traversal that would land back inside the basePath", () => {
    const manifest = withPage({ kind: "button", label: "X", action: "POST /api/hello/x/../y" });
    expect(() => validatePlugins([manifest])).toThrow(/POST \/api\/hello\/x\/\.\.\/y/);
  });
});
