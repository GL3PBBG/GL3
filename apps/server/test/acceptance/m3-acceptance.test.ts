import type { AddressInfo } from "node:net";
import { ServerFrameSchema } from "@gl3/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gangInvites, gangs, playerStats, players, roleModuleAccess, roles, transactions } from "../../src/db/schema/index.js";
import { uuidv7 } from "uuidv7";
import { resetDb, testDb } from "../helpers/db.js";
import { bootTestServer } from "../helpers/server.js";

const { db, sql: conn } = testDb();
let app: FastifyInstance;
let closeServer: () => Promise<void>;
let baseUrl: string;

beforeEach(async () => {
  await resetDb(db);
  if (!app) {
    ({ app, close: closeServer } = await bootTestServer());
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}/ws`;
  }
});

afterAll(async () => { await closeServer(); await conn.end(); });

/**
 * Mints the handshake ticket the way a real client would: an authenticated
 * POST. The `/ws` upgrade only accepts a short-lived, single-use ticket in
 * its query string, never a raw session token — see gateway.ts and
 * ws.test.ts's "rejects a connection presenting a raw session token instead
 * of a ticket". Tickets are single-use, so every socket in this test mints
 * its own. Copied from mail.test.ts / gang-invites.test.ts, both of which
 * get this right.
 */
const mintTicket = async (authToken: string): Promise<string> => {
  const res = await app.inject({ method: "POST", url: "/api/ws/ticket", headers: { authorization: `Bearer ${authToken}` } });
  expect(res.statusCode).toBe(201);
  return res.json().ticket;
};

/**
 * Same queueing `open`/`nextFrame` pair as mail.test.ts and
 * gang-invites.test.ts: the gateway sends `ready` synchronously on connect,
 * which on loopback can arrive before a listener attached only after
 * `open()` resolves — `ws` never buffers a `message` event for a
 * not-yet-attached listener. Queueing from a listener attached
 * synchronously inside `open()` closes that gap.
 */
interface FrameQueue { queue: unknown[]; waiting: ((frame: unknown) => void) | null }
const frameQueues = new WeakMap<WebSocket, FrameQueue>();

const open = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const state: FrameQueue = { queue: [], waiting: null };
    frameQueues.set(socket, state);
    socket.on("message", (raw) => {
      const frame: unknown = JSON.parse(raw.toString());
      if (state.waiting) {
        const deliver = state.waiting;
        state.waiting = null;
        deliver(frame);
      } else {
        state.queue.push(frame);
      }
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

const nextFrame = (socket: WebSocket): Promise<unknown> => {
  const state = frameQueues.get(socket);
  if (!state) throw new Error("socket was not opened via open()");
  if (state.queue.length > 0) return Promise.resolve(state.queue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("nextFrame: no frame within 4000ms")), 4000);
    state.waiting = (frame) => { clearTimeout(timer); resolve(frame); };
  });
};

/** sum(transactions.amount) for a WHERE clause, as a bigint, the same shape gang-bank.test.ts's invariant test uses. */
const ledgerSum = async (where: ReturnType<typeof eq>): Promise<bigint> => {
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${transactions.amount}), 0)` }).from(transactions).where(where);
  return BigInt(row?.total ?? "0");
};

