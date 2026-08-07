import { z } from "zod";
import { GameEventSchema } from "./events.js";

export const ServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), playerId: z.string().uuid() }),
  z.object({ kind: z.literal("event"), event: GameEventSchema }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("pong") }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("ping") })]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
