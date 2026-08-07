CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TYPE "public"."balance_kind" AS ENUM('cash', 'bank', 'points');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bounties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"placed_by" uuid NOT NULL,
	"target" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" uuid
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value" bigint NOT NULL,
	"theft_weight" integer DEFAULT 1 NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crime_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"crime_id" uuid NOT NULL,
	"success" boolean NOT NULL,
	"payout" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crimes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"cooldown_seconds" integer NOT NULL,
	"min_payout" bigint NOT NULL,
	"max_payout" bigint NOT NULL,
	"min_bullets" integer DEFAULT 0 NOT NULL,
	"max_bullets" integer DEFAULT 0 NOT NULL,
	"exp_reward" bigint DEFAULT 0 NOT NULL,
	"min_rank" integer DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "detective_searches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"target_player_id" uuid NOT NULL,
	"detectives" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"succeeded" boolean
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "game_news" (
	"id" uuid PRIMARY KEY NOT NULL,
	"author_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gang_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gang_id" uuid NOT NULL,
	"invited_player_id" uuid NOT NULL,
	"invited_by_player_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gang_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gang_id" uuid NOT NULL,
	"player_id" uuid,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gang_members" (
	"gang_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gang_members_gang_id_player_id_pk" PRIMARY KEY("gang_id","player_id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gang_permissions" (
	"gang_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "gang_permissions_gang_id_player_id_permission_pk" PRIMARY KEY("gang_id","player_id","permission")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gangs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"info" text DEFAULT '' NOT NULL,
	"bank" bigint DEFAULT 0 NOT NULL,
	"cash" bigint DEFAULT 0 NOT NULL,
	"bullets" bigint DEFAULT 0 NOT NULL,
	"level" integer DEFAULT 1 NOT NULL,
	"location_id" uuid,
	"boss_player_id" uuid,
	"underboss_player_id" uuid,
	CONSTRAINT "gangs_name_unique" UNIQUE("name")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "garage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"car_id" uuid NOT NULL,
	"damage" integer DEFAULT 0 NOT NULL,
	"location_id" uuid
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "id_map" (
	"v2_table" text NOT NULL,
	"v2_id" integer NOT NULL,
	"v3_id" uuid NOT NULL,
	CONSTRAINT "id_map_v2_table_v2_id_pk" PRIMARY KEY("v2_table","v2_id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"item_type" text NOT NULL,
	"effects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"travel_cost" bigint DEFAULT 0 NOT NULL,
	"travel_cooldown_seconds" integer DEFAULT 0 NOT NULL,
	"bullet_stock" integer DEFAULT 0 NOT NULL,
	"bullet_cost" bigint DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"sender_id" uuid,
	"recipient_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "money_ranks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"threshold" bigint NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"body" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_crime_skill" (
	"player_id" uuid NOT NULL,
	"crime_id" uuid NOT NULL,
	"chance" numeric(5, 2) NOT NULL,
	CONSTRAINT "player_crime_skill_player_id_crime_id_pk" PRIMARY KEY("player_id","crime_id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_items" (
	"player_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "player_items_player_id_item_id_pk" PRIMARY KEY("player_id","item_id")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_stats" (
	"player_id" uuid PRIMARY KEY NOT NULL,
	"cash" bigint DEFAULT 0 NOT NULL,
	"bank" bigint DEFAULT 0 NOT NULL,
	"points" bigint DEFAULT 0 NOT NULL,
	"bullets" bigint DEFAULT 0 NOT NULL,
	"exp" bigint DEFAULT 0 NOT NULL,
	"health" integer DEFAULT 100 NOT NULL,
	"backfire" integer DEFAULT 0 NOT NULL,
	"rank_id" uuid,
	"gang_id" uuid,
	"location_id" uuid,
	"weapon_item_id" uuid,
	"armor_item_id" uuid,
	"avatar_url" text,
	"bio" text,
	"jailed_until" timestamp with time zone,
	"hospital_until" timestamp with time zone
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "player_timers" (
	"player_id" uuid NOT NULL,
	"key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "player_timers_player_id_key_pk" PRIMARY KEY("player_id","key")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "players" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" "citext" NOT NULL,
	"email" "citext",
	"password_hash" text,
	"legacy_password_sha256" text,
	"legacy_v2_id" integer,
	"role_id" uuid,
	"round_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "properties" (
	"id" uuid PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"owner_player_id" uuid,
	"cost" bigint DEFAULT 0 NOT NULL,
	"profit" bigint DEFAULT 0 NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ranks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"exp_required" bigint NOT NULL,
	"cash_reward" bigint DEFAULT 0 NOT NULL,
	"bullet_reward" integer DEFAULT 0 NOT NULL,
	"max_health" integer DEFAULT 100 NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_module_access" (
	"role_id" uuid NOT NULL,
	"module_key" text NOT NULL,
	CONSTRAINT "role_module_access_role_id_module_key_pk" PRIMARY KEY("role_id","module_key")
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rounds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "theft_tiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"success_chance" integer NOT NULL,
	"max_damage" integer NOT NULL,
	"min_car_value" bigint NOT NULL,
	"max_car_value" bigint NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"player_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"balance_kind" "balance_kind" NOT NULL,
	"reason" text NOT NULL,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "weapons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"accuracy" integer NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_placed_by_players_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_target_players_id_fk" FOREIGN KEY ("target") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bounties" ADD CONSTRAINT "bounties_claimed_by_players_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crime_log" ADD CONSTRAINT "crime_log_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crime_log" ADD CONSTRAINT "crime_log_crime_id_crimes_id_fk" FOREIGN KEY ("crime_id") REFERENCES "public"."crimes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "detective_searches" ADD CONSTRAINT "detective_searches_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "detective_searches" ADD CONSTRAINT "detective_searches_target_player_id_players_id_fk" FOREIGN KEY ("target_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "game_news" ADD CONSTRAINT "game_news_author_id_players_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_invites" ADD CONSTRAINT "gang_invites_gang_id_gangs_id_fk" FOREIGN KEY ("gang_id") REFERENCES "public"."gangs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_invites" ADD CONSTRAINT "gang_invites_invited_player_id_players_id_fk" FOREIGN KEY ("invited_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_invites" ADD CONSTRAINT "gang_invites_invited_by_player_id_players_id_fk" FOREIGN KEY ("invited_by_player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_logs" ADD CONSTRAINT "gang_logs_gang_id_gangs_id_fk" FOREIGN KEY ("gang_id") REFERENCES "public"."gangs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_logs" ADD CONSTRAINT "gang_logs_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_members" ADD CONSTRAINT "gang_members_gang_id_gangs_id_fk" FOREIGN KEY ("gang_id") REFERENCES "public"."gangs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_members" ADD CONSTRAINT "gang_members_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_permissions" ADD CONSTRAINT "gang_permissions_gang_id_gangs_id_fk" FOREIGN KEY ("gang_id") REFERENCES "public"."gangs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gang_permissions" ADD CONSTRAINT "gang_permissions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gangs" ADD CONSTRAINT "gangs_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gangs" ADD CONSTRAINT "gangs_boss_player_id_players_id_fk" FOREIGN KEY ("boss_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gangs" ADD CONSTRAINT "gangs_underboss_player_id_players_id_fk" FOREIGN KEY ("underboss_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garage" ADD CONSTRAINT "garage_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garage" ADD CONSTRAINT "garage_car_id_cars_id_fk" FOREIGN KEY ("car_id") REFERENCES "public"."cars"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "garage" ADD CONSTRAINT "garage_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_sender_id_players_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_recipient_id_players_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notifications" ADD CONSTRAINT "notifications_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_crime_skill" ADD CONSTRAINT "player_crime_skill_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_crime_skill" ADD CONSTRAINT "player_crime_skill_crime_id_crimes_id_fk" FOREIGN KEY ("crime_id") REFERENCES "public"."crimes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_items" ADD CONSTRAINT "player_items_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_items" ADD CONSTRAINT "player_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_rank_id_ranks_id_fk" FOREIGN KEY ("rank_id") REFERENCES "public"."ranks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_gang_id_gangs_id_fk" FOREIGN KEY ("gang_id") REFERENCES "public"."gangs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_weapon_item_id_items_id_fk" FOREIGN KEY ("weapon_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_armor_item_id_items_id_fk" FOREIGN KEY ("armor_item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "player_timers" ADD CONSTRAINT "player_timers_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "players" ADD CONSTRAINT "players_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "players" ADD CONSTRAINT "players_round_id_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "properties" ADD CONSTRAINT "properties_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "properties" ADD CONSTRAINT "properties_owner_player_id_players_id_fk" FOREIGN KEY ("owner_player_id") REFERENCES "public"."players"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_module_access" ADD CONSTRAINT "role_module_access_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bounties_target_idx" ON "bounties" USING btree ("target");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crime_log_player_idx" ON "crime_log" USING btree ("player_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crimes_sort_idx" ON "crimes" USING btree ("sort");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gang_invites_invited_idx" ON "gang_invites" USING btree ("invited_player_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gang_logs_gang_idx" ON "gang_logs" USING btree ("gang_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gang_members_player_idx" ON "gang_members" USING btree ("player_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "garage_player_idx" ON "garage" USING btree ("player_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_recipient_idx" ON "mail_messages" USING btree ("recipient_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_thread_idx" ON "mail_messages" USING btree ("thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_player_idx" ON "notifications" USING btree ("player_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_stats_cash_idx" ON "player_stats" USING btree ("cash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_stats_exp_idx" ON "player_stats" USING btree ("exp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_stats_gang_idx" ON "player_stats" USING btree ("gang_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_stats_rank_idx" ON "player_stats" USING btree ("rank_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "player_stats_location_idx" ON "player_stats" USING btree ("location_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "players_username_unique" ON "players" USING btree ("username");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "players_email_unique" ON "players" USING btree ("email");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "players_legacy_v2_id_unique" ON "players" USING btree ("legacy_v2_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "players_role_idx" ON "players" USING btree ("role_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "players_round_idx" ON "players" USING btree ("round_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "properties_location_idx" ON "properties" USING btree ("location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ranks_exp_idx" ON "ranks" USING btree ("exp_required");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_player_idx" ON "transactions" USING btree ("player_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_player_kind_idx" ON "transactions" USING btree ("player_id","balance_kind");
