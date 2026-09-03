-- Push notification device registry (spec 2026-09-03-push-notifications-design).
-- One row per app INSTALLATION, not per player: `expo_token` is unique
-- game-wide so a shared handset that signs out player A and signs in player B
-- transfers the row rather than leaving A's mail ringing on B's phone. The
-- registration route upserts on that unique index.
--
-- `disabled_at` is a soft delete, not a DELETE: a token Expo reports as
-- DeviceNotRegistered is usually a reinstall, and keeping the row gives the
-- re-registration upsert something to clear instead of the table growing a
-- new row per reinstall.
--
-- `platform` is stored and unused by the sender in v1 — Expo's message shape
-- is platform-neutral. It exists so the iOS sub-project has a column to
-- filter on rather than a migration to write.
--
-- Drift guard (apps/server/test/schema.test.ts): foreign keys 38 -> 39
-- (cascade 24 -> 25, set-null unchanged at 14); non-primary-key indexes
-- 31 -> 33 (push_devices_expo_token_key, push_devices_player_idx).
CREATE TABLE "push_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"expo_token" text NOT NULL,
	"platform" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_expo_token_key" ON "push_devices" USING btree ("expo_token");--> statement-breakpoint
CREATE INDEX "push_devices_player_idx" ON "push_devices" USING btree ("player_id");
