const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
function isMerchantOpenNow(merchant, now = new Date()) {
  if (!merchant.is_open) return { open: false, reason: 'manual_closed' };
  if (merchant.temp_closed_until && new Date(merchant.temp_closed_until) > now) return { open: false, reason: 'temp_closed', until: merchant.temp_closed_until };
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).reduce((out, p) => ({ ...out, [p.type]: p.value }), {});
  const weekday = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday];
  const time = `${parts.hour}:${parts.minute}`;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (Array.isArray(merchant.closed_dates) && merchant.closed_dates.includes(date)) return { open: false, reason: 'holiday' };
  const hours = merchant.working_hours;
  if (hours && typeof hours === 'object') {
    const today = hours[DAY_KEYS[weekday]];
    const yesterday = hours[DAY_KEYS[(weekday + 6) % 7]];
    const fromYesterday = yesterday && yesterday.close < yesterday.open && time < yesterday.close;
    const fromToday = today && (today.close < today.open ? time >= today.open : time >= today.open && time < today.close);
    if (!fromYesterday && !fromToday) return { open: false, reason: today ? 'outside_hours' : 'day_off' };
  }
  if (merchant.break_start && merchant.break_end) {
    const inBreak = merchant.break_end < merchant.break_start
      ? time >= merchant.break_start || time < merchant.break_end
      : time >= merchant.break_start && time < merchant.break_end;
    if (inBreak) return { open: false, reason: 'break' };
  }
  return { open: true };
}
module.exports = { isMerchantOpenNow, DAY_KEYS };
