import { describe, expect, it } from "vitest";
import blackjackPlugin from "@gl3/plugin-blackjack";
import combatPlugin from "@gl3/plugin-combat";
import crimesPlugin from "@gl3/plugin-crimes";
import { bootSeedsFor } from "../src/db/seed.js";
import { bundledPlugins, FRAMEWORK_PLUGINS, GAMEPLAY_PLUGINS } from "../src/plugins/core-plugins.js";
import { buildPluginsPayload } from "../src/plugins/manifest-endpoint.js";
import { validatePlugins } from "../src/plugins/validate.js";
import { bootTestServer } from "./helpers/server.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

const FRAMEWORK_IDS = ["bank", "forum", "inventory", "mail", "membership", "news", "notifications", "ranks"];

describe("bundledPlugins", () => {
  it("framework loads exactly the eight game-agnostic plugins, full loads all twenty", () => {
    expect(bundledPlugins("framework", []).map((m) => m.id).sort()).toEqual([...FRAMEWORK_IDS].sort());
    expect(bundledPlugins("full", []).map((m) => m.id).sort()).toEqual(
      [...FRAMEWORK_IDS, ...GAMEPLAY_PLUGINS.map((m) => m.id)].sort(),
    );
  });

  it("de-duplicates an optional manifest the profile already includes", () => {
    const full = bundledPlugins("full", [crimesPlugin]);
    expect(full.filter((m) => m.id === "crimes")).toHaveLength(1);
    // The same id in a framework boot is an ADD, not a duplicate.
    const framework = bundledPlugins("framework", [crimesPlugin]);
    expect(framework.filter((m) => m.id === "crimes")).toHaveLength(1);
  });
});

describe("requires validation", () => {
  it("accepts a framework boot plus crimes: membership (its requirement) is framework", () => {
    expect(() => validatePlugins(bundledPlugins("framework", [crimesPlugin]))).not.toThrow();
  });

  it("rejects combat without detectives, naming both plugins", () => {
    expect(() => validatePlugins(bundledPlugins("framework", [combatPlugin]))).toThrowError(/"combat".*"detectives"/);
  });

  it("rejects blackjack without casino, and the whole-graph full set passes", () => {
    expect(() => validatePlugins([...FRAMEWORK_PLUGINS, blackjackPlugin])).toThrowError(/"blackjack".*"casino"/);
    expect(() => validatePlugins(bundledPlugins("full", []))).not.toThrow();
  });
});

describe("bootSeedsFor", () => {
  it("full boot seeds everything; framework boot skips crimes and locations, keeps ranks and items", () => {
    const full = bootSeedsFor(bundledPlugins("full", []).map((m) => m.id));
    expect(full).toEqual({ crimes: true, ranks: true, locations: true, items: true });

    const framework = bootSeedsFor(bundledPlugins("framework", []).map((m) => m.id));
    expect(framework).toEqual({ crimes: false, ranks: true, locations: false, items: true });
  });

  it("a framework boot plus crimes re-arms the crimes seed; travel alone re-arms locations", () => {
    expect(bootSeedsFor(bundledPlugins("framework", [crimesPlugin]).map((m) => m.id)).crimes).toBe(true);
    const ids = bundledPlugins("framework", []).map((m) => m.id);
    expect(bootSeedsFor([...ids, "travel"]).locations).toBe(true);
    expect(bootSeedsFor([...ids, "bullets"]).locations).toBe(true);
  });
});

describe("plugins payload synthetic core pages", () => {
  it("includes jail and hospital under full, neither under framework", () => {
    const full = buildPluginsPayload(bundledPlugins("full", []), "full");
    expect(full.pages.map((p) => p.id)).toContain("jail");
    expect(full.pages.map((p) => p.id)).toContain("hospital");
    expect(full.menu.find((m) => m.pageId === "jail")?.category).toBe("town");

    const framework = buildPluginsPayload(bundledPlugins("framework", []), "framework");
    expect(framework.pages.map((p) => p.id)).not.toContain("jail");
    expect(framework.pages.map((p) => p.id)).not.toContain("hospital");
  });
});

describe("framework boot (integration)", () => {
  it("serves framework plugins, 404s gameplay routes and core jail/hospital, and reports no gameplay pages", async () => {
    const server = await bootTestServer({ profile: "framework" });
    try {
      // The eight game-agnostic plugins loaded, and nothing else.
      expect(server.plugins.manifests.map((m) => m.id).sort()).toEqual([...FRAMEWORK_IDS].sort());

      const { token } = await registerVerifiedPlayer(server);

      const ranks = await server.app.inject({ method: "GET", url: "/api/ranks", headers: { authorization: `Bearer ${token}` } });
      expect(ranks.statusCode).toBe(200);

      for (const url of ["/api/crimes", "/api/combat/targets", "/api/jail", "/api/hospital", "/api/locations"]) {
        const res = await server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
        expect(res.statusCode, url).toBe(404);
      }

      const payload = await server.app.inject({ method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` } });
      expect(payload.statusCode).toBe(200);
      const body = payload.json() as { pages: { id: string; pluginId: string }[]; menu: { pageId: string }[] };
      expect(body.pages.filter((p) => p.pluginId === "core")).toEqual([]);
      expect(body.menu.map((m) => m.pageId)).not.toContain("jail");
    } finally {
      await server.close();
    }
  });
});
