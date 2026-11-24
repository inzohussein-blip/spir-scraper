import type { SourceType } from "./types.js";

/** The store's shelves, by where the data comes from. */
export const STORE_CATEGORIES = {
  instagram: "إنستقرام",
  tiktok: "تيك توك",
  youtube: "يوتيوب",
  facebook: "فيسبوك",
  maps: "خرائط Google",
  web: "المواقع",
  own: "حسابي",
} as const;
export type StoreCategory = keyof typeof STORE_CATEGORIES;

/** What a tool needs before it can run. */
export type StoreNeed = "apify" | "youtube" | "own" | "engine";

export const STORE_NEEDS: Record<StoreNeed, string> = {
  apify: "APIFY_TOKEN",
  youtube: "YOUTUBE_API_KEY",
  own: "ربط حسابك الرسمي (IG_BUSINESS_ACCOUNT_ID و IG_GRAPH_TOKEN)",
  engine: "جهاز متصل بمحرك Spir",
};

/**
 * How a tool runs:
 * - job: a collection job (leads go to a project), with this source type;
 * - tool: a tool run whose results are a dataset (see features/tools.ts);
 * - page: a window of its own in the dashboard.
 */
export type StoreRun =
  | { kind: "job"; sourceType: SourceType }
  | { kind: "tool" }
  | { kind: "page"; href: string };

export interface StoreTool {
  id: string;
  name: string;
  /** One line under the name. */
  summary: string;
  /** What the owner gets, shown on the tool's page. */
  output: string;
  category: StoreCategory;
  /**
   * free: no money at all; apify: paid from the Apify credit (per1k is the
   * price per 1,000 results); engine-or-apify: free through the Spir engine,
   * or Apify when there is no device.
   */
  pricing: { kind: "free" | "apify" | "engine-or-apify"; per1k?: number; unit?: string };
  needs: StoreNeed[];
  run: StoreRun;
  /** Shown first in the store. */
  featured?: boolean;
  /** Pinned at the very top of the store with its explanation («ابدأ من هنا»). */
  pinned?: boolean;
  /** A fuller explanation: when to use it, what comes out, what it costs. */
  details?: string[];
  /** For a tool run: an example of what to type. */
  example?: string;
}

