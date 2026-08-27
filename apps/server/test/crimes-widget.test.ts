import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { DashboardWidgetsResponseSchema } from "@gl3/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { crimes } from "../src/db/schema/index.js";
import { seedCrimes } from "../src/db/seed.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let crimeId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, redis, close: closeServer } = await bootTestServer());
  await seedCrimes(db, "v2");

  const [first] = await db.select().from(crimes).where(eq(crimes.name, "Pickpocket"));
  crimeId = first!.id;
});

afterAll(async () => {
  await closeServer();
  await conn.end();
});

describe("crimes on the dashboard (core.dashboard)", () => {
  it("contributes a ready-to-crime widget for a fresh player", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis }, {
      username: "CrimeWidgetReady",
      remoteAddress: "10.14.0.1",
    });

    const res = await app.inject({
      method: "GET", url: "/api/dashboard/widgets", headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { widgets } = DashboardWidgetsResponseSchema.parse(res.json());

    const widget = widgets.find((w) => w.pluginId === "crimes");
    expect(widget).toBeDefined();
    expect(widget!.title).toBe("Crimes");
    if (widget!.view.kind !== "panel") throw new Error("expected a panel view");
    const text = widget!.view.children.find((c) => c.kind === "text");
    expect(text).toBeDefined();
    if (text!.kind !== "text") throw new Error("unreachable");
    expect(text!.value).toBe("A crime is ready.");
    const link = widget!.view.children.find((c) => c.kind === "link");
    expect(link).toEqual({ kind: "link", label: "Go to crimes", to: "/plugins/crimes.index" });
  });

  it("shows the armed cooldown after a commit, proving the sibling ctx reads crimes' own scope", async () => {
    const { token } = await registerVerifiedPlayer({ app, redis }, {
      username: "CrimeWidgetArmed",
      remoteAddress: "10.14.0.2",
    });
    const auth = { authorization: `Bearer ${token}` };

    const commitRes = await app.inject({ method: "POST", url: `/api/crimes/${crimeId}/commit`, headers: auth });
    expect(commitRes.statusCode).toBe(202);

    const res = await app.inject({ method: "GET", url: "/api/dashboard/widgets", headers: auth });
    expect(res.statusCode).toBe(200);
    const { widgets } = DashboardWidgetsResponseSchema.parse(res.json());

    const widget = widgets.find((w) => w.pluginId === "crimes");
    expect(widget).toBeDefined();
    if (widget!.view.kind !== "panel") throw new Error("expected a panel view");
    const text = widget!.view.children.find((c) => c.kind === "text");
    expect(text).toBeDefined();
    if (text!.kind !== "text") throw new Error("unreachable");
    expect(text!.value).toMatch(/^Next crime ready in \d+s$/);
  });
});
