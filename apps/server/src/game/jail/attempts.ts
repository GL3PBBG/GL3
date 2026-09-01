import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import { insertOutboxEvents } from "../../bus/outbox.js";
import { settlePool } from "@gl3/plugin-sdk";
import type { collectAttributePools } from "../../plugins/attribute-pools.js";
import type { Db } from "../../db/client.js";
import { players, playerStats, playerTimers } from "../../db/schema/index.js";
import { lockPlayersForUpdate } from "../../economy/ledger.js";
import { insertNotification } from "../notifications/service.js";
import { breakoutPercent, superMaxLive, SUPER_MAX_KEY } from "./breakout.js";
import { bustSucceeds } from "./bust.js";
import { sendToJail } from "./status.js";
import { bustFailJailSeconds, escapeFailExtraSeconds } from "./settings.js";

type OutboxRow = Awaited<ReturnType<typeof insertOutboxEvents>>[number];

/** MCCodes' flat bust charge (`jailbust.php:12-18`, audit §7 item 12). */
const BUST_ENERGY_COST = 10;

export type EscapeResult =
  | { kind: "free" }
  | { kind: "super_max" }
  | { kind: "failed"; until: Date; outboxRows: OutboxRow[] }
  | { kind: "escaped"; outboxRows: OutboxRow[] };

/**
 * V2's self-targeted breakout (the template labels it "Escape"). The chance
 * is `breakoutPercent`, derived from the CALLER's own level (callerJailed is
 * always true here — the caller is, definitionally, the one jailed) rather
 * than `jail.bust_success_percent`. Failure EXTENDS the caller's existing
 * sentence by `jail.escape_fail_extra_seconds` — V2 added 90s to the timer
 * rather than restarting it, so `sendToJail` (which overwrites from now) is
 * deliberately not used here — AND sets a co-expiring super max
 * (`SUPER_MAX_KEY`) that blocks the next attempt until the extended sentence
 * itself expires. Free, no cooldown: the added time is the whole cost, same
 * reasoning as bust. No notification either — the player did this to
 * themselves and already holds the response, the hospital check-in
 * precedent.
 */
export async function escapeAttempt(
  db: Db, settings: Record<string, string>, playerId: string, seed: string,
): Promise<EscapeResult> {
  return db.transaction(async (tx) => {
    // First statement, before the row is read (NOTES.md rule 6).
    await lockPlayersForUpdate(tx, [playerId]);

    const [caller] = await tx.select({
      jailedUntil: playerStats.jailedUntil, username: players.username,
      level: playerStats.level,
    })
      .from(playerStats)
      .innerJoin(players, eq(players.id, playerStats.playerId))
      .where(eq(playerStats.playerId, playerId));

    const jailedUntil = caller?.jailedUntil ?? null;
    if (jailedUntil === null || jailedUntil.getTime() <= Date.now()) {
      return { kind: "free" as const };
    }

    // Caller's own super max — one attempt per sentence (V2 jail.inc.php:106-110).
    const [smRow] = await tx.select({ expiresAt: playerTimers.expiresAt }).from(playerTimers)
      .where(and(eq(playerTimers.playerId, playerId), eq(playerTimers.key, SUPER_MAX_KEY)));
    if (superMaxLive(jailedUntil, smRow?.expiresAt ?? null)) return { kind: "super_max" as const };

    const callerName = caller?.username ?? "unknown";
    const percent = breakoutPercent(caller?.level ?? 0, true, false);
    if (!bustSucceeds(seed, percent)) {
      const until = new Date(jailedUntil.getTime() + escapeFailExtraSeconds(settings) * 1000);
      await tx.update(playerStats)
        .set({ jailedUntil: until })
        .where(eq(playerStats.playerId, playerId));
      // V2's co-expiry (jail.inc.php:141-147): super max lives exactly as
      // long as the extended sentence, expiring the same instant it does.
      await tx.insert(playerTimers).values({ playerId, key: SUPER_MAX_KEY, expiresAt: until })
        .onConflictDoUpdate({ target: [playerTimers.playerId, playerTimers.key], set: { expiresAt: until } });
      // Minted and outboxed in-transaction; published after commit (rule 5).
      const outboxRows = await insertOutboxEvents(tx, [{
        id: uuidv7(), type: "player.jailed", at: new Date().toISOString(),
        actorId: playerId, actorName: callerName,
        audience: { kind: "player", playerId },
        until: until.toISOString(), reason: "escape.failed",
      }]);
      return { kind: "failed" as const, until, outboxRows };
    }

    await tx.update(playerStats)
      .set({ jailedUntil: null })
      .where(eq(playerStats.playerId, playerId));
    const outboxRows = await insertOutboxEvents(tx, [{
      id: uuidv7(), type: "player.released", at: new Date().toISOString(),
      actorId: playerId, actorName: callerName,
      audience: { kind: "player", playerId },
    }]);
    return { kind: "escaped" as const, outboxRows };
  });
}

export type BustResult =
  | { kind: "missing" } | { kind: "elsewhere" } | { kind: "free" }
  | { kind: "caller_jailed" } | { kind: "insufficient_energy" }
  | { kind: "target_super_max" }
  | { kind: "failed"; until: Date; outboxRows: OutboxRow[] }
  | { kind: "busted"; outboxRows: OutboxRow[] };

/**
 * The failure branch — the caller doing the target's kind of time — is the
 * whole cost, which is why there is no cooldown. The seed is generated by
 * the caller and never accepted from the client: a client-chosen seed is a
 * client-chosen outcome. Since 2026-08-26 (audit §7 item 12) a boot with
 * the energy pool declared also charges a flat 10 energy per attempt, on
 * both outcomes — MCCodes' own number; a default install's bust stays
 * free and byte-identical, because no pool is declared.
 */