/** Every collection tool of the platform, in the store's order. */
export const STORE_TOOLS: StoreTool[] = [
  {
    id: "ig-commenters",
    name: "المعلّقون على حساب",
    summary: "من يعلّق على منشورات حساب منافس أو مدرب: أكثر الناس اهتماماً.",
    output: "عملاء في مشروعك: الاسم، والبايو، والمتابعون، ووسائل التواصل، والتقييم.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: [],
    run: { kind: "job", sourceType: "profile" },
    featured: true,
    pinned: true,
    details: [
      "ضع رابط صفحة إنستقرام (منافس، مدرب، وسيط) فتجمع من يعلّقون على منشوراتها.",
      "الأفضل غالباً: أشخاص متفاعلون فعلاً، ونسبة المهتمين بينهم أعلى من المتابعين.",
      "لكل حساب: الاسم، والبايو، والمتابعون، والدولة واللغة، والتقييم، والإيميل والهاتف والموقع إن كانت ظاهرة للعامة.",
      "الإيميل والرقم يظهران غالباً للحسابات التجارية والمدربين والشركات؛ الحسابات الشخصية العادية غالباً بلا وسيلة تواصل ظاهرة.",
      "القراءة مجانية عبر محرك Spir إن كان جهازك متصلاً، وإلا من رصيد Apify (حوالي 1.60 دولار لكل 1000 حساب). المقروء خلال 30 يوماً لا يُدفع مرة أخرى.",
      "بعد الانتهاء: صفحة العملاء ← فلتر «له إيميل» أو «له هاتف» ← تصدير Excel.",
    ],
  },
  {
    id: "ig-followers",
    name: "متابعو حساب",
    summary: "قائمة متابعي حساب منافس، مرتبة بالأقرب لعملائك.",
    output: "عملاء في مشروعك مع بيانات حساباتهم.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: ["apify"],
    run: { kind: "job", sourceType: "followers" },
    featured: true,
    pinned: true,
    details: [
      "ضع رابط صفحة إنستقرام فتجمع قائمة متابعيها، والأقرب لعملائك أولاً.",
      "استعملها حين تريد عدداً أكبر من المعلّقين (آلاف الحسابات).",
      "لكل حساب نفس البيانات: الاسم، والبايو، والمتابعون، والتقييم، والإيميل والهاتف والموقع إن كانت ظاهرة للعامة.",
      "جمع القائمة من Apify (حوالي 1.15 دولار لكل 1000 متابع)، والقراءة مجانية بالمحرك أو من رصيد Apify.",
      "بعد الانتهاء: صفحة العملاء ← فلتر «له إيميل» أو «له هاتف» ← تصدير Excel.",
    ],
  },
  {
    id: "ig-post",
    name: "المعلّقون على منشور",
    summary: "كل من علّق على منشور أو ريل محدد.",
    output: "عملاء في مشروعك، مع تمييز من سأل عن السعر أو التسجيل.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: [],
    run: { kind: "job", sourceType: "post" },
  },
  {
    id: "ig-hashtag",
    name: "هاشتاق",
    summary: "من ينشر على هاشتاق مثل #تداول أو #فوركس.",
    output: "عملاء في مشروعك.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: ["apify"],
    run: { kind: "job", sourceType: "hashtag" },
  },
  {
    id: "ig-search",
    name: "بحث بالكلمات",
    summary: "حسابات تطابق كلمات مثل «مدرب تداول دبي».",
    output: "عملاء في مشروعك.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: ["apify"],
    run: { kind: "job", sourceType: "search" },
  },
  {
    id: "ig-location",
    name: "مكان",
    summary: "من ينشر من مكان محدد (رابط صفحة مكان في إنستقرام).",
    output: "عملاء في مشروعك.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: ["apify"],
    run: { kind: "job", sourceType: "location" },
  },
  {
    id: "ig-similar",
    name: "حسابات مشابهة",
    summary: "الحسابات التي يقترحها إنستقرام بجانب حساب ما.",
    output: "عملاء في مشروعك.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: ["apify"],
    run: { kind: "job", sourceType: "similar" },
  },
  {
    id: "ig-list",
    name: "قراءة قائمة حسابات",
    summary: "الصق أسماء حسابات أو ارفع ملف CSV فتُقرأ كلها.",
    output: "عملاء في مشروعك.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: [],
    run: { kind: "job", sourceType: "upload" },
  },
  {
    id: "spir-engine",
    name: "محرك Spir",
    summary: "زحف بطيء ومجاني من جهازك: يبدأ من حسابات ويتبع من يذكرونهم.",
    output: "مجموعة حسابات تُرسل إلى مشروعك، مع سرعة وساعات راحة تتحكم بها.",
    category: "instagram",
    pricing: { kind: "free" },
    needs: ["engine"],
    run: { kind: "page", href: "/engine" },
    featured: true,
  },
  {
    id: "ig-competitor",
    name: "تحليل منافس",
    summary: "نمو المنافس، وأفضل منشوراته، ومن يتفاعل معه، ومراقبة دورية.",
    output: "تقرير وتاريخ نمو، وتنبيه عند القفزات.",
    category: "instagram",
    pricing: { kind: "engine-or-apify", unit: "حساب" },
    needs: [],
    run: { kind: "page", href: "/competitors" },
  },
  {
    id: "tiktok-comments",
    name: "تعليقات تيك توك",
    summary: "من يسأل تحت فيديوهات التداول: «كيف أبدأ؟»، «بكم؟».",
    output: "قائمة التعليقات مع تمييز من أبدى اهتماماً، ورابط حسابه.",
    category: "tiktok",
    pricing: { kind: "apify", per1k: 0.5, unit: "تعليق" },
    needs: ["apify"],
    run: { kind: "tool" },
    featured: true,
    example: "https://www.tiktok.com/@account/video/1234567890",
  },
  {
    id: "youtube-comments",
    name: "تعليقات يوتيوب",
    summary: "تعليقات فيديو يوتيوب، ومن يسأل عن الاشتراك أو الحساب.",
    output: "قائمة التعليقات مع تمييز من أبدى اهتماماً، ورابط قناته.",
    category: "youtube",
    pricing: { kind: "free" },
    needs: ["youtube"],
    run: { kind: "tool" },
    featured: true,
    example: "https://www.youtube.com/watch?v=VIDEO_ID",
  },
  {
    id: "fb-ads",
    name: "إعلانات المنافسين (مكتبة إعلانات Meta)",
    summary: "من يعلن عن التداول في بلدك، وماذا يقول، ومنذ متى.",
    output: "قائمة الإعلانات: المعلن، والنص، والرابط، وتاريخ البدء، وهل ما زال يعمل.",
    category: "facebook",
    pricing: { kind: "apify", per1k: 0.75, unit: "إعلان" },
    needs: ["apify"],
    run: { kind: "tool" },
    featured: true,
    example: "تداول",
  },
  {
    id: "maps-businesses",
    name: "شركات من خرائط Google",
    summary: "مكاتب ومراكز تدريب وشركات في مدينة، مع مواقعها وأرقامها.",
    output: "قائمة شركات، وقراءة مواقعها، وتحويلها إلى عملاء.",
    category: "maps",
    pricing: { kind: "apify", unit: "مكان" },
    needs: ["apify"],
    run: { kind: "page", href: "/places" },
  },
  {
    id: "web-watch",
    name: "مراقبة موقع منافس",
    summary: "تنبيه حين يتغير موقع منافس (عروض، أسعار، صفحات جديدة).",
    output: "إشعار بما تغير.",
    category: "web",
    pricing: { kind: "free" },
    needs: [],
    run: { kind: "page", href: "/competitors" },
  },
  {
    id: "own-comments",
    name: "تعليقات ورسائل حسابي",
    summary: "من يعلّق أو يراسل حسابك الرسمي، ومن سأل عن السعر.",
    output: "عملاء في مشروعك ورسائل في صندوق الوارد.",
    category: "own",
    pricing: { kind: "free" },
    needs: ["own"],
    run: { kind: "page", href: "/own" },
  },
];

