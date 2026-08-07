import { BankTransactionRequestSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import type { Db } from "../../db/client.js";
import { InsufficientFundsError } from "../../economy/ledger.js";
import { performBankTransaction, type BankDirection } from "./service.js";

export function registerBankRoutes(
  app: FastifyInstance, db: Db, redis: Redis,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  const handler = (direction: BankDirection) => async (request: FastifyRequest, reply: FastifyReply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = BankTransactionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const amount = BigInt(parsed.data.amount);
    if (amount <= 0n) return reply.code(400).send({ error: "amount_must_be_positive" });

    try {
      const result = await performBankTransaction(db, redis, playerId, direction, amount);
      return reply.send({ cash: result.cash.toString(), bank: result.bank.toString() });
    } catch (err) {
      if (err instanceof InsufficientFundsError) return reply.code(409).send({ error: "insufficient_funds" });
      throw err;
    }
  };

  app.post("/api/bank/deposit", { preHandler: requireAuth }, handler("deposit"));
  app.post("/api/bank/withdraw", { preHandler: requireAuth }, handler("withdraw"));
}
