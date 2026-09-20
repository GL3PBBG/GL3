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

export const PresenceErrorCodeSchema = z.enum([
  "not_joined", "no_location", "rate_limited", "superseded",
  // Interior transitions (spec 2026-09-20 casino-interior §4.3).
  "unknown_hook", "no_interior", "wrong_space", "sentenced",
]);
export type PresenceErrorCode = z.infer<typeof PresenceErrorCodeSchema>;

export const HookKindSchema = z.enum(["building", "npc", "prop"]);
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

/** `"<pluginId>.<hookId>"` — the wire id of a placed hook (`PlacedHook.id`). */
export const HookRefSchema = z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, "hook ref must be <pluginId>.<hookId>").max(80);
export type HookRef = z.infer<typeof HookRefSchema>;

/**
 * Where an avatar is (spec 2026-09-20 casino-interior §1): the town's street
 * or one of its interiors. The player's `location_id` is the same in both —
 * an interior changes what the client draws, never what the game scopes.
 */
export const SpaceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("street"), locationId: IdSchema }),
  z.object({
    kind: z.literal("interior"), locationId: IdSchema, hookId: HookRefSchema,
    /** Where the player stands on the street after exiting: in front of the door. */
    exit: SceneSpawnSchema,
  }),
]);
export type SpaceRef = z.infer<typeof SpaceRefSchema>;

export const InteriorPointKindSchema = z.enum(["table", "machine", "npc"]);
export type InteriorPointKind = z.infer<typeof InteriorPointKindSchema>;
/** Ties a point to a game station; the owning plugin serves the live row behind it. */
export const InteriorBindingSchema = z.object({ gameId: z.string().min(1).max(80), station: z.number().int().min(0).max(99) });
export type InteriorBinding = z.infer<typeof InteriorBindingSchema>;
/** An interaction spot inside an interior. Absolute interior coordinates; `facing` is the dealer's for a table. */
export const InteriorPointSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, "point id must be lowercase kebab-case").max(40),
  kind: InteriorPointKindSchema,
  label: z.string().min(1).max(24),
  model: z.string().min(1),
  position: z.object({ x: finite, y: finite }),
  facing: finite,
  /** Index = seat number. Absolute, facing the point. */
  seats: z.array(SceneSpawnSchema).max(5).optional(),
  binding: InteriorBindingSchema.optional(),
});
export type InteriorPoint = z.infer<typeof InteriorPointSchema>;

/** What a door hook declares (spec §3); the SDK reuses this schema verbatim. */
export const InteriorDeclSchema = z.object({
  sceneKey: z.string().regex(/^[a-z][a-z0-9-]*$/, "sceneKey must be a lowercase tag").max(64),
  bounds: SceneBoundsSchema,
  /** Entrance, INSIDE. */
  spawn: SceneSpawnSchema,
  /** OUTSIDE, absolute street coordinates. Default: 3 m in front of the door (spec §4.2). */
  exit: SceneSpawnSchema.optional(),
  points: z.array(InteriorPointSchema),
});
export type InteriorDecl = z.infer<typeof InteriorDeclSchema>;

/** Lowercase tag a template slot carries and a hook may ask for (spec 2026-09-20 §1). */
export const ZoneSchema = z.string().regex(/^[a-z][a-z0-9-]*$/, "zone must be a lowercase tag").max(24);

/** One place a hook can occupy in an authored template. */
export const SlotSchema = z.object({
  id: z.string().min(1),
  accepts: HookKindSchema,
  zone: ZoneSchema,
  position: z.object({ x: finite, y: finite }),
  facing: finite,
  max: FootprintSchema,
});
export type Slot = z.infer<typeof SlotSchema>;

/** A building slot reserved for core.jail / core.hospital, with its confinement yard. */
export const FacilitySlotSchema = SlotSchema.extend({ yard: z.object({ x: finite, y: finite }) });
export type FacilitySlot = z.infer<typeof FacilitySlotSchema>;

/** A straight road segment; `halfWidth` is the carriageway, `pavement` the extra band each side. */
export const RoadSchema = z.object({
  from: z.object({ x: finite, y: finite }),
  to: z.object({ x: finite, y: finite }),
  halfWidth: z.number().positive(),
  pavement: z.number().nonnegative(),
});
export type Road = z.infer<typeof RoadSchema>;

/** An authored city layout (spec 2026-09-20 §1, §7), served at GET /api/world/template/:sceneKey. */
export const SceneTemplateSchema = z.object({
  key: z.string().min(1),
  bounds: SceneBoundsSchema,
  spawn: SceneSpawnSchema,
  roads: z.array(RoadSchema),
  slots: z.array(SlotSchema),
  facilities: z.object({ jail: FacilitySlotSchema, hospital: FacilitySlotSchema }),
});
export type SceneTemplate = z.infer<typeof SceneTemplateSchema>;

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
  /** Present on a door that can be ENTERED (spec 2026-09-20 casino-interior §2); `href` still opens the page. */
  interior: z.object({ sceneKey: z.string().min(1) }).optional(),
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
  /** Absent = street, so a client written before interiors reads every room as one. */
  space: SpaceRefSchema.optional(),
  /** Interior rooms only. */
  points: z.array(InteriorPointSchema).optional(),
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
