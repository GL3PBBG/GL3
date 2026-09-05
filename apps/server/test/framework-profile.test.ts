import { describe, expect, it } from "vitest";
import blackjackPlugin from "@gl3/plugin-blackjack";
import combatPlugin from "@gl3/plugin-combat";
import crimesPlugin from "@gl3/plugin-crimes";
import { bootSeedsFor } from "../src/db/seed.js";
import { loadConfig } from "../src/config.js";
import { bundledPlugins, FRAMEWORK_PLUGINS, GAMEPLAY_PLUGINS, MCCODES_PLUGINS } from "../src/plugins/core-plugins.js";
import { buildPluginsPayload } from "../src/plugins/manifest-endpoint.js";
import { validatePlugins } from "../src/plugins/validate.js";
import { bootTestServer } from "./helpers/server.js";
import { registerVerifiedPlayer } from "./helpers/register.js";

const FRAMEWORK_IDS = ["bank", "forum", "inventory", "mail", "membership", "news", "notifications", "ranks"];
const MCCODES_FAMILY_IDS = ["mccodes-attributes", "gym", "houses", "education", "jobs", "temple", "progression"];

describe("bundledPlugins", () => {
  it("framework loads exactly the eight game-agnostic plugins, v2 loads all twenty", () => {
    expect(bundledPlugins("framework", []).map((m) => m.id).sort()).toEqual([...FRAMEWORK_IDS].sort());
    expect(bundledPlugins("v2", []).map((m) => m.id).sort()).toEqual(
      [...FRAMEWORK_IDS, ...GAMEPLAY_PLUGINS.map((m) => m.id)].sort(),
    );
  });

  it("mccodes loads framework + the family + crimes/combat/travel/detectives", () => {
    // detectives is combat's requires-edge (underground mode), not MCCodes lore.
    expect(bundledPlugins("mccodes", []).map((m) => m.id).sort()).toEqual(
      [...FRAMEWORK_IDS, ...MCCODES_FAMILY_IDS, "crimes", "combat", "travel", "detectives"].sort(),
    );
  });

  it("gl3 is the deduped union of every bundled plugin", () => {
    const gl3 = bundledPlugins("gl3", []).map((m) => m.id);
    expect([...gl3].sort()).toEqual(
      [...new Set([...FRAMEWORK_IDS, ...GAMEPLAY_PLUGINS.map((m) => m.id), ...MCCODES_FAMILY_IDS])].sort(),
    );
    expect(new Set(gl3).size).toBe(gl3.length); // no duplicate ids
    expect(MCCODES_PLUGINS.map((m) => m.id).sort()).toEqual([...MCCODES_FAMILY_IDS].sort());
  });

  it("the whole gl3 union passes requires-validation", () => {
    expect(() => validatePlugins(bundledPlugins("gl3", []))).not.toThrow();
    expect(() => validatePlugins(bundledPlugins("mccodes", []))).not.toThrow();
  });

  it("GL3_PROFILE=full is rejected at config parse; the four modes parse", () => {
    const baseEnv = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x" };
    expect(() => loadConfig({ ...baseEnv, GL3_PROFILE: "full" })).toThrow();
    expect(loadConfig({ ...baseEnv, GL3_PROFILE: "gl3" }).profile).toBe("gl3");
    expect(loadConfig({ ...baseEnv, GL3_PROFILE: "v2" }).profile).toBe("v2");
    expect(loadConfig({ ...baseEnv, GL3_PROFILE: "mccodes" }).profile).toBe("mccodes");
    expect(loadConfig({ ...baseEnv, GL3_PROFILE: "framework" }).profile).toBe("framework");
  });

  it("de-duplicates an optional manifest the profile already includes", () => {
    const v2 = bundledPlugins("v2", [crimesPlugin]);
    expect(v2.filter((m) => m.id === "crimes")).toHaveLength(1);
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

  it("rejects blackjack without casino, and the whole-graph v2 set passes", () => {
    expect(() => validatePlugins([...FRAMEWORK_PLUGINS, blackjackPlugin])).toThrowError(/"blackjack".*"casino"/);
    expect(() => validatePlugins(bundledPlugins("v2", []))).not.toThrow();
  });
});

describe("bootSeedsFor", () => {
  it("v2 boot seeds everything; framework boot skips crimes and locations, keeps ranks and items", () => {
    const v2 = bootSeedsFor(bundledPlugins("v2", []).map((m) => m.id), "v2");
    expect(v2).toEqual({
      crimes: true, ranks: true, locations: true, items: true,
      family: false, templeExchanges: false, unarmedMelee: false,
    });

    const framework = bootSeedsFor(bundledPlugins("framework", []).map((m) => m.id), "framework");
    expect(framework).toEqual({
      crimes: false, ranks: true, locations: false, items: true,
      family: false, templeExchanges: false, unarmedMelee: false,
    });

    const gl3 = bootSeedsFor(bundledPlugins("gl3", []).map((m) => m.id), "gl3");
    expect(gl3).toEqual({
      crimes: true, ranks: true, locations: true, items: true,
      family: true, templeExchanges: true, unarmedMelee: true,
    });
  });

  it("a framework boot plus crimes re-arms the crimes seed; travel alone re-arms locations", () => {
    expect(bootSeedsFor(bundledPlugins("framework", [crimesPlugin]).map((m) => m.id), "framework").crimes).toBe(true);
    const ids = bundledPlugins("framework", []).map((m) => m.id);
    expect(bootSeedsFor([...ids, "travel"], "framework").locations).toBe(true);
    expect(bootSeedsFor([...ids, "bullets"], "framework").locations).toBe(true);
  });
});

describe("plugins payload synthetic core pages", () => {
  it("includes jail and hospital under every gameplay profile, neither under framework", () => {
    const v2 = buildPluginsPayload(bundledPlugins("v2", []), "v2");
    expect(v2.pages.map((p) => p.id)).toContain("jail");
    expect(v2.pages.map((p) => p.id)).toContain("hospital");
    expect(v2.menu.find((m) => m.pageId === "jail")?.category).toBe("town");
    const gl3 = buildPluginsPayload(bundledPlugins("gl3", []), "gl3");
    expect(gl3.pages.map((p) => p.id)).toContain("jail");

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
