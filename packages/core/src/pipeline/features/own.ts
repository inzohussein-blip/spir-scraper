import { inboxMessages, ownComments, ownPosts } from "@scrapers/db";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { checkMessage } from "../../compliance.js";
import { commentIntent } from "../../extract/index.js";
import type { FeatureContext } from "./context.js";

/** The owner's own Instagram account: posts, comments that show interest, and direct messages. */
export function ownMethods(ctx: FeatureContext) {
  const { db, deps, scorer, notify, self } = ctx;

  /** Stores a direct message (from the Meta webhook, or a reply sent from here). */
  async function storeMessage(m: {
    id: string;
    threadId: string;
    username?: string | null;
    direction: "in" | "out";
    text: string;
    at?: Date;
  }) {
    const [row] = await db
      .insert(inboxMessages)
      .values({
        id: m.id,
        threadId: m.threadId,
        username: m.username ?? null,
        direction: m.direction,
        text: m.text.slice(0, 4000),
        ...(m.at ? { at: m.at } : {}),
        ...(m.direction === "out" ? { readAt: new Date() } : {}),
      })
      .onConflictDoNothing({ target: inboxMessages.id })
      .returning({ id: inboxMessages.id });
    if (row && m.direction === "in") {
      const intent = commentIntent(m.text);
      await notify({
        type: "system",
        level: intent.length ? "ok" : "info",
        title: `${intent.length ? "🔥 " : ""}رسالة جديدة${m.username ? ` من @${m.username}` : ""}`,
        body: m.text.slice(0, 200),
        url: `/inbox?thread=${encodeURIComponent(m.threadId)}`,
        key: `dm:${m.id}`,
      });
    }
    return !!row;
  }

  return {
    /** Whether the owner's own account is connected (IG_BUSINESS_ACCOUNT_ID + IG_GRAPH_TOKEN). */
    get ownAccountAvailable() {
      return !!deps.own;
    },

    /**
     * Reads the owner's recent posts and their comments. Commenters showing
     * buying intent ("بكم؟", "التفاصيل", "price") are sent to the project as
     * leads, one job per post so revenue is credited to the post that brought them.
     */
    async syncOwnAccount(projectId: string, opts: { posts?: number } = {}) {
      if (!deps.own) throw new Error("ربط حسابك يحتاج IG_BUSINESS_ACCOUNT_ID و IG_GRAPH_TOKEN");
      const media = await deps.own.listMedia(opts.posts ?? 20);
      let newComments = 0;
      let hot = 0;
      const jobsStarted: string[] = [];
      for (const m of media) {
        await db
          .insert(ownPosts)
          .values({
            mediaId: m.id,
            caption: m.caption,
            permalink: m.permalink,
            type: m.type,
            postedAt: m.timestamp ? new Date(m.timestamp) : null,
            likes: m.likes,
            comments: m.comments,
          })
          .onConflictDoUpdate({
            target: ownPosts.mediaId,
            set: {
              likes: m.likes,
              comments: m.comments,
              caption: m.caption,
              fetchedAt: new Date(),
            },
          });
        const comments = m.comments ? await deps.own.listComments(m.id, 100) : [];
        const fresh: string[] = [];
        for (const c of comments) {
          const intent = commentIntent(c.text);
          const [row] = await db
            .insert(ownComments)
            .values({
              id: c.id,
              mediaId: m.id,
              username: c.username,
              text: c.text.slice(0, 1000),
              at: c.timestamp ? new Date(c.timestamp) : null,
              intent: intent.length ? intent : null,
            })
            .onConflictDoNothing({ target: ownComments.id })
            .returning({ id: ownComments.id });
          if (!row) continue;
          newComments++;
          if (intent.length && c.username) fresh.push(c.username);
        }
        const [{ n } = { n: 0 }] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(ownComments)
          .where(and(eq(ownComments.mediaId, m.id), isNotNull(ownComments.intent)));
        await db
          .update(ownPosts)
          .set({ intentComments: Number(n) })
          .where(eq(ownPosts.mediaId, m.id));
        // Interested commenters not sent yet (also those the webhook delivered between syncs).
        const pending = await db
          .select({ username: ownComments.username })
          .from(ownComments)
          .where(
            and(
              eq(ownComments.mediaId, m.id),
              isNotNull(ownComments.intent),
              eq(ownComments.leadSent, false),
              isNotNull(ownComments.username),
            ),
          );
        const names = [...new Set([...fresh, ...pending.map((x) => x.username as string)])];
        if (names.length) {
          hot += names.length;
          const { job } = await self().startJob({
            projectId,
            source: { type: "upload", usernames: names, url: `منشوري: ${m.permalink ?? m.id}` },
            limit: names.length,
          });
          jobsStarted.push(job.id);
          await db
            .update(ownComments)
            .set({ leadSent: true })
            .where(and(eq(ownComments.mediaId, m.id), inArray(ownComments.username, names)));
        }
      }
      if (hot > 0)
        await notify({
          type: "system",
          level: "ok",
          title: `${hot} عملاء ساخنون علّقوا على منشوراتك`,
          body: "كتبوا ما يدل على اهتمام (بكم، التفاصيل، أبغى…). أُضيفوا للعملاء.",
          url: "/own",
          key: `own-hot:${new Date().toISOString().slice(0, 13)}`,
        });
      return { posts: media.length, newComments, hot, jobs: jobsStarted };
    },

    /**
     * Each own post with its interest and what it brought: leads from its
     * commenters, customers and revenue (the "منشوري:" sources).
     */
    async ownPostPerformance(projectId: string) {
      const posts = await db.select().from(ownPosts).orderBy(desc(ownPosts.postedAt)).limit(100);
      const perf = await self().sourcePerformance(projectId);
      return posts.map((p) => {
        const s = perf.sources.find((x) => x.source === `منشوري: ${p.permalink ?? p.mediaId}`);
        return {
          ...p,
          leads: s?.leads ?? 0,
          customers: s?.customers ?? 0,
          revenue: s?.revenue ?? 0,
        };
      });
    },

    /** A comment delivered by the Meta webhook; leads are created at the next sync. */
    async storeComment(c: {
      id: string;
      mediaId: string;
      username: string | null;
      text: string;
      at?: Date;
    }) {
      await db
        .insert(ownPosts)
        .values({ mediaId: c.mediaId })
        .onConflictDoNothing({ target: ownPosts.mediaId });
      const intent = commentIntent(c.text);
      const [row] = await db
        .insert(ownComments)
        .values({
          id: c.id,
          mediaId: c.mediaId,
          username: c.username?.toLowerCase() ?? null,
          text: c.text.slice(0, 1000),
          at: c.at ?? new Date(),
          intent: intent.length ? intent : null,
        })
        .onConflictDoNothing({ target: ownComments.id })
        .returning({ id: ownComments.id });
      if (row && intent.length)
        await notify({
          type: "system",
          level: "ok",
          title: `🔥 @${c.username ?? "?"} مهتم بمنشورك`,
          body: c.text.slice(0, 200),
          url: "/own",
          key: `own-comment:${c.id}`,
        });
      return !!row;
    },

    async hotComments(limit = 30) {
      return db
        .select()
        .from(ownComments)
        .where(isNotNull(ownComments.intent))
        .orderBy(sql`${ownComments.at} desc nulls last`)
        .limit(limit);
    },

    storeMessage,

    async listThreads(limit = 50) {
      const rows = await db
        .select({
          threadId: inboxMessages.threadId,
          username: sql<string | null>`max(${inboxMessages.username})`,
          last: sql<Date>`max(${inboxMessages.at})`,
          unread: sql<number>`count(*) filter (where ${inboxMessages.direction} = 'in' and ${inboxMessages.readAt} is null)::int`,
          lastIn: sql<Date | null>`max(${inboxMessages.at}) filter (where ${inboxMessages.direction} = 'in')`,
        })
        .from(inboxMessages)
        .groupBy(inboxMessages.threadId)
        .orderBy(sql`max(${inboxMessages.at}) desc`)
        .limit(limit);
      return rows.map((r) => ({ ...r, unread: Number(r.unread) }));
    },

    async threadMessages(threadId: string) {
      const msgs = await db
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.threadId, threadId))
        .orderBy(inboxMessages.at)
        .limit(200);
      await db
        .update(inboxMessages)
        .set({ readAt: new Date() })
        .where(and(eq(inboxMessages.threadId, threadId), isNull(inboxMessages.readAt)));
      return msgs;
    },

    /** A reply drafted by the AI for the owner to edit (empty without a key). */
    async draftReply(threadId: string, offer: string) {
      if (!scorer?.replyDraft) return "";
      const msgs = await db
        .select({ direction: inboxMessages.direction, text: inboxMessages.text })
        .from(inboxMessages)
        .where(eq(inboxMessages.threadId, threadId))
        .orderBy(inboxMessages.at)
        .limit(30);
      return scorer.replyDraft(
        msgs.map((m) => ({
          from: m.direction === "out" ? ("me" as const) : ("them" as const),
          text: m.text ?? "",
        })),
        offer,
      );
    },

    /**
     * Sends the owner's reply (they pressed send). Meta allows replies within
     * 24 hours of the person's last message; claims that break financial
     * promotion rules are refused.
     */
    async sendReply(threadId: string, text: string, now = new Date()) {
      if (!deps.own) throw new Error("الرد يحتاج ربط حسابك (IG_GRAPH_TOKEN)");
      const check = checkMessage(text);
      if (!check.ok)
        throw new Error(
          `لم تُرسل: ${check.issues
            .filter((i) => i.severity === "block")
            .map((i) => i.message)
            .join(" ")}`,
        );
      const [lastIn] = await db
        .select({ at: inboxMessages.at })
        .from(inboxMessages)
        .where(and(eq(inboxMessages.threadId, threadId), eq(inboxMessages.direction, "in")))
        .orderBy(desc(inboxMessages.at))
        .limit(1);
      if (!lastIn || now.getTime() - lastIn.at.getTime() > 24 * 3_600_000)
        throw new Error(
          "مرّ أكثر من 24 ساعة على آخر رسالة منه؛ Meta لا تسمح بالرد من هنا. رد من تطبيق إنستقرام.",
        );
      const sent = await deps.own.sendMessage(threadId, text);
      await storeMessage({ id: sent.id, threadId, direction: "out", text, at: now });
      await self().audit({ actor: "owner", action: "inbox.reply", detail: { threadId } });
      return sent;
    },
  };
}
