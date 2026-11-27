import Link from "next/link";
import {
  addEngineProxy,
  checkEngineIps,
  createKey,
  engineWorkerAction,
  resumeEngine,
  setEngineUseDirect,
  updateEngineProxy,
} from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { CopyText } from "@/components/extension-info";
import {
  Badge,
  Card,
  Field,
  fmtAgo,
  fmtDate,
  fmtNum,
  Input,
  LinkButton,
  Notice,
} from "@/components/ui";
import { EXE } from "@/lib/downloads";
import { appOrigin } from "@/lib/env";
import { getRuntime } from "@/lib/runtime";

export const metadata = { title: "العامل المنزلي" };

const STATE: Record<string, string> = {
  running: "يعمل",
  idle: "جاهز، لا يوجد ما يقرأه",
  resting: "يستريح بطلب من إنستقرام",
  quiet: "ساعات الراحة",
  daily_cap: "بلغ حد اليوم",
  paused: "متوقف من صفحة المحرك",
  no_worker: "لا يوجد جهاز متصل",
};

function Btn({
  children,
  tone = "plain",
}: {
  children: React.ReactNode;
  tone?: "plain" | "accent" | "bad";
}) {
  const cls =
    tone === "accent"
      ? "text-accent hover:bg-accent-soft"
      : tone === "bad"
        ? "text-bad hover:bg-bad-soft"
        : "text-muted hover:bg-bg-2";
  return (
    <button type="submit" className={`rounded px-2 py-0.5 text-xs ${cls}`}>
      {children}
    </button>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="ltr overflow-x-auto rounded-lg bg-bg-2 p-3 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  );
}

export default async function WorkersPage() {
  const rt = await getRuntime();
  const [status, workers, proxies] = await Promise.all([
    rt.scrapers.engineStatus(),
    rt.scrapers.listEngineWorkers(),
    rt.scrapers.listEngineProxies(),
  ]);
  const origin = appOrigin();
  const now = Date.now();
  const online = (seen: Date) => now - new Date(seen).getTime() < 15 * 60_000;
  const run = `python spir-worker.py --platform ${origin} --key sk_المفتاح`;

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-3 p-5">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold">العامل المنزلي</h1>
          <p className="text-sm text-muted">
            الأجهزة التي تقرأ لمحرك Spir من بيتك، وعناوينها، والبروكسيات، وطريقة تشغيلها. القراءة
            دائماً بدون تسجيل دخول، وحسابك على إنستقرام لا يُستعمل.
          </p>
        </div>
        <Badge
          tone={status.state === "running" ? "ok" : status.state === "resting" ? "warn" : "info"}
        >
          {STATE[status.state] ?? status.state}
        </Badge>
        {status.restingUntil && (
          <form action={resumeEngine}>
            <Btn tone="accent">أنهِ الاستراحة الآن</Btn>
          </form>
        )}
        <form action={checkEngineIps}>
          <Btn tone="accent">افحص العناوين</Btn>
        </form>
        <LinkButton href="/engine">صفحة المحرك</LinkButton>
      </div>
      {status.restingUntil && (
        <Notice tone="warn">
          المحرك يستريح حتى {fmtDate(status.restingUntil)} لأن إنستقرام طلب التمهل. إن غيّرت الشبكة
          أو الـ IP (انظر «إن حصلت مشكلة» في الأسفل)، اضغط «أنهِ الاستراحة الآن».
        </Notice>
      )}

      <Card
        title="الأجهزة"
        icon="plug"
        description="كل متصفح أو برنامج اتصل بالمنصة. «متصل» يعني أنه سأل خلال آخر 15 دقيقة."
      >
        {workers.length === 0 ? (
          <p className="text-sm text-muted">
            لم يتصل أي جهاز بعد. اختر طريقة من «طرق التشغيل» في الأسفل.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-[12.5px] text-muted">
                  {["الجهاز", "النوع", "العنوان (IP)", "المخارج", "قرأ", "آخر اتصال", ""].map(
                    (h) => (
                      <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {workers.map((w) => (
                  <tr key={w.id} className="border-b border-line align-top last:border-0">
                    <td className="py-2.5 pe-2">
                      <div className="font-medium">{w.name ?? w.id}</div>
                      <div className="ltr text-xs text-muted">
                        {w.id} {w.version ? `· v${w.version}` : ""}
                      </div>
                    </td>
                    <td className="px-2">{w.kind === "extension" ? "إضافة المتصفح" : "برنامج"}</td>
                    <td className="ltr px-2 font-mono text-xs">{w.ip ?? "—"}</td>
                    <td className="px-2 text-xs">
                      {(w.exits ?? []).length === 0
                        ? "اتصال البيت"
                        : (w.exits ?? []).map((e) => (
                            <div key={e.id}>
                              <Badge tone={e.ok ? "ok" : "warn"} dot={false}>
                                {e.label}
                              </Badge>{" "}
                              <span className="ltr text-muted">{e.ip ?? ""}</span>
                              {e.error && <div className="text-muted">{e.error}</div>}
                            </div>
                          ))}
                    </td>
                    <td className="px-2 tabular-nums">{fmtNum(w.reads)}</td>
                    <td className="px-2 text-xs">
                      <Badge
                        tone={w.disabled ? "plain" : online(w.lastSeen) ? "ok" : "warn"}
                        dot={false}
                      >
                        {w.disabled ? "موقوف" : online(w.lastSeen) ? "متصل" : "غير متصل"}
                      </Badge>
                      <div className="text-muted">{fmtAgo(w.lastSeen)}</div>
                    </td>
                    <td className="px-2">
                      <div className="flex gap-1">
                        <form
                          action={engineWorkerAction.bind(
                            null,
                            w.id,
                            w.disabled ? "enable" : "disable",
                          )}
                        >
                          <Btn>{w.disabled ? "تشغيل" : "إيقاف"}</Btn>
                        </form>
                        <form action={engineWorkerAction.bind(null, w.id, "delete")}>
                          <Btn tone="bad">حذف</Btn>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="البروكسيات"
        icon="shield"
        description="للبرنامج فقط: يوزّع القراءة على اتصال البيت وعلى هذه البروكسيات، وإن رفض إنستقرام أحدها يرتاح وتكمل البقية. تصل التغييرات للبرنامج خلال دقائق بدون إعادة تشغيله."
      >
        <div className="space-y-4 text-sm">
          {proxies.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-[12.5px] text-muted">
                    {["البروكسي", "الحالة", "آخر IP", "قرأ", "رُفض", "آخر خطأ", ""].map((h) => (
                      <th key={h} className="px-2 py-2 text-start font-medium first:ps-0">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {proxies.map((p) => {
                    const resting = p.restingUntil && new Date(p.restingUntil).getTime() > now;
                    return (
                      <tr key={p.id} className="border-b border-line align-top last:border-0">
                        <td className="ltr py-2.5 pe-2 font-mono text-xs">
                          {p.label}
                          {p.rotateUrlEnc && <div className="text-muted">+ رابط تغيير IP</div>}
                        </td>
                        <td className="px-2">
                          <Badge tone={!p.enabled ? "plain" : resting ? "warn" : "ok"} dot={false}>
                            {!p.enabled
                              ? "معطّل"
                              : resting
                                ? `يرتاح حتى ${fmtDate(p.restingUntil)}`
                                : "جاهز"}
                          </Badge>
                        </td>
                        <td className="ltr px-2 font-mono text-xs">{p.lastIp ?? "—"}</td>
                        <td className="px-2 tabular-nums">{fmtNum(p.reads)}</td>
                        <td className="px-2 tabular-nums">{fmtNum(p.failures)}</td>
                        <td className="max-w-48 px-2 text-xs text-muted">{p.lastError ?? ""}</td>
                        <td className="px-2">
                          <div className="flex flex-wrap gap-1">
                            {p.rotateUrlEnc && (
                              <form action={updateEngineProxy.bind(null, p.id, "rotate")}>
                                <Btn tone="accent">غيّر IP</Btn>
                              </form>
                            )}
                            {resting ? (
                              <form action={updateEngineProxy.bind(null, p.id, "clear")}>
                                <Btn>أعده للعمل</Btn>
                              </form>
                            ) : (
                              <form action={updateEngineProxy.bind(null, p.id, "rest")}>
                                <Btn>أرحه ساعة</Btn>
                              </form>
                            )}
                            <form
                              action={updateEngineProxy.bind(
                                null,
                                p.id,
                                p.enabled ? "disable" : "enable",
                              )}
                            >
                              <Btn>{p.enabled ? "عطّل" : "فعّل"}</Btn>
                            </form>
                            <form action={updateEngineProxy.bind(null, p.id, "delete")}>
                              <Btn tone="bad">حذف</Btn>
                            </form>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <span>اتصال البيت مع البروكسيات:</span>
            <Badge tone={status.settings.useDirect ? "ok" : "plain"} dot={false}>
              {status.settings.useDirect ? "يُستعمل أيضاً" : "لا يُستعمل"}
            </Badge>
            <form action={setEngineUseDirect.bind(null, !status.settings.useDirect)}>
              <Btn tone="accent">
                {status.settings.useDirect ? "استعمل البروكسيات فقط" : "استعمله أيضاً"}
              </Btn>
            </form>
          </div>
          <ActionForm
            action={addEngineProxy}
            submit="أضف البروكسي"
            className="grid gap-3 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end"
          >
            <Field label="عنوان البروكسي" hint="http://user:pass@host:port (يُحفظ مشفّراً)">
              <Input
                name="url"
                className="ltr"
                placeholder="http://user:pass@gw.provider.com:8000"
                required
              />
            </Field>
            <Field label="رابط تغيير IP (اختياري)" hint="من مزوّد البروكسي المتنقل">
              <Input
                name="rotate_url"
                className="ltr"
                placeholder="https://provider.com/api/changeip?key=…"
              />
            </Field>
            <Field label="اسم (اختياري)">
              <Input name="label" placeholder="بروكسي 1" />
            </Field>
          </ActionForm>
          <details className="rounded-lg border border-line p-3">
            <summary className="cursor-pointer font-medium">ما البروكسي الذي أختاره؟</summary>
            <ul className="mt-2 list-inside list-disc space-y-1 text-fg-2">
              <li>
                <b>منزلي (Residential) أو متنقل (Mobile):</b> عناوين بيوت وشبكات جوال حقيقية،
                وإنستقرام نادراً ما يحظرها. الأفضل، وتُدفع عادة بالـ GB (القراءة البطيئة تستهلك قليلاً
                جداً).
              </li>
              <li>
                <b>بروكسي الخوادم (Datacenter):</b> رخيص لكن إنستقرام يحظر أغلبه بسرعة. لا أنصح به.
              </li>
              <li>
                <b>رابط تغيير IP:</b> مزوّدو البروكسي المتنقل يعطونك رابطاً يغيّر العنوان عند فتحه. ضعه
                هنا، فيظهر زر «غيّر IP» ويفتحه البرنامج عند الضغط.
              </li>
              <li>
                <b>التدوير التلقائي:</b> بعض المزوّدين يغيّر العنوان مع كل طلب أو كل بضع دقائق من نفس
                العنوان، فلا تحتاج رابط تغيير.
              </li>
              <li>البرنامج يدعم http و https فقط (SOCKS غير مدعوم).</li>
            </ul>
          </details>
        </div>
      </Card>

      <Card
        title="طرق التشغيل"
        icon="settings"
        description="اختر واحدة أو أكثر. كلها تقرأ من بيتك، والمنصة تحدد السرعة للجميع."
      >
        <div className="space-y-4 text-sm">
          <div className="rounded-lg border border-line p-4">
            <h3 className="mb-1 font-bold">١. إضافة المتصفح (الأسهل)</h3>
            <p className="mb-2 text-fg-2">
              لا تثبيت جديد. تعمل ما دام المتصفح مفتوحاً، من اتصال البيت فقط (لا تستعمل البروكسيات
              حتى لا تتغير جلستك أنت على إنستقرام).
            </p>
            <ol className="list-inside list-decimal space-y-1">
              <li>
                ثبّت آخر نسخة من{" "}
                <Link href="/extension" className="text-accent hover:underline">
                  صفحة الإضافة
                </Link>{" "}
                (الإصدار 0.2.0 أو أحدث).
              </li>
              <li>في الإضافة ← الإعدادات ← «المنصة»: رابط المنصة ومفتاح بصلاحية كتابة.</li>
              <li>في نفس الصفحة: فعّل «شغّل المحرك من هذا المتصفح».</li>
              <li>يظهر المتصفح في «الأجهزة» أعلاه خلال دقيقة.</li>
            </ol>
          </div>

          <div className="rounded-lg border border-line p-4">
            <h3 className="mb-1 font-bold">
              ٢. البرنامج بدون Docker (يعمل 24 ساعة، ويدعم البروكسيات)
            </h3>
            <p className="mb-3 text-fg-2">
              ملف واحد، ولا يحتاج تثبيت مكتبات: فقط Python. يمكن تشغيله على حاسوب البيت أو Raspberry
              Pi أو أي جهاز يبقى يعمل.
            </p>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <LinkButton href="/downloads/spir-worker.py" download>
                تنزيل spir-worker.py
              </LinkButton>
              <LinkButton href={EXE.worker} data-exe="worker">
                تنزيل spir-worker.exe (ويندوز، بلا Python)
              </LinkButton>
              <ActionForm action={createKey} submit="أنشئ مفتاحاً للبرنامج">
                <input type="hidden" name="name" value="العامل المنزلي" />
                <input type="hidden" name="write" value="on" />
              </ActionForm>
            </div>
            <p className="mb-3 text-xs text-muted">
              المفتاح يظهر مرة واحدة: احفظه. رابط المنصة: <CopyText text={origin} />
            </p>
            <p className="mb-3 text-xs text-muted">
              <b>ملف exe (اختياري):</b> لا يحتاج تثبيت Python. افتحه بنقرة مزدوجة، فيسألك مرة واحدة
              عن رابط المنصة والمفتاح ويتذكرهما. ويندوز قد يقول «Windows protected your PC» لأنه غير
              موقّع: More info ← Run anyway. أو شغّله بنفس خيارات الأمر في الأسفل. الملفات وبصماتها في{" "}
              <a
                href={EXE.release}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                صفحة الإصدار
              </a>
              .
            </p>

            <details className="mb-2 rounded-lg border border-line p-3" open>
              <summary className="cursor-pointer font-medium">Windows</summary>
              <ol className="mt-2 list-inside list-decimal space-y-2">
                <li>
                  ثبّت Python من{" "}
                  <a
                    href="https://www.python.org/downloads/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent hover:underline"
                  >
                    python.org
                  </a>{" "}
                  (3.9 أو أحدث). في أول شاشة فعّل <b>Add python.exe to PATH</b>.
                </li>
                <li>
                  ضع <span className="ltr font-mono">spir-worker.py</span> في مجلد، مثلاً
                  «المستندات\spir».
                </li>
                <li>
                  افتح المجلد، اكتب <span className="ltr font-mono">cmd</span> في شريط العنوان واضغط
                  Enter.
                </li>
                <li>
                  شغّله (ضع مفتاحك):
                  <Code>{run}</Code>
                </li>
                <li>اترك النافذة مفتوحة. يظهر الجهاز في «الأجهزة» خلال دقيقة.</li>
                <li>
                  <b>تشغيله تلقائياً عند فتح الجهاز:</b> أنشئ ملفاً{" "}
                  <span className="ltr font-mono">spir.bat</span> في نفس المجلد فيه:
                  <Code>{`cd /d "%~dp0"\n${run}`}</Code>
                  ثم اضغط Win+R واكتب <span className="ltr font-mono">shell:startup</span>، وضع
                  اختصاراً لـ spir.bat في المجلد الذي يفتح.
                </li>
              </ol>
            </details>

            <details className="mb-2 rounded-lg border border-line p-3">
              <summary className="cursor-pointer font-medium">Mac</summary>
              <ol className="mt-2 list-inside list-decimal space-y-2">
                <li>
                  افتح «Terminal» واكتب <span className="ltr font-mono">python3 --version</span>. إن
                  لم يكن موجوداً يقترح النظام تثبيته، أو ثبّته من python.org.
                </li>
                <li>
                  انتقل لمجلد الملف وشغّله:
                  <Code>{`cd ~/Downloads\npython3 spir-worker.py --platform ${origin} --key sk_المفتاح`}</Code>
                </li>
                <li>
                  ليبقى يعمل بعد إغلاق النافذة:
                  <Code>{`nohup python3 spir-worker.py --platform ${origin} --key sk_المفتاح > spir.log 2>&1 &`}</Code>
                </li>
                <li>
                  امنع الجهاز من النوم: إعدادات النظام ← البطارية/الطاقة ← منع السكون عند الاتصال
                  بالشاحن.
                </li>
              </ol>
            </details>

            <details className="mb-2 rounded-lg border border-line p-3">
              <summary className="cursor-pointer font-medium">
                Linux أو Raspberry Pi (يعمل دائماً كخدمة)
              </summary>
              <ol className="mt-2 list-inside list-decimal space-y-2">
                <li>
                  نزّل الملف:
                  <Code>{`mkdir -p ~/spir && cd ~/spir\ncurl -fsSLO ${origin}/downloads/spir-worker.py`}</Code>
                </li>
                <li>
                  جرّبه:{" "}
                  <Code>{`python3 spir-worker.py --platform ${origin} --key sk_المفتاح`}</Code>
                </li>
                <li>
                  اجعله خدمة تعمل عند التشغيل وتعود وحدها إن توقفت: أنشئ الملف{" "}
                  <span className="ltr font-mono">/etc/systemd/system/spir.service</span>:
                  <Code>{`[Unit]
Description=Spir home worker
After=network-online.target

[Service]
User=${"$"}USER
WorkingDirectory=/home/${"$"}USER/spir
Environment=PLATFORM_URL=${origin}
Environment=SPIR_KEY=sk_المفتاح
ExecStart=/usr/bin/python3 spir-worker.py
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target`}</Code>
                  ضع اسم المستخدم مكان <span className="ltr font-mono">$USER</span>، ثم:
                  <Code>
                    {
                      "sudo systemctl daemon-reload\nsudo systemctl enable --now spir\njournalctl -u spir -f"
                    }
                  </Code>
                </li>
              </ol>
            </details>

            <details className="rounded-lg border border-line p-3">
              <summary className="cursor-pointer font-medium">ما يعرضه البرنامج وكيف أوقفه</summary>
              <ul className="mt-2 list-inside list-disc space-y-1 text-fg-2">
                <li>
                  يكتب كل سطر ما فعله: <span className="ltr font-mono">@account: ok</span> أو{" "}
                  <span className="ltr font-mono">wait 75s (pace)</span>.
                </li>
                <li>
                  يحفظ معرّفه في ملف <span className="ltr font-mono">.spir-worker.json</span> في مجلد
                  المستخدم.
                </li>
                <li>
                  الإيقاف: Ctrl+C في النافذة، أو «إيقاف» بجانبه في «الأجهزة» (يبقى ينتظر حتى تشغّله).
                </li>
                <li>
                  بروكسيات بدون اللوحة (اختياري):{" "}
                  <span className="ltr font-mono">PROXY_URLS=http://u:p@host:port,…</span> قبل
                  الأمر. بروكسيات اللوحة لها الأولوية.
                </li>
              </ul>
            </details>
          </div>

          <div className="rounded-lg border border-line p-4">
            <h3 className="mb-1 font-bold">٣. Docker (لمن يستعمله)</h3>
            <p className="mb-2 text-fg-2">نفس البرنامج داخل حاوية، يعود وحده بعد إعادة التشغيل.</p>
            <Code>{`# في .env بجانب docker-compose.yml
PLATFORM_URL=${origin}
SPIR_KEY=sk_المفتاح

docker compose --profile engine up -d ig-engine`}</Code>
          </div>
        </div>
      </Card>

      <Card title="إن حصلت مشكلة" icon="bell">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-[12.5px] text-muted">
                <th className="py-2 pe-2 text-start font-medium">المشكلة</th>
                <th className="px-2 py-2 text-start font-medium">ما تفعله</th>
              </tr>
            </thead>
            <tbody className="align-top">
              <tr className="border-b border-line">
                <td className="py-2.5 pe-2 font-medium">المحرك «يستريح» كثيراً</td>
                <td className="px-2">
                  إنستقرام يطلب التمهل من عنوانك. أبطئ السرعة من صفحة المحرك (90 أو 120 ثانية) وقلل
                  الحد اليومي. إن استمر، غيّر الـ IP (الصف التالي) ثم «أنهِ الاستراحة الآن».
                </td>
              </tr>
              <tr className="border-b border-line">
                <td className="py-2.5 pe-2 font-medium">تغيير الـ IP</td>
                <td className="px-2">
                  <ul className="list-inside list-disc space-y-1">
                    <li>
                      <b>اتصال البيت:</b> أطفئ الراوتر دقيقتين ثم شغّله؛ أغلب شركات الإنترنت تعطي
                      عنواناً جديداً. اضغط «افحص العناوين» للتأكد.
                    </li>
                    <li>
                      <b>نقطة اتصال الجوال:</b> شغّل المتصفح أو البرنامج على إنترنت الجوال، وكل تشغيل
                      لوضع الطيران يعطي عنواناً جديداً غالباً.
                    </li>
                    <li>
                      <b>بروكسي متنقل:</b> زر «غيّر IP» بجانبه (يحتاج رابط التغيير من المزوّد).
                    </li>
                    <li>
                      <b>بروكسي معطوب:</b> «عطّل» أو «حذف»، وأضف غيره؛ البرنامج يأخذ القائمة الجديدة
                      وحده.
                    </li>
                    <li>تجنّب VPN المجانية: عناوينها مشتركة ومحظورة غالباً.</li>
                  </ul>
                </td>
              </tr>
              <tr className="border-b border-line">
                <td className="py-2.5 pe-2 font-medium">الجهاز «غير متصل»</td>
                <td className="px-2">
                  المتصفح مغلق أو الجهاز نائم أو البرنامج متوقف. للبرنامج: انظر رسائل النافذة. إن
                  قال «refused» فالمفتاح أو الرابط خطأ: أنشئ مفتاحاً جديداً بصلاحية كتابة.
                </td>
              </tr>
              <tr className="border-b border-line">
                <td className="py-2.5 pe-2 font-medium">بروكسي «رُفض» كثيراً</td>
                <td className="px-2">
                  غالباً بروكسي خوادم محظور، أو انتهى رصيده. جرّب «غيّر IP» أو بدّله ببروكسي منزلي أو
                  متنقل.
                </td>
              </tr>
              <tr>
                <td className="py-2.5 pe-2 font-medium">يقرأ لكن لا يظهر عملاء</td>
                <td className="px-2">
                  تأكد من كلمات المجال في التشغيل (الحساب الذي لا يطابقها لا يُقبل)، ومن وجود تشغيل
                  نشط في صفحة المحرك. المقبولون يُرسلون للمشروع كل 25 حساباً أو كل 30 دقيقة.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