describe("M3 acceptance: gangs, mail, notifications, profile, news", () => {
  it("plays the full social loop end to end", async () => {
    // --- gang founded ---
    const boss = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Vito", password: "hunter2hunter2" } });
    const { token: bossToken, playerId: bossId } = boss.json();
    const recruit = await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "Sonny", password: "hunter2hunter2" } });
    const { token: recruitToken, playerId: recruitId } = recruit.json();

    const gangRes = await app.inject({
      method: "POST", url: "/api/gangs", headers: { authorization: `Bearer ${bossToken}` },
      payload: { name: "The Corleones", description: "Family business" },
    });
    expect(gangRes.statusCode).toBe(201);
    const gangId = gangRes.json().id;

    // --- SPEC §6 checkmark 1/2: WS notifies invitees live ---
    const recruitTicket = await mintTicket(recruitToken);
    const recruitSocket = await open(`${baseUrl}?ticket=${recruitTicket}`);
    await nextFrame(recruitSocket); // ready
    const invited = nextFrame(recruitSocket);

    const inviteRes = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/invites`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { username: "Sonny" },
    });
    expect(inviteRes.statusCode).toBe(201);

    // Validated through ServerFrameSchema, not trusted by shape, so a
    // malformed frame fails loudly here rather than passing a weaker check.
    const inviteFrame = ServerFrameSchema.parse(await invited);
    expect(inviteFrame.kind).toBe("event");
    if (inviteFrame.kind !== "event") throw new Error("unreachable");
    expect(inviteFrame.event.type).toBe("notification.created");
    recruitSocket.close();

    const [invite] = await db.select().from(gangInvites).where(eq(gangInvites.invitedPlayerId, recruitId));
    const acceptRes = await app.inject({
      method: "POST", url: `/api/gangs/invites/${invite!.id}/accept`, headers: { authorization: `Bearer ${recruitToken}` },
    });
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().memberCount).toBe(2);

    // --- SPEC §6 checkmark 2/2: gang bank transfers ledgered ---
    await app.inject({
      method: "PUT", url: `/api/gangs/${gangId}/permissions`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { playerId: recruitId, permission: "bank.withdraw" },
    });

    // Registration grants no starting cash (playerStats.cash defaults to 0
    // in identity.ts, and auth/routes.ts inserts with column defaults only)
    // — fund the boss directly, the way gang-bank.test.ts funds its member,
    // before the deposit below. Funded to exactly the deposit amount so the
    // boss's post-deposit cash lands at a clean 0n.
    const DEPOSIT = 1_000n;
    await db.update(playerStats).set({ cash: DEPOSIT }).where(eq(playerStats.playerId, bossId));

    const depositRes = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/deposit`, headers: { authorization: `Bearer ${bossToken}` },
      payload: { amount: "1000" },
    });
    expect(depositRes.statusCode).toBe(200);
    expect(depositRes.json().bank).toBe("1000");

    const withdrawRes = await app.inject({
      method: "POST", url: `/api/gangs/${gangId}/bank/withdraw`, headers: { authorization: `Bearer ${recruitToken}` },
      payload: { amount: "400" },
    });
    expect(withdrawRes.statusCode).toBe(200);
    expect(withdrawRes.json().bank).toBe("600");

    // The ledger, not the HTTP response, is what SPEC §6's "gang bank
    // transfers ledgered" checkmark actually asserts: a 200 with the right
    // `bank` field would still pass if the transactions rows were never
    // written. Reconcile sum(ledger) == balance for the gang and for both
    // players who moved money, the same shape gang-bank.test.ts's 100-op
    // invariant test uses.
    const gangLedgerTotal = await ledgerSum(eq(transactions.gangId, gangId));
    const [gangRow] = await db.select({ bank: gangs.bank }).from(gangs).where(eq(gangs.id, gangId));
    expect(gangRow?.bank).toBe(gangLedgerTotal);
    expect(gangRow?.bank).toBe(600n);

    const bossLedgerTotal = await ledgerSum(eq(transactions.playerId, bossId));
    const [bossStats] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, bossId));
    expect(bossStats?.cash).toBe(DEPOSIT + bossLedgerTotal); // 1000 funded - 1000 deposited = 0

    const recruitLedgerTotal = await ledgerSum(eq(transactions.playerId, recruitId));
    const [recruitStats] = await db.select({ cash: playerStats.cash }).from(playerStats).where(eq(playerStats.playerId, recruitId));
    expect(recruitStats?.cash).toBe(recruitLedgerTotal); // recruit started at 0, then withdrew 400

    const logsRes = await app.inject({ method: "GET", url: `/api/gangs/${gangId}/logs`, headers: { authorization: `Bearer ${bossToken}` } });
    expect(logsRes.json().logs.length).toBeGreaterThanOrEqual(4); // founded, invited, joined, deposit, withdraw

    // --- mail ---
    const mailRes = await app.inject({
      method: "POST", url: "/api/mail", headers: { authorization: `Bearer ${bossToken}` },
      payload: { recipientUsername: "Sonny", subject: "Welcome", body: "Glad to have you." },
    });
    expect(mailRes.statusCode).toBe(201);
    const inboxRes = await app.inject({ method: "GET", url: "/api/mail", headers: { authorization: `Bearer ${recruitToken}` } });
    expect(inboxRes.json().mail).toHaveLength(1);

    // --- game news ---
    const newsRoleId = uuidv7();
    await db.insert(roles).values({ id: newsRoleId, name: "Staff" });
    await db.insert(roleModuleAccess).values({ roleId: newsRoleId, moduleKey: "news" });
    await db.update(players).set({ roleId: newsRoleId }).where(eq(players.id, bossId));

    const newsRes = await app.inject({
      method: "POST", url: "/api/news", headers: { authorization: `Bearer ${bossToken}` },
      payload: { title: "New family in town", body: "The Corleones have arrived." },
    });
    expect(newsRes.statusCode).toBe(201);
    const newsList = await app.inject({ method: "GET", url: "/api/news" });
    expect(newsList.json().news).toHaveLength(1);

    // --- profile reflects gang membership ---
    const profileRes = await app.inject({ method: "GET", url: `/api/players/${recruitId}/profile` });
    expect(profileRes.json()).toMatchObject({ username: "Sonny", gangId, gangName: "The Corleones" });
  });
});
