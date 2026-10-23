'use strict';

// Offset (ms) of a time zone from UTC at a given instant.
function tzOffsetMs(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const o = {};
  for (const p of dtf.formatToParts(date)) o[p.type] = p.value;
  const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
  return asUTC - (date.getTime() - date.getMilliseconds());
}

// The instant at which "today" began in the given time zone.
function startOfDay(tz, now) {
  now = now || new Date();
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  let t = guess - tzOffsetMs(tz, new Date(guess));
  t = guess - tzOffsetMs(tz, new Date(t));
  return new Date(t);
}

module.exports = { startOfDay, tzOffsetMs };
