-- Images become an engine capability. Two core tables, and the shape of the
-- second is the whole design decision.
--
-- `assets` is the blob, content-addressed: `sha256` IS the storage key, so
-- dedup and cache-busting are free and a key's content can never change.
--
-- `entity_assets` maps (scope, entity_id, slot) -> asset. `scope` is a plugin
-- id or the literal 'core'. It carries NO foreign key on `entity_id`, on
-- purpose: the alternative design (an `asset_id` column on every entity table)
-- would add a foreign key from each plugin table into a core table, and a
-- foreign key is a lock — `FOR KEY SHARE` taken implicitly, invisible to a
-- reader checking only the explicit lock calls, and the cause of both deadlocks
-- this project has shipped. This migration adds exactly one FK and it is
-- core-to-core, on a table no gameplay path locks. The cost is orphan rows when
-- an entity is deleted, which the sweeper collects.
--
-- Drift guard (`apps/server/test/schema.test.ts`): foreign keys 36 -> 37
-- (cascade 23 -> 24), non-primary-key indexes 29 -> 30 (assets_sha256_key).
-- The composite primary key on `entity_assets` is not counted.
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_assets" (
	"scope" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_assets_scope_entity_id_slot_pk" PRIMARY KEY("scope","entity_id","slot")
);
--> statement-breakpoint
ALTER TABLE "entity_assets" ADD CONSTRAINT "entity_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_sha256_key" ON "assets" USING btree ("sha256");
