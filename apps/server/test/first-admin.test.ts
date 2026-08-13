import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { players, roleModuleAccess, roles } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer } = await bootTestServer());
});

afterAll(async () => { await closeServer(); await conn.end(); });

async function register(username: string) {
  const res = await app.inject({
    method: "POST", url: "/api/auth/register",
    payload: { username, password: "hunter2hunter2" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { playerId: string; token: string };
}

async function grantsOf(playerId: string): Promise<string[]> {
  const rows = await db
    .select({ moduleKey: roleModuleAccess.moduleKey })
    .from(players)
    .innerJoin(roleModuleAccess, eq(roleModuleAccess.roleId, players.roleId))
    .where(eq(players.id, playerId));
  return rows.map((r) => r.moduleKey);
}

describe("first registered player becomes admin", () => {
  it("gives the very first player the Administrator role with *", async () => {
    const first = await register("Founder");
    expect(await grantsOf(first.playerId)).toEqual(["*"]);
    const [role] = await db.select().from(roles);
    expect(role?.name).toBe("Administrator");
  });

  it("gives the second player no role", async () => {
    await register("Founder");
    const second = await register("Latecomer");
    expect(await grantsOf(second.playerId)).toEqual([]);
    const [row] = await db.select({ roleId: players.roleId }).from(players)
      .where(eq(players.id, second.playerId));
    expect(row?.roleId).toBeNull();
  });

  it("exactly one admin under concurrent first registrations", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        app.inject({
          method: "POST", url: "/api/auth/register",
          payload: { username: `Racer${i}`, password: "hunter2hunter2" },
        }),
      ),
    );
    const created = results.filter((r) => r.statusCode === 201);
    expect(created.length).toBeGreaterThanOrEqual(2);
    const admins = await db.select({ id: players.id }).from(players)
      .innerJoin(roles, eq(players.roleId, roles.id));
    expect(admins).toHaveLength(1);
  });
});
