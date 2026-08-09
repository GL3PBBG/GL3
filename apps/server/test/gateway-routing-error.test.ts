import { createServer, type Server } from "node:http";
import type { GameEvent } from "@gl3/shared";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishEvent } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { createDb } from "../src/db/client.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { attachGateway, type GatewayHandle } from "../src/ws/gateway.js";

/**
 * gateway.ts's `route` (the "gang" branch) queries Postgres. Before this
 * fix, `attachGateway` drove it as `void route(event)` with no `.catch` —
 * any rejection (a DB error mid-teardown, a transient network blip in
 * production) became an unhandled rejection, which can take the whole
 * process down and drop every connected socket. bus/subscribe.ts already
 * states this exact intent for a malformed frame ("must not take this
 * process down"); the DB path had no equivalent guard.
 *
 * Ending the connection *before* publishing makes the query fail
 * deterministically on every subsequent call — not a race against an
 * in-flight query — which is what lets this be a real RED/GREEN proof
 * instead of a flaky one. No mocks: this is a real Postgres connection,
 * genuinely closed, and a real Redis pub/sub round trip (CLAUDE.md: no
 * mocks for DB, queue or bus paths).
 */
describe("WS gateway: routing errors don't crash the process", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("catches a failed `gang` route instead of leaving an unhandled rejection", async () => {
    const config = loadConfig({ ...process.env, NODE_ENV: "test" });
    const { db, sql } = createDb(config.databaseUrl);
    const redis = createRedis(config.redisUrl);
    const subscriber = createSubscriber(config.redisUrl);
    const publisher = createRedis(config.redisUrl);
    const server: Server = createServer();
    let gateway: GatewayHandle | undefined;

    cleanup = async () => {
      await gateway?.close();
      redis.disconnect();
      subscriber.disconnect();
      publisher.disconnect();
      server.close();
    };

    gateway = await attachGateway(server, { db, redis, subscriber, corsOrigins: [] });

    // Deterministically fail every subsequent query on this connection —
    // the same shape as a query killed during teardown (isolated-db.setup.ts
    // does exactly this to this file's own database once the suite ends).
    await sql.end();

    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);

    const errorCalls: unknown[][] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errorCalls.push(args); });

    try {
      const event: GameEvent = {
        id: uuidv7(), type: "gang.memberJoined", at: new Date().toISOString(),
        actorId: uuidv7(), actorName: "Vito", audience: { kind: "gang", gangId: uuidv7() },
        gangId: uuidv7(),
      };
      await publishEvent(publisher, event);

      // Wait for the actual completion signal — the caught error being
      // logged — rather than a fixed sleep, so this isn't timing-dependent.
      await vi.waitFor(() => { expect(errorCalls.length).toBeGreaterThan(0); }, { timeout: 2000, interval: 20 });

      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      errorSpy.mockRestore();
    }
  });
});
