import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import housesPlugin from "@gl3/plugin-houses";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import { playerStats } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

async function seedHouse(name: string, price: number, will: number): Promise<string> {
  const id = crypto.randomUUID();
  // p_houses_houses is plugin-owned; raw SQL keeps this fixture independent of the
  // plugin package's unexported table object.
  await db.execute(
    sql`INSERT INTO p_houses_houses (id, name, price, will) VALUES (${id}, ${name}, ${price}, ${will})`,
  );
  return id;
}

describe("houses plugin", () => {
  let server: Awaited<ReturnType<typeof bootTestServer>>;
  let shackId: string;
  let villaId: string;

  beforeEach(async () => {
    if (!server) server = await bootTestServer({ plugins: [mccodesAttributes, housesPlugin] });
    shackId = await seedHouse("Shack", 500, 150);
    villaId = await seedHouse("Villa", 5000, 300);
  });
  afterAll(async () => { await server.close(); });

  it("lists the catalog with the migration-seeded Default House", async () => {
    const { token } = await registerVerifiedPlayer(server, { remoteAddress: "10.12.1.1" });
    const res = await server.app.inject({
      method: "GET", url: "/api/houses",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currentWillMax).toBe(100);
    expect(body.houses).toHaveLength(3);
    expect(body.houses.map((h: { name: string }) => h.name)).toContain("Default House");
  });

  it("buys an upgrade: pays, resets will, raises maxwill", async () => {
    const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.12.1.2" });
    await db.update(playerStats).set({ cash: 1000n }).where(eq(playerStats.playerId, playerId));

    const res = await server.app.inject({
      method: "POST", url: "/api/houses/buy",
      headers: { authorization: `Bearer ${token}` },
      payload: { houseId: shackId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().willMax).toBe(150);

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.cash).toBe(500n);
    expect(row?.willMax).toBe(150);
    expect(row?.will).toBe(0); // moving house resets will (estate.php:47-51)
  });

  it("refuses downgrades, equal rebuys, and unaffordable houses", async () => {
    const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.12.1.3" });
    await db.update(playerStats).set({ cash: 500n, willMax: 150, will: 0 })
      .where(eq(playerStats.playerId, playerId));

    const downgrade = await server.app.inject({
      method: "POST", url: "/api/houses/buy",
      headers: { authorization: `Bearer ${token}` },
      payload: { houseId: shackId },
    });
    expect(downgrade.statusCode).toBe(409);
    expect(downgrade.json().error).toBe("downgrade_refused");

    const broke = await server.app.inject({
      method: "POST", url: "/api/houses/buy",
      headers: { authorization: `Bearer ${token}` },
      payload: { houseId: villaId },
    });
    expect(broke.statusCode).toBe(409);
    expect(broke.json().error).toBe("insufficient_funds");
  });

  it("sells with a full refund and returns to the Default House", async () => {
    const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.12.1.4" });
    await db.update(playerStats).set({ cash: 5000n, willMax: 300, will: 40 })
      .where(eq(playerStats.playerId, playerId));

    const res = await server.app.inject({
      method: "POST", url: "/api/houses/sell",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().refund).toBe("5000");

    const [row] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(row?.cash).toBe(10000n); // 5000 + 5000 refund
    expect(row?.willMax).toBe(100);
    expect(row?.will).toBe(0);

    const again = await server.app.inject({
      method: "POST", url: "/api/houses/sell",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("no_house_to_sell");
  });
});
