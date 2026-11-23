/**
 * Market topics and the content plan template. Topics are matched in bios and
 * captions (Arabic and English) to read what the audience is moving toward.
 */
export const MARKET_TOPICS = {
  gold: { label: "الذهب", pattern: "ذهب|الذهب|gold|xau" },
  crypto: {
    label: "الكريبتو",
    pattern: "كريبتو|كربتو|بيتكوين|بتكوين|عملات رقمية|crypto|bitcoin|btc|eth|binance",
  },
  stocks: {
    label: "الأسهم",
    pattern: "أسهم|اسهم|الأسهم|سهم|تاسي|nasdaq|stocks?|s&p|نازداك",
  },
  forex: { label: "الفوركس", pattern: "فوركس|فوريكس|forex|\\bfx\\b|عملات اجنبية|عملات أجنبية" },
  education: {
    label: "تعليم التداول",
    pattern: "دورة|كورس|تعليم|أكاديمية|اكاديمية|course|academy|mentor",
  },
  signals: { label: "التوصيات", pattern: "توصيات|توصية|signals?|إشارات|اشارات" },
} satisfies Record<string, { label: string; pattern: string }>;

export type MarketTopic = keyof typeof MARKET_TOPICS;

/** Topics mentioned in a text (case-insensitive). */
export function topicsOf(text: string | null | undefined): MarketTopic[] {
  if (!text) return [];
  return (Object.keys(MARKET_TOPICS) as MarketTopic[]).filter((k) =>
    new RegExp(MARKET_TOPICS[k].pattern, "iu").test(text),
  );
}

export interface ContentPlanInput {
  offer: string;
  personas: { name: string; description: string }[];
  /** The owner's posts that brought the most interest or money, best first. */
  bestPosts: { caption: string; type: string | null; interest: number; revenue: number }[];
  /** Topics growing in the audience, most growth first. */
  risingTopics: { topic: string; change: number }[];
  /** Competitors growing fastest. */
  competitors: { username: string; percent: number | null }[];
}

export interface ContentPlan {
  days: {
    day: string;
    format: string;
    topic: string;
    hook: string;
    persona: string | null;
    goal: string;
  }[];
  reels: { title: string; hook: string; script: string; cta: string }[];
  notes: string[];
}

const DAYS = ["السبت", "الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة"];

/**
 * A plan built without AI from the same data: the topics that are rising, the
 * formats that worked on the owner's account, a segment per day.
 */
export function templateContentPlan(input: ContentPlanInput): ContentPlan {
  const topics = input.risingTopics.length
    ? input.risingTopics.map((t) => t.topic)
    : ["الذهب", "الأسهم", "إدارة المخاطر"];
  const bestFormat =
    input.bestPosts.find((p) => p.type)?.type?.replace("carousel_album", "كاروسيل") ?? "ريل";
  const personas = input.personas.length ? input.personas.map((p) => p.name) : [null];
  const formats = [
    bestFormat,
    "ستوري تفاعلي",
    "كاروسيل",
    bestFormat,
    "بث مباشر",
    bestFormat,
    "ستوري أسئلة",
  ];
  const goals = ["جذب", "تفاعل", "ثقة", "جذب", "تحويل", "ثقة", "تحويل"];
  const hooks = [
    (t: string) => `أكثر خطأ يقع فيه المبتدئ في ${t}`,
    (t: string) => `سؤال لكم: وش أكبر تحدي عندكم في ${t}؟`,
    (t: string) => `${t}: 3 أشياء لازم تعرفها قبل أي صفقة`,
    (t: string) => `كيف تقرأ حركة ${t} هذا الأسبوع بدون تعقيد`,
    (t: string) => `جلسة أسئلة مباشرة عن ${t}`,
    (t: string) => `قصة متداول: كيف حمى رأس ماله في ${t}`,
    (t: string) => `اسألني أي شيء عن ${t} وفتح الحساب`,
  ];
  const days = DAYS.map((day, i) => {
    const topic = topics[i % topics.length] as string;
    return {
      day,
      format: formats[i] as string,
      topic,
      hook: (hooks[i] as (t: string) => string)(topic),
      persona: personas[i % personas.length] ?? null,
      goal: goals[i] as string,
    };
  });
  const reels = topics.slice(0, 3).map((t) => ({
    title: `${t} للمبتدئين في 30 ثانية`,
    hook: `لا تدخل ${t} قبل ما تسمع هذا`,
    script: [
      `الثانية 0-3: «لا تدخل ${t} قبل ما تسمع هذا».`,
      `3-15: فكرة واحدة واضحة عن ${t} (مثال من السوق هذا الأسبوع).`,
      "15-25: خطأ شائع وكيف تتجنبه، مع تذكير أن التداول فيه مخاطرة.",
      "25-30: دعوة للتعليق بكلمة «التفاصيل» لإرسال المعلومات.",
    ].join("\n"),
    cta: "علّق «التفاصيل» وأرسل لك الخطوات",
  }));
  const notes = [
    input.bestPosts[0]
      ? `أفضل منشور عندك جلب ${input.bestPosts[0].interest} تعليق اهتمام: كرّر أسلوبه.`
      : "اربط حسابك لنعرف أي نوع منشورات يجلب عملاء.",
    ...(input.competitors[0]
      ? [
          `@${input.competitors[0].username} ينمو الأسرع (${input.competitors[0].percent ?? 0}%): راجع آخر منشوراته.`,
        ]
      : []),
    "لا تعد بأرباح ولا تقل «بدون مخاطرة»: كل نص يُراجَع قبل حفظه.",
  ];
  return { days, reels, notes };
}
