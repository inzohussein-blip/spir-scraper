CREATE TABLE "broker_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"external_id" text,
	"email_hash" text,
	"phone_hash" text,
	"amount" numeric(14, 2),
	"currency" text,
	"sub" text,
	"lead_id" uuid,
	"partner_id" uuid,
	"source" text NOT NULL,
	"dedupe_key" text NOT NULL,
	CONSTRAINT "broker_events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "inbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"username" text,
	"direction" text NOT NULL,
	"text" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "own_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"media_id" text NOT NULL,
	"username" text,
	"text" text,
	"at" timestamp with time zone,
	"intent" text[],
	"lead_sent" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "own_posts" (
	"media_id" text PRIMARY KEY NOT NULL,
	"caption" text,
	"permalink" text,
	"type" text,
	"posted_at" timestamp with time zone,
	"likes" integer,
	"comments" integer,
	"intent_comments" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_clicks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"instagram" text,
	"share_percent" integer DEFAULT 0 NOT NULL,
	"portal_token" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partners_code_unique" UNIQUE("code"),
	CONSTRAINT "partners_portal_token_unique" UNIQUE("portal_token")
);
--> statement-breakpoint
ALTER TABLE "broker_events" ADD CONSTRAINT "broker_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "broker_events" ADD CONSTRAINT "broker_events_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "own_comments" ADD CONSTRAINT "own_comments_media_id_own_posts_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."own_posts"("media_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_clicks" ADD CONSTRAINT "partner_clicks_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broker_events_lead_idx" ON "broker_events" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "broker_events_partner_idx" ON "broker_events" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "broker_events_at_idx" ON "broker_events" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inbox_thread_idx" ON "inbox_messages" USING btree ("thread_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "own_comments_media_idx" ON "own_comments" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "partner_clicks_partner_idx" ON "partner_clicks" USING btree ("partner_id","at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "partners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "partner_clicks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broker_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "own_posts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "own_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inbox_messages" ENABLE ROW LEVEL SECURITY;
