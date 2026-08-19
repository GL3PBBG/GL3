/**
 * Admin acceptance: the founder (first registered player, auto-admin with *)
 * fills the game world via admin routes, and a second player sees everything
 * through the public surfaces.
 *
 * Boot B (plugin-absence) is deliberately skipped: all six admin-bearing plugins
 * (travel, bullets, inventory, news, crimes, ranks) are CORE_PLUGINS loaded
 * unconditionally via `withCorePlugins` and cannot be excluded from a
 * `bootTestServer` call. Plugin-absence is already proven by
 * `admin-shell.test.ts`'s custom `alpha`/`beta` manifests — that test boots
 * with only those two optional plugins and asserts the admin-plugins endpoint
 * reflects exactly what was loaded.
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, testDb } from "../helpers/db.js";
import { registerVerifiedPlayer } from "../helpers/register.js";
import { bootTestServer } from "../helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("admin acceptance: admin fills the world, players see it", () => {
  it("end-to-end flow from admin creation to public visibility", async () => {
    // --- Founder registers, becomes admin ---
    const { token: adminToken, playerId: adminId } = await registerVerifiedPlayer({ app, redis }, { username: "Founder" });

    // --- GET /api/admin/plugins lists expected sections ---
    const pluginsRes = await app.inject({
      method: "GET", url: "/api/admin/plugins", headers: auth(adminToken),
    });
    expect(pluginsRes.statusCode).toBe(200);
    const sectionIds = pluginsRes.json().sections.map((s: { pluginId: string }) => s.pluginId);
    expect(sectionIds).toContain("travel");
    expect(sectionIds).toContain("bullets");
    expect(sectionIds).toContain("inventory");
    expect(sectionIds).toContain("news");
    expect(sectionIds).toContain("crimes");
    expect(sectionIds).toContain("ranks");
    expect(sectionIds).toContain("roles");

    // --- Admin creates a town ---
    const townRes = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(adminToken),
      payload: { name: "Riviera", travelCost: "1000", travelCooldownSeconds: 120 },
    });
    expect(townRes.statusCode).toBe(201);
    const townId = townRes.json().id;

    // --- Admin sets bullet stock on the town ---
    const bulletStockRes = await app.inject({
      method: "POST", url: "/api/admin/bullets/stock", headers: auth(adminToken),
      payload: { locationId: townId, bulletStock: 50, bulletCost: "200" },
    });
    expect(bulletStockRes.statusCode).toBe(204);

    // --- Admin creates an item ---
    const itemRes = await app.inject({
      method: "POST", url: "/api/admin/inventory/items", headers: auth(adminToken),
      payload: { itemType: "weapon", name: "Riviera Special", damageMin: 10, damageMax: 25, accuracy: 70 },
    });
    expect(itemRes.statusCode).toBe(201);
    const itemId = itemRes.json().id;

    // --- Admin stocks the shop at the town ---
    const shopStockRes = await app.inject({
      method: "POST", url: "/api/admin/inventory/shop", headers: auth(adminToken),
      payload: { locationId: townId, itemId, price: "5000", stock: 5 },
    });
    expect(shopStockRes.statusCode).toBe(204);

    // --- Admin posts news ---
    const newsRes = await app.inject({
      method: "POST", url: "/api/news", headers: auth(adminToken),
      payload: { title: "Grand Opening", body: "Riviera is now open for business." },
    });
    expect(newsRes.statusCode).toBe(201);

    // --- Second player registers ---
    const { token: playerToken, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Tourist" });

    // Move the second player to the new town so the shop listing is scoped there.
    // The shop route reads player_stats.location_id to scope stock rows.
    await db.execute(
      sql`update player_stats set location_id = ${townId} where player_id = ${playerId}`,
    );

    // --- PUBLIC: locations list contains the town with bullet stock/cost ---
    const locationsRes = await app.inject({
      method: "GET", url: "/api/locations", headers: auth(playerToken),
    });
    expect(locationsRes.statusCode).toBe(200);
    const town = locationsRes.json().locations.find(
      (l: { id: string }) => l.id === townId,
    );
    expect(town).toBeDefined();
    expect(town.name).toBe("Riviera");
    expect(town.travelCost).toBe("1000");
    expect(town.bulletStock).toBe(50);
    expect(town.bulletCost).toBe("200");

    // --- PUBLIC: shop listing at that location contains the item ---
    const shopRes = await app.inject({
      method: "GET", url: "/api/shop", headers: auth(playerToken),
    });
    expect(shopRes.statusCode).toBe(200);
    expect(shopRes.json().locationId).toBe(townId);
    const shopItem = shopRes.json().items.find(
      (i: { itemId: string }) => i.itemId === itemId,
    );
    expect(shopItem).toBeDefined();
    expect(shopItem.name).toBe("Riviera Special");
    expect(shopItem.price).toBe("5000");
    expect(shopItem.stock).toBe(5);

    // --- PUBLIC: news list contains the post ---
    const newsListRes = await app.inject({ method: "GET", url: "/api/news" });
    expect(newsListRes.statusCode).toBe(200);
    const post = newsListRes.json().news.find(
      (n: { title: string }) => n.title === "Grand Opening",
    );
    expect(post).toBeDefined();
    expect(post.body).toBe("Riviera is now open for business.");
  });
});
