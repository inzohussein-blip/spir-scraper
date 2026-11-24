CREATE TABLE "engine_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engine_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"username" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"referrer" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"leased_until" timestamp with time zone,
	"read_at" timestamp with time zone,
	"accepted" boolean,
	"note" text,
	"followers" integer,
	"job_id" uuid,
	CONSTRAINT "engine_queue_run_user_uq" UNIQUE("run_id","username")
);
--> statement-breakpoint
CREATE TABLE "engine_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"seeds" text[] NOT NULL,
	"keywords" text[],
	"max_depth" integer DEFAULT 2 NOT NULL,
	"max_accounts" integer DEFAULT 500 NOT NULL,
	"min_followers" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "engine_queue" ADD CONSTRAINT "engine_queue_run_id_engine_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."engine_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engine_events_at_idx" ON "engine_events" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "engine_queue_next_idx" ON "engine_queue" USING btree ("status","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "engine_queue_read_idx" ON "engine_queue" USING btree ("read_at");--> statement-breakpoint
ALTER TABLE "engine_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "engine_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "engine_events" ENABLE ROW LEVEL SECURITY;