CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"url" text NOT NULL,
	"source" text NOT NULL,
	"display_name" text,
	"bio" text,
	"followers" integer,
	"stats" jsonb,
	"fetched_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_platform_handle_uq" UNIQUE("platform","handle")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "person_id" uuid;--> statement-breakpoint
UPDATE "profiles" SET "person_id" = gen_random_uuid();--> statement-breakpoint
INSERT INTO "people" ("id", "created_at") SELECT "person_id", "fetched_at" FROM "profiles";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_person_idx" ON "accounts" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "accounts" ENABLE ROW LEVEL SECURITY;
