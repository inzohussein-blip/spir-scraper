CREATE TABLE "site_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"label" text,
	"last_hash" text,
	"last_text" text,
	"last_checked_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"last_diff" jsonb,
	"error" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_watches_url_unique" UNIQUE("url")
);
--> statement-breakpoint
ALTER TABLE "site_watches" ENABLE ROW LEVEL SECURITY;