export function storeTool(id: string): StoreTool | undefined {
  return STORE_TOOLS.find((t) => t.id === id);
}

/** A YouTube video id from a link (watch, youtu.be, shorts, embed) or the id itself. */
export function youtubeVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (host.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
      if (m?.[1]) return m[1];
    }
  } catch {
    // not a URL
  }
  return null;
}

/** A TikTok video link, or null. */
export function tiktokVideoUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "tiktok.com" && /^\/@[\w.-]+\/video\/\d+/.test(u.pathname))
      return `https://www.tiktok.com${u.pathname}`;
    if (host === "vm.tiktok.com" || host === "vt.tiktok.com") return u.toString();
  } catch {
    // not a URL
  }
  return null;
}

/**
 * The Meta Ad Library search address for keywords or a Facebook page.
 * `country` is a 2-letter code or ALL.
 */
export function adLibraryUrl(query: string, country: string): string {
  const q = query.trim();
  if (/^https?:\/\/(www\.)?facebook\.com\//i.test(q)) return q;
  const c = /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : "ALL";
  const qs = new URLSearchParams({
    active_status: "active",
    ad_type: "all",
    country: c,
    q,
    search_type: "keyword_unordered",
    media_type: "all",
  });
  return `https://www.facebook.com/ads/library/?${qs}`;
}
