CREATE TABLE IF NOT EXISTS "combat_log" (
  "id" uuid PRIMARY KEY NOT NULL,
  "attacker_id" uuid NOT NULL,
  "target_id" uuid NOT NULL,
  "hit" boolean NOT NULL,
  "damage" integer DEFAULT 0 NOT NULL,
  "fatal" boolean DEFAULT false NOT NULL,
  "weapon_item_id" uuid,
  "payout" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "combat_log" ADD CONSTRAINT "combat_log_attacker_id_players_id_fk"
  FOREIGN KEY ("attacker_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "combat_log" ADD CONSTRAINT "combat_log_target_id_players_id_fk"
  FOREIGN KEY ("target_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "combat_log" ADD CONSTRAINT "combat_log_weapon_item_id_items_id_fk"
  FOREIGN KEY ("weapon_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "combat_log_target_idx" ON "combat_log" ("target_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "combat_log_attacker_idx" ON "combat_log" ("attacker_id","created_at");
