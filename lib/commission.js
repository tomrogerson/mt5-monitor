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
    this.d = { rates: {}, paid: {}, live: {}, dep: {}, wd: {}, hidden: [] };
    this.dirty = false;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); Object.assign(this.d, j); } catch (e) { /* first run */ }
    // older saves kept one entry per person per bot (two accounts overwrote each other): drop them, the collectors re-send everything
    for (const o of Object.values(this.d.live)) for (const id of Object.keys(o)) if (id.split('|').length < 3) delete o[id];
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
      const id = a.group + '|' + who + '|' + (a.id || a.login || a.name);   // one entry per account, so two accounts of one person in the same bot add up
      const set = (mk, v) => {
        if (typeof v !== 'number' || !isFinite(v)) return;
        const o = this.d.live[mk] || (this.d.live[mk] = {});
        if (o[id] !== v) { o[id] = Math.round(v * 100) / 100; this.dirty = true; }
      };
      set(cur, a.pnlMonth); set(prev, a.pnlLastMonth);
      const st = this.startFor(this.labels[a.group] || a.group);
      if (a.monthly) for (const [mk, v] of Object.entries(a.monthly)) if (mk >= st && mk < cur) set(mk, v);   // full history from the collector
      if (Array.isArray(a.deposits) && a.deposits.length) { this.d.dep[a.id] = { g: a.group, who, list: a.deposits }; this.dirty = true; }
      if (Array.isArray(a.withdrawals) && a.withdrawals.length) { this.d.wd[a.id] = { g: a.group, who, list: a.withdrawals }; this.dirty = true; }
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
        const p = id.split('|'), grp = p[0], who = p[1];
        if (seed.months[mk] && seed.months[mk][who] !== undefined && this.seedGroups.has(grp)) continue;   // the tracker already covers this person's Bot 2 months
        add(mk, who, this.labels[grp] || grp, v);
      }
    }
    const live = new Set(); for (const o of Object.values(this.d.live)) for (const id of Object.keys(o)) live.add(id.split('|')[1]);
    return { rates: seed.rates, paid: this.d.paid, selfPaid: seed.selfPaid || [], payments: seed.payments || {}, alias: seed.alias || {}, aliasPrefix: seed.aliasPrefix || [],
      capital: this.capital(), withdrawn: this.withdrawn(), closed: seed.closed || [], bots: [...bots].sort(), seedBot: this.seedLabel, months, active: [...live], now: this.monthKey(new Date()) };
  }
  // Every deposit and every withdrawal the collectors have read from each person's accounts, grouped by bot (nothing netted off or filtered).
  flows() {
    const out = { dep: {}, wd: {} };
    for (const [kind, src] of [['dep', this.d.dep], ['wd', this.d.wd]]) for (const e of Object.values(src || {})) {
      const bot = this.labels[e.g] || e.g, m = out[kind][bot] || (out[kind][bot] = {});
      (m[e.who] = m[e.who] || []).push(...e.list);
    }
    for (const kind of ['dep', 'wd']) for (const m of Object.values(out[kind])) for (const l of Object.values(m)) l.sort((x, y) => (x[0] < y[0] ? -1 : 1));
    return out;
  }
  capital() {
    const out = {}, f = this.flows(); out[this.seedLabel] = JSON.parse(JSON.stringify(seed.capital || {}));
    for (const [bot, o] of Object.entries(f.dep)) for (const [who, list] of Object.entries(o)) {
      const m = out[bot] || (out[bot] = {});
      if (bot === this.seedLabel && (seed.selfPaid || []).includes(who)) delete m[who];
      if (bot === this.seedLabel && (seed.capital || {})[who] && !(seed.selfPaid || []).includes(who)) continue;   // the tracker has the full picture for these (not your own accounts: their totals in and out come from MT5)
      const fx = ((seed.capitalFixed || {})[bot] || {})[who];
      (m[who] = m[who] || []).push(...(fx ? list.filter(d => d[0] > fx[fx.length - 1][0]) : list));   // a fixed list replaces the deposits up to its last date
    }
    for (const [bot, o] of Object.entries(seed.capitalFixed || {})) for (const [who, list] of Object.entries(o)) {
      const m = out[bot] || (out[bot] = {});
      m[who] = list.concat(m[who] || []);
    }
    return out;
  }
  withdrawn() {
    const out = {}, f = this.flows();
    for (const [bot, o] of Object.entries(f.wd)) for (const [who, list] of Object.entries(o)) {
      const m = out[bot] || (out[bot] = {});
      const fx = ((seed.withdrawnFixed || {})[bot] || {})[who];
      (m[who] = m[who] || []).push(...(fx ? list.filter(d => d[0] > fx[fx.length - 1][0]) : list));
    }
    for (const [bot, o] of Object.entries(seed.withdrawnFixed || {})) for (const [who, list] of Object.entries(o)) {
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
