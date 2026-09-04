import type { GameEvent } from "@gl3/shared";
import { eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { subscribeToEvents } from "../bus/subscribe.js";
import type { Db } from "../db/client.js";
import { gangMembers } from "../db/schema/index.js";
import { PRESENCE_KEY } from "../presence/touch.js";
import { disableDevice, enabledDevicesForPlayer } from "./devices.js";
import { pushMessageFor } from "./message.js";
import { sendExpoPush, type ExpoPushMessage } from "./sender.js";

/**
 * How fresh a presence score has to be for a push to be skipped as
 * redundant. 120s, NOT the 5 minutes `PRESENCE_ONLINE_WINDOW_MS` uses for the
 * /api/online listing: that window answers "who is around", where generosity
 * is a feature, while this one answers "is this person already looking at
 * it", where four minutes of staleness means a player who put their phone
 * down gets nothing. A product decision, so a constant rather than an
 * environment variable.
 *
 * `touchPresence` runs on every authenticated request, so a foregrounded app
 * making any API call keeps its own score fresh. That is an optimisation, not
 * the correctness guarantee — an idle foregrounded app holding only a
 * WebSocket takes no authenticated HTTP requests and goes stale. The
 * guarantee is on the device: the app's foreground handler declines to show a
 * system banner because the in-app toast already covers that case.
 */
export const PUSH_ONLINE_SUPPRESS_MS = 120_000;

/** Orders of magnitude past any legitimate redelivery — the outbox backoff caps at 60s. */
const CLAIM_TTL_SECONDS = 3600;

export interface PushSubscriberDeps {
  db: Db;
  /** Command client: ZSCORE for presence, SET NX for the send claim. */
  redis: Redis;
  /** Dedicated subscribed client — a subscribed client runs no other commands. */
  subscriber: Redis;
  accessToken: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface PushSubscriberHandle { close(): Promise<void> }

async function recipientsOf(db: Db, event: GameEvent): Promise<string[]> {
  switch (event.audience.kind) {
    case "player":
      return [event.audience.playerId];
    case "gang": {
      const rows = await db.select({ playerId: gangMembers.playerId })
        .from(gangMembers).where(eq(gangMembers.gangId, event.audience.gangId));
      return rows.map((row) => row.playerId);
    }
    case "global":
      // Never pushed in v1: a whole-table fan-out needs segmentation, rate
      // thinking and an opt-out first. This deliberately excludes
      // round.finished.
      return [];
  }
}

async function isRecentlyPresent(redis: Redis, playerId: string, now: number): Promise<boolean> {
  const score = await redis.zscore(PRESENCE_KEY, playerId);
  if (score === null) return false;
  return Number(score) >= now - PUSH_ONLINE_SUPPRESS_MS;
}

async function handleEvent(event: GameEvent, deps: PushSubscriberDeps, now: () => number): Promise<void> {
  const recipients = await recipientsOf(deps.db, event);
  if (recipients.length === 0) return;

  const messages: ExpoPushMessage[] = [];
  for (const playerId of recipients) {
    // Build first: an unmapped or self-suppressed event must not burn a claim.
    const content = pushMessageFor(event, playerId);
    if (content === null) continue;

    // Then presence: an online player's skipped push must not consume the
    // idempotency slot a later legitimate redelivery would need.
    if (await isRecentlyPresent(deps.redis, playerId, now())) continue;

    // Then the claim. The NX OUTCOME is the decision (rule 2) — never a read
    // followed by a write. "OK" means this process won the right to send.
    const claimed = await deps.redis.set(
      `push:sent:${event.id}:${playerId}`, "1", "EX", CLAIM_TTL_SECONDS, "NX",
    );
    if (claimed !== "OK") continue;

    for (const device of await enabledDevicesForPlayer(deps.db, playerId)) {
      messages.push({
        to: device.expoToken,
        title: content.title,
        body: content.body,
        data: { path: content.path, eventId: event.id, type: event.type },
        channelId: "default",
        priority: "high",
      });
    }
  }

  if (messages.length === 0) return;
  await sendExpoPush(messages, {
    fetch: deps.fetchImpl ?? fetch,
    accessToken: deps.accessToken,
    onDeadToken: (token) => disableDevice(deps.db, token),
  });
}

/**
 * A second subscriber on the gateway's own `game:events` fan-out. Started
 * from index.ts, OUTSIDE buildApp, guarded by `config.push.enabled` — the
 * same placement and the same reason as `startOutboxLoop` and the sentence
 * sweeper: every integration test builds its server through
 * buildApp/bootTestServer, and a background subscriber firing HTTP requests
 * under those tests would race a whole class of them. The dispatch test
 * constructs it explicitly instead.
 */
export async function startPushSubscriber(deps: PushSubscriberDeps): Promise<PushSubscriberHandle> {
  const now = deps.now ?? ((): number => Date.now());
  const onError = deps.onError ?? ((error: unknown): void => {
    console.error({ err: error }, "push: failed to dispatch event");
  });

  // One event at a time. Two reasons: an unbounded fan-out of concurrent
  // handlers would open hundreds of Expo requests at once under a burst, and
  // a serialised chain is what lets a test publish A then B, observe B, and
  // conclude that A produced nothing.
  let chain: Promise<void> = Promise.resolve();

  await subscribeToEvents(deps.subscriber, (event) => {
    chain = chain
      .then(() => handleEvent(event, deps, now))
      .catch((error: unknown) => { onError(error); });
  });

  return {
    close: async () => {
      await chain;
      await deps.subscriber.quit();
    },
  };
}
