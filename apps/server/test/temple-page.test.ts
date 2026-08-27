// Same shape as temple.test.ts's own gated case: settings are loaded ONCE at
// boot (apps/server/src/app.ts / test/helpers/server.ts both call
// `loadSettings` before the app is built), so a setting row must be seeded
// BEFORE `bootTestServer`, not written afterward and expected to take effect.
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import templePlugin, { templePage } from "@gl3/plugin-temple";
import { settings } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

describe("GET /api/temple", () => {
  it("answers all three exchanges when the setting is unset", async () => {
    const server = await bootTestServer({ profile: "v2", plugins: [mccodesAttributes, templePlugin] });
    try {
      const { token } = await registerVerifiedPlayer(server, { remoteAddress: "10.17.1.1" });
      const res = await server.app.inject({
        method: "GET", url: "/api/temple", headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().values.exchanges).toBe("refill,iq,money");
    } finally {
      await server.close();
    }
  });

  it("follows temple.exchanges when set", async () => {
    await db.insert(settings).values({ key: "temple.exchanges", value: "refill" })
      .onConflictDoUpdate({ target: settings.key, set: { value: "refill" } });
    const server = await bootTestServer({ profile: "v2", plugins: [mccodesAttributes, templePlugin] });
    try {
      const { token } = await registerVerifiedPlayer(server, { remoteAddress: "10.17.1.2" });
      const res = await server.app.inject({
        method: "GET", url: "/api/temple", headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().values.exchanges).toBe("refill");
    } finally {
      await db.delete(settings).where(eq(settings.key, "temple.exchanges"));
      await server.close();
    }
  });
});

describe("temple page", () => {
  it("is declared in /api/plugins with the keyValueSource and all three actions, unconditionally", async () => {
    const server = await bootTestServer({ profile: "v2", plugins: [mccodesAttributes, templePlugin] });
    try {
      const { token } = await registerVerifiedPlayer(server, { remoteAddress: "10.17.1.3" });
      const res = await server.app.inject({
        method: "GET", url: "/api/plugins", headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const pages = (res.json() as { pages: { pluginId: string; id: string }[] }).pages;
      expect(pages.some((p) => p.pluginId === "temple" && p.id === "temple.index")).toBe(true);

      // The view schema itself (imported straight from the plugin, same
      // precedent as jobs-page.test.ts's admin-page id-column walk):
      // exactly the three actions, declared with no conditional wrapping —
      // a disabled exchange answers its own 403, not a hidden node.
      const actions: string[] = [];
      let keyValueSource: { source: string; entries: { label: string; key: string }[] } | undefined;
      const walk = (node: unknown): void => {
        if (typeof node !== "object" || node === null) return;
        const n = node as Record<string, unknown>;
        if (n.kind === "button" || n.kind === "form") actions.push(n.action as string);
        if (n.kind === "keyValueSource") {
          keyValueSource = { source: n.source as string, entries: n.entries as { label: string; key: string }[] };
        }
        if (Array.isArray(n.children)) for (const child of n.children) walk(child);
      };
      walk(templePage.view);

      expect(actions.sort()).toEqual([
        "POST /api/temple/iq",
        "POST /api/temple/money",
        "POST /api/temple/refill",
      ]);
      expect(keyValueSource?.source).toBe("GET /api/temple");
      expect(keyValueSource?.entries).toContainEqual({ label: "Offered here", key: "exchanges" });
    } finally {
      await server.close();
    }
  });
});
