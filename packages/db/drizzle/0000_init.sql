CREATE TYPE "public"."contact_source" AS ENUM('business_button', 'bio', 'link');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."provider_id" AS ENUM('graph', 'apify', 'worker', 'upload');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('profile', 'post', 'hashtag', 'upload');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{read}'::text[] NOT NULL,
	"last_used" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_url" text NOT NULL,
	"limit" integer NOT NULL,
	"provider" "provider_id",
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_usd" numeric(10, 4) DEFAULT '0' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_limit_range" CHECK ("jobs"."limit" between 1 and 5000)
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"email" text,
	"phone_e164" text,
	"phone_raw" text,
	"phone_country" char(2),
	"contact_source" "contact_source",
	"ai_score" smallint,
	"ai_tags" text[],
	"ai_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_project_profile_uq" UNIQUE("project_id","profile_id"),
	CONSTRAINT "leads_ai_score_range" CHECK ("leads"."ai_score" between 0 and 100),
	CONSTRAINT "leads_contact_has_source" CHECK (("leads"."email" is null and "leads"."phone_e164" is null and "leads"."phone_raw" is null) or "leads"."contact_source" is not null)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"ig_user_id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"full_name" text,
	"bio" text,
	"followers" integer,
	"following" integer,
	"posts" integer,
	"is_business" boolean DEFAULT false NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"category" text,
	"external_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_by" "provider_id" NOT NULL,
	CONSTRAINT "profiles_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"sheet_id" text,
	"ai_criteria" text,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppression" (
	"value_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppression_kind" CHECK ("suppression"."kind" in ('username', 'email', 'phone'))
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_profile_id_profiles_ig_user_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("ig_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_project_created_idx" ON "jobs" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_project_score_idx" ON "leads" USING btree ("project_id","ai_score" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "leads_expires_idx" ON "leads" USING btree ("expires_at");