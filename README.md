# Wasal Backend (وصل)

باك اند REST API لتطبيق وصل، مبني بـ **Node.js + Express + PostgreSQL**، ومصمم عشان يشتغل مع
`api_service.dart` الموجود في تطبيق الفلاتر من غير أي تعديل — نفس الـ endpoints، نفس شكل الـ JWT.

الصور بترفع مباشرة على **Cloudinary**، مافيش أي تخزين محلي على السيرفر، فالمشروع آمن على Railway
مهما اتعمل Redeploy.

## التشغيل محليًا

### 1. متطلبات
- Node.js 18+
- PostgreSQL شغال (محلي أو Supabase/أي مزود سحابي)
- حساب Cloudinary (مجاني)

### 2. تجهيز قاعدة البيانات
```bash
createdb wasal
```
أو استخدم Supabase / Railway Postgres وخد الـ connection string.

### 3. الإعداد
```bash
cd wasal_backend
npm install
cp .env.example .env
```
افتح `.env` وحط:
- `DATABASE_URL` — رابط قاعدة البيانات
- `JWT_SECRET` — نص عشوائي طويل وسري
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — من Dashboard حساب Cloudinary

### 4. التشغيل
```bash
npm start
```
أول تشغيل هيعمل كل الجداول تلقائيًا + Migrations لأعمدة `*_public_id` + حساب أدمن افتراضي:
```
admin@wasal.app / admin123
```
**غيّر الباسورد ده فورًا**.

## النشر على Railway
1. اربط الريبو بـ Railway.
2. زوّد متغيرات البيئة في Railway Variables:
   - `DATABASE_URL` (تلقائي لو ربطت Postgres plugin)
   - `JWT_SECRET`
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
3. Railway هيحقن `PORT` تلقائيًا — ما تحطهوش يدوي.
4. مافيش حاجة لأي Persistent Volume، الصور كلها على Cloudinary.

## ربطه بتطبيق الفلاتر
في `lib/api_service.dart`، الـ `baseUrl` متظبط على:
```dart
static const String baseUrl = 'http://10.0.2.2:3000/api';
```
للتجربة على جهاز حقيقي أو الإنتاج، غيّره لعنوان السيرفر الفعلي.

## نظام رفع الصور
```
Flutter/الموقع
    ↓  multipart POST /api/upload (أو /api/auth/register)
Backend على Railway (multer.memoryStorage — Buffer فقط)
    ↓  upload_stream
Cloudinary (wasal/users, wasal/merchants, wasal/products, wasal/misc)
    ↓  secure_url + public_id
PostgreSQL (يحفظ الرابط في avatar_url / image_url / … + public_id في *_public_id)
    ↓
Flutter/الموقع يعرض الرابط مباشرة
```

- كل Endpoint لرفع الصور محفوظ نفسه: نفس الاسم، نفس الحقول، نفس الاستجابة.
- عند تغيير صورة أو حذف عنصر، بنحذف الصورة القديمة من Cloudinary تلقائياً لو `public_id` معروف.
- الصور القديمة اللي كانت `/uploads/...` بتفضل نصّها في DB بدون تعديل، بس روابطها هتبقى مكسورة
  (وهي أصلاً بتضيع مع كل Redeploy على Railway حاليًا).

## هيكل المشروع
```
src/
  db.js                 اتصال قاعدة البيانات + إنشاء الجداول + Migrations آمنة
  config/
    cloudinary.js       إعداد Cloudinary + uploadBuffer + destroyByPublicId + extractPublicIdFromUrl
  middleware/
    auth.js             JWT auth + role-based access
    uploader.js         multer.memoryStorage موحّد + fileFilter + error handler
  routes/
    auth.js             تسجيل/دخول (بيرفع logo + صور البطاقة والسيلفي على Cloudinary)
    upload.js           POST /api/upload — رفع صورة عامة على Cloudinary
    users.js            تحديث/حذف البروفايل + تنظيف الصور من Cloudinary
    merchantPanel.js    لوحة التاجر + تنظيف الصور من Cloudinary عند التغيير/الحذف
    driverPanel.js      لوحة السائق
    admin.js            لوحة الأدمن
    merchants.js, products.js, cart.js, orders.js, addresses.js,
    categories.js, notifications.js
  server.js             نقطة التشغيل (مافيش /uploads static خلاص)
```

## متابعة التشغيل والحسابات والدعم

تضاف الجداول والأعمدة الجديدة عند التشغيل بشكل متكرر آمن؛ لا يلزم تغيير عنوان Railway أو دمج ريبو التطبيق مع الباك إند. انشر الباك إند المتوافق قبل نسخة التطبيق الجديدة.

- `/api/operations/admin/jobs` يجمع الطلبات النشطة للخدمات الثلاث ويقبل فلاتر `service` و`attention`؛ الحد 100. حد التأخير الافتراضي 30 دقيقة في المرحلة الحالية، ويضبط عبر `late_minutes`.
- تغيير المندوب يستخدم الحالة والإسناد المتوقعين وسببًا؛ لا يسمح بعد الاستلام أو بدء الرحلة. `job_events` يسجل الإنشاء والحالة والإسناد وصاحب العملية. الطلبات المنتهية لا تعاد إلى حالة نشطة.
- `delivery_ledger` يسجل رسوم الخدمة والعمولة وصافي الربح والتحصيل والمدفوع للمتجر أو تكلفة الشراء الفعلية، مرة واحدة لكل طلب مكتمل. الأسعار التقريبية لهاتهالي لا تدخل الحساب. `commission_percent` الافتراضي صفر؛ تحفظ النسبة عند إنشاء الطلب ولا تطبق بأثر رجعي.
- كشف حساب المندوب تحت `/api/operations/driver/statement`، وللإدارة تحت `/api/operations/admin/drivers/:id/statement`. ملخص الفترة شامل، والقوائم تعرض أحدث 200 قيد وتسوية؛ الفترة بتوقيت القاهرة وحدها سنة. الرصيد يشمل كل التاريخ.
- الرصيد = التحصيل المؤكد − صافي أرباح المندوب − تكلفة شراء هاتهالي − ما دفعه المندوب للمتجر − التسويات المستلمة من المندوب + التسويات المدفوعة له. الرصيد الموجب مستحق للمنصة، والسالب مستحق للمندوب.
- التحصيل القديم المجهول يبقى غير مؤكد، ويمنع تسجيل تسوية حتى تأكيده بواسطة الإدارة مع سبب. التسوية تحتاج `Idempotency-Key` ورصيدًا متوقعًا، وتُسلسل مع تسليم الطلبات لنفس المندوب. تسجيل التسوية توثيق لفلوس دُفعت بالفعل، وليس تحويلًا ماليًا.
- بلاغات العملاء مرتبطة بملكية الطلب؛ البلاغ المفتوح المتكرر يُحدّث بدل التكرار. رقم الدعم اختياري عبر `support_phone`.
- أخطاء الخادم تحمل `X-Request-ID` ومرجعًا في استجابة 500، وتسجل فئة واسم مسار دون جسم الطلب. `/api/diagnostics` يسمح للإدارة بالمراجعة، ويقبل من التطبيق فئات الأخطاء فقط بمعدل محدود.

## التشغيل الحالي

السلة لمتجر واحد، وموافقة المتاجر والمناديب مطلوبة. رسوم التوصيل وأسعار الخدمات تأتي من إعدادات الخادم. إشعارات قاعدة البيانات وWebSocket تعمل، وإشعارات Firebase تتطلب إعداد بيانات حساب الخدمة المشار إليها أعلاه.
