CREATE TABLE "plugin_job_runs" (
	"plugin_id" text NOT NULL,
	"job_id" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_job_runs_plugin_id_job_id_pk" PRIMARY KEY("plugin_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_migrations" (
	"plugin_id" text NOT NULL,
	"name" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plugin_migrations_plugin_id_name_pk" PRIMARY KEY("plugin_id","name")
);
