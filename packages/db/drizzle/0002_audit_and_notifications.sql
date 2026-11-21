CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"url" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "audit_action_at_idx" ON "audit_log" USING btree ("action","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_at_idx" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_at_idx" ON "notifications" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_key_idx" ON "notifications" USING btree ("dedupe_key","at" DESC NULLS LAST);