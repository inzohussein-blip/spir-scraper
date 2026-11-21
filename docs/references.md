# المراجع مفتوحة المصدر

نقرأ هذه المشاريع لنفهم شكل البيانات ونقاط النهاية. المستقر منها نغلّفه داخل مزوّد (provider) قابل للاستبدال. نتحقق من الرخصة وآخر إصدار قبل الاعتماد على أي مشروع.

## مكتبات أساسية
| المشروع | اللغة | الدور عندنا | الرابط |
|---|---|---|---|
| Instaloader | Python | مزوّد الملفات العامة بدون تسجيل دخول (الإصدار 4.15.x، رخصة MIT) | https://github.com/instaloader/instaloader · التوثيق: https://instaloader.github.io |
| instagrapi | Python | مرجع فقط لبنية بيانات الحساب وحقول التواصل التجاري. يتطلب تسجيل دخول، فلا نستخدمه في الإنتاج | https://github.com/subzeroid/instagrapi · https://instagrapi.com |
| aiograpi-rest | Python / Docker | نمط تغليف المكتبة كخدمة REST، وهو نفس فكرة `ig-worker` عندنا | https://github.com/subzeroid/aiograpi-rest |

## أدوات جمع العملاء (Lead Generation)
| المشروع | اللغة | ما نأخذه منه | الرابط |
|---|---|---|---|
| instagram-scraper (drawrowfly) | TypeScript | أسلوب جلب الهاشتاقات والمعلّقين من Node | https://github.com/drawrowfly/instagram-scraper |
| ig-lead-generator | Python + Selenium | منطق تحويل الملفات إلى عملاء وتصديرهم | https://github.com/erikbrandondigital/ig-lead-generator |

## مزوّدون سحابيون
| المزوّد | الرابط |
|---|---|
| Apify — Instagram Email & Phone Lead Scraper | https://apify.com/automation_studio/instagram-email-phone-lead-scraper |
| Apify — Instagram Profile Scraper | https://apify.com/apify/instagram-profile-scraper |
| Instagram Graph API — Business Discovery | https://developers.facebook.com/docs/instagram-platform |

## تصنيفات GitHub للتصفّح
- https://github.com/topics/instagram-lead-scraper
- https://github.com/topics/instagram-leads
- https://github.com/topics/instagrapi
- https://github.com/topics/lead-generation
- https://github.com/topics/lead-generator
- مقال مرجعي: https://www.browseract.com/blog/instagram-scraper-github

## أدوات تجارية (للمقارنة فقط)
IGLeads (https://igleads.co) · Modash (https://www.modash.io/instagram-email-finder) · Datablist (https://www.datablist.com/ar/enrichments/instagram-profile-scraper-bulk) · igscraper.io (https://igscraper.io)

## مراجع تقنية
- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/llms.txt
- مواصفات MCP 2026-07-28: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- Instaloader على pepy.tech: https://pepy.tech/project/instaloader
