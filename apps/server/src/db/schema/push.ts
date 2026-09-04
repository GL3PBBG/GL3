import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { players } from "./identity.js";

/**
 * A registered Expo push token. See 0023_push_devices.sql for why the token
 * is unique game-wide rather than per player, and why `disabled_at` is a soft
 * delete rather than a row removal.
 *
 * `platform` is a bare `text` rather than an enum: the DTO
 * (`PushDeviceRegisterRequestSchema`) is what constrains it to
 * "android" | "ios", and a CHECK constraint here would mean a migration to
 * add a third platform for no gain the zod schema does not already provide.
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: uuid("id").primaryKey(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    expoToken: text("expo_token").notNull(),
    platform: text("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().default(sql`now()`),
    /** Set when Expo reports the token dead; the subscriber filters these out. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => ({
    expoTokenUnique: uniqueIndex("push_devices_expo_token_key").on(t.expoToken),
    playerIdx: index("push_devices_player_idx").on(t.playerId),
  }),
);
