'use strict';

// Intl.DateTimeFormat objects are expensive and hold native memory, so build each one once.
const cache = new Map();
function fmt(kind, tz) {
  const k = kind + '|' + tz;
  let f = cache.get(k);
  if (!f) {
    f = kind === 'parts' ? new Intl.DateTimeFormat('en-US', {
          timeZone: tz, hourCycle: 'h23',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : kind === 'ymd' ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      : new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
    cache.set(k, f);
  }
  return f;
}

// Offset (ms) of a time zone from UTC at a given instant.
function tzOffsetMs(tz, date) {
  const dtf = fmt('parts', tz);
  const o = {};
  for (const p of dtf.formatToParts(date)) o[p.type] = p.value;
  const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  return asUTC - (date.getTime() - date.getMilliseconds());
}

// The instant at which "today" began in the given time zone.
function startOfDay(tz, now) {
  now = now || new Date();
  const ymd = fmt('ymd', tz).format(now);
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let t = guess - tzOffsetMs(tz, new Date(guess));
  t = guess - tzOffsetMs(tz, new Date(t));
  return new Date(t);
}

// The instant at which this week (Monday 00:00) began in the given time zone.
function startOfWeek(tz, now) {
  now = now || new Date();
  const day = startOfDay(tz, now);
  const wd = fmt('wd', tz).format(now);
  const back = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd);
  if (back <= 0) return day;
  return startOfDay(tz, new Date(day.getTime() - back * 86400000 + 12 * 3600000));
}

module.exports = { startOfDay, startOfWeek, tzOffsetMs };
