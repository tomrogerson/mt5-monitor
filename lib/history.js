'use strict';
// Records equity samples per account so the 24h curves survive page reloads.
const fs = require('fs');
const path = require('path');

const KEEP_MS = 26 * 3600 * 1000;

class History {
  constructor(dir) {
    this.dir = dir || null;
    this.file = dir ? path.join(dir, 'history.json') : null;
    this.map = new Map();
    this.dirty = false;
  }

  load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, arr] of Object.entries(j)) {
        if (Array.isArray(arr)) this.map.set(id, arr);
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
    this.dirty = true;
  }

  // n points, stepMs apart, ending now. Unknown early slots are null.
  series(id, liveEquity, now, n, stepMs) {
    n = n || 96;
    stepMs = stepMs || 15 * 60 * 1000;
    const a = this.map.get(id) || [];
    const out = new Array(n).fill(null);
    for (let i = 0; i < n - 1; i++) {
      const ts = now - (n - 1 - i) * stepMs;
      let lo = 0, hi = a.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid][0] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      out[i] = ans >= 0 ? a[ans][1] : null;
    }
    out[n - 1] = Number.isFinite(liveEquity) ? liveEquity : null;
    return out;
  }

  save() {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.error('Could not save history:', e.message);
    }
  }
}

module.exports = { History };
