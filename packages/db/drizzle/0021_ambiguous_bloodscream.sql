ALTER TYPE "public"."contact_source" ADD VALUE 'website';--> statement-breakpoint
ALTER TYPE "public"."contact_source" ADD VALUE 'account';--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "contact_checked_at" timestamp with time zone;