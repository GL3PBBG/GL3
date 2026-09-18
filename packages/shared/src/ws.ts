import { z } from "zod";
import { GameEventSchema } from "./events.js";
import {
  ClientKindSchema, EmoteSchema, PresenceErrorCodeSchema, PresenceMovedSchema,
  PresenceStateSchema, RoomDescriptorSchema,
} from "./presence.js";
import { IdSchema } from "./primitives.js";

const finite = z.number().finite();

export const ServerFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready"), playerId: z.string().uuid() }),
  z.object({ kind: z.literal("event"), event: GameEventSchema }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("pong") }),
  // Presence (spec 2026-09-17 §1.1). `players` is [] when `concealed`.
  z.object({
    kind: z.literal("presence.snapshot"),
    room: RoomDescriptorSchema,
    you: PresenceStateSchema,
    players: z.array(PresenceStateSchema),
    concealed: z.boolean(),
  }),
  z.object({
    kind: z.literal("presence.tick"),
    locationId: IdSchema,
    joined: z.array(PresenceStateSchema),
    moved: z.array(PresenceMovedSchema),
    emoted: z.array(z.object({ playerId: IdSchema, emote: EmoteSchema })),
    left: z.array(IdSchema),
  }),
  z.object({ kind: z.literal("presence.error"), code: PresenceErrorCodeSchema }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export const ClientFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ping") }),
  z.object({ kind: z.literal("presence.join"), client: ClientKindSchema }),
  // `seq` is monotonic per socket; the server drops a stale one. Coordinates
  // are validated finite here and CLAMPED (never rejected) to the room's
  // bounds by the server — a rejected frame under lag is a stuck avatar.
  z.object({
    kind: z.literal("presence.move"),
    seq: z.number().int().nonnegative(),
    x: finite,
    y: finite,
    facing: finite.min(-Math.PI).max(Math.PI),
  }),
  z.object({ kind: z.literal("presence.emote"), emote: EmoteSchema }),
  z.object({ kind: z.literal("presence.leave") }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;
