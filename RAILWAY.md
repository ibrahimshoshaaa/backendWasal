# نشر Wasal على Railway

1. داخل مشروع Railway أضف خدمة من GitHub واختر `ibrahimshoshaaa/backendWasal` والفرع الذي يحتوي على `railway.json`. مجلد التشغيل هو جذر المستودع.
2. أضف PostgreSQL في نفس المشروع.
3. في Variables لخدمة الباك إند أضف مرجعًا إلى DATABASE_URL الخاص بخدمة PostgreSQL. إذا كان اسمها Postgres تكون القيمة `${{Postgres.DATABASE_URL}}`. لو الاسم مختلف استخدم الاسم الفعلي.
4. للاتصال الخاص بقاعدة Railway أضف `DATABASE_SSL=false`. لا تستخدم هذا الإعداد عند الاتصال بقاعدة خارجية تتطلب TLS.
5. انقل قيم المتغيرات المستخدمة حاليًا إلى Railway بدون وضع الأسرار في GitHub:
   - `JWT_SECRET` (نفس القيمة الحالية للحفاظ على صلاحية الجلسات إذا نقلت البيانات).
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
   - إعدادات الإيميل المستخدمة: `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` و/أو `MAILJET_API_KEY`, `MAILJET_SECRET_KEY`, `MAILJET_FROM_EMAIL`, `EMAIL_FROM`.
   - `FIREBASE_SERVICE_ACCOUNT` إذا كانت إشعارات Firebase مفعلة.
6. اترك Railway يحدد PORT. التشغيل بـ npm start وفحص الصحة على /api/health مضبوطين في railway.json.
7. انشر الخدمة ثم من Networking ولّد Public Domain. افتح https://YOUR-DOMAIN/api/health وتأكد أن الرد {"ok":true}.
8. بعد نجاح النشر غيّر baseUrl في lib/api_service.dart بمستودع wasalV5 إلى https://YOUR-DOMAIN/api وأعد بناء APK. راجع أي نسخة HTML مستقلة تستخدم رابط Northflank وحدث رابط API فيها أيضًا.

## البيانات الحالية

قاعدة Railway الجديدة فارغة؛ إنشاء الجداول تلقائيًا لا ينقل حسابات أو طلبات Northflank. إذا أردت الاحتفاظ بالبيانات خذ نسخة pg_dump من WasalDB واستعدها على Railway قبل تحويل التطبيق. احتفظ بالخدمة القديمة حتى تتأكد من نقل البيانات ونجاح تسجيل الدخول والإيميل ورفع الصور.

## التحقق

- /api/health يرجع {"ok":true}.
- تسجيل الدخول بحساب موجود بعد نقل البيانات، أو تسجيل حساب جديد وتأكيد الإيميل.
- رفع صورة على Cloudinary.
- اتصال WebSocket على /ws؛ التطبيق يشتق عنوانه من baseUrl.
- عرض الجداول من خدمة PostgreSQL في Railway.

لم يتم النشر أو نقل البيانات بمجرد إضافة الملفات؛ هذه خطوات تجهيز وربط الخدمة بحساب Railway.
