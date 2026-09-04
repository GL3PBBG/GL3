import { PushDeviceRegisterRequestSchema } from "@gl3/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { registerDevice, unregisterDevice } from "./devices.js";

/**
 * Not `ExpoPushTokenSchema`: an unregister of a malformed token must still
 * answer 204 rather than 400, because the client calls it on sign-out and a
 * failing sign-out is worse than a no-op delete. The bound is only there to
 * stop an unbounded string reaching the query.
 */
const TokenParamsSchema = z.object({ token: z.string().min(1).max(200) }).strict();

export function registerPushRoutes(
  app: FastifyInstance,
  db: Db,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  // Both routes sit behind requireAuth and are deliberately NOT in
  // auth/routes.ts's GATE_EXEMPT list: an unverified account should not be
  // accumulating push subscriptions. The app therefore registers on sign-in
  // AND again after a successful verification — see the app-side lifecycle.
  app.post("/api/push/devices", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const parsed = PushDeviceRegisterRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    await registerDevice(db, playerId, parsed.data.expoToken, parsed.data.platform);
    return reply.send({ registered: true });
  });

  app.delete("/api/push/devices/:token", { preHandler: requireAuth }, async (request, reply) => {
    const playerId = request.playerId;
    if (!playerId) return reply.code(401).send({ error: "unauthorized" });

    const params = TokenParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(204).send();

    await unregisterDevice(db, playerId, params.data.token);
    return reply.code(204).send();
  });
}