export async function bustAttempt(
  db: Db, settings: Record<string, string>,
  pools: ReturnType<typeof collectAttributePools>,
  callerId: string, targetId: string, seed: string,
): Promise<BustResult> {
  return db.transaction(async (tx) => {
    // ONE sorted call over both players, FIRST statement, before either row
    // is read (NOTES.md rule 6) — same shape as the bail route in routes.ts.
    await lockPlayersForUpdate(tx, [callerId, targetId]);

    const [caller] = await tx.select({
      locationId: playerStats.locationId, jailedUntil: playerStats.jailedUntil,
      username: players.username,
      energy: playerStats.energy, energyMax: playerStats.energyMax,
      energyRegenAt: playerStats.energyRegenAt,
      level: playerStats.level,
    })
      .from(playerStats)
      .innerJoin(players, eq(players.id, playerStats.playerId))
      .where(eq(playerStats.playerId, callerId));
    // A jailed caller is rejected here, before the target's own super-max
    // state is ever read — so the caller's own super max (relevant only to
    // self-targeted escape, above) is unreachable on this path and
    // deliberately not checked as dead code. Spec §3.4.
    if (caller && (caller.jailedUntil?.getTime() ?? 0) > Date.now()) {
      return { kind: "caller_jailed" as const };
    }

    const [target] = await tx.select({
      locationId: playerStats.locationId, jailedUntil: playerStats.jailedUntil,
      username: players.username, level: playerStats.level,
    })
      .from(playerStats)
      .innerJoin(players, eq(players.id, playerStats.playerId))
      .where(eq(playerStats.playerId, targetId));

    if (!target) return { kind: "missing" as const };
    if (target.locationId === null || target.locationId !== caller?.locationId) {
      return { kind: "elsewhere" as const };
    }
    if ((target.jailedUntil?.getTime() ?? 0) <= Date.now()) return { kind: "free" as const };

    // V2 jail.inc.php:94-98 — a super-maxed inmate cannot be chosen. The user's
    // 2026-08-31 decision extends the same wall to bail (Task 5).
    const [smRow] = await tx.select({ expiresAt: playerTimers.expiresAt }).from(playerTimers)
      .where(and(eq(playerTimers.playerId, targetId), eq(playerTimers.key, SUPER_MAX_KEY)));
    if (superMaxLive(target.jailedUntil, smRow?.expiresAt ?? null)) return { kind: "target_super_max" as const };

    // The attempt charge, on both outcomes, under the lock this transaction
    // already holds. The lazy settle is persisted with the spend so the
    // regen bookkeeping and the charge commit atomically; a shortfall 409s
    // before any state moves. Skipped entirely with no declaration — the
    // opt-in property.
    const energyDecl = pools.get("energy") ?? null;
    if (energyDecl !== null) {
      const settled = settlePool(
        caller?.energy ?? 0, caller?.energyMax ?? 0, caller?.energyRegenAt ?? null,
        new Date(), energyDecl,
      );
      if (settled.value < BUST_ENERGY_COST) return { kind: "insufficient_energy" as const };
      await tx.update(playerStats)
        .set({
          energy: settled.value - BUST_ENERGY_COST,
          energyMax: settled.max,
          energyRegenAt: settled.stamp,
        })
        .where(eq(playerStats.playerId, callerId));
    }

    // callerJailed is false by construction — the caller_jailed arm above
    // rejected a jailed caller already, so this is always the free-caller
    // branch of breakoutPercent.
    const percent = breakoutPercent(target.level ?? 0, false, false);
    if (!bustSucceeds(seed, percent)) {
      const until = await sendToJail(tx, callerId, bustFailJailSeconds(settings));
      // Minted and outboxed in-transaction; published after commit (rule 5).
      const outboxRows = await insertOutboxEvents(tx, [{
        id: uuidv7(), type: "player.jailed", at: new Date().toISOString(),
        actorId: callerId, actorName: caller?.username ?? "unknown",
        audience: { kind: "player", playerId: callerId },
        until: until.toISOString(), reason: "bust.failed",
      }]);
      return { kind: "failed" as const, until, outboxRows };
    }

    await tx.update(playerStats)
      .set({ jailedUntil: null })
      .where(eq(playerStats.playerId, targetId));

    // Audit §7 item 4: a successful bust grants the BUSTER level×5
    // crime_exp — the counter's only MCCodes producer besides per-crime
    // rewards, keeping its economy intact for the crime odds that read
    // it. Unconditional by that decision: with no formula crime in the
    // catalog the column is inert, accumulating harmlessly.
    await tx.update(playerStats)
      .set({ crimeExp: sql`${playerStats.crimeExp} + ${BigInt((caller?.level ?? 1) * 5)}` })
      .where(eq(playerStats.playerId, callerId));

    const notificationId = uuidv7();
    await insertNotification(tx, {
      id: notificationId, playerId: targetId, body: "Someone busted you out.",
    });
    const at = new Date().toISOString();
    const outboxRows = await insertOutboxEvents(tx, [
      {
        id: uuidv7(), type: "player.released", at,
        actorId: targetId, actorName: target.username,
        audience: { kind: "player", playerId: targetId },
      },
      {
        id: uuidv7(), type: "notification.created", at,
        actorId: targetId, actorName: target.username,
        audience: { kind: "player", playerId: targetId },
        notificationId, body: "Someone busted you out.",
      },
    ]);
    return { kind: "busted" as const, outboxRows };
  });
}
