CREATE TABLE "tool_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"data" jsonb NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_items_run_key_uq" UNIQUE("run_id","key")
);
--> statement-breakpoint
CREATE TABLE "tool_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tool" text NOT NULL,
	"project_id" uuid,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"flagged" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_items" ADD CONSTRAINT "tool_items_run_id_tool_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."tool_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runs" ADD CONSTRAINT "tool_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_items_run_idx" ON "tool_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "tool_runs_started_idx" ON "tool_runs" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "tool_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_items" ENABLE ROW LEVEL SECURITY;