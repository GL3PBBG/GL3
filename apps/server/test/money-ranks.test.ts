import { ProfileDtoSchema, RankListResponseSchema } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { moneyRanks, playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let redis: Redis;
let closeServer: () => Promise<void>;
let token: string;
let playerId: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) ({ app, close: closeServer, redis } = await bootTestServer());
  ({ token, playerId } = await registerVerifiedPlayer({ app, redis }, { username: "Moneybags" }));
});

afterAll(async () => { await closeServer(); await conn.end(); });

const seed = async (rows: { label: string; threshold: bigint }[]): Promise<void> => {
  await db.delete(moneyRanks);
  await db.insert(moneyRanks).values(rows.map((r) => ({ id: uuidv7(), ...r })));
};

const getProfile = () => app.inject({ method: "GET", url: `/api/players/${playerId}/profile` });

describe("money rank bracket on the public profile", () => {
  it("picks the highest bracket at or below cash+bank", async () => {
    await seed([
      { label: "Broke", threshold: 0n },
      { label: "Comfortable", threshold: 10_000n },
      { label: "Rich", threshold: 1_000_000n },
    ]);
    await db.update(playerStats).set({ cash: 9_000n, bank: 2_000n })
      .where(eq(playerStats.playerId, playerId));

    const dto = ProfileDtoSchema.parse((await getProfile()).json());
    expect(dto.moneyRankLabel).toBe("Comfortable");
  });

  it("includes a player sitting exactly on the threshold", async () => {
    await seed([{ label: "Broke", threshold: 0n }, { label: "Rich", threshold: 1_000n }]);
    await db.update(playerStats).set({ cash: 1_000n, bank: 0n })
      .where(eq(playerStats.playerId, playerId));

    const dto = ProfileDtoSchema.parse((await getProfile()).json());
    expect(dto.moneyRankLabel).toBe("Rich");
  });

  it("returns null below the lowest threshold", async () => {
    await seed([{ label: "Rich", threshold: 1_000n }]);
    await db.update(playerStats).set({ cash: 10n, bank: 0n })
      .where(eq(playerStats.playerId, playerId));

    const dto = ProfileDtoSchema.parse((await getProfile()).json());
    expect(dto.moneyRankLabel).toBeNull();
  });

  it("returns null when the table is empty rather than erroring", async () => {
    await db.delete(moneyRanks);
    const res = await getProfile();
    expect(res.statusCode).toBe(200);
    expect(ProfileDtoSchema.parse(res.json()).moneyRankLabel).toBeNull();
  });

  it("sums cash and bank, not either alone", async () => {
    await seed([{ label: "Rich", threshold: 1_000n }]);
    await db.update(playerStats).set({ cash: 600n, bank: 600n })
      .where(eq(playerStats.playerId, playerId));
    const dto = ProfileDtoSchema.parse((await getProfile()).json());
    expect(dto.moneyRankLabel).toBe("Rich");
  });

  /**
   * The bracket is public; the figure is not. This is the guard on the
   * payload widening — cash and bank are SELECTed to compute the label and
   * must never appear in the response.
   */
  it("never returns a cash or bank figure", async () => {
    await seed([{ label: "Rich", threshold: 0n }]);
    await db.update(playerStats).set({ cash: 1_234_567n, bank: 0n })
      .where(eq(playerStats.playerId, playerId));
    const body = (await getProfile()).json();
    expect(body).not.toHaveProperty("cash");
    expect(body).not.toHaveProperty("bank");
    expect(JSON.stringify(body)).not.toContain("1234567");
  });

  it("returns the lifetime backfire count", async () => {
    await db.update(playerStats).set({ backfire: 4 }).where(eq(playerStats.playerId, playerId));
    const dto = ProfileDtoSchema.parse((await getProfile()).json());
    expect(dto.backfire).toBe(4);
  });
});

describe("GET /api/ranks money ladder", () => {
  it("serves the ladder ascending by threshold", async () => {
    await seed([
      { label: "Rich", threshold: 1_000n },
      { label: "Broke", threshold: 0n },
    ]);
    const res = RankListResponseSchema.parse(
      (await app.inject({ method: "GET", url: "/api/ranks", headers: { authorization: `Bearer ${token}` } })).json(),
    );
    expect(res.moneyRanks.map((m) => m.label)).toEqual(["Broke", "Rich"]);
    expect(res.moneyRanks[0]?.threshold).toBe("0");
  });
});
