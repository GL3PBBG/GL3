import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { adminPage as propertiesAdminPage } from "@gl3/plugin-properties";
import { locations as coreLocations } from "../src/db/schema/index.js";
import { propertiesPlugin } from "./helpers/plugin-tables.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

// The coexistence test below needs a SECOND declared property type — with only
// `bullets` declared it could not tell the (location_id, plugin_id) key from
// the old bare unique(location_id). It used to supply one itself, as a
// test-only `definePlugin({ id: "casino", ... })` stub passed to
// `bootTestServer`. That stub is gone: the casino cluster made `casino` a real
// CORE plugin id, and `withCorePlugins` silently FILTERS an optional plugin
// whose id collides with a core one (core-plugins.ts:50) — so the stub was
// dropped at boot, its type never registered, and both tests below 404'd with
// `unknown_property_type`. Nothing warned; the collision is invisible at boot.
//
// `blackjack` replaces it and is strictly better than the stub ever was: it is
// a genuinely shipped type (blackjack/src/index.ts:84) whose owner a real
// consumer pays (casino's `payOwner`), which is exactly the property the old
// comment here said a test-only type could not have.
const SECOND_TYPE = "blackjack";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let adminToken: string;
let locationId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  adminToken = (await registerVerifiedPlayer({ app, redis }, { username: "Founder" })).token;

  // Seed a location — resetDb truncates all tables including locations.
  locationId = uuidv7();
  await db.insert(coreLocations).values({ id: locationId, name: "Testville" });
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

const ADMIN_ROUTES: { method: "GET" | "POST"; url: string }[] = [
  { method: "GET", url: "/api/admin/properties" },
  { method: "GET", url: "/api/admin/properties/locations" },
  { method: "GET", url: "/api/admin/properties/types" },
  { method: "POST", url: "/api/admin/properties" },
  { method: "POST", url: "/api/admin/properties/update" },
];

