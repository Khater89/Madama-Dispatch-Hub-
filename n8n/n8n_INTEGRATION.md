# استخدام n8n Automation لجلب الفنيين لحظياً

هذا يستبدل تدفق `rank-technicians` بـ Supabase عندما تضغط "Find Closest Tech".
البحث يتم مباشرة على Google (عبر Serper) ويقتصر على Facebook.

## 1) استيراد الـ Workflow في n8n

1. افتح n8n → **Workflows** → زر **Import from File**.
2. اختر `MDAMA_find_closest_tech.json`.
3. الـ workflow يفتح بـ 5 nodes: Webhook → Build Search Query → Serper → Extract → Respond.

## 2) إعدادات Serper

هذا الـ node يستخدم **HTTP Header Auth** مثل الـ workflow القديم:

1. اضغط على node **Google Search via Serper**.
2. تحت **Credential to connect with**، اختر نفس الـ credential المستخدم بالـ workflow القديم
   (أو أنشئ جديد: Name = `X-API-KEY`, Value = مفتاح Serper تبعك).

## 3) تفعيل الـ Webhook

1. اضغط زر **Active** (أعلى الشاشة) لتفعيل الـ workflow.
2. اضغط على node **Webhook — Find Closest Tech** لاستخراج الـ Production URL.
   شكله: `https://<your-n8n-domain>/webhook/find-closest-tech`
   (بيئة الاختبار: `/webhook-test/find-closest-tech` — تشتغل فقط لما تضغط "Test workflow").

## 4) اختبار سريع بـ curl

```bash
curl -X POST https://<your-n8n>/webhook/find-closest-tech \
  -H "Content-Type: application/json" \
  -d '{
    "wo_number": "1189749-5",
    "trade": "HVAC",
    "city": "Findlay",
    "state": "OH",
    "zip_code": "45840"
  }'
```

يرجّع JSON:
```json
{
  "ok": true,
  "count": 5,
  "wo_number": "1189749-5",
  "trade": "HVAC",
  "city": "Findlay",
  "state": "OH",
  "candidates": [
    {
      "name": "Jake Wilson HVAC — Findlay, OH",
      "phone": "4195550142",
      "facebook_url": "https://www.facebook.com/jakewilsonhvac",
      "snippet": "Independent HVAC contractor in Findlay, OH. Call me…",
      "solo_score": 88,
      "location_boost": 23,
      "rank_score": 126
    }
    // … 4 more
  ]
}
```

## 5) ربط الزر بالنظام

في تبويب **New Work Order** بالواجهة، أضف زر **Find Closest Tech**.
احفظ رابط الـ webhook في تبويب Settings (متغير جديد `n8n_find_tech_url`) لتتمكن من
تعديله بدون لمس الكود.

راجع ملف `frontend_snippet.js` — يحتوي على:
- إضافة الحقل في Settings
- الزر في New Work Order
- الدالة التي تنادي الـ webhook وتعرض النتائج

## 6) معالجة الأخطاء المحتملة

- **429 من Serper**: تجاوزت حد المعدل. الـ workflow القديم كان يعمل loop مع wait —
  هنا كل ضغطة زر = طلب واحد فقط، فمن الصعب تصل للحد إلا لو ضغطت الزر بسرعة كبيرة.
- **empty candidates**: الـ trade أو المدينة نادرة على Facebook. جرّب zip بدل city،
  أو نوّع صياغة الـ trade (مثلاً "AC repair" بدل "HVAC").
- **Timeout**: Serper بيرد بحدود 2-5 ثواني عادة. لو الاتصال بطيء، ارفع timeout في node.
