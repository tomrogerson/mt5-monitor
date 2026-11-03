'use strict';
const fs = require('fs');
const path = require('path');
// Accounts are pushed to /api/ingest by collectors running next to the MT5 terminals.
// An account that has not reported for STALE_MS is shown as disconnected.
const STALE_MS = 20 * 1000;
const FORGET_MS = 7 * 24 * 3600 * 1000; // accounts silent this long are dropped when loading

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const str = v => (v === undefined || v === null) ? '' : String(v).slice(0, 80);

function clean(body) {
  if (!body || typeof body !== 'object') throw new Error('body must be an object');
  const id = str(body.id);
  if (!id) throw new Error('id is required');
  const balance = num(body.balance), equity = num(body.equity);
  if (balance === null || equity === null) throw new Error('balance and equity must be numbers');
  const positions = (Array.isArray(body.positions) ? body.positions : []).slice(0, 500).map(p => ({
    ticket: str(p.ticket), symbol: str(p.symbol), dir: p.dir < 0 ? -1 : 1,
    lots: num(p.lots) || 0, open: num(p.open) || 0, cur: num(p.cur) || 0, pnl: num(p.pnl) || 0
  }));
  const closed = (Array.isArray(body.closed) ? body.closed : []).slice(0, 1000).map(t => ({
    t: num(t.t) || 0, symbol: str(t.symbol), dir: t.dir < 0 ? -1 : 1, lots: num(t.lots) || 0, pnl: num(t.pnl) || 0
  })).sort((a, b) => b.t - a.t);
  return {
    id, name: str(body.name) || id, group: str(body.group) || undefined,
    server: str(body.server), login: str(body.login), currency: str(body.currency) || 'USD',
    terminalConnected: body.connected !== false,
    demo: body.demo === true || /demo/i.test(str(body.server)),
    balance, equity, margin: num(body.margin) || 0, marginLevel: num(body.marginLevel),
    credit: num(body.credit) || 0,
    pnlWeek: num(body.pnlWeek), pnlMonth: num(body.pnlMonth),
    pnlLastMonth: num(body.pnlLastMonth), pnl90: num(body.pnl90), pnlYear: num(body.pnlYear),
    flows: Array.isArray(body.flows)
      ? body.flows.slice(-300).map(f => [num(f && f[0]) || 0, num(f && f[1]) || 0]).filter(f => f[0] > 0 && f[1] !== 0)
      : undefined,   // undefined = not sent this time, keep the last list
    monthly: body.monthly && typeof body.monthly === 'object' && !Array.isArray(body.monthly)
      ? Object.fromEntries(Object.entries(body.monthly).filter(([k, v]) => /^\d{4}-\d{2}$/.test(k) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]))
      : undefined,   // closed profit per completed month, sent every few hours
    deposits: Array.isArray(body.deposits)
      ? body.deposits.slice(-100).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(String(d[0])) && Number(d[1]) > 0).map(d => [String(d[0]), Number(d[1])])
      : undefined,
    positions, closed
  };
}

class PushProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.accts = new Map();
    this.file = cfg.dataDir ? path.join(cfg.dataDir, 'push-accounts.json') : null;
    this.dirty = false;
    this.timer = null;
    this.clashes = new Map(); // id -> {names:Set, at}: two collectors reporting the same account
    this.forgotten = [];   // ids removed at startup via FORGET_ACCOUNTS
  }

  async start() {
    this.load();
    this.timer = setInterval(() => this.save(), 15000);
    if (this.timer.unref) this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.save();
  }

  // Remember accounts across restarts so they stay on the dashboard (as disconnected) until they report again.
  load(now) {
    if (!this.file) return;
    now = now || Date.now();
    try {
      const list = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const forget = (this.cfg && this.cfg.forgetAccounts) || [];
      for (const a of list) {
        if (!a || !a.id || now - (a.seen || 0) > FORGET_MS) continue;
        if (forget.includes(a.id) || forget.includes(String(a.login))) {
          this.forgotten.push(a.id); this.dirty = true;
          console.log('Forgetting account ' + a.id + ' (FORGET_ACCOUNTS)');
          continue;
        }
        a.lostAt = a.seen;
        this.accts.set(a.id, a);
      }
    } catch (e) { /* no file yet, or unreadable: start empty */ }
  }

  save() {
    if (!this.file || !this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this.accts.values()]));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { console.error('Could not save push accounts:', e.message); }
  }

  ingest(body, now) {
    now = now || Date.now();
    const a = clean(body);
    const prev = this.accts.get(a.id);
    if (prev && prev.name !== a.name && now - prev.seen < 6000) {
      const c = this.clashes.get(a.id) || { names: new Set(), at: 0 };
      c.names.add(prev.name); c.names.add(a.name); c.at = now;
      this.clashes.set(a.id, c);
    }
    if (a.flows === undefined) a.flows = (prev && prev.flows) || [];
    if (a.monthly === undefined && prev) a.monthly = prev.monthly;
    if (a.deposits === undefined && prev) a.deposits = prev.deposits;
    a.seen = now;
    a.lostAt = a.terminalConnected ? 0 : (prev && prev.lostAt ? prev.lostAt : now);
    this.accts.set(a.id, a);
    this.dirty = true;
    return a.id;
  }

  snapshot(now) {
    now = now || Date.now();
    const accounts = [];
    for (const a of this.accts.values()) {
      const fresh = now - a.seen < STALE_MS;
      const connected = fresh && a.terminalConnected;
      accounts.push({
        id: a.id, name: a.name, group: a.group, server: a.server, login: a.login,
        currency: a.currency, demo: a.demo, connected,
        lostAt: connected ? 0 : (a.lostAt || a.seen),
        balance: a.balance, credit: a.credit || 0, equity: a.equity, margin: a.margin, marginLevel: a.marginLevel,
        pnlWeek: a.pnlWeek, pnlMonth: a.pnlMonth, flows: a.flows || [],
        pnlLastMonth: a.pnlLastMonth, pnl90: a.pnl90, pnlYear: a.pnlYear, monthly: a.monthly, deposits: a.deposits,
        positions: a.positions, closed: a.closed
      });
    }
    accounts.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
    const expected = Math.max(this.cfg.expectedAccounts || 0, accounts.length);
    const errors = [];
    for (const [id, c] of this.clashes) {
      if (now - c.at > 60000) { this.clashes.delete(id); continue; }
      errors.push({ name: 'Account clash', message: 'login ' + id + ' is being reported by more than one collector: ' + [...c.names].join(' / ') });
    }
    return { accounts, expected, errors };
  }
}

module.exports = { PushProvider, clean, STALE_MS, FORGET_MS };
