CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'interested', 'customer', 'rejected');--> statement-breakpoint
CREATE TABLE "counters" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ephemeral" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_url" text NOT NULL,
	"limit" integer DEFAULT 100 NOT NULL,
	"every_days" integer DEFAULT 7 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitors_every_days" CHECK ("monitors"."every_days" between 1 and 90),
	CONSTRAINT "monitors_limit_range" CHECK ("monitors"."limit" between 1 and 5000)
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "only_new" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "monitor_id" uuid;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "phone_hash" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status" "lead_status" DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status_note" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "status_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "business_email" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "business_phone" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "business_phone_country_code" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "business_whatsapp" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "engagement_rate" numeric(7, 3);--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "quality_flags" text[];--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "auto_export" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "watch_keywords" text[];--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "counters_expires_idx" ON "counters" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ephemeral_expires_idx" ON "ephemeral" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "leads_profile_idx" ON "leads" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "leads_phone_hash_idx" ON "leads" USING btree ("phone_hash");--> statement-breakpoint
CREATE INDEX "leads_project_status_idx" ON "leads" USING btree ("project_id","status");