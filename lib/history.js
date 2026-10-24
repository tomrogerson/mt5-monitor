'use strict';
// Records equity samples per account. Two tiers:
//   fine   - one sample per minute, kept 48 hours (24h curve)
//   hourly - last sample of each hour, kept ~13 months (week / month / year views)
const fs = require('fs');
const path = require('path');

const KEEP_MS = 48 * 3600 * 1000;
const HOUR = 3600 * 1000;
const SETTLE_MS = 60 * 1000;
const KEEP_HOURLY_MS = 400 * 24 * HOUR;

class History {
  constructor(dir) {
    this.dir = dir || null;
    this.file = dir ? path.join(dir, 'history.json') : null;
    this.map = new Map();
    this.hmap = new Map();
    this.ddmap = new Map();   // id -> { all:{amt,pct}, week:{start,amt,pct} }  (worst floating loss)
    this.seen = new Map();    // id -> { since, last }  for the settle period
    this.dirty = false;
  }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && j.v === 2) {
        for (const [id, arr] of Object.entries(j.m || {})) if (Array.isArray(arr)) this.map.set(id, arr);
        for (const [id, arr] of Object.entries(j.h || {})) if (Array.isArray(arr)) this.hmap.set(id, arr);
        for (const [id, d] of Object.entries(j.f || {})) if (d && d.all) this.ddmap.set(id, d);   // old 'd' (peak-to-trough) is dropped
      } else {
        // old format: plain { id: [[t, eq], ...] }
        for (const [id, arr] of Object.entries(j)) if (Array.isArray(arr)) this.map.set(id, arr);
      }
    } catch (e) { /* first run or unreadable file: start empty */ }
  }

  add(id, t, equity) {
    if (!Number.isFinite(equity)) return;
    let a = this.map.get(id);
    if (!a) { a = []; this.map.set(id, a); }
    const last = a[a.length - 1];
    if (last && t - last[0] < 30000) return;
    a.push([t, Math.round(equity * 100) / 100]);
    const cut = t - KEEP_MS;
    let drop = 0;
    while (drop < a.length && a[drop][0] < cut) drop++;
    if (drop) a.splice(0, drop);

    // hourly tier: one point per hour, holding the latest value seen in that hour
    let hh = this.hmap.get(id);
    if (!hh) { hh = []; this.hmap.set(id, hh); }
    const bucket = Math.floor(t / HOUR) * HOUR;
    const v = a[a.length - 1][1];
    const hl = hh[hh.length - 1];
    if (hl && hl[0] === bucket) hl[1] = v;
    else if (!hl || bucket > hl[0]) hh.push([bucket, v]);
    const hcut = t - KEEP_HOURLY_MS;
    let hd = 0;
    while (hd < hh.length && hh[hd][0] < hcut) hd++;
    if (hd) hh.splice(0, hd);
    this.dirty = true;
  }

  // Remove everything stored for these account ids (charts, drawdown).
  forget(ids) {
    for (const id of ids) { this.map.delete(id); this.hmap.delete(id); this.ddmap.delete(id); this.seen.delete(id); }
    if (ids.length) this.dirty = true;
  }

  // Biggest drawdown = the lowest the open trades' floating P&L has reached (equity - balance - credit),
  // so deposits, withdrawals and bonuses never count. Tracked on every report.
  // 'all' covers everything seen; 'week' restarts at weekStart (Monday 00:00 local).
  // Readings in the first SETTLE_MS after an account (re)appears are ignored: terminals restarting
  // can briefly show stale prices.
  track(id, floating, balance, weekStart, now, noSettle) {
    if (!Number.isFinite(floating) || !Number.isFinite(balance)) return;
    now = now || Date.now();
    let s = this.seen.get(id);
    if (!s || now - s.last > 15000) s = { since: now, last: now };
    s.last = now;
    this.seen.set(id, s);
    if (!noSettle && now - s.since < SETTLE_MS) return;
    let d = this.ddmap.get(id);
    if (!d) { d = { all: { amt: 0, pct: 0 }, week: { start: weekStart, amt: 0, pct: 0 } }; this.ddmap.set(id, d); this.dirty = true; }
    if (d.week.start !== weekStart) { d.week = { start: weekStart, amt: 0, pct: 0 }; this.dirty = true; }
    const loss = -floating;
    if (loss <= 0) return;
    const pct = balance > 0 ? loss / balance * 100 : 0;
    for (const w of [d.all, d.week]) {
      if (loss > w.amt) { w.amt = loss; w.pct = pct; this.dirty = true; }
    }
  }

  reset(id) {
    const d = this.ddmap.get(id);
    if (!d) return false;
    d.all = { amt: 0, pct: 0 }; d.week = { start: d.week.start, amt: 0, pct: 0 };
    this.dirty = true;
    return true;
  }

  drawdown(id, weekStart) {
    const d = this.ddmap.get(id);
    if (!d) return null;
    const wk = d.week.start === weekStart ? d.week : { amt: 0, pct: 0 };
    const r2 = v => Math.round(v * 100) / 100;
    return { week: { amt: r2(wk.amt), pct: r2(wk.pct) }, all: { amt: r2(d.all.amt), pct: r2(d.all.pct) } };
  }

  // n points, stepMs apart, ending now. Unknown early slots are null.
  series(id, liveEquity, now, n, stepMs) {
    n = n || 96;
    stepMs = stepMs || 15 * 60 * 1000;
    const a = this.map.get(id) || [];
    const hh = this.hmap.get(id) || [];
    const find = (arr, ts) => {
      let lo = 0, hi = arr.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid][0] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    };
    const out = new Array(n).fill(null);
    const firstFine = a.length ? a[0][0] : Infinity;
    for (let i = 0; i < n - 1; i++) {
      const ts = now - (n - 1 - i) * stepMs;
      let k = ts >= firstFine ? find(a, ts) : -1;
      if (k >= 0) { out[i] = a[k][1]; continue; }
      // older than the fine tier: use hourly (its point covers the hour starting at its stamp)
      k = find(hh, ts - HOUR + 1);
      out[i] = k >= 0 ? hh[k][1] : null;
    }
    out[n - 1] = Number.isFinite(liveEquity) ? liveEquity : null;
    return out;
  }

  save() {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 2, m: Object.fromEntries(this.map), h: Object.fromEntries(this.hmap), f: Object.fromEntries(this.ddmap) }));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.error('Could not save history:', e.message);
    }
  }
}

module.exports = { History };
