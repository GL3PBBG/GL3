import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { settings } from "../src/db/schema/identity.js";
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
  adminToken = (await registerVerifiedPlayer({ app, redis }, { username: "Founder" })).token;
});

afterAll(async () => { await closeServer(); await conn.end(); });

const auth = () => ({ authorization: `Bearer ${adminToken}` });

describe("detectives admin settings", () => {
  it("lists the three settings at their coded defaults when nothing is stored", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/detectives/settings", headers: auth() });
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ rows: { key: string; label: string; value: string }[] }>().rows;
    expect(rows.map((r) => r.key)).toEqual(["cost", "duration", "expire"]);
    expect(rows.map((r) => r.value)).toEqual(["125000", "3600", "600"]);
  });

  it("upserts the settings rows and reads them back", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/admin/detectives/settings", headers: auth(),
      payload: { cost: "90000", duration: 60, expire: 300 },
    });
    expect(res.statusCode).toBe(204);

    const [row] = await db.select().from(settings).where(eq(settings.key, "detectives.duration"));
    expect(row?.value).toBe("60");

    // The panel reads the TABLE, not the boot snapshot, so it shows what the
    // next boot will read — same posture as bullets' options panel.
    const list = await app.inject({ method: "GET", url: "/api/admin/detectives/settings", headers: auth() });
    expect(list.json<{ rows: { key: string; value: string }[] }>().rows.map((r) => r.value))
      .toEqual(["90000", "60", "300"]);

    // Second write updates in place rather than violating the key PK.
    const again = await app.inject({
      method: "POST", url: "/api/admin/detectives/settings", headers: auth(),
      payload: { cost: "90000", duration: 3600, expire: 300 },
    });
    expect(again.statusCode).toBe(204);
    const [updated] = await db.select().from(settings).where(eq(settings.key, "detectives.duration"));
    expect(updated?.value).toBe("3600");
  });

  it("400s a zero duration and a non-digit cost", async () => {
    const zero = await app.inject({
      method: "POST", url: "/api/admin/detectives/settings", headers: auth(),
      payload: { cost: "1000", duration: 0, expire: 300 },
    });
    expect(zero.statusCode).toBe(400);

    const junk = await app.inject({
      method: "POST", url: "/api/admin/detectives/settings", headers: auth(),
      payload: { cost: "12.50", duration: 60, expire: 300 },
    });
    expect(junk.statusCode).toBe(400);
  });

  it("403s a non-admin caller", async () => {
    const punter = await registerVerifiedPlayer({ app, redis }, {
      username: "Punter", remoteAddress: "10.80.0.2",
    });
    const res = await app.inject({
      method: "GET", url: "/api/admin/detectives/settings",
      headers: { authorization: `Bearer ${punter.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
