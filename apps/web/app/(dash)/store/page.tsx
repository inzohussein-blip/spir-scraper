import { STORE_CATEGORIES, STORE_TOOLS, type StoreCategory, type StoreTool } from "@scrapers/core";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { Badge, cx } from "@/components/ui";
import { getRuntime } from "@/lib/runtime";
import { missingNeeds, priceLabel, TOOL_ICON } from "@/lib/store";

/**
 * «المتجر»: every collection tool as a card, by platform, with its price and
 * whether it still needs a setting. A card opens the tool's page and form.
 */
export default async function Store({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; c?: string }>;
}) {
  const { q = "", c = "" } = await searchParams;
  const engineOnline = await (await getRuntime()).scrapers.engineOnline();
  const needle = q.trim().toLowerCase();
  const tools = STORE_TOOLS.filter(
    (t) =>
      (!c || t.category === c) &&
      (!needle || `${t.name} ${t.summary} ${t.output}`.toLowerCase().includes(needle)),
  );
  const featured = !c && !needle ? STORE_TOOLS.filter((t) => t.featured) : [];
  const counts = new Map<string, number>();
  for (const t of STORE_TOOLS) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  const withQ = (base: string) =>
    q ? `${base}${base.includes("?") ? "&" : "?"}q=${encodeURIComponent(q)}` : base;

  const chip = (key: string, label: string, n: number) => (
    <Link
      key={key || "all"}
      href={withQ(key ? `/store?c=${key}` : "/store")}
      className={cx(
        "rounded-full border px-3 py-1 text-sm",
        c === key ? "border-accent bg-accent-soft text-accent" : "border-line hover:bg-surface-2",
      )}
    >
      {label} <span className="text-muted">{n}</span>
    </Link>
  );

  const card = (t: StoreTool) => {
    const missing = missingNeeds(t, engineOnline);
    return (
      <Link
        key={t.id}
        href={`/store/${t.id}`}
        className="card flex flex-col gap-2 p-4 transition hover:border-accent"
        data-tool={t.id}
      >
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent">
            <Icon name={TOOL_ICON[t.category]} />
          </span>
          <div className="min-w-0">
            <div className="truncate font-semibold">{t.name}</div>
            <div className="text-xs text-muted">{STORE_CATEGORIES[t.category]}</div>
          </div>
        </div>
        <p className="flex-1 text-sm text-fg-2">{t.summary}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={t.pricing.kind === "apify" ? "warn" : "ok"}>{priceLabel(t)}</Badge>
          {missing.length > 0 && <Badge tone="info">يحتاج إعداداً</Badge>}
        </div>
      </Link>
    );
  };

  return (
    <>
      <form className="flex flex-wrap items-center gap-2" action="/store">
        {c && <input type="hidden" name="c" value={c} />}
        <input
          name="q"
          defaultValue={q}
          aria-label="ابحث في الأدوات"
          placeholder="ابحث عن أداة: تعليقات، متابعين، إعلانات…"
          className="min-w-0 flex-1 rounded-[10px] border border-line bg-surface px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-[10px] border border-line px-3 py-2 text-sm hover:bg-surface-2"
        >
          بحث
        </button>
      </form>
      <nav className="flex flex-wrap gap-2" aria-label="التصنيفات">
        {chip("", "الكل", STORE_TOOLS.length)}
        {(Object.keys(STORE_CATEGORIES) as StoreCategory[]).map((k) =>
          chip(k, STORE_CATEGORIES[k], counts.get(k) ?? 0),
        )}
      </nav>

      {featured.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-[15px] font-semibold">الأكثر فائدة لعملك</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{featured.map(card)}</div>
        </section>
      )}
      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold">
          {c ? STORE_CATEGORIES[c as StoreCategory] : "كل الأدوات"} ({tools.length})
        </h2>
        {tools.length === 0 ? (
          <p className="text-sm text-muted">لا أدوات تطابق البحث.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{tools.map(card)}</div>
        )}
      </section>
    </>
  );
}
