CREATE TABLE "competitor_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"followers" integer,
	"posts" integer
);
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "country" char(2);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "sources" text[];--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "source_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "language" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "skip_fake" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lead_events" ADD CONSTRAINT "lead_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_snapshots_user_idx" ON "competitor_snapshots" USING btree ("username","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "lead_events_lead_idx" ON "lead_events" USING btree ("lead_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_project_sources_idx" ON "leads" USING btree ("project_id","source_count");--> statement-breakpoint
CREATE INDEX "leads_project_country_idx" ON "leads" USING btree ("project_id","country");--> statement-breakpoint
UPDATE "leads" SET "sources" = ARRAY[j."source_url"] FROM "jobs" j WHERE j."id" = "leads"."job_id";
--> statement-breakpoint
UPDATE "leads" SET "country" = "phone_country" WHERE "phone_country" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "lead_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "competitor_snapshots" ENABLE ROW LEVEL SECURITY;