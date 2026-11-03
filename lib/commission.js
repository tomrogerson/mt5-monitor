'use strict';
const fs = require('fs');
const path = require('path');
const seed = require('./commission-seed.json');

/* Commission store: rates and "paid" ticks the owner edits, plus a record of each account's closed profit per month
   (so a month is not lost when the collector's "this month" window rolls over). Saved as DATA_DIR/commission.json. */
class Commission {
  constructor(cfg) {
    this.file = path.join(cfg.dataDir || require('os').tmpdir(), 'commission.json');
    this.labels = {}; for (const g of cfg.groups || []) this.labels[g.key] = g.label;
    this.seedLabel = ((cfg.groups || []).find(g => /^bot ?2$/i.test(g.label)) || { label: 'Bot 2' }).label;
    this.tz = cfg.timezone || 'Europe/London';
    this.followerGroups = new Set((cfg.groups || []).filter(g => /^bot ?[12]$/i.test(g.label)).map(g => g.key));
    this.seedGroups = new Set((cfg.groups || []).filter(g => /^bot ?2$/i.test(g.label)).map(g => g.key));
    this.d = { rates: {}, paid: {}, live: {}, dep: {}, hidden: [] };
    this.dirty = false;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); Object.assign(this.d, j); } catch (e) { /* first run */ }
  }
  monthKey(date) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: this.tz, year: 'numeric', month: '2-digit' }).formatToParts(date);
    const g = t => p.find(x => x.type === t).value;
    return g('year') + '-' + g('month');
  }
  who(name) {
    if (seed.alias && seed.alias[name]) return seed.alias[name];
    for (const [pre, p] of seed.aliasPrefix || []) if (name === pre || name.startsWith(pre + ' ')) return p;
    return name;
  }
  startFor(label) { const s = seed.start || {}; return s[label] || s.default || '2025-11'; }
  prevKey(key) { const [y, m] = key.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); }
  record(accounts, now) {
    const cur = this.monthKey(new Date(now)), prev = this.prevKey(cur);
    for (const a of accounts) {
      const who = this.who(a.name);
      if (a.demo || !(this.followerGroups.has(a.group) || who !== a.name)) continue;   // an alias (e.g. Andy V TT Gold) pulls in accounts from other tabs
      const id = a.group + '|' + who;
      const set = (mk, v) => {
        if (typeof v !== 'number' || !isFinite(v)) return;
        const o = this.d.live[mk] || (this.d.live[mk] = {});
        if (o[id] !== v) { o[id] = Math.round(v * 100) / 100; this.dirty = true; }
      };
      set(cur, a.pnlMonth); set(prev, a.pnlLastMonth);
      const st = this.startFor(this.labels[a.group] || a.group);
      if (a.monthly) for (const [mk, v] of Object.entries(a.monthly)) if (mk >= st && mk < cur) set(mk, v);   // full history from the collector
      if (Array.isArray(a.deposits) && a.deposits.length) { this.d.dep[a.id] = { g: a.group, who, list: a.deposits }; this.dirty = true; }
    }
  }
  view() {
    const months = {}, bots = new Set();
    const add = (mk, who, bot, v) => {
      bots.add(bot);
      const m = (months[mk] || (months[mk] = {}))[who] || (months[mk][who] = {});
      m[bot] = Math.round(((m[bot] || 0) + v) * 100) / 100;
    };
    for (const [mk, o] of Object.entries(seed.months)) for (const [who, v] of Object.entries(o)) add(mk, who, this.seedLabel, v);
    for (const [mk, o] of Object.entries(this.d.live)) {
      for (const [id, v] of Object.entries(o)) {
        const i = id.indexOf('|'), grp = id.slice(0, i), who = id.slice(i + 1);
        if (seed.months[mk] && seed.months[mk][who] !== undefined && this.seedGroups.has(grp)) continue;   // the tracker already covers this person's Bot 2 months
        add(mk, who, this.labels[grp] || grp, v);
      }
    }
    const live = new Set(); for (const o of Object.values(this.d.live)) for (const id of Object.keys(o)) live.add(id.slice(id.indexOf('|') + 1));
    return { rates: seed.rates, paid: this.d.paid, selfPaid: seed.selfPaid || [], payments: seed.payments || {}, alias: seed.alias || {}, aliasPrefix: seed.aliasPrefix || [],
      capital: this.capital(), closed: seed.closed || [], bots: [...bots].sort(), seedBot: this.seedLabel, months, active: [...live], now: this.monthKey(new Date()) };
  }
  capital() {
    const out = {}; out[this.seedLabel] = JSON.parse(JSON.stringify(seed.capital || {}));
    for (const e of Object.values(this.d.dep)) {
      const bot = this.labels[e.g] || e.g, m = out[bot] || (out[bot] = {});
      if (bot === this.seedLabel && (seed.capital || {})[e.who]) continue;   // the tracker has the full picture for these
      const fx = ((seed.capitalFixed || {})[bot] || {})[e.who];
      (m[e.who] = m[e.who] || []).push(...(fx ? e.list.filter(d => d[0] > fx[0][0]) : e.list));   // a fixed start replaces any earlier deposits
    }
    for (const [bot, o] of Object.entries(seed.capitalFixed || {})) for (const [who, list] of Object.entries(o)) {
      const m = out[bot] || (out[bot] = {});
      m[who] = list.concat(m[who] || []);
    }
    return out;
  }
  update(body) {
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
