import { z } from "zod";
import { AudienceSchema, IdSchema, MoneySchema, TimestampSchema } from "./primitives.js";

/**
 * SPEC §3: every event carries `at` (ISO string) and the acting player's id +
 * display name. Payloads therefore never repeat the actor.
 */
const base = {
  id: IdSchema,
  at: TimestampSchema,
  actorId: IdSchema,
  actorName: z.string(),
  audience: AudienceSchema,
};

export const GameEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("crime.resolved"),
    crimeId: IdSchema,
    crimeName: z.string(),
    success: z.boolean(),
    payout: MoneySchema,
    bullets: MoneySchema,
    exp: MoneySchema,
    jailedUntil: TimestampSchema.nullable(),
  }),
  // actor = the jailed player.
  z.object({ ...base, type: z.literal("player.jailed"), until: TimestampSchema, reason: z.string() }),
  z.object({ ...base, type: z.literal("player.released") }),
  // fromLocationId is null the first time a player ever travels (no prior
  // location — playerStats.location_id starts null and M2 does not backfill
  // a "home" location at registration, see M2 plan Task 7).
  z.object({ ...base, type: z.literal("player.travelled"), fromLocationId: IdSchema.nullable(), toLocationId: IdSchema, cost: MoneySchema }),
  // actor = the attacker.
  z.object({ ...base, type: z.literal("player.attacked"), targetId: IdSchema, targetName: z.string(), damage: z.number().int().nonnegative() }),
  // actor = the killer, or the victim when the kill has no human killer.
  z.object({ ...base, type: z.literal("player.killed"), victimId: IdSchema, victimName: z.string() }),
  // actor = the player who placed the bounty.
  z.object({ ...base, type: z.literal("bounty.placed"), bountyId: IdSchema, targetId: IdSchema, targetName: z.string(), amount: MoneySchema }),
  // actor = the player who claimed it.
  z.object({ ...base, type: z.literal("bounty.claimed"), bountyId: IdSchema, targetId: IdSchema, targetName: z.string(), amount: MoneySchema }),
  // actor = the founding boss.
  z.object({ ...base, type: z.literal("gang.created"), gangId: IdSchema, gangName: z.string() }),
  // actor = the member who joined / left.
  z.object({ ...base, type: z.literal("gang.memberJoined"), gangId: IdSchema }),
  z.object({ ...base, type: z.literal("gang.memberLeft"), gangId: IdSchema }),
  // actor = the sender, or the recipient for system mail.
  z.object({ ...base, type: z.literal("mail.received"), mailId: IdSchema, recipientId: IdSchema, subject: z.string() }),
  // actor = the notified player.
  z.object({ ...base, type: z.literal("notification.created"), notificationId: IdSchema, body: z.string() }),
  // actor = the author.
  z.object({ ...base, type: z.literal("news.posted"), newsId: IdSchema, title: z.string() }),
  // actor = the speaker; actorName is the display name, so no separate username field.
  z.object({ ...base, type: z.literal("chat.message"), body: z.string() }),
  // actor = the player who just joined.
  z.object({ ...base, type: z.literal("player.joined") }),
  // actor = the player who ranked up.
  z.object({
    ...base, type: z.literal("player.rankedUp"),
    rankId: IdSchema, rankName: z.string(), cashReward: MoneySchema, bulletReward: MoneySchema, maxHealth: z.number().int().positive(),
  }),
  // actor = the account holder. Private audience — bank state is not broadcast.
  z.object({
    ...base, type: z.literal("bank.transacted"),
    direction: z.enum(["deposit", "withdraw"]), amount: MoneySchema, cash: MoneySchema, bank: MoneySchema,
  }),
  // actor = the buyer.
  z.object({
    ...base, type: z.literal("bullets.purchased"),
    locationId: IdSchema, quantity: z.number().int().positive(), cost: MoneySchema, cash: MoneySchema, bullets: MoneySchema,
  }),
  // actor = the OC participant whose status changed.
  z.object({ ...base, type: z.literal("oc.updated"), heistId: IdSchema, status: z.enum(["open", "executing", "done", "failed", "cancelled"]) }),
  // actor = the OC participant receiving the result.
  z.object({ ...base, type: z.literal("oc.resolved"), heistId: IdSchema, success: z.boolean(), share: MoneySchema, jailSeconds: z.number().int().nonnegative() }),
  /**
   * The envelope every plugin event travels in. The twenty-one core variants
   * above stay closed and unchanged; ported core modules keep emitting their
   * own typed variants (spec: Events). A plugin declares the payload schema,
   * the `describe` template and the invalidation keys in its manifest, and all
   * three reach the client through GET /api/plugins.
   *
   * `payload` is `z.record(z.unknown())` because this schema cannot know a
   * plugin's shapes — the plugin's own declared schema is what checks them.
   * Money inside a payload is still a decimal string, as everywhere else.
   */
  z.object({
    ...base,
    type: z.literal("plugin.event"),
    pluginId: z.string(),
    name: z.string(),
    payload: z.record(z.unknown()),
  }),
]);

export type GameEvent = z.infer<typeof GameEventSchema>;
export type GameEventType = GameEvent["type"];
