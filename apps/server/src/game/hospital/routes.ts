import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { publishEvent } from "../../bus/publish.js";
import type { Db } from "../../db/client.js";
import { players, playerStats } from "../../db/schema/index.js";
import { applyBalanceChange, InsufficientFundsError, lockPlayersForUpdate } from "../../economy/ledger.js";
import { insertNotification } from "../notifications/service.js";
import { listSentencedAtLocation } from "../roster.js";
import { checkHospital, maxHealthFor, sendToHospital, settleHospital } from "./status.js";
import { checkinSecondsPerHp, dischargeCostPerSecond } from "./settings.js";

const TargetBodySchema = z.object({ playerId: z.string().uuid() });

export function registerHospitalRoutes(
  app: FastifyInstance,
  db: Db,
  redis: Redis,
  settings: Record<string, string>,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/hospital", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    // Settle first, so a GET after the sentence elapsed reports the restored
    // health rather than the stale 0.
    await db.transaction((tx) => settleHospital(tx, playerId));

    const status = await checkHospital(db, playerId);
    const [row] = await db.select({ health: playerStats.health })
      .from(playerStats).where(eq(playerStats.playerId, playerId));
    const maxHealth = await db.transaction((tx) => maxHealthFor(tx, playerId));

    return reply.send({
      health: row?.health ?? 0,
      maxHealth,
      hospitalised: status.hospitalised,
      until: status.until,
      remainingSeconds: status.remainingSeconds,
      // Money crosses the wire as a decimal string, never a JSON number.
      dischargeCost: (BigInt(status.remainingSeconds) * dischargeCostPerSecond(settings)).toString(),
    });
  });

  /** Everyone else's live stay in the caller's own town. Never lists the caller. */
  app.get("/api/hospital/local", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const rows = await listSentencedAtLocation(db, playerId, "hospital");
    const rate = dischargeCostPerSecond(settings);
    return reply.send({
      patients: rows.map((row) => ({
        ...row,
        dischargeCost: (BigInt(row.remainingSeconds) * rate).toString(),
      })),
    });
  });

  /**
   * Reachable while jailed, deliberately: jail and hospital are independent
   * sentences and being jailed must not block paying off the ward.
   */
  app.post("/api/hospital/discharge", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    try {
      const result = await db.transaction(async (tx) => {
        // FIRST statement, before settleHospital reads anything.
        // `settleHospital` takes no lock of its own and `applyBalanceChange`
        // takes one only when it runs, so without this the read of
        // `hospital_until` happens outside any lock: two concurrent discharges
        // both saw "hospitalised", both queued on the ledger's lock, and both
        // charged — one discharge, two `hospital.discharge` rows, double the
        // money gone. The ledger stays self-consistent through that, so
        // `sum(ledger) == balance` never notices. Locking here makes the
        // loser's re-read observe `hospital_until = null` and 409 instead.
        // Regression: `test/hospital-concurrency.test.ts`.
        await lockPlayersForUpdate(tx, [playerId]);
        const settled = await settleHospital(tx, playerId);
        if (!settled.hospitalised) return { kind: "free" as const };

        const cost = BigInt(settled.remainingSeconds) * dischargeCostPerSecond(settings);
        const cash = await applyBalanceChange(tx, {
          playerId, amount: -cost, kind: "cash", reason: "hospital.discharge",
        });

        const maxHealth = await maxHealthFor(tx, playerId);
        await tx.update(playerStats)
          .set({ hospitalUntil: null, health: maxHealth })
          .where(eq(playerStats.playerId, playerId));

        return { kind: "discharged" as const, cash, cost, health: maxHealth };
      });

      if (result.kind === "free") return reply.code(409).send({ error: "not_hospitalised" });
      return reply.send({
        health: result.health,
        cash: result.cash.toString(),
        paid: result.cost.toString(),
      });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        return reply.code(409).send({ error: "insufficient_funds" });
      }
      throw error;
    }
  });

  /**
   * The voluntary door. Free — the stay itself is the price, because a
   * hospitalised player is gated out of crimes, combat and travel for its
   * whole length. Paying to leave early is the existing discharge route, so a
   * player can check in and then buy out; that is intended, and it costs
   * strictly more than waiting.
   */
  app.post("/api/hospital/checkin", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const result = await db.transaction(async (tx) => {
      // First statement, before any read: the same check-then-act hazard the
      // discharge route documents. Without it two concurrent check-ins both
      // read "not hospitalised" and the second overwrites the first's
      // deadline with one computed from health 0 — a maximal stay.
      await lockPlayersForUpdate(tx, [playerId]);
      const settled = await settleHospital(tx, playerId);
      if (settled.hospitalised) return { kind: "already" as const };

      const [row] = await tx.select({ health: playerStats.health })
        .from(playerStats).where(eq(playerStats.playerId, playerId));
      const health = row?.health ?? 0;
      const maxHealth = await maxHealthFor(tx, playerId);
      const missing = maxHealth - health;
      if (missing <= 0) return { kind: "healthy" as const };

      const seconds = missing * checkinSecondsPerHp(settings);
      const until = await sendToHospital(tx, playerId, seconds);
      return { kind: "admitted" as const, until, seconds, maxHealth };
    });

    if (result.kind === "already") return reply.code(409).send({ error: "already_hospitalised" });
    if (result.kind === "healthy") return reply.code(409).send({ error: "not_injured" });

    return reply.send({
      health: 0,
      maxHealth: result.maxHealth,
      hospitalised: true,
      until: result.until.toISOString(),
      remainingSeconds: result.seconds,
      dischargeCost: (BigInt(result.seconds) * dischargeCostPerSecond(settings)).toString(),
    });
  });

  /**
   * Pay a stranger out of the ward. Money moves from the CALLER; the target
   * is healed and never debited.
   */
  app.post("/api/hospital/discharge-player", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = TargetBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const targetId = parsed.data.playerId;
    if (targetId === playerId) return reply.code(409).send({ error: "self_target" });

    try {
      const result = await db.transaction(async (tx) => {
        // ONE sorted call over both players, FIRST statement, before either row
        // is read (CLAUDE.md rule 6). Two separate calls, or a read before the
        // lock, is the double-charge shape test/hospital-concurrency.test.ts
        // exists for on the single-player discharge route above.
        await lockPlayersForUpdate(tx, [playerId, targetId]);

        const [caller] = await tx.select({ locationId: playerStats.locationId })
          .from(playerStats).where(eq(playerStats.playerId, playerId));
        const [target] = await tx.select({
          locationId: playerStats.locationId,
          hospitalUntil: playerStats.hospitalUntil,
          username: players.username,
        })
          .from(playerStats)
          .innerJoin(players, eq(players.id, playerStats.playerId))
          .where(eq(playerStats.playerId, targetId));

        if (!target) return { kind: "missing" as const };
        if (target.locationId === null || target.locationId !== caller?.locationId) {
          return { kind: "elsewhere" as const };
        }

        const remainingMs = (target.hospitalUntil?.getTime() ?? 0) - Date.now();
        if (remainingMs <= 0) return { kind: "free" as const };
        const remainingSeconds = Math.ceil(remainingMs / 1000);

        const cost = BigInt(remainingSeconds) * dischargeCostPerSecond(settings);
        const cash = await applyBalanceChange(tx, {
          playerId, amount: -cost, kind: "cash", reason: "hospital.discharge",
        });

        const maxHealth = await maxHealthFor(tx, targetId);
        await tx.update(playerStats)
          .set({ hospitalUntil: null, health: maxHealth })
          .where(eq(playerStats.playerId, targetId));

        const [me] = await tx.select({ username: players.username })
          .from(players).where(eq(players.id, playerId));

        const notificationId = uuidv7();
        await insertNotification(tx, {
          id: notificationId, playerId: targetId,
          body: `${me?.username ?? "Someone"} paid for your discharge.`,
        });

        return {
          kind: "paid" as const, cash, cost, notificationId,
          targetName: target.username,
        };
      });

      if (result.kind === "missing") return reply.code(404).send({ error: "player_not_found" });
      if (result.kind === "elsewhere") return reply.code(409).send({ error: "wrong_location" });
      if (result.kind === "free") return reply.code(409).send({ error: "not_hospitalised" });

      // After commit, never inside the transaction (CLAUDE.md rule 5). Both
      // events are addressed to the TARGET and carry the target as actor:
      // `player.discharged` is what the web client's invalidation keys off,
      // and `notification.created`'s actor is the recipient by convention
      // (apps/server/src/plugins/ctx.ts).
      const at = new Date().toISOString();
      await publishEvent(redis, {
        id: uuidv7(), type: "player.discharged", at,
        actorId: targetId, actorName: result.targetName,
        audience: { kind: "player", playerId: targetId },
      });
      await publishEvent(redis, {
        id: uuidv7(), type: "notification.created", at,
        actorId: targetId, actorName: result.targetName,
        audience: { kind: "player", playerId: targetId },
        notificationId: result.notificationId,
        body: "Someone paid for your discharge.",
      });

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
}
