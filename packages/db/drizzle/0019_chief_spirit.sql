CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"category" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_day_category_pk" PRIMARY KEY("day","category")
);
--> statement-breakpoint
CREATE TABLE "usage_slots" (
	"day" date NOT NULL,
	"slot" smallint NOT NULL,
	CONSTRAINT "usage_slots_day_slot_pk" PRIMARY KEY("day","slot")
);
--> statement-breakpoint
ALTER TABLE "usage_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_slots" ENABLE ROW LEVEL SECURITY;