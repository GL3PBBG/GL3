import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../../db/client.js";
import { playerStats } from "../../db/schema/index.js";
import { applyBalanceChange, InsufficientFundsError } from "../../economy/ledger.js";
import { checkHospital, maxHealthFor, settleHospital } from "./status.js";

const DEFAULT_COST_PER_SECOND = 1000n;

/**
 * A malformed setting falls back to the default rather than throwing on every
 * request. `settings` is admin-edited free text; a typo there must not take
 * the route down.
 */
function costPerSecond(settings: Record<string, string>): bigint {
  const raw = settings["hospital.discharge_cost_per_second"];
  if (raw === undefined) return DEFAULT_COST_PER_SECOND;
  try {
    const parsed = BigInt(raw);
    return parsed >= 0n ? parsed : DEFAULT_COST_PER_SECOND;
  } catch {
    return DEFAULT_COST_PER_SECOND;
  }
}

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
      dischargeCost: (BigInt(status.remainingSeconds) * costPerSecond(settings)).toString(),
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
        // settleHospital takes no lock of its own; applyBalanceChange below
        // locks this player's row, and both run in this one transaction.
        const settled = await settleHospital(tx, playerId);
        if (!settled.hospitalised) return { kind: "free" as const };

        const cost = BigInt(settled.remainingSeconds) * costPerSecond(settings);
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
}
