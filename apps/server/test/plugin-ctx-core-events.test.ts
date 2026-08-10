import { GameEventSchema, type GameEvent } from "@gl3/shared";
import type { CoreEventInput } from "@gl3/plugin-sdk";
import { randomUUID } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAME_EVENTS_CHANNEL } from "../src/bus/publish.js";
import { loadConfig } from "../src/config.js";
import { players, playerStats } from "../src/db/schema/index.js";
import { createPluginCtx } from "../src/plugins/ctx.js";
import { createRedis, createSubscriber } from "../src/redis.js";
import { testDb } from "./helpers/db.js";

const { db, sql: conn } = testDb();
const redis = createRedis(loadConfig(process.env).redisUrl);
const subscriber = createSubscriber(loadConfig(process.env).redisUrl);

beforeAll(async () => { await subscriber.subscribe(GAME_EVENTS_CHANNEL); });
afterAll(async () => { await conn.end(); redis.disconnect(); subscriber.disconnect(); });

async function createPlayer(): Promise<{ id: string; username: string }> {
  const id = uuidv7();
  // Whole uuid, not a prefix: uuidv7's leading hex is the millisecond
  // timestamp, so two players minted in the same tick collide on the
  // `players_username_unique` index.
  const username = `pcce${id}`;
  await db.insert(players).values({ id, username });
  await db.insert(playerStats).values({ playerId: id });
  return { id, username };
}

// A prefix unique to this file's run, for the same reason bootTestServer has
// one: Redis is shared across every concurrently-running test file, so a
// shared `leaderboard:*` key would let two files see each other's scores.
const leaderboardPrefix = `pcce-test-${randomUUID()}`;

const deps = (): Parameters<typeof createPluginCtx>[0] =>
  ({ db, redis, queues: new Map(), settings: {}, leaderboardPrefix });
const opts = { pluginId: "t", player: null, job: null, filters: [] };

/**
 * `game:events` is one global channel shared by every test file running in
 * parallel (NOTES.md rule 4), so this filters on the freshly-minted actorId.
 * Local rather than `awaitOwnEvent` because these cases need to collect
 * SEVERAL frames, and the rollback case needs the timeout to be the success.
 */
function watchOwnEvents(actorId: string, expected: number): { seen: GameEvent[]; settled: Promise<void> } {
  const seen: GameEvent[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });
  const onMessage = (channel: string, raw: string): void => {
    if (channel !== GAME_EVENTS_CHANNEL) return;
    const parsed = GameEventSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.actorId !== actorId) return;
    seen.push(parsed.data);
    if (seen.length >= expected) resolveDone();
  };
  subscriber.on("message", onMessage);
  const settled = Promise.race([done, new Promise<void>((r) => setTimeout(r, 1500))])
    .then(() => { subscriber.off("message", onMessage); });
  return { seen, settled };
}

/**
 * One sample per core variant, built by the plugin-facing shape: no `id`, no
 * `at`. `actorId`/`actorName` are filled per-test from a fresh player, so the
 * corpus carries placeholders the test overwrites.
 */
type CorpusEntry = Omit<CoreEventInput, "actorId" | "actorName">;

const UUID_A = "01920000-0000-7000-8000-00000000000a";
const UUID_B = "01920000-0000-7000-8000-00000000000b";
const AT = "2026-08-10T00:00:00.000Z";

