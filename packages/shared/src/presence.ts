import { z } from "zod";
import { CombatModeSchema } from "./dto/combat.js";
import { IdSchema } from "./primitives.js";

/**
 * Presence wire shapes (spec 2026-09-17 §1.1, §1.4, §A). Positions are a 2D
 * ground plane in metres — `x` east, `y` north, origin at the scene centre;
 * the Godot client maps `y → -z`. They are COSMETIC: no server code reads
 * one to make a game decision, which is the anti-cheat boundary.
 */
const finite = z.number().finite();

/** Informational only — the server never branches on it. `android`/`ios` are the Expo shell. */
export const ClientKindSchema = z.enum(["godot-desktop", "godot-web", "web", "android", "ios"]);
export type ClientKind = z.infer<typeof ClientKindSchema>;

export const EmoteSchema = z.enum(["wave", "point", "smoke"]);
export type Emote = z.infer<typeof EmoteSchema>;

export const AvatarBodySchema = z.enum(["suit-dark", "suit-light", "coat", "dress"]);
export type AvatarBody = z.infer<typeof AvatarBodySchema>;

export const PresenceErrorCodeSchema = z.enum(["not_joined", "no_location", "rate_limited", "superseded"]);
export type PresenceErrorCode = z.infer<typeof PresenceErrorCodeSchema>;

export const HookKindSchema = z.enum(["building", "npc"]);
export type HookKind = z.infer<typeof HookKindSchema>;

export const SceneBoundsSchema = z
  .object({ minX: finite, minY: finite, maxX: finite, maxY: finite })
  .refine((b) => b.minX < b.maxX && b.minY < b.maxY, { message: "bounds must have positive extent" });
export type SceneBounds = z.infer<typeof SceneBoundsSchema>;

/** `facing` is a Godot yaw in radians: 0 faces north (+y), positive is counter-clockwise from above. */
export const SceneSpawnSchema = z.object({ x: finite, y: finite, facing: finite });
export type SceneSpawn = z.infer<typeof SceneSpawnSchema>;

export const FootprintSchema = z.object({ w: z.number().min(1).max(30), d: z.number().min(1).max(30) });
export type Footprint = z.infer<typeof FootprintSchema>;

export const DEFAULT_SCENE_KEY = "default";
export const DEFAULT_SCENE_BOUNDS: SceneBounds = { minX: -40, minY: -20, maxX: 40, maxY: 20 };
export const DEFAULT_SCENE_SPAWN: SceneSpawn = { x: 0, y: -15, facing: 0 };

/** A hook after layout: what the client instantiates. `id` is `"<pluginId>.<hookId>"`. */
export const PlacedHookSchema = z.object({
  id: z.string().min(1),
  pluginId: z.string().min(1),
  hookId: z.string().min(1),
  kind: HookKindSchema,
  label: z.string().min(1).max(24),
  model: z.string().min(1),
  footprint: FootprintSchema,
  /** Footprint centre, metres. */
  position: z.object({ x: finite, y: finite }),
  facing: finite,
  /** App-internal path the client opens on interact: `/plugins/<pageId>`. */
  href: z.string().min(1),
  signageUrl: z.string().nullable(),
  /** Core-only: the explicit confinement spot for a sentenced player (spec 2026-09-18 §2). Plugin hooks never carry it. */
  yard: z.object({ x: finite, y: finite }).optional(),
});
export type PlacedHook = z.infer<typeof PlacedHookSchema>;

export const RoomDescriptorSchema = z.object({
  locationId: IdSchema,
  locationName: z.string(),
  combatMode: CombatModeSchema,
  sceneKey: z.string().min(1),
  bounds: SceneBoundsSchema,
  spawn: SceneSpawnSchema,
  hooks: z.array(PlacedHookSchema),
});
export type RoomDescriptor = z.infer<typeof RoomDescriptorSchema>;

/** Where a player is confined, derived from `player_stats.jailed_until` / `hospital_until` (spec 2026-09-18 §3). `jail` wins when both are set. */
export const SentenceSchema = z.enum(["jail", "hospital"]).nullable();
export type Sentence = z.infer<typeof SentenceSchema>;

export const PresenceStateSchema = z.object({
  playerId: IdSchema,
  username: z.string(),
  gangId: IdSchema.nullable(),
  x: finite,
  y: finite,
  facing: finite,
  avatar: z.object({ body: AvatarBodySchema }),
  /** ms epoch of join. */
  since: z.number().int().nonnegative(),
  /** Derived display fact, not read by any server decision — see `SentenceSchema`. */
  sentence: SentenceSchema.optional(),
  /**
   * True while NO socket of this player has sent `presence.join` (spec
   * 2026-09-19 §1): the server put them in the room itself, nobody is
   * driving the avatar and it never moves. Absent means false, so a client
   * written before this field reads every member as live, exactly as it did.
   */
  static: z.boolean().optional(),
});
export type PresenceState = z.infer<typeof PresenceStateSchema>;

export const PresenceMovedSchema = z.object({
  playerId: IdSchema, x: finite, y: finite, facing: finite, at: z.number().int().nonnegative(),
});
export type PresenceMoved = z.infer<typeof PresenceMovedSchema>;
