import type { FeatureContext } from "./context.js";

/** The meters the saver reacts to (see the «الاستهلاك» page). */
export type SaverMeter = "dbHours" | "dbStorage" | "requests" | "apify";

export interface SaverState {
  /** The owner lets the platform save on its own (default on). */
  auto: boolean;
  active: boolean;
  /** YYYY-MM it was switched on: a new month undoes it. */
  month: string | null;
  since: string | null;
  /** What it changed, in Arabic, for the page and the alert. */
  actions: string[];
  /** Engine settings before it changed them. */
  previous: { batchMinutes: number; quietFrom: number; quietTo: number } | null;
  /** Monitors it paused (only these are switched back on). */
  pausedMonitors: string[];
}

const KEY = "saver:state";
const EMPTY: SaverState = {
  auto: true,
  active: false,
  month: null,
  since: null,
  actions: [],
  previous: null,
  pausedMonitors: [],
};

interface SaverSelf {
  engineSettings(): Promise<{ batchMinutes: number; quietFrom: number; quietTo: number }>;
  saveEngineSettings(input: {
    batchMinutes?: number;
    quietFrom?: number;
    quietTo?: number;
  }): Promise<unknown>;
  listMonitors(): Promise<{ id: string; enabled: boolean }[]>;
  setMonitorEnabled(id: string, enabled: boolean): Promise<void>;
}

/** Quiet hours that last at least eight hours (from the same start, or 01:00–09:00 when none). */
export function widerQuiet(from: number, to: number): { quietFrom: number; quietTo: number } {
  if (from === to) return { quietFrom: 1, quietTo: 9 };
  const length = (to - from + 24) % 24;
  return length >= 8
    ? { quietFrom: from, quietTo: to }
    : { quietFrom: from, quietTo: (from + 8) % 24 };
}

/**
 * Automatic saving: when a meter is heading past its free-plan limit, the
 * platform makes itself lighter (longer engine batches and quiet hours for
 * the database and requests; paid monitors paused for Apify), tells the
 * owner what it changed, and undoes it on request or when the month ends.
 */
export function saverMethods(ctx: FeatureContext) {
  const { notify, getValue, setValue } = ctx;
  const self = () => ctx.self() as unknown as SaverSelf;
  const state = async (): Promise<SaverState> => ({
    ...EMPTY,
    ...((await getValue<SaverState>(KEY)) ?? {}),
  });
  const save = (s: SaverState) => setValue(KEY, s, 400 * 86_400_000);

  async function undo(reason: string) {
    const s = await state();
    if (!s.active) return s;
    if (s.previous) await self().saveEngineSettings(s.previous);
    for (const id of s.pausedMonitors) await self().setMonitorEnabled(id, true);
    const next = { ...EMPTY, auto: s.auto };
    await save(next);
    await notify({
      type: "system",
      level: "info",
      title: "انتهى وضع التوفير",
      body: `${reason} أُعيدت إعدادات المحرك والمراقبات كما كانت.`,
      url: "/usage",
      key: `saver-off:${new Date().toISOString().slice(0, 13)}`,
    });
    return next;
  }

  return {
    saverState: state,

    async setSaverAuto(auto: boolean) {
      const s = await state();
      await save({ ...s, auto });
    },

    undoSaver: () => undo("أنهيته من صفحة الاستهلاك."),

    /**
     * Called by the daily maintenance with the meters heading past their
     * limit. Applies what is not applied yet; a new month undoes it first.
     */
    async applySaver(over: SaverMeter[], now = new Date()) {
      let s = await state();
      const month = now.toISOString().slice(0, 7);
      if (s.active && s.month !== month) s = await undo("بدأ شهر جديد.");
      if (!s.auto || over.length === 0) return null;
      const added: string[] = [];
      if ((over.includes("dbHours") || over.includes("requests")) && !s.previous) {
        const e = await self().engineSettings();
        const quiet = widerQuiet(e.quietFrom, e.quietTo);
        const batch = Math.max(e.batchMinutes, 90);
        await self().saveEngineSettings({ batchMinutes: batch, ...quiet });
        s.previous = { batchMinutes: e.batchMinutes, quietFrom: e.quietFrom, quietTo: e.quietTo };
        added.push(
          `دفعات المحرك ${batch} دقيقة وساعات الراحة من ${quiet.quietFrom}:00 إلى ${quiet.quietTo}:00 (أقل اتصالات بالقاعدة)`,
        );
      }
      if (over.includes("apify") && s.pausedMonitors.length === 0) {
        const on = (await self().listMonitors()).filter((m) => m.enabled);
        for (const m of on) await self().setMonitorEnabled(m.id, false);
        if (on.length) {
          s.pausedMonitors = on.map((m) => m.id);
          added.push(
            `أُوقفت ${on.length} مراقبة مدفوعة حتى نهاية الشهر (القراءة عبر المحرك تبقى مجانية)`,
          );
        }
      }
      if (over.includes("dbStorage"))
        added.push("حجم القاعدة يقترب من الحد: احذف المشاريع القديمة أو قصّر مدة الاحتفاظ بالعملاء");
      if (added.length === 0) return null;
      const next: SaverState = {
        ...s,
        active: true,
        month,
        since: s.since ?? now.toISOString(),
        actions: [...s.actions, ...added],
      };
      await save(next);
      await notify({
        type: "system",
        level: "warn",
        title: "شغّلت المنصة وضع التوفير",
        body: `${added.join("\n")}\nتلغيه بزر واحد من صفحة الاستهلاك.`,
        url: "/usage",
        key: `saver-on:${now.toISOString().slice(0, 10)}`,
      });
      return next;
    },
  };
}