const CORPUS: readonly CorpusEntry[] = [
  { type: "crime.resolved", audience: { kind: "global" }, crimeId: UUID_A, crimeName: "Rob a store", success: true, payout: "500", bullets: "2", exp: "10", jailedUntil: null },
  { type: "player.jailed", audience: { kind: "global" }, until: AT, reason: "failed a crime" },
  { type: "player.released", audience: { kind: "global" } },
  { type: "player.travelled", audience: { kind: "global" }, fromLocationId: null, toLocationId: UUID_A, cost: "100" },
  { type: "player.attacked", audience: { kind: "global" }, targetId: UUID_A, targetName: "Sollozzo", damage: 12 },
  { type: "player.killed", audience: { kind: "global" }, victimId: UUID_A, victimName: "Sollozzo" },
  { type: "bounty.placed", audience: { kind: "global" }, bountyId: UUID_A, targetId: UUID_B, targetName: "Sollozzo", amount: "1000" },
  { type: "bounty.claimed", audience: { kind: "global" }, bountyId: UUID_A, targetId: UUID_B, targetName: "Sollozzo", amount: "1000" },
  { type: "gang.created", audience: { kind: "global" }, gangId: UUID_A, gangName: "Corleone" },
  { type: "gang.memberJoined", audience: { kind: "gang", gangId: UUID_A }, gangId: UUID_A },
  { type: "gang.memberLeft", audience: { kind: "gang", gangId: UUID_A }, gangId: UUID_A },
  { type: "mail.received", audience: { kind: "player", playerId: UUID_A }, mailId: UUID_B, recipientId: UUID_A, subject: "Business" },
  { type: "notification.created", audience: { kind: "player", playerId: UUID_A }, notificationId: UUID_B, body: "You have mail." },
  { type: "news.posted", audience: { kind: "global" }, newsId: UUID_A, title: "Round 2 begins" },
  { type: "chat.message", audience: { kind: "global" }, body: "Leave the gun." },
  { type: "player.joined", audience: { kind: "global" } },
  { type: "player.rankedUp", audience: { kind: "global" }, rankId: UUID_A, rankName: "Thug", cashReward: "250", bulletReward: "5", maxHealth: 120 },
  { type: "bank.transacted", audience: { kind: "player", playerId: UUID_A }, direction: "deposit", amount: "100", cash: "900", bank: "100" },
  { type: "bullets.purchased", audience: { kind: "player", playerId: UUID_A }, locationId: UUID_A, quantity: 5, cost: "500", cash: "500", bullets: "5" },
];

describe("tx.events.publishCore", () => {
  /**
   * The drift guard. `CoreEventInput` is DERIVED from `GameEventSchema`, so a
   * twentieth core variant reaches the SDK for free — and would reach the wire
   * completely untested. This fails the moment a variant is added without a
   * corpus entry, which is the prompt to add one.
   */
  it("covers every core variant declared by GameEventSchema", () => {
    const covered = new Set(CORPUS.map((e) => e.type));
    const declared = [...GameEventSchema.optionsMap.keys()]
      .filter((t): t is string => typeof t === "string" && t !== "plugin.event");
    expect(declared.filter((t) => !covered.has(t as CorpusEntry["type"]))).toEqual([]);
    expect(CORPUS).toHaveLength(declared.length);
  });

  it("publishes every core variant verbatim, with core-filled id and at", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(player.id, CORPUS.length);

    await ctx.transaction(async (tx) => {
      for (const entry of CORPUS) {
        await tx.events.publishCore({
          ...entry, actorId: player.id, actorName: player.username,
        } as CoreEventInput);
      }
    });

    await watch.settled;
    expect(watch.seen.map((e) => e.type)).toEqual(CORPUS.map((e) => e.type));
    for (const event of watch.seen) {
      // Not `plugin.event`: the whole point is that these are indistinguishable
      // from core's own emissions on the wire.
      expect(event.type).not.toBe("plugin.event");
      expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(() => new Date(event.at).toISOString()).not.toThrow();
    }
  });

  it("preserves call order across publish and publishCore", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(player.id, 3);

    await ctx.transaction(async (tx) => {
      await tx.events.publishCore({
        type: "news.posted", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, newsId: UUID_A, title: "first",
      });
      await tx.events.publish({
        name: "middle", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, payload: {},
      });
      await tx.events.publishCore({
        type: "chat.message", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, body: "last",
      });
    });

    await watch.settled;
    expect(watch.seen.map((e) => e.type)).toEqual(["news.posted", "plugin.event", "chat.message"]);
  });

  it("drops a buffered core event when the transaction rolls back", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(player.id, 1);

    await expect(ctx.transaction(async (tx) => {
      await tx.events.publishCore({
        type: "news.posted", actorId: player.id, actorName: player.username,
        audience: { kind: "global" }, newsId: UUID_A, title: "never",
      });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    await watch.settled;
    expect(watch.seen).toEqual([]);
  });
});

