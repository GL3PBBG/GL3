import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../src/index.js";

const TABLE_PREFIX = `p_${manifest.id.replaceAll("-", "_")}_`;

describe("manifest", () => {
  it("is the __ID__ plugin on apiVersion 1", () => {
    expect(manifest.id).toBe("__ID__");
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.basePaths).toEqual(["/api/__ID__", "/api/admin/__ID__"]);
  });

  // The manifest version is a literal (rootDir is src/, so the manifest cannot
  // import package.json) — the engine serves this string, not the package one.
  it("declares the version the package ships as", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });

  it("every /api/admin/ route declares auth: admin", () => {
    for (const r of manifest.routes.filter((r) => r.path.startsWith("/api/admin/"))) {
      expect(r.auth, r.path).toBe("admin");
    }
  });

  it("every route path sits under a basePath", () => {
    for (const r of manifest.routes) {
      expect(manifest.basePaths.some((base) => r.path.startsWith(base)), r.path).toBe(true);
    }
  });

  it("every declared table is namespaced under the engine's prefix (p_<id with - as _>_)", () => {
    for (const name of Object.values(manifest.tables)) {
      expect(String(name).startsWith(TABLE_PREFIX), String(name)).toBe(true);
    }
  });
});
