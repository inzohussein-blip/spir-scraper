# مشروع Scrapers — ملاحظات وجمع متطلبات

> الحالة: اكتمل جمع المتطلبات. الخطة المتكاملة في `docs/PLAN.md`، والمراجع في `docs/references.md`.
> آخر تحديث: 2026-11-21

## 1. فكرة المشروع
منصة Scrapers مستقلة. الفكرة الأولى منها مستوحاة من منشور على إنستغرام:
- يلصق المستخدم رابط حساب إنستغرام لمنافس.
- تُرجع المنصة معلومات عن عملاء محتملين (leads) من جمهور هذا المنافس:
  اسم المستخدم (المعرّف)، والإيميل والرقم إن كانا ظاهرين علناً في الـ bio أو في أزرار التواصل، ...إلخ.

## 2. أوضاع التشغيل المطلوبة (كلها مطلوبة)
| الوضع | الوصف |
|------|-------|
| مستقل (Standalone) | يعمل وحده: CLI، أو واجهة، أو مهام مجدولة |
| مع AI | تحليل البيانات وإثراؤها وتصنيفها بنموذج ذكاء اصطناعي |
| مع Claude | تكامل مباشر مع Claude |
| REST API | واجهة برمجية لأي تطبيق خارجي |
| MCP Server | الربط مع Claude عبر MCP (الهدف الأساسي: كل الأدوات متاحة لـ Claude) |

## 3. التخزين والتصدير (الخياران متاحان)
- **Google Sheets:** الربط مع شيت موجود يحدده المستخدم.
- **شيت تلقائي:** المنصة تنشئ الشيت بنفسها وتملؤها.
- (وضمنياً) تصدير CSV/JSON محلي.

## 4. متطلبات تقنية عامة
- استخدام أحدث اللغات والمكتبات.
- استخدام المشاريع مفتوحة المصدر أدناه **كمرجع** للتصميم والتعامل مع إنستغرام.

## 5. المراجع مفتوحة المصدر (محفوظة)

### مكتبات أساسية
| المشروع | اللغة | الملاحظات | الرابط |
|--------|-------|-----------|--------|
| Instaloader | Python | الأشهر والأنشط: حسابات عامة، متابعون، منشورات، تعليقات، تصدير JSON | https://github.com/instaloader/instaloader — التوثيق: https://instaloader.github.io |
| instagrapi | Python | واجهة التطبيق الخاصة (Private API)، سريعة، تجلب المتابعين ومعلومات التواصل العامة. تتطلب حذراً | https://github.com/subzeroid/instagrapi — https://instagrapi.com |
| aiograpi-rest | Python/Docker | نسخة async من instagrapi على شكل REST API محلي | https://github.com/subzeroid/aiograpi-rest |

### أدوات جمع العملاء (Lead Generation)
| المشروع | اللغة | الملاحظات | الرابط |
|--------|-------|-----------|--------|
| instagram-scraper (drawrowfly) | TypeScript | مستخدمون، هاشتاقات، معلّقون، وكثير منها بدون تسجيل دخول | https://github.com/drawrowfly/instagram-scraper |
| ig-lead-generator | Python + Selenium | سحب متابعي حساب لجمع العملاء | https://github.com/erikbrandondigital/ig-lead-generator |

### تصنيفات GitHub للاستكشاف
- https://github.com/topics/instagram-lead-scraper
- https://github.com/topics/instagram-leads (أتمتة وتصدير إلى Google Sheets)
- https://github.com/topics/instagrapi
- https://github.com/topics/lead-generation
- https://github.com/topics/lead-generator
- مقال مرجعي: https://www.browseract.com/blog/instagram-scraper-github

## 6. تحديات معروفة يجب أن تعالجها الخطة
1. **الحظر وحدود المعدل:** نحتاج proxies مع تدوير العناوين (rotation) وتأخير وتحكم في المعدل (rate limiting).
2. **تغيّر بنية إنستغرام باستمرار:** نحتاج طبقة "محوّلات" (adapters) قابلة للاستبدال، فإذا تعطلت مكتبة نبدّل إلى غيرها.
3. **الحاجة لتسجيل الدخول لسحب المتابعين:** نستخدم حسابات ثانوية (burner) ونحفظ الجلسات (sessions)، وليس الحساب الأساسي أبداً.
4. **الامتثال القانوني:** شروط استخدام Meta، وقوانين حماية البيانات (مثل GDPR) عند جمع بيانات التواصل. نكتفي بالبيانات المعلنة علناً، ونضيف خيار حذف البيانات.

## 7. بانتظار التفاصيل من صاحب المشروع
- [x] تفاصيل الخطة ← docs/PLAN.md
- [x] مكان النشر والاستضافة ← Railway + Supabase
- [x] الواجهة ← لوحة Next.js في المرحلة 3، و Claude عبر MCP أولاً
- [ ] الأسئلة المفتوحة ← القسم 17 في docs/PLAN.md
