import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { locations } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let adminToken: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  adminToken = (await registerVerifiedPlayer({ app, redis }, { username: "Founder" })).token; // first registration -> * grant (Task 6)
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe("travel admin", () => {
  it("creates a town and lists it", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "Palermo", travelCost: "500", travelCooldownSeconds: 60 },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json();

    const list = await app.inject({ method: "GET", url: "/api/admin/travel/locations", headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().rows).toEqual([
      { id, name: "Palermo", travelCost: "500", travelCooldownSeconds: "60", combatMode: "open" },
    ]);

    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    expect(row?.travelCost).toBe(500n);
  });

  it("updates a town", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "Palermo", travelCost: "500", travelCooldownSeconds: 60 },
    });
    const { id } = create.json();
    const update = await app.inject({
      method: "POST", url: "/api/admin/travel/locations/update", headers: auth(),
      payload: { id, name: "Corleone", travelCost: "750", travelCooldownSeconds: 90 },
    });
    expect(update.statusCode).toBe(204);
    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    expect(row?.name).toBe("Corleone");
    expect(row?.travelCost).toBe(750n);
  });

  it("404s an update to an unknown id", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/travel/locations/update", headers: auth(),
      payload: { id: "00000000-0000-7000-8000-000000000000", name: "X", travelCost: "1", travelCooldownSeconds: 1 },
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s a negative travel cost", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "X", travelCost: "-5", travelCooldownSeconds: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("admin round-trips combat_mode and refuses junk", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "Hideout", travelCost: "0", travelCooldownSeconds: 0, combatMode: "underground" },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json<{ id: string }>();

    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    expect(row?.combatMode).toBe("underground");

    const bad = await app.inject({
      method: "POST", url: "/api/admin/travel/locations/update", headers: auth(),
      payload: { id, name: "Hideout", travelCost: "0", travelCooldownSeconds: 0, combatMode: "ghost" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toBe("invalid_combat_mode");
  });

  it("treats an empty combatMode (the admin form's untouched select) as unset on create", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "Nowhere", travelCost: "0", travelCooldownSeconds: 0, combatMode: "" },
    });
    expect(create.statusCode).toBe(201);
    const { id } = create.json<{ id: string }>();

    const [row] = await db.select().from(locations).where(eq(locations.id, id));
    expect(row?.combatMode).toBe("open");
  });

  it("preserves the stored combat mode when update omits combatMode or sends the empty-select value", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/admin/travel/locations", headers: auth(),
      payload: { name: "Hideout", travelCost: "0", travelCooldownSeconds: 0, combatMode: "underground" },
    });
    const { id } = create.json<{ id: string }>();

    const omitted = await app.inject({
      method: "POST", url: "/api/admin/travel/locations/update", headers: auth(),
      payload: { id, name: "Hideout", travelCost: "0", travelCooldownSeconds: 0 },
    });
    expect(omitted.statusCode).toBe(204);
    const [afterOmit] = await db.select().from(locations).where(eq(locations.id, id));
    expect(afterOmit?.combatMode).toBe("underground");

    const empty = await app.inject({
      method: "POST", url: "/api/admin/travel/locations/update", headers: auth(),
      payload: { id, name: "Hideout", travelCost: "0", travelCooldownSeconds: 0, combatMode: "" },
    });
    expect(empty.statusCode).toBe(204);
    const [afterEmpty] = await db.select().from(locations).where(eq(locations.id, id));
    expect(afterEmpty?.combatMode).toBe("underground");
  });

  it("403s a non-admin", async () => {
    const p = await registerVerifiedPlayer({ app, redis }, { username: "Pleb" });
    const res = await app.inject({
      method: "GET", url: "/api/admin/travel/locations",
      headers: { authorization: `Bearer ${p.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
