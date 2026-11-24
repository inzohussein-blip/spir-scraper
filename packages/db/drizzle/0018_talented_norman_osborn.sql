CREATE TABLE "engine_proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"url_enc" text NOT NULL,
	"rotate_url_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"reads" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_ip" text,
	"resting_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engine_workers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"version" text,
	"ip" text,
	"exits" jsonb,
	"disabled" boolean DEFAULT false NOT NULL,
	"reads" integer DEFAULT 0 NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "engine_workers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "engine_proxies" ENABLE ROW LEVEL SECURITY;