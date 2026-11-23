CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "profile_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"followers" integer,
	"following" integer,
	"posts" integer,
	"is_business" boolean
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "persona" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "search_text" text;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "signals" text[];--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "personas" jsonb;--> statement-breakpoint
CREATE INDEX "profile_snapshots_profile_idx" ON "profile_snapshots" USING btree ("profile_id","at" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "profile_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "profiles" SET "search_text" = lower(concat_ws(' ', "username", "full_name", "category", "bio"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profiles_search_trgm_idx" ON "profiles" USING gin ("search_text" gin_trgm_ops);--> statement-breakpoint
INSERT INTO "profile_snapshots" ("profile_id", "at", "followers", "following", "posts", "is_business") SELECT "ig_user_id", "fetched_at", "followers", "following", "posts", "is_business" FROM "profiles";