ALTER TABLE "leads" ADD COLUMN "follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "message_template" text;--> statement-breakpoint
CREATE INDEX "leads_follow_up_idx" ON "leads" USING btree ("follow_up_at");