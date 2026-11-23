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

export const sourceType = pgEnum("source_type", [
  "profile",
  "followers",
  "post",
  "hashtag",
  "upload",
  "search",
  "location",
  "similar",
]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "done", "failed", "cancelled"]);
export const contactSource = pgEnum("contact_source", ["business_button", "bio", "link"]);
export const providerId = pgEnum("provider_id", ["graph", "apify", "worker", "upload"]);
/** Where the owner is with each lead (idea from the Spir bot's review page). */
export const leadStatus = pgEnum("lead_status", [
  "new",
  "contacted",
  "interested",
  "customer",
  "rejected",
]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  owner: text("owner").notNull(),
  /** Existing Google Sheet to append to (optional). */
  sheetId: text("sheet_id"),
  /** Free-text scoring criteria for the AI layer. */
  aiCriteria: text("ai_criteria"),
  retentionDays: integer("retention_days").notNull().default(90),
  /** Append every lead (with its score) to the project's sheet when a job finishes. */
  autoExport: boolean("auto_export").notNull().default(false),
  /** Words in a name or bio that trigger an alert, e.g. وكيل, IB, partner. */
  watchKeywords: text("watch_keywords").array(),
  /** First-message template for WhatsApp links; {name} and {username} are filled in. */
  messageTemplate: text("message_template"),
  /** Audience segments found by AI: name, description and the words that mark them. */
  personas: jsonb("personas").$type<{ name: string; description: string; keywords: string[] }[]>(),
  /** The prediction model trained on this project's outcomes (see core learn/model). */
  model: jsonb("model").$type<Record<string, unknown>>(),
  /** Do not keep accounts with two or more fake-account signals and no contact. */
  skipFake: boolean("skip_fake").notNull().default(false),
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
    /** Skip accounts already in the project (used by monitors). */
    onlyNew: boolean("only_new").notNull().default(false),
    monitorId: uuid("monitor_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("jobs_limit_range", sql`${t.limit} between 1 and 5000`),
    index("jobs_project_created_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

/** One real person or business, whatever platforms they are on. */
export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: createdAt(),
});

export const profiles = pgTable("profiles", {
  igUserId: text("ig_user_id").primaryKey(),
  /** The person this Instagram account belongs to (see accounts for their other platforms). */
  personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
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
  /** Public contact-button fields, kept so a cached profile can be re-read without fetching. */
  businessEmail: text("business_email"),
  businessPhone: text("business_phone"),
  businessPhoneCountryCode: text("business_phone_country_code"),
  businessWhatsapp: text("business_whatsapp"),
  city: text("city"),
  /** Average (likes + comments) / followers over recent posts, in percent. */
  engagementRate: numeric("engagement_rate", { precision: 7, scale: 3 }),
  /** Heuristic warnings such as low_engagement or follow_farming. */
  qualityFlags: text("quality_flags").array(),
  /** Main script of the name and bio: ar, fa, en, ... (heuristic). */
  language: text("language"),
  /** Lower-cased username, name, category and bio, for trigram similarity search. */
  searchText: text("search_text"),
  /** Timing signals from the account's history, e.g. rising, became_business. */
  signals: text("signals").array(),
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
    /** Most likely country (from the phone, bio, city and emails), for filtering. */
    country: char("country", { length: 2 }),
    contactSource: contactSource("contact_source"),
    aiScore: smallint("ai_score"),
    aiTags: text("ai_tags").array(),
    aiReason: text("ai_reason"),
    /** Suppression hash of the phone, so suppressing a number is an index lookup. */
    phoneHash: text("phone_hash"),
    status: leadStatus("status").notNull().default("new"),
    statusNote: text("status_note"),
    statusAt: timestamp("status_at", { withTimezone: true }),
    /** When the owner wants to be reminded to follow up (cleared once reminded). */
    followUpAt: timestamp("follow_up_at", { withTimezone: true }),
    /** What the deal was worth to the owner (deposit, commission...), set when it closes. */
    dealValue: numeric("deal_value", { precision: 12, scale: 2 }),
    /** Chance (0-100) it becomes a customer, by the model trained on the owner's outcomes. */
    winProb: smallint("win_prob"),
    /** The project's audience segment this account belongs to (see projects.personas). */
    persona: text("persona"),
    dealAt: timestamp("deal_at", { withTimezone: true }),
    /** Every source (competitor, post, hashtag) the account was found in for this project. */
    sources: text("sources").array(),
    /** Number of distinct sources; following several competitors signals interest. */
    sourceCount: integer("source_count").notNull().default(1),
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
    index("leads_profile_idx").on(t.profileId),
    index("leads_phone_hash_idx").on(t.phoneHash),
    index("leads_project_status_idx").on(t.projectId, t.status),
    index("leads_follow_up_idx").on(t.followUpAt),
    index("leads_project_sources_idx").on(t.projectId, t.sourceCount),
    index("leads_project_country_idx").on(t.projectId, t.country),
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

/** Who did what and from where: logins, failed logins and changes (dashboard "النشاط"). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** owner | api:<key name> | mcp | system */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    ip: text("ip"),
  },
  (t) => [
    index("audit_action_at_idx").on(t.action, t.at.desc()),
    index("audit_at_idx").on(t.at.desc()),
  ],
);

/** Bell notifications in the dashboard, also pushed to Telegram when configured. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** job | provider | budget | ai | security | system */
    type: text("type").notNull(),
    /** info | ok | warn | bad */
    level: text("level").notNull().default("info"),
    title: text("title").notNull(),
    body: text("body"),
    url: text("url"),
    /** Same key within 30 minutes is not repeated. */
    dedupeKey: text("dedupe_key"),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_at_idx").on(t.at.desc()),
    index("notifications_key_idx").on(t.dedupeKey, t.at.desc()),
  ],
);

export type AuditEntry = typeof auditLog.$inferSelect;
export type Notification = typeof notifications.$inferSelect;

/** Recurring jobs that watch a competitor and collect only new accounts. */
export const monitors = pgTable(
  "monitors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sourceType: sourceType("source_type").notNull(),
    sourceUrl: text("source_url").notNull(),
    limit: integer("limit").notNull().default(100),
    everyDays: integer("every_days").notNull().default(7),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    check("monitors_every_days", sql`${t.everyDays} between 1 and 90`),
    check("monitors_limit_range", sql`${t.limit} between 1 and 5000`),
  ],
);

/** Short-lived values shared by serverless instances: idempotency, used OAuth codes, provider state. */
export const ephemeral = pgTable(
  "ephemeral",
  {
    key: text("key").primaryKey(),
    value: jsonb("value").$type<unknown>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("ephemeral_expires_idx").on(t.expiresAt)],
);

/** Fixed-window counters, e.g. API requests per key per minute. */
export const counters = pgTable(
  "counters",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("counters_expires_idx").on(t.expiresAt)],
);

/** Browser push subscriptions for dashboard notifications. */
export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: createdAt(),
});

export type Monitor = typeof monitors.$inferSelect;
export type LeadStatus = (typeof leadStatus.enumValues)[number];

/** The owner's notes and the history of each lead (status changes, profile changes). */
export const leadEvents = pgTable(
  "lead_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** note | status | change | follow_up */
    kind: text("kind").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("lead_events_lead_idx").on(t.leadId, t.at.desc())],
);

/** Follower counts of watched competitors over time (growth alerts and analysis). */
export const competitorSnapshots = pgTable(
  "competitor_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    followers: integer("followers"),
    posts: integer("posts"),
  },
  (t) => [index("competitor_snapshots_user_idx").on(t.username, t.at.desc())],
);

export type LeadEvent = typeof leadEvents.$inferSelect;

/** Each fetch of a profile, so growth and changes over time can be read. */
export const profileSnapshots = pgTable(
  "profile_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: text("profile_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    followers: integer("followers"),
    following: integer("following"),
    posts: integer("posts"),
    isBusiness: boolean("is_business"),
  },
  (t) => [index("profile_snapshots_profile_idx").on(t.profileId, t.at.desc())],
);

/**
 * A person's accounts on other platforms (TikTok, YouTube, Telegram, X, their
 * website...). Found in their own bio or link, or added by the owner.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    handle: text("handle").notNull(),
    url: text("url").notNull(),
    /** bio_link (their own bio or link) | website (linked from their site) | manual (added by the owner) */
    source: text("source").notNull(),
    displayName: text("display_name"),
    bio: text("bio"),
    /** Followers, subscribers or members, whatever the platform counts. */
    followers: integer("followers"),
    /** Platform-specific numbers, e.g. videos and views for YouTube. */
    stats: jsonb("stats").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("accounts_platform_handle_uq").on(t.platform, t.handle),
    index("accounts_person_idx").on(t.personId),
  ],
);

export type Account = typeof accounts.$inferSelect;

