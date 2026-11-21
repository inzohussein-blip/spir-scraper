import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const sourceType = pgEnum("source_type", ["profile", "post", "hashtag", "upload"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "done", "failed", "cancelled"]);
export const contactSource = pgEnum("contact_source", ["business_button", "bio", "link"]);
export const providerId = pgEnum("provider_id", ["graph", "apify", "worker", "upload"]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  owner: text("owner").notNull(),
  /** Existing Google Sheet to append to (optional). */
  sheetId: text("sheet_id"),
  /** Free-text scoring criteria for the AI layer. */
  aiCriteria: text("ai_criteria"),
  retentionDays: integer("retention_days").notNull().default(90),
  createdAt: createdAt(),
});

export type JobCounts = {
  discovered?: number;
  enriched?: number;
  leads?: number;
  /** Suppressed, private or missing accounts. */
  skipped?: number;
  failed?: number;
  /** AI audience report (markdown). */
  report?: string;
  /** Pending Anthropic Message Batch for AI scoring. */
  aiBatchId?: string;
  aiCriteria?: string;
  scored?: number;
};

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceType: sourceType("source_type").notNull(),
    sourceUrl: text("source_url").notNull(),
    limit: integer("limit").notNull(),
    /** Provider actually used for discovery. */
    provider: providerId("provider"),
    status: jobStatus("status").notNull().default("queued"),
    counts: jsonb("counts").$type<JobCounts>().notNull().default({}),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull().default("0"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("jobs_limit_range", sql`${t.limit} between 1 and 5000`),
    index("jobs_project_created_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

export const profiles = pgTable("profiles", {
  igUserId: text("ig_user_id").primaryKey(),
  username: text("username").notNull().unique(),
  fullName: text("full_name"),
  bio: text("bio"),
  followers: integer("followers"),
  following: integer("following"),
  posts: integer("posts"),
  isBusiness: boolean("is_business").notNull().default(false),
  isVerified: boolean("is_verified").notNull().default(false),
  category: text("category"),
  externalUrl: text("external_url"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  fetchedBy: providerId("fetched_by").notNull(),
});

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    profileId: text("profile_id")
      .notNull()
      .references(() => profiles.igUserId, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    email: text("email"),
    /** Verified number in E.164. */
    phoneE164: text("phone_e164"),
    /** Number as written, when its country could not be confirmed. */
    phoneRaw: text("phone_raw"),
    /** ISO 3166-1 alpha-2 country of the phone number. */
    phoneCountry: char("phone_country", { length: 2 }),
    contactSource: contactSource("contact_source"),
    aiScore: smallint("ai_score"),
    aiTags: text("ai_tags").array(),
    aiReason: text("ai_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("leads_project_profile_uq").on(t.projectId, t.profileId),
    check("leads_ai_score_range", sql`${t.aiScore} between 0 and 100`),
    check(
      "leads_contact_has_source",
      sql`(${t.email} is null and ${t.phoneE164} is null and ${t.phoneRaw} is null) or ${t.contactSource} is not null`,
    ),
    index("leads_project_score_idx").on(t.projectId, t.aiScore.desc()),
    index("leads_expires_idx").on(t.expiresAt),
  ],
);

export const suppression = pgTable(
  "suppression",
  {
    /** sha256(normalize(value) + pepper) — the raw value is never stored. */
    valueHash: text("value_hash").primaryKey(),
    kind: text("kind").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [check("suppression_kind", sql`${t.kind} in ('username', 'email', 'phone')`)],
);

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopes: text("scopes").array().notNull().default(sql`'{read}'::text[]`),
  lastUsed: timestamp("last_used", { withTimezone: true }),
  createdAt: createdAt(),
});

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Suppression = typeof suppression.$inferSelect;