describe("plugin economy changes update the leaderboard", () => {
  const score = async (kind: "cash" | "bank" | "exp", playerId: string): Promise<string | null> =>
    await redis.zscore(`${leaderboardPrefix}:${kind}`, playerId);

  it("records the committed balance for a cash change", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await ctx.transaction(async (tx) => {
      await tx.economy.applyBalanceChange({
        playerId: player.id, amount: 750n, kind: "cash", reason: "plugin_test",
      });
    });

    expect(await score("cash", player.id)).toBe("750");
  });

  it("records only the FINAL balance when one transaction moves cash twice", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await ctx.transaction(async (tx) => {
      await tx.economy.applyBalanceChange({ playerId: player.id, amount: 500n, kind: "cash", reason: "a" });
      await tx.economy.applyBalanceChange({ playerId: player.id, amount: -200n, kind: "cash", reason: "b" });
    });

    expect(await score("cash", player.id)).toBe("300");
  });

  it("records exp after addExp", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await ctx.transaction(async (tx) => { await tx.economy.addExp(player.id, 42n); });

    expect(await score("exp", player.id)).toBe("42");
  });

  // Regression for the zero-gain case: core's addExp (economy/ledger.ts)
  // is a no-op on amount === 0n — no UPDATE, so no row lock. Buffering a
  // score here would be an unlocked read that could ZADD a stale snapshot
  // over a newer committed value. A zero gain is the ordinary failed-action
  // case, so this must leave the leaderboard key untouched, not merely
  // "eventually correct."
  it("does not touch the leaderboard when addExp gains zero", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await ctx.transaction(async (tx) => { await tx.economy.addExp(player.id, 0n); });

    expect(await score("exp", player.id)).toBeNull();
  });

  it("writes nothing when the transaction rolls back", async () => {
    const player = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);

    await expect(ctx.transaction(async (tx) => {
      await tx.economy.applyBalanceChange({ playerId: player.id, amount: 900n, kind: "cash", reason: "rolled_back" });
      throw new Error("boom");
    })).rejects.toThrow("boom");

    expect(await score("cash", player.id)).toBeNull();
  });
});

describe("tx.notify", () => {
  it("publishes notification.created addressed to the NOTIFIED player", async () => {
    const actor = await createPlayer();
    const recipient = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    // Filters on the recipient, not the actor — that is the assertion.
    const watch = watchOwnEvents(recipient.id, 1);

    await ctx.transaction(async (tx) => { await tx.notify(recipient.id, "You have mail."); });

    await watch.settled;
    expect(watch.seen).toHaveLength(1);
    const event = watch.seen[0];
    if (event?.type !== "notification.created") throw new Error(`expected notification.created, got ${String(event?.type)}`);
    expect(event.actorId).toBe(recipient.id);
    expect(event.actorName).toBe(recipient.username);
    expect(event.audience).toEqual({ kind: "player", playerId: recipient.id });
    expect(event.body).toBe("You have mail.");
    expect(event.notificationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(actor.id).not.toBe(event.actorId);
  });

  it("publishes nothing when the transaction rolls back", async () => {
    const recipient = await createPlayer();
    const ctx = createPluginCtx(deps(), opts);
    const watch = watchOwnEvents(recipient.id, 1);

    await expect(ctx.transaction(async (tx) => {
      await tx.notify(recipient.id, "never sent");
      throw new Error("boom");
    })).rejects.toThrow("boom");

    await watch.settled;
    expect(watch.seen).toEqual([]);
  });
});
