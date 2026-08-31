import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { insertOutboxEvents, outboxErrorLog, type OutboxDelivery } from "../../bus/outbox.js";
import type { PluginManifest } from "@gl3/plugin-sdk";
import { collectAttributePools } from "../../plugins/attribute-pools.js";
import type { Db } from "../../db/client.js";
import { players, playerStats } from "../../db/schema/index.js";
import { applyBalanceChange, InsufficientFundsError, lockPlayersForUpdate } from "../../economy/ledger.js";
import { wealthScaledFee } from "../../economy/wealth-fee.js";
import { newSeed } from "../rng.js";
import { insertNotification } from "../notifications/service.js";
import { listSentencedAtLocation } from "../roster.js";
import { bustAttempt, escapeAttempt } from "./attempts.js";
import { releaseIfExpired } from "./status.js";
import { bailCostPerSecond, bailWealthCapMultiplier, bailWealthPercent } from "./settings.js";

const TargetBodySchema = z.object({ playerId: z.string().uuid() });

export function registerJailRoutes(
  app: FastifyInstance, db: Db, deliver: OutboxDelivery, settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  manifests: () => readonly PluginManifest[] = () => [],
): void {
  app.get("/api/jail", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });
    return reply.send(await releaseIfExpired(db, deliver, playerId));
  });

  /** Everyone else's live sentence in the caller's own town. Never lists the caller. */
  app.get("/api/jail/local", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await listSentencedAtLocation(db, playerId, "jail");
    // The caller's wealth sizes each fee, so the roster's prices are what THIS
    // caller would pay. Plain read, no lock: a preview may lag the authoritative
    // computation the bail route does under lock — never the reverse.
    const [me] = await db.select({ cash: playerStats.cash, bank: playerStats.bank })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    const wealth = (me?.cash ?? 0n) + (me?.bank ?? 0n);
    const rate = bailCostPerSecond(settings);
    const percent = bailWealthPercent(settings);
    const capMultiplier = bailWealthCapMultiplier(settings);
    return reply.send({
      inmates: rows.map((row) => ({
        ...row,
        bailCost: wealthScaledFee(BigInt(row.remainingSeconds) * rate, wealth, percent, capMultiplier).toString(),
      })),
    });
  });

  /**
   * Pay a local inmate out. Money moves from the CALLER; the inmate's
   * balance is never touched. Mirrors `POST /api/hospital/discharge-player`.
   */
  app.post("/api/jail/bail", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = TargetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const targetId = parsed.data.playerId;
    if (targetId === playerId) return reply.code(409).send({ error: "self_target" });

    try {
      const result = await db.transaction(async (tx) => {
        // ONE sorted call over both players, FIRST statement, before either row
        // is read (NOTES.md rule 6) — the same shape as discharge-player.
        await lockPlayersForUpdate(tx, [playerId, targetId]);

        const [caller] = await tx.select({
          locationId: playerStats.locationId,
          cash: playerStats.cash,
          bank: playerStats.bank,
        })
          .from(playerStats).where(eq(playerStats.playerId, playerId));
        const [target] = await tx.select({
          locationId: playerStats.locationId,
          jailedUntil: playerStats.jailedUntil,
          username: players.username,
        })
          .from(playerStats)
          .innerJoin(players, eq(players.id, playerStats.playerId))
          .where(eq(playerStats.playerId, targetId));

        if (!target) return { kind: "missing" as const };
        if (target.locationId === null || target.locationId !== caller?.locationId) {
          return { kind: "elsewhere" as const };
        }

        const remainingMs = (target.jailedUntil?.getTime() ?? 0) - Date.now();
        if (remainingMs <= 0) return { kind: "free" as const };
        const remainingSeconds = Math.ceil(remainingMs / 1000);

        // Scaled on the PAYER's wealth (cash + bank), computed under the lock
        // taken above — the /local roster previews the same formula unlocked.
        // Wealth includes the bank on purpose: cash-only scaling would make
        // depositing a bail shelter.
        const cost = wealthScaledFee(
          BigInt(remainingSeconds) * bailCostPerSecond(settings),
          (caller?.cash ?? 0n) + (caller?.bank ?? 0n),
          bailWealthPercent(settings), bailWealthCapMultiplier(settings),
        );
        const cash = await applyBalanceChange(tx, {
          playerId, amount: -cost, kind: "cash", reason: "jail.bail",
        });

        await tx.update(playerStats)
          .set({ jailedUntil: null })
          .where(eq(playerStats.playerId, targetId));

        const [me] = await tx.select({ username: players.username })
          .from(players).where(eq(players.id, playerId));

        const notificationId = uuidv7();
        // Same string goes into the notification row and the event body below —
        // a caller who reads the row moments after the toast must see the same
        // fact, not "Someone" in one place and the payer's name in the other.
        const body = `${me?.username ?? "Someone"} paid your bail.`;
        await insertNotification(tx, { id: notificationId, playerId: targetId, body });

        // Minted and outboxed INSIDE the transaction, published only after
        // it commits (NOTES.md rule 5) — the envelope ids are stable across
        // the fast path and any dispatcher retry. Both events are addressed
        // to the TARGET and carry the target as actor.
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
            notificationId,
            body,
          },
        ]);

        return {
          kind: "paid" as const, cash, cost, outboxRows,
          targetName: target.username,
        };
      });

      if (result.kind === "missing") return reply.code(404).send({ error: "player_not_found" });
      if (result.kind === "elsewhere") return reply.code(409).send({ error: "wrong_location" });
      if (result.kind === "free") return reply.code(409).send({ error: "not_jailed" });

      // The fast path — never throws: anything undeliverable here is the
      // dispatcher's, not the player's, because the rows committed with the
      // facts.
      await deliver(result.outboxRows, outboxErrorLog(request.log));

      return reply.send({
        freed: targetId,
        paid: result.cost.toString(),
        cash: result.cash.toString(),
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return reply.code(409).send({ error: "insufficient_funds" });
      }
      throw error;
    }
  });

  /**
   * The failure branch — the caller doing the target's kind of time — is the
   * whole cost, which is why there is no cooldown. The seed is generated
   * here and never accepted from the client: a client-chosen seed is a
   * client-chosen outcome. Since 2026-08-26 (audit §7 item 12) a boot with
   * the energy pool declared also charges a flat 10 energy per attempt, on
   * both outcomes — MCCodes' own number; a default install's bust stays
   * free and byte-identical, because no pool is declared.
   */
  app.post("/api/jail/bust", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = TargetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const targetId = parsed.data.playerId;
    if (targetId === playerId) return reply.code(409).send({ error: "self_target" });

    const attributePools = collectAttributePools(manifests());

    const result = await bustAttempt(db, settings, attributePools, playerId, targetId, newSeed());

    if (result.kind === "missing") return reply.code(404).send({ error: "player_not_found" });
    if (result.kind === "elsewhere") return reply.code(409).send({ error: "wrong_location" });
    if (result.kind === "free") return reply.code(409).send({ error: "not_jailed" });
    if (result.kind === "caller_jailed") return reply.code(409).send({ error: "already_jailed" });
    if (result.kind === "insufficient_energy") return reply.code(409).send({ error: "insufficient_energy" });

    // The fast path — never throws; the dispatcher owns what it cannot deliver.
    await deliver(result.outboxRows, outboxErrorLog(request.log));

    if (result.kind === "failed") {
      return reply.send({ success: false, jailedUntil: result.until.toISOString() });
    }
    return reply.send({ success: true, jailedUntil: null });
  });

  /**
   * V2's self-targeted breakout (the template labels it "Escape"). Same roll
   * and the same `jail.bust_success_percent` as bust, but failure EXTENDS the
   * caller's existing sentence by `jail.escape_fail_extra_seconds` — V2 added
   * 90s to the timer rather than restarting it, so `sendToJail` (which
   * overwrites from now) is deliberately not used here. Free, no cooldown:
   * the added time is the whole cost, same reasoning as bust. No
   * notification either — the player did this to themselves and already
   * holds the response, the hospital check-in precedent.
   */
  app.post("/api/jail/escape", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const result = await escapeAttempt(db, settings, playerId, newSeed());

    if (result.kind === "free") return reply.code(409).send({ error: "not_jailed" });

    // The fast path — never throws; the dispatcher owns what it cannot deliver.
    await deliver(result.outboxRows, outboxErrorLog(request.log));

    if (result.kind === "failed") {
      return reply.send({ success: false, jailedUntil: result.until.toISOString() });
    }
    return reply.send({ success: true, jailedUntil: null });
  });
}
