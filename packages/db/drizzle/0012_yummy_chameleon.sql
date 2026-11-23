CREATE TABLE "places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"place_id" text NOT NULL,
	"query" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"address" text,
	"city" text,
	"country" char(2),
	"phone" text,
	"website" text,
	"rating" numeric(2, 1),
	"reviews" integer,
	"url" text,
	"instagram" text,
	"emails" text[],
	"analyzed_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "places_project_place_uq" UNIQUE("project_id","place_id")
);
--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "places_project_idx" ON "places" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "places" ENABLE ROW LEVEL SECURITY;
