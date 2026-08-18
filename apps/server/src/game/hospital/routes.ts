import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../db/client.js";
import { playerStats } from "../../db/schema/index.js";
import { applyBalanceChange, InsufficientFundsError, lockPlayersForUpdate } from "../../economy/ledger.js";
import { listSentencedAtLocation } from "../roster.js";
import { checkHospital, maxHealthFor, sendToHospital, settleHospital } from "./status.js";
import { checkinSecondsPerHp, dischargeCostPerSecond } from "./settings.js";

export function registerHospitalRoutes(
  app: FastifyInstance,
  db: Db,
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
}