describe("properties admin", () => {
  it("403s a non-admin on every admin route", async () => {
    // One pleb per route, distinct IP (N2): a shared IP risks a rate-limit
    // 429 instead of the 403 under test.
    for (let i = 0; i < ADMIN_ROUTES.length; i++) {
      const pleb = await registerVerifiedPlayer({ app, redis }, { username: `Pleb${i}`, remoteAddress: `10.99.1.${i + 1}` });
      const headers = { authorization: `Bearer ${pleb.token}` };
      const { method, url } = ADMIN_ROUTES[i];
      const res = await app.inject({ method, url, headers, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("creates a property and lists it as a TableRowsResponse", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bullets", cost: "10000" },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };

    const [row] = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.id, id));
    expect(row).toMatchObject({ locationId, pluginId: "bullets", cost: 10000n });

    const list = await app.inject({ method: "GET", url: "/api/admin/properties", headers: auth() });
    expect(list.statusCode).toBe(200);
    const match = (list.json().rows as Record<string, string>[]).find((r) => r.id === id);
    expect(match).toBeDefined();
    expect(match!.locationId).toBe(locationId);
    expect(match!.plugin).toBe("bullets");
    expect(match!.cost).toBe("10000");
  });

  // Was "409s a create for a location that already has a property" under the
  // old unique(location_id) key, using two placeholder pluginIds ("first",
  // "second") that no longer validate. Since 0004_location_plugin_unique the
  // key is (location_id, plugin_id), a second create at the same location
  // only 409s when it repeats the same declared type — a DIFFERENT type now
  // legitimately succeeds. That is exactly what "allows two property types
  // in the same location" below proves (using the two real declared types,
  // bullets and blackjack), including the same-type duplicate 409 as its final
  // step — so this test is folded into that one rather than kept alongside
  // it as a near-duplicate.

  // Was "lists only unclaimed locations in the locations endpoint" under the
  // old unique(location_id) key. Since 0004_location_plugin_unique a claimed
  // location can still take a second property type, so the create form's
  // location select must offer every location, claimed or not — the 409
  // `location_type_taken` guard on the create route is what rejects a
  // genuine duplicate.
  it("lists every location in the locations endpoint, claimed or not", async () => {
    const locationId2 = uuidv7();
    await db.insert(coreLocations).values({ id: locationId2, name: "Othertown" });

    await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bullets", cost: "1000" },
    });

    const res = await app.inject({ method: "GET", url: "/api/admin/properties/locations", headers: auth() });
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Record<string, string>[];
    const ids = rows.map((r) => r.locationId);
    expect(ids).toContain(locationId);
    expect(ids).toContain(locationId2);
  });

  it("updates a property with a blank pluginId and keeps the old value", async () => {
    const propId = uuidv7();
    await db.insert(propertiesPlugin).values({
      id: propId, locationId, pluginId: "city-bank", cost: 10000n, profit: 0n,
    });

    const res = await app.inject({
      method: "POST", url: "/api/admin/properties/update", headers: auth(),
      payload: { id: propId, pluginId: "", cost: "15000" },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.id, propId));
    expect(row).toMatchObject({ pluginId: "city-bank", cost: 15000n });
  });

  it("404s an update to an unknown id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/properties/update", headers: auth(),
      payload: { id: uuidv7(), pluginId: "", cost: "1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a create with a negative cost and leaves the DB unchanged", async () => {
    const before = await db.select().from(propertiesPlugin);
    const beforeCount = before.length;

    const res = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bad", cost: "-5" },
    });
    expect(res.statusCode).toBe(400);

    const after = await db.select().from(propertiesPlugin);
    expect(after).toHaveLength(beforeCount);
  });

  it("lists declared property types for the create form's select", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/admin/properties/types", headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ rows: { pluginId: string; name: string }[] }>().rows;
    expect(rows.map((r) => r.pluginId)).toContain("bullets");
  });

  it("refuses to create a property with an undeclared type", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "not-a-plugin", cost: "0" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe("unknown_property_type");
  });

  // `SECOND_TYPE` is a genuine second declared type, so this is the test that
  // actually distinguishes the new key from the old one: under the OLD
  // unique(location_id), the second create below would 409 just like the final
  // `bullets` repeat does — it would never reach 201. Verified by temporarily
  // reverting 0004 back to a bare location_id index and confirming this exact
  // step turns 409 (see task report for the RED output).
  it("allows two property types in the same location", async () => {
    const first = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bullets", cost: "0" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: SECOND_TYPE, cost: "0" },
    });
    expect(second.statusCode).toBe(201);

    const rows = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.locationId, locationId));
    expect(rows).toHaveLength(2);

    const duplicate = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bullets", cost: "0" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<{ error: string }>().error).toBe("location_type_taken");

    // The failed duplicate insert left no partial or phantom row: still
    // exactly the two rows (bullets, SECOND_TYPE) from before the 409.
    const rowsAfterDuplicate = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.locationId, locationId));
    expect(rowsAfterDuplicate).toHaveLength(2);
  });

  // adminUpdateRoute has its own try/catch on the same `23505` (Fix 1 of the
  // final review pass): under the old unique(location_id), location_id was
  // never updatable so update could never violate the index and needed no
  // guard. Since 0004_location_plugin_unique, pluginId IS updatable, so
  // retyping one row to a type its location already has now can violate the
  // key — and without a catch here, that 23505 was an uncaught 500 on a
  // well-formed admin request.
  it("409s an update that retypes a property to one its location already has", async () => {
    const bullets = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bullets", cost: "0" },
    });
    expect(bullets.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: SECOND_TYPE, cost: "0" },
    });
    expect(second.statusCode).toBe(201);
    const { id: secondId } = second.json() as { id: string };

    const res = await app.inject({
      method: "POST", url: "/api/admin/properties/update", headers: auth(),
      payload: { id: secondId, pluginId: "bullets", cost: "0" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe("location_type_taken");

    // The failed update left the SECOND_TYPE row exactly as it was.
    const [row] = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.id, secondId));
    expect(row).toMatchObject({ pluginId: SECOND_TYPE });
  });

  // Kept alongside the route-level test above rather than as a substitute
  // for it: this one bypasses the admin route (and its registry check,
  // PropertyCreateSchema, and pgErrorCode→PluginError translation) and
  // inserts straight into the table, so it is the tightest possible proof of
  // the DB constraint itself, independent of anything the route layer does.
  // The route-level test above is what proves the constraint is actually
  // reachable, and reachable correctly, through the admin API.
  it("db-level: two different plugin_ids coexist at one location, a repeat collides", async () => {
    await db.insert(propertiesPlugin).values({
      id: uuidv7(), locationId, pluginId: "typeA", cost: 0n, profit: 0n,
    });
    await db.insert(propertiesPlugin).values({
      id: uuidv7(), locationId, pluginId: "typeB", cost: 0n, profit: 0n,
    });
    const rows = await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.locationId, locationId));
    expect(rows).toHaveLength(2);

    await expect(
      db.insert(propertiesPlugin).values({
        id: uuidv7(), locationId, pluginId: "typeA", cost: 0n, profit: 0n,
      }),
    ).rejects.toThrow();
  });

  it("deletes an unowned property", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bullets", cost: "10000" },
    });
    const { id } = create.json() as { id: string };
    const del = await app.inject({ method: "DELETE", url: `/api/admin/properties/${id}`, headers: auth() });
    expect(del.statusCode).toBe(204);
    expect(await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.id, id))).toEqual([]);
  });

  it("refuses deleting an owned property", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/properties", headers: auth(),
      payload: { locationId, pluginId: "bullets", cost: "10000" },
    });
    const { id } = create.json() as { id: string };
    const owner = await registerVerifiedPlayer({ app, redis }, { username: "Deedholder", remoteAddress: "10.99.2.1" });
    await db.update(propertiesPlugin).set({ ownerPlayerId: owner.playerId }).where(eq(propertiesPlugin.id, id));

    const del = await app.inject({ method: "DELETE", url: `/api/admin/properties/${id}`, headers: auth() });
    expect(del.statusCode).toBe(409);
    expect(del.json().error).toBe("property_owned");
    expect((await db.select().from(propertiesPlugin).where(eq(propertiesPlugin.id, id))).length).toBe(1);
  });

  it("404s deleting an unknown property", async () => {
    const del = await app.inject({ method: "DELETE", url: `/api/admin/properties/${uuidv7()}`, headers: auth() });
    expect(del.statusCode).toBe(404);
  });

  it("never renders id as a table column, only as a select's valueKey", () => {
    const idKeys: string[] = [];
    const valueKeys: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node !== "object" || node === null) return;
      const n = node as Record<string, unknown>;
      if (n.kind === "table" && Array.isArray(n.columns)) {
        for (const c of n.columns as { key: string }[]) idKeys.push(c.key);
      }
      if (n.kind === "form" && Array.isArray(n.fields)) {
        for (const f of n.fields as { type: string; valueKey?: string }[]) {
          if (f.type === "select" && f.valueKey !== undefined) valueKeys.push(f.valueKey);
        }
      }
      for (const key of ["children", "items"]) {
        if (Array.isArray(n[key])) for (const child of n[key] as unknown[]) walk(child);
      }
    };
    walk(propertiesAdminPage.view);
    expect(idKeys.filter((k) => /^id$|Id$/.test(k))).toEqual([]);
    expect(valueKeys).toContain("id");
  });
});
