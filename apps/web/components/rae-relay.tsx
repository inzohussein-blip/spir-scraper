"use client";

import { useEffect, useState } from "react";
import { Badge, Card, Notice } from "./ui";

type RelayState = {
  enabled: boolean;
  connected?: boolean;
  last?: string | null;
  error?: string | null;
};

const Cmd = ({ children }: { children: string }) => (
  <pre className="ltr overflow-x-auto rounded-lg bg-bg-2 p-2 text-xs">{children}</pre>
);

/** 32 random bytes as base64url, made in this browser (never sent anywhere by the page). */
function newSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The «عبر claude.ai» tab: explains the ntfy relay, makes the shared secret,
 * and shows whether the local bridge is listening (asked of the bridge on
 * this computer, not of the platform).
 */
export function RaeRelay() {
  const [origin, setOrigin] = useState("https://<موقعك>");
  const [secret, setSecret] = useState("");
  const [relay, setRelay] = useState<RelayState | null>(null);
  const [bridge, setBridge] = useState<"unknown" | "off" | "on">("unknown");

  useEffect(() => {
    setOrigin(window.location.origin);
    let saved: { url?: string; token?: string } = {};
    try {
      saved = JSON.parse(localStorage.getItem("spir-rae-bridge") ?? "{}");
    } catch {
      // storage blocked
    }
    if (!saved.token) {
      setBridge("off");
      return;
    }
    fetch(`${(saved.url || "http://127.0.0.1:7466").replace(/\/$/, "")}/status`, {
      headers: { authorization: `Bearer ${saved.token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((s: { relay?: RelayState }) => {
        setBridge("on");
        setRelay(s.relay ?? { enabled: false });
      })
      .catch(() => setBridge("off"));
  }, []);

  const shown = secret || "RAE_RELAY_SECRET";

  return (
    <div className="space-y-4">
      <Card
        title="كيف تعمل هذه الطريقة"
        icon="sparkles"
        description="تطلب من Claude في claude.ai (من أي متصفح أو من الهاتف)، والتنفيذ يحدث على جهازك."
      >
        <ol className="list-decimal space-y-1.5 ps-5 text-sm text-fg-2">
          <li>تكتب لـ Claude في claude.ai: «حوّل هذا الموقع إلى API: …».</li>
          <li>
            Claude يستدعي أداة <span className="ltr font-mono text-xs">rae_relay_capture</span> في
            خادم MCP الخاص بمنصتك (طلب واحد قصير).
          </li>
          <li>
            المنصة ترسل رسالة <b>مشفّرة</b> إلى قناة سرية في خدمة الإشعارات المجانية <b>ntfy.sh</b>.
          </li>
          <li>
            الجسر على جهازك مستمع لتلك القناة (وليس للمنصة)، فيستلمها فوراً ويشغّل
            reverse-api-engineer محلياً.
          </li>
          <li>الجسر يبلّغ المنصة مرتين فقط: «بدأت» ثم «انتهيت» مع الكود.</li>
          <li>
            Claude يسأل <span className="ltr font-mono text-xs">rae_relay_result</span> فيعرض لك
            الكود.
          </li>
        </ol>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-[12.5px] text-muted">
                <th className="py-2 text-start font-medium">الخدمة</th>
                <th className="py-2 text-start font-medium">لكل تشغيل</th>
              </tr>
            </thead>
            <tbody className="[&_td]:py-2 [&_tr]:border-b [&_tr]:border-line">
              <tr>
                <td>Vercel</td>
                <td>بين 5 و10 طلبات قصيرة (الحد المجاني مليون شهرياً)</td>
              </tr>
              <tr>
                <td>قاعدة البيانات</td>
                <td>تستيقظ دقائق قليلة؛ النتيجة تُحذف بعد يوم</td>
              </tr>
              <tr>
                <td>ntfy.sh</td>
                <td>مجاني</td>
              </tr>
              <tr>
                <td>أثناء الانتظار</td>
                <td>صفر: الجسر لا يسأل المنصة أبداً</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="حالة الجسر على هذا الجهاز"
        icon="plug"
        description="تُقرأ من الجسر مباشرة (بدون المنصة)."
        actions={
          bridge === "on" && relay?.enabled ? (
            relay.connected ? (
              <Badge tone="ok">مستمع لـ ntfy</Badge>
            ) : (
              <Badge tone="warn">يحاول الاتصال بـ ntfy</Badge>
            )
          ) : bridge === "on" ? (
            <Badge tone="plain">الجسر يعمل بلا ربط claude.ai</Badge>
          ) : (
            <Badge tone="plain">لا يوجد جسر متصل</Badge>
          )
        }
      >
        <p className="text-sm text-fg-2" data-rae-relay-state>
          {bridge === "off"
            ? "اربط الجسر أولاً من تبويب «محلي» (رمز الربط)، ثم ارجع هنا."
            : relay?.enabled
              ? `آخر طلب: ${relay.last ?? "لا شيء بعد"}${relay.error ? ` · آخر خطأ: ${relay.error}` : ""}`
              : "شغّل الجسر بخيار --relay كما في الخطوة 3."}
        </p>
      </Card>

      <Card title="الإعداد (مرة واحدة)" icon="settings">
        <ol className="list-decimal space-y-3 ps-5 text-sm text-fg-2">
          <li>
            <b>اصنع السر المشترك</b> (يُصنع في متصفحك ولا يُرسل لأي مكان):
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSecret(newSecret())}
                className="rounded-[10px] border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-accent-text"
              >
                اصنع سراً جديداً
              </button>
              {secret && (
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(secret)}
                  className="rounded-[10px] border border-line px-3 py-1.5 text-sm"
                >
                  انسخ
                </button>
              )}
            </div>
            {secret && <Cmd>{secret}</Cmd>}
          </li>
          <li>
            <b>ضعه في Vercel:</b> Settings ← Environment Variables ← أضف{" "}
            <span className="ltr font-mono text-xs">RAE_RELAY_SECRET</span> بهذه القيمة، ثم
            Redeploy.
          </li>
          <li>
            <b>شغّل الجسر بخيار الربط</b> (يبقى يعمل محلياً أيضاً كما في تبويب «محلي»):
            <Cmd>{`python rae-bridge.py --origin ${origin} --relay ${shown}`}</Cmd>
            يكتب الجسر «claude.ai relay: waiting on https://ntfy.sh» حين يستمع.
          </li>
          <li>
            <b>في claude.ai:</b> منصتك مضافة أصلاً كـ connector (خادم MCP{" "}
            <span className="ltr font-mono text-xs">{origin}/api/mcp</span>). إن لم تكن: Settings ←
            Connectors ← Add custom connector بهذا العنوان.
          </li>
          <li>
            <b>جرّب:</b> اكتب لـ Claude:
            <p className="mt-1 rounded-lg bg-bg-2 p-2 text-sm text-fg">
              استعمل rae_relay_capture لتحويل https://example.com/brokers إلى API: قائمة الوسطاء مع
              الاسم والرخصة والموقع
            </p>
          </li>
        </ol>
      </Card>

      <Card title="الحماية والخصوصية" icon="shield">
        <ul className="list-disc space-y-1.5 ps-5 text-sm text-fg-2">
          <li>
            الرسائل <b>مشفّرة ومختومة</b> بالسر المشترك: ntfy يرى نصاً مشفّراً فقط، ولا يستطيع أحد إرسال
            طلب لجهازك دون السر.
          </li>
          <li>
            اسم القناة في ntfy مشتق من السر وعشوائي، والطلبات الأقدم من ساعة أو المكررة تُتجاهل.
          </li>
          <li>
            <b>جهازك لا يُكشف على الإنترنت:</b> الجسر هو من يتصل بالخارج، ولا أحد يتصل به.
          </li>
          <li>
            نفس القيود: لا يُشغَّل الكود الناتج، وإنستقرام وتيك توك وMeta مرفوضة، وتشغيل واحد في كل
            مرة.
          </li>
          <li>
            إن تسرّب السر: غيّره في Vercel وأعد تشغيل الجسر بالجديد. ويمكنك تشغيل خادم ntfy خاص بك
            وتمريره بـ <span className="ltr font-mono text-xs">--ntfy</span> و{" "}
            <span className="ltr font-mono text-xs">RAE_NTFY_URL</span>.
          </li>
        </ul>
      </Card>

      <Notice tone="info">
        الجسر يجب أن يكون شغالاً على جهازك وقت الطلب. إن لم يكن، تبقى الرسالة في ntfy ساعة، ويُنفَّذ
        الطلب إن شغّلته خلالها؛ وClaude يخبرك أن جهازك لم يستلمه بعد.
      </Notice>
    </div>
  );
}
