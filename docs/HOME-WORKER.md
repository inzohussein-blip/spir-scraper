# عامل Instaloader على جهاز في البيت (حل الحجب)

إنستقرام يحجب بسرعة عناوين مراكز البيانات، أي خوادم Vercel و Railway وأي سحابة. عنوان الإنترنت المنزلي عنوان سكني، وإنستقرام يحجبه أقل بكثير. لذلك يعمل العامل على جهاز عندك، ويصل إليه Vercel عبر Cloudflare Tunnel:

```
Vercel (اللوحة)  ──https──▶  Cloudflare  ◀──نفق صادر──  جهازك: ig-worker + cloudflared  ──▶  إنستقرام
```

- **مجاني:** Cloudflare Tunnel مجاني، والجهاز يمكن أن يكون أي كمبيوتر أو Raspberry Pi يبقى شغالاً.
- **آمن:** النفق يتصل من جهازك إلى Cloudflare، فلا تفتح أي منفذ في الراوتر، وعنوان بيتك لا يظهر لأحد. كل طلب يحتاج `WORKER_SHARED_SECRET`.

## ثلاث طبقات ضد الحجب (تعمل تلقائياً)

1. **العامل يبطّئ نفسه:** طلب كل 3 ثوانٍ تقريباً مع تأخير عشوائي، وبدون تسجيل دخول.
2. **تدوير المخارج داخل العامل:** إن أضفت بروكسيات سكنية في `PROXY_URLS`، يبدأ العامل بعنوان البيت ثم البروكسيات. أي مخرج يُحجب يرتاح 15 دقيقة، وتتضاعف المدة مع كل حجب متتالٍ حتى 6 ساعات، وينتقل الطلب نفسه للمخرج التالي.
3. **التحويل بين المزوّدين في اللوحة:** إذا ارتاحت كل مخارج العامل، تنتقل المهمة تلقائياً إلى Graph API أو Apify إن كانت مضبوطة، ثم تعود للعامل المجاني عندما يجهز.

## الخطوات

### 1. Cloudflare Tunnel

1. أنشئ حساباً مجانياً على cloudflare.com وأضف نطاقك. يلزمك نطاق تملكه، ولو كان رخيصاً.
2. من **Zero Trust → Networks → Tunnels → Create a tunnel** اختر **Cloudflared**، وسمّه `ig-worker`.
3. انسخ الـ **token** الذي يظهر في أمر التثبيت (النص الطويل بعد `--token`).
4. في **Public Hostname** أضف:
   - Subdomain: `worker` (مثلاً)، والنطاق: نطاقك
   - Service: `HTTP` و `ig-worker:8000`

### 2. على جهازك

ثبّت Docker، ثم:

```bash
git clone https://github.com/inzohussein-blip/spir-scraper.git
cd spir-scraper/deploy/home-worker
cp .env.example .env
```

عبّئ في `.env`:
- `WORKER_SHARED_SECRET`: قيمة طويلة عشوائية (`openssl rand -hex 32`)، وهي نفسها التي ستضعها في Vercel.
- `TUNNEL_TOKEN`: من الخطوة السابقة.
- `PROXY_URLS`: اختياري، ويُترك فارغاً في البداية.

```bash
docker compose up -d
```

الحاويتان مضبوطتان على `restart: unless-stopped`، فتعودان للعمل وحدهما بعد إعادة تشغيل الجهاز.

### 3. في Vercel

من **Settings → Environment Variables**:

| المتغير | القيمة |
|---|---|
| `WORKER_URL` | `https://worker.نطاقك.com` |
| `WORKER_SHARED_SECRET` | نفس القيمة التي في `.env` |
| `WORKER_RATE_PER_MINUTE` | `15` (اختياري) |

ثم **Redeploy**.

## الفحص

```bash
curl https://worker.نطاقك.com/health
# {"status":"ok","exits":1,"ready":1}

curl -H "x-worker-secret: $WORKER_SHARED_SECRET" https://worker.نطاقك.com/status
# حالة كل مخرج: هل هو جاهز، ومتى يعود إن كان يرتاح، وآخر خطأ
```

`/health` عام لكنه لا يعرض إلا الأعداد. أما `/status` فيحتاج السر، ولا يعرض كلمات مرور البروكسيات أبداً.

في اللوحة، **الإعدادات** تعرض حالة المزوّدين، ويرسل تلكرام تنبيهاً عندما يُحجب مزوّد وعندما يعود.

## إن استمر الحجب

- زِد `MIN_INTERVAL_SECONDS` إلى 5 أو 8.
- أضف بروكسياً سكنياً واحداً أو أكثر في `PROXY_URLS`، بشرط أن يكون سكنياً لا من مراكز البيانات.
- اضبط `APIFY_TOKEN` في Vercel كاحتياط، فيكمل العمل تلقائياً عند الحجب.
