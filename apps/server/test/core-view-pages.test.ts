import { FormValuesResponseSchema, PluginsPayloadSchema, TableRowsResponseSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats } from "../src/db/schema/index.js";
import { seedLocations } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * The three world-hook plugins' view-node pages (spec
 * 2026-09-18-core-view-pages-design §5): a client that renders a plugin page
 * from the view vocabulary — the Godot client does — must find a real view
 * behind each door, and every `source`/`action` in it must be a route this
 * boot actually serves. `apps/web` is unaffected: `PAGE_OVERRIDES` still wins
 * there, so nothing here asserts anything about the browser.
 */
const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;

beforeAll(async () => { ({ app, close: closeServer, redis } = await bootTestServer()); });
beforeEach(async () => { await resetDb(db); await seedLocations(db); });
afterAll(async () => { await closeServer(); await conn.end(); });

const get = (url: string, token: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, token: string, payload?: unknown) =>
  app.inject({
    method: "POST", url, headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

describe("bank.index", () => {
  it("declares a real view whose sources are served", async () => {
    const { token, playerId } = await registerVerifiedPlayer({ app, redis });
    const payload = PluginsPayloadSchema.parse((await get("/api/plugins", token)).json());
    const page = payload.pages.find((p) => p.id === "bank.index")!;
    expect(JSON.stringify(page.view)).toContain("GET /api/bank/summary");
    expect(JSON.stringify(page.view)).toContain("POST /api/bank/deposit");
    expect(JSON.stringify(page.view)).toContain("POST /api/bank/withdraw");

    await db.update(playerStats).set({ cash: 1500n, bank: 250n }).where(eq(playerStats.playerId, playerId));
    const summary = FormValuesResponseSchema.parse((await get("/api/bank/summary", token)).json());
    expect(summary.values).toMatchObject({ cash: "1500", bank: "250", account: "open" });

    expect((await post("/api/bank/deposit", token, { amount: "500" })).statusCode).toBe(200);
    const after = FormValuesResponseSchema.parse((await get("/api/bank/summary", token)).json());
    expect(after.values).toMatchObject({ cash: "1000", bank: "750" });
  });
});
