'use strict';
const fs = require('fs');
const path = require('path');
const seed = require('./commission-seed.json');

/* Commission store: rates and "paid" ticks the owner edits, plus a record of each account's closed profit per month
   (so a month is not lost when the collector's "this month" window rolls over). Saved as DATA_DIR/commission.json. */
class Commission {
  constructor(cfg) {
    this.file = path.join(cfg.dataDir || require('os').tmpdir(), 'commission.json');
    this.tz = cfg.timezone || 'Europe/London';
    this.followerGroups = new Set((cfg.groups || []).filter(g => /^bot ?[12]$/i.test(g.label)).map(g => g.key));
    this.seedGroups = new Set((cfg.groups || []).filter(g => /^bot ?2$/i.test(g.label)).map(g => g.key));
    this.d = { rates: {}, paid: {}, live: {}, hidden: [] };
    this.dirty = false;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); Object.assign(this.d, j); } catch (e) { /* first run */ }
  }
  monthKey(date) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: this.tz, year: 'numeric', month: '2-digit' }).formatToParts(date);
    const g = t => p.find(x => x.type === t).value;
    return g('year') + '-' + g('month');
  }
  prevKey(key) { const [y, m] = key.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); }
  record(accounts, now) {
    const cur = this.monthKey(new Date(now)), prev = this.prevKey(cur);
    for (const a of accounts) {
      if (a.demo || !this.followerGroups.has(a.group)) continue;
      const id = a.group + '|' + a.name;
      const set = (mk, v) => {
        if (typeof v !== 'number' || !isFinite(v)) return;
        const o = this.d.live[mk] || (this.d.live[mk] = {});
        if (o[id] !== v) { o[id] = Math.round(v * 100) / 100; this.dirty = true; }
      };
      set(cur, a.pnlMonth); set(prev, a.pnlLastMonth);
    }
  }
  view() {
    const months = {};
    const add = (mk, who, v) => { (months[mk] || (months[mk] = {}))[who] = Math.round(((months[mk] && months[mk][who]) || 0) * 100 + v * 100) / 100; };
    for (const [mk, o] of Object.entries(seed.months)) for (const [who, v] of Object.entries(o)) add(mk, who, v);
    for (const [mk, o] of Object.entries(this.d.live)) {
      for (const [id, v] of Object.entries(o)) {
        const i = id.indexOf('|'), grp = id.slice(0, i), who = id.slice(i + 1);
        if (seed.months[mk] && this.seedGroups.has(grp)) continue;   // the tracker already covers Bot 2 for those months
        add(mk, who, v);
      }
    }
    const live = new Set(); for (const o of Object.values(this.d.live)) for (const id of Object.keys(o)) live.add(id.slice(id.indexOf('|') + 1));
    return { rates: Object.assign({}, seed.rates, this.d.rates), paid: this.d.paid, months, active: [...live], now: this.monthKey(new Date()) };
  }
  update(body) {
    if (body.rates && typeof body.rates === 'object') for (const [k, v] of Object.entries(body.rates)) {
      if (v === null) delete this.d.rates[k]; else if (typeof v === 'number' && v >= 0 && v <= 1) this.d.rates[k] = v;
    }
    if (body.paid && typeof body.paid === 'object') for (const [k, v] of Object.entries(body.paid)) {
      if (!/^\d{4}-\d{2}\|.{1,40}$/.test(k)) continue;
      if (v === null) delete this.d.paid[k]; else if (typeof v === 'number' && isFinite(v)) this.d.paid[k] = Math.round(v * 100) / 100;
    }
    this.dirty = true; this.save();
  }
  save() {
    if (!this.dirty) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.d)); fs.renameSync(this.file + '.tmp', this.file); this.dirty = false; } catch (e) { /* retry next time */ }
  }
}
module.exports = { Commission };
