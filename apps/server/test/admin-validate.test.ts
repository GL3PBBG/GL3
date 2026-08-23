import { definePlugin, route } from "@gl3/plugin-sdk";
import { describe, expect, it } from "vitest";
import { validatePlugins } from "../src/plugins/validate.js";
import { buildPluginsPayload } from "../src/plugins/manifest-endpoint.js";

const ok = route({ method: "GET", path: "/api/admin/hello/things", auth: "admin", handler: async () => ({ status: 200 }) });

function manifest(overrides: Parameters<typeof definePlugin>[0]): ReturnType<typeof definePlugin> {
  return definePlugin(overrides);
}

describe("admin validation rules", () => {
  it("accepts an admin route with auth admin under /api/admin/<id>", () => {
    const m = manifest({
      id: "hello", version: "1.0.0",
      basePaths: ["/api/hello", "/api/admin/hello"], routes: [ok],
    });
    expect(() => validatePlugins([m])).not.toThrow();
  });

  it("rejects an /api/admin/ route without auth admin", () => {
    const bad = route({ method: "GET", path: "/api/admin/hello/things", auth: "player", handler: async () => ({ status: 200 }) });
    const m = manifest({
      id: "hello", version: "1.0.0",
      basePaths: ["/api/hello", "/api/admin/hello"], routes: [bad],
    });
    expect(() => validatePlugins([m])).toThrow(/must declare auth "admin"/);
  });

  it("rejects a basePath overlapping the reserved core admin endpoints", () => {
    const m = manifest({ id: "sneaky", version: "1.0.0", basePaths: ["/api/admin/roles"] });
    expect(() => validatePlugins([m])).toThrow(/reserved to core/);
  });

  it("rejects an admin page id colliding with a public page id across plugins", () => {
    const a = manifest({
      id: "aaa", version: "1.0.0", basePaths: ["/api/aaa"],
      pages: [{ id: "clash", path: "/aaa", view: { kind: "text", value: "x" } }],
    });
    const b = manifest({
      id: "bbb", version: "1.0.0", basePaths: ["/api/bbb"],
      adminPages: [{ id: "clash", path: "/admin/bbb", view: { kind: "text", value: "x" } }],
    });
    expect(() => validatePlugins([a, b])).toThrow(/page id "clash"/);
  });

  it("rejects an admin page action outside the plugin's basePaths", () => {
    const m = manifest({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "form", action: "POST /api/bank/deposit", submitLabel: "x", fields: [] },
      }],
    });
    expect(() => validatePlugins([m])).toThrow(/outside/);
  });

  it("treats a table source as a view action for containment", () => {
    const m = manifest({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "table", source: "GET /api/other/things", columns: [{ key: "a", label: "A" }] },
      }],
    });
    expect(() => validatePlugins([m])).toThrow(/outside/);
  });

  it("treats a table rowAction as a view action for containment", () => {
    const m = manifest({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: {
          kind: "table", source: "GET /api/admin/hello/things",
          columns: [{ key: "a", label: "A" }],
          rowActions: [{ label: "Delete", action: "DELETE /api/other/things/:id", confirm: "Sure?" }],
        },
      }],
    });
    expect(() => validatePlugins([m])).toThrow(/outside/);
  });

  it("accepts a contained rowAction with an :id placeholder", () => {
    const m = manifest({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: {
          kind: "table", source: "GET /api/admin/hello/things",
          columns: [{ key: "a", label: "A" }],
          rowActions: [{ label: "Delete", action: "DELETE /api/admin/hello/things/:id", confirm: "Sure?" }],
        },
      }],
    });
    expect(() => validatePlugins([m])).not.toThrow();
  });

  it("rejects a table source containing a dot segment", () => {
    const m = manifest({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      adminPages: [{
        id: "hello-admin", path: "/admin/hello",
        view: { kind: "table", source: "GET /api/admin/hello/../../bank/x", columns: [{ key: "a", label: "A" }] },
      }],
    });
    expect(() => validatePlugins([m])).toThrow(/"\." or "\.\." segment/);
  });
});

describe("buildPluginsPayload admin leak test", () => {
  it("buildPluginsPayload never includes adminPages", () => {
    const m = manifest({
      id: "hello", version: "1.0.0", basePaths: ["/api/hello", "/api/admin/hello"],
      pages: [{ id: "pub", path: "/hello", view: { kind: "text", value: "x" } }],
      adminPages: [{ id: "adm", path: "/admin/hello", view: { kind: "text", value: "x" } }],
    });
    // framework: this is about adminPages exclusion, and the full profile
    // would additionally append the synthetic jail/hospital core pages.
    const payload = buildPluginsPayload([m], "framework");
    expect(payload.pages.map((p) => p.id)).toEqual(["pub"]);
  });
});
