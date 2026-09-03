import { eq } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { players, pushDevices } from "../src/db/schema/index.js";
import { disableDevice } from "../src/push/devices.js";
import { EXPO_SEND_URL, sendExpoPush, type ExpoPushMessage } from "../src/push/sender.js";
import { resetDb, testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();

beforeEach(async () => { await resetDb(db); });
afterAll(async () => { await conn.end(); });

const message = (token: string): ExpoPushMessage => ({
  to: token,
  title: "New mail from Vito",
  body: "Meet me at the docks",
  data: { path: "/mail", eventId: uuidv7(), type: "mail.received" },
  channelId: "default",
  priority: "high",
});

const okTickets = (n: number): Response =>
  new Response(JSON.stringify({ data: Array.from({ length: n }, () => ({ status: "ok", id: "t" })) }), {
    status: 200, headers: { "content-type": "application/json" },
  });

const noopDeadToken = async (): Promise<void> => undefined;

async function seedDevice(token: string): Promise<string> {
  const playerId = uuidv7();
  await db.insert(players).values({ id: playerId, username: `push_${playerId.slice(-8)}` });
  await db.insert(pushDevices).values({ id: uuidv7(), playerId, expoToken: token, platform: "android" });
  return playerId;
}

describe("sendExpoPush", () => {
  it("chunks 250 messages into three calls of 100, 100 and 50", async () => {
    const calls: ExpoPushMessage[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      calls.push(batch);
      return okTickets(batch.length);
    }) as unknown as typeof fetch;

    const messages = Array.from({ length: 250 }, (_, i) => message(`ExponentPushToken[t${i}]`));
    const result = await sendExpoPush(messages, { fetch: fetchImpl, accessToken: null, onDeadToken: noopDeadToken });

    expect(calls.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(result).toEqual({ sent: 250, failed: 0 });
  });

  it("POSTs to Expo's send endpoint with the Authorization header only when a token is configured", async () => {
    const headers: (Record<string, string> | undefined)[] = [];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      headers.push(init?.headers as Record<string, string> | undefined);
      return okTickets(1);
    }) as unknown as typeof fetch;

    await sendExpoPush([message("ExponentPushToken[a]")], { fetch: fetchImpl, accessToken: "expo_abc", onDeadToken: noopDeadToken });
    await sendExpoPush([message("ExponentPushToken[a]")], { fetch: fetchImpl, accessToken: null, onDeadToken: noopDeadToken });

    expect(urls).toEqual([EXPO_SEND_URL, EXPO_SEND_URL]);
    expect(headers[0]!.authorization).toBe("Bearer expo_abc");
    expect(headers[1]!.authorization).toBeUndefined();
    expect(headers[0]!["content-type"]).toBe("application/json");
  });

  it("disables only the token whose ticket says DeviceNotRegistered", async () => {
    const dead = "ExponentPushToken[dead]";
    const alive = "ExponentPushToken[alive]";
    await seedDevice(dead);
    await seedDevice(alive);

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } },
        { status: "ok", id: "t" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    const result = await sendExpoPush([message(dead), message(alive)], {
      fetch: fetchImpl, accessToken: null, onDeadToken: (token) => disableDevice(db, token),
    });

    expect(result).toEqual({ sent: 1, failed: 1 });
    const [deadRow] = await db.select().from(pushDevices).where(eq(pushDevices.expoToken, dead));
    const [aliveRow] = await db.select().from(pushDevices).where(eq(pushDevices.expoToken, alive));
    expect(deadRow!.disabledAt).not.toBeNull();
    expect(aliveRow!.disabledAt).toBeNull();
  });

  it("counts a 500 from Expo as failed and throws nothing", async () => {
    const fetchImpl = vi.fn(async () => new Response("upstream boom", { status: 500 })) as unknown as typeof fetch;
    const result = await sendExpoPush([message("ExponentPushToken[a]"), message("ExponentPushToken[b]")], {
      fetch: fetchImpl, accessToken: null, onDeadToken: noopDeadToken,
    });
    expect(result).toEqual({ sent: 0, failed: 2 });
  });

  it("counts a rejected transport as failed and throws nothing", async () => {
    const fetchImpl = vi.fn(async () => { throw new DOMException("The operation was aborted.", "AbortError"); }) as unknown as typeof fetch;
    const result = await sendExpoPush([message("ExponentPushToken[a]")], {
      fetch: fetchImpl, accessToken: null, onDeadToken: noopDeadToken,
    });
    expect(result).toEqual({ sent: 0, failed: 1 });
  });

  it("counts an unrecognised response body as failed rather than throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nope: true }), {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const result = await sendExpoPush([message("ExponentPushToken[a]")], {
      fetch: fetchImpl, accessToken: null, onDeadToken: noopDeadToken,
    });
    expect(result).toEqual({ sent: 0, failed: 1 });
  });

  it("makes no HTTP call at all for an empty message list", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await sendExpoPush([], { fetch: fetchImpl, accessToken: null, onDeadToken: noopDeadToken });
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
