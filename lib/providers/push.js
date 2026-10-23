'use strict';
// Accounts are pushed to /api/ingest by collectors running next to the MT5 terminals.
// An account that has not reported for STALE_MS is shown as disconnected.
const STALE_MS = 20 * 1000;

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
    balance, equity, margin: num(body.margin) || 0, marginLevel: num(body.marginLevel),
    positions, closed
  };
}

class PushProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.accts = new Map();
  }

  async start() {}
  async stop() {}

  ingest(body, now) {
    now = now || Date.now();
    const a = clean(body);
    const prev = this.accts.get(a.id);
    a.seen = now;
    a.lostAt = a.terminalConnected ? 0 : (prev && prev.lostAt ? prev.lostAt : now);
    this.accts.set(a.id, a);
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
        currency: a.currency, connected,
        lostAt: connected ? 0 : (a.lostAt || a.seen),
        balance: a.balance, equity: a.equity, margin: a.margin, marginLevel: a.marginLevel,
        positions: a.positions, closed: a.closed
      });
    }
    accounts.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
    const expected = Math.max(this.cfg.expectedAccounts || 0, accounts.length);
    return { accounts, expected, errors: [] };
  }
}

module.exports = { PushProvider, clean, STALE_MS };
