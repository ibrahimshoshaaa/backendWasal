// ─── أوقات العمل والإغلاق التلقائي ──────────────────────────────────────────
// بيحسب هل المتجر مفتوح "دلوقتي" فعلياً، آخذاً في الاعتبار:
// - المفتاح اليدوي is_open (سويتش التاجر)
// - إغلاق مؤقت عند ضغط الطلبات (temp_closed_until)
// - إجازات بتاريخ محدد (closed_dates)
// - جدول أيام/ساعات العمل الأسبوعي (working_hours)
// - فترة راحة يومية (break_start/break_end)
//
// بنستخدم توقيت القاهرة صراحةً (Africa/Cairo) عشان النتيجة تبقى صحيحة أياً كان
// توقيت السيرفر نفسه (غالباً UTC على استضافات زي Railway).

const TIMEZONE = 'Africa/Cairo';
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function cairoParts(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const weekdayMap = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
  return {
    dayKey: weekdayMap[parts.weekday],
    time: `${parts.hour}:${parts.minute}`,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

// بيرجع { open: boolean, reason?: string, until?: string }
function isMerchantOpenNow(merchant, now = new Date()) {
  if (!merchant.is_open) return { open: false, reason: 'manual_closed' };

  if (merchant.temp_closed_until && new Date(merchant.temp_closed_until) > now) {
    return { open: false, reason: 'temp_closed', until: merchant.temp_closed_until };
  }

  const { dayKey, time, dateStr } = cairoParts(now);

  const closedDates = merchant.closed_dates;
  if (Array.isArray(closedDates) && closedDates.includes(dateStr)) {
    return { open: false, reason: 'holiday' };
  }

  const hours = merchant.working_hours;
  if (hours && typeof hours === 'object') {
    const today = hours[dayKey];
    if (!today) return { open: false, reason: 'day_off' };

    // لو معاد القفل أصغر من معاد الفتح، يبقى المتجر شغال لحد بعد نص الليل
    // (مثال: يفتح 10:00 ويقفل 02:00 اليوم اللي بعده)
    const overnight = today.close < today.open;
    const withinHours = overnight
      ? (time >= today.open || time <= today.close)
      : (time >= today.open && time <= today.close);

    if (!withinHours) {
      return { open: false, reason: 'outside_hours' };
    }
  }

  if (merchant.break_start && merchant.break_end) {
    if (time >= merchant.break_start && time <= merchant.break_end) {
      return { open: false, reason: 'break' };
    }
  }

  return { open: true };
}

module.exports = { isMerchantOpenNow, DAY_KEYS };
