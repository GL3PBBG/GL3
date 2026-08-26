import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { playerStats } from "../src/db/schema/index.js";
import { resetDb, testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

/**
 * The optional account-open fee (C spec §5.4). The zero-fee default — every
 * existing bank byte identical — is proven by bank.test.ts running unchanged
 * with no `bank.open_fee` row; these tests are the fee>0 world, which needs
 * the settings row in place BEFORE boot (settings load once at startup).
 */
describe("bank.open_fee", () => {
  let server: Awaited<ReturnType<typeof bootTestServer>>;

  beforeEach(async () => {
    await resetDb(db);
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('bank.open_fee', '500')`);
    if (!server) server = await bootTestServer();
  });
  afterAll(async () => { if (server) await server.close(); });

  it("refuses a deposit from an unopened account, then opens, charges once, and works", async () => {
    const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.17.1.1" });
    const auth = { authorization: `Bearer ${token}` };

    const blocked = await server.app.inject({
      method: "POST", url: "/api/bank/deposit", headers: auth, payload: { amount: "50" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("account_not_opened");

    // Broke: the fee itself is unaffordable.
    const broke = await server.app.inject({ method: "POST", url: "/api/bank/open", headers: auth });
    expect(broke.statusCode).toBe(409);
    expect(broke.json().error).toBe("insufficient_funds");

    await db.update(playerStats).set({ cash: 600n }).where(eq(playerStats.playerId, playerId));
    const opened = await server.app.inject({ method: "POST", url: "/api/bank/open", headers: auth });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().fee).toBe("500");

    const [afterOpen] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(afterOpen?.cash).toBe(100n);

    const deposit = await server.app.inject({
      method: "POST", url: "/api/bank/deposit", headers: auth, payload: { amount: "50" },
    });
    expect(deposit.statusCode).toBe(200);
    expect(deposit.json()).toMatchObject({ cash: "50", bank: "50" });

    // Idempotent: a second open charges nothing.
    const again = await server.app.inject({ method: "POST", url: "/api/bank/open", headers: auth });
    expect(again.statusCode).toBe(200);
    expect(again.json().fee).toBe("0");
    const [final] = await db.select().from(playerStats).where(eq(playerStats.playerId, playerId));
    expect(final?.cash).toBe(50n);
  });

  it("never gates withdrawals — only deposits", async () => {
    const { token, playerId } = await registerVerifiedPlayer(server, { remoteAddress: "10.17.1.2" });
    await db.update(playerStats).set({ bank: 100n }).where(eq(playerStats.playerId, playerId));
    const res = await server.app.inject({
      method: "POST", url: "/api/bank/withdraw",
      headers: { authorization: `Bearer ${token}` },
      payload: { amount: "40" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ cash: "40", bank: "60" });
  });
});