/** Businesses found on Google Maps for a project (shops, offices, training centers...). */
export const places = pgTable(
  "places",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    placeId: text("place_id").notNull(),
    /** The search that found it, e.g. "مكتب صرافة · الرياض". */
    query: text("query").notNull(),
    name: text("name").notNull(),
    category: text("category"),
    address: text("address"),
    city: text("city"),
    country: char("country", { length: 2 }),
    phone: text("phone"),
    website: text("website"),
    rating: numeric("rating", { precision: 2, scale: 1 }),
    reviews: integer("reviews"),
    url: text("url"),
    /** Found on its website. */
    instagram: text("instagram"),
    emails: text("emails").array(),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    /** When its Instagram account was sent to the project as a lead. */
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("places_project_place_uq").on(t.projectId, t.placeId),
    index("places_project_idx").on(t.projectId, t.createdAt.desc()),
  ],
);

export type Place = typeof places.$inferSelect;

/** Competitor pages (prices, offers, partner terms) checked for changes. */
export const siteWatches = pgTable("site_watches", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull().unique(),
  label: text("label"),
  /** sha256 of the page's normalised text. */
  lastHash: text("last_hash"),
  lastText: text("last_text"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
  /** Lines added and removed at the last change. */
  lastDiff: jsonb("last_diff").$type<{ added: string[]; removed: string[] }>(),
  error: text("error"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
});

export type SiteWatch = typeof siteWatches.$inferSelect;

/** People who bring clients (coaches, channel owners) with their own tracking link. */
export const partners = pgTable("partners", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Short code in the tracking link and the broker's sub id. */
  code: text("code").notNull().unique(),
  instagram: text("instagram"),
  /** Share of the commission the partner earns, in percent. */
  sharePercent: integer("share_percent").notNull().default(0),
  /** Secret for the partner's read-only page. */
  portalToken: text("portal_token").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const partnerClicks = pgTable(
  "partner_clicks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("partner_clicks_partner_idx").on(t.partnerId, t.at.desc())],
);

/**
 * What the broker reports: registrations, first deposits, deposits, trades and
 * commissions. Emails and phones are kept only as hashes, for matching.
 */
export const brokerEvents = pgTable(
  "broker_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** registration | ftd | deposit | trade | commission */
    event: text("event").notNull(),
    /** The broker's client id. */
    externalId: text("external_id"),
    emailHash: text("email_hash"),
    phoneHash: text("phone_hash"),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    currency: text("currency"),
    /** Sub id from the tracking link (a partner's code). */
    sub: text("sub"),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    partnerId: uuid("partner_id").references(() => partners.id, { onDelete: "set null" }),
    /** postback | csv */
    source: text("source").notNull(),
    /** Same report line twice is stored once. */
    dedupeKey: text("dedupe_key").notNull().unique(),
  },
  (t) => [
    index("broker_events_lead_idx").on(t.leadId),
    index("broker_events_partner_idx").on(t.partnerId),
    index("broker_events_at_idx").on(t.at.desc()),
  ],
);

/** The owner's own Instagram posts (Graph API), for comments and what each post brought. */
export const ownPosts = pgTable("own_posts", {
  mediaId: text("media_id").primaryKey(),
  caption: text("caption"),
  permalink: text("permalink"),
  type: text("type"),
  postedAt: timestamp("posted_at", { withTimezone: true }),
  likes: integer("likes"),
  comments: integer("comments"),
  /** Comments showing buying intent. */
  intentComments: integer("intent_comments").notNull().default(0),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ownComments = pgTable(
  "own_comments",
  {
    id: text("id").primaryKey(),
    mediaId: text("media_id")
      .notNull()
      .references(() => ownPosts.mediaId, { onDelete: "cascade" }),
    username: text("username"),
    text: text("text"),
    at: timestamp("at", { withTimezone: true }),
    intent: text("intent").array(),
    /** The commenter was sent to a project as a lead. */
    leadSent: boolean("lead_sent").notNull().default(false),
  },
  (t) => [index("own_comments_media_idx").on(t.mediaId)],
);

/** Direct messages to the owner's account (Meta webhook), and the replies sent from here. */
export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: text("id").primaryKey(),
    /** The other person's Instagram-scoped id: one thread per person. */
    threadId: text("thread_id").notNull(),
    username: text("username"),
    direction: text("direction").notNull(),
    text: text("text"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("inbox_thread_idx").on(t.threadId, t.at.desc())],
);

export type Partner = typeof partners.$inferSelect;
export type BrokerEvent = typeof brokerEvents.$inferSelect;
export type OwnPost = typeof ownPosts.$inferSelect;
export type InboxMessage = typeof inboxMessages.$inferSelect;
