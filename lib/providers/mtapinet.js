'use strict';
// EXPERIMENTAL provider for MetaTraderAPI (metatraderapi.net / .dev), polling its REST API.
//
// The vendor's public OpenAPI file does not describe the response bodies, so the field
// mapping below is deliberately forgiving (it tries several common names). It has NOT been
// run against a live account. Open /api/debug/<account id> while logged in to see the raw
// responses, then tweak the name lists in pick(...) calls if anything shows as 0 or missing.
const { startOfDay } = require('../tz');

const round2 = v => Math.round(v * 100) / 100;
const toNum = v => { const n = Number(v); return Number.isFinite(n) ? n : undefined; };

function pick(o, names) {
  if (!o || typeof o !== 'object') return undefined;
  const lower = new Map(Object.keys(o).map(k => [k.toLowerCase(), k]));
  for (const n of names) {
    const k = lower.get(n.toLowerCase());
    if (k !== undefined && o[k] !== null && o[k] !== undefined) return o[k];
  }
  return undefined;
}

function sideOf(v) {
  if (typeof v === 'number') return v === 0 ? 1 : v === 1 ? -1 : null;
  const s = String(v || '').toLowerCase();
  if (s.includes('buy')) return 1;
  if (s.includes('sell')) return -1;
  return null;
}
function isPending(v) {
  if (typeof v === 'number') return v > 1;
  const s = String(v || '').toLowerCase();
  return s.includes('limit') || s.includes('stop');
}
function listFrom(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const k of Object.keys(json)) if (Array.isArray(json[k])) return json[k];
  }
  return [];
}

function mapSummary(j) {
  const o = (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  return {
    balance: toNum(pick(o, ['balance'])),
    equity: toNum(pick(o, ['equity'])),
    margin: toNum(pick(o, ['margin', 'usedMargin'])),
    marginLevel: toNum(pick(o, ['marginLevel', 'margin_level'])),
    currency: pick(o, ['currency', 'accountCurrency']),
    server: pick(o, ['server', 'serverName']),
    login: pick(o, ['login', 'accountNumber'])
  };
}

function mapOpened(json) {
  const out = [];
  for (const o of listFrom(json)) {
    const type = pick(o, ['type', 'orderType', 'operation', 'side', 'cmd']);
    if (isPending(type)) continue;
    const dir = sideOf(type);
    if (dir === null) continue;
    const open = toNum(pick(o, ['openPrice', 'open_price', 'priceOpen', 'price']));
    out.push({
      ticket: String(pick(o, ['ticket', 'id', 'position', 'positionId']) || ''),
      symbol: String(pick(o, ['symbol']) || ''),
      dir,
      lots: toNum(pick(o, ['lots', 'volume'])) || 0,
      open: open || 0,
      cur: toNum(pick(o, ['currentPrice', 'closePrice', 'priceCurrent', 'price'])) || open || 0,
      pnl: round2((toNum(pick(o, ['profit'])) || 0) + (toNum(pick(o, ['swap'])) || 0) + (toNum(pick(o, ['commission'])) || 0))
    });
  }
  return out;
}

function mapClosed(json, sinceMs) {
  const out = [];
  for (const o of listFrom(json)) {
    const type = pick(o, ['type', 'orderType', 'operation', 'side', 'cmd']);
    const dir = sideOf(type);
    const symbol = pick(o, ['symbol']);
    if (dir === null || !symbol) continue;
    const t = new Date(pick(o, ['closeTime', 'close_time', 'timeClose', 'time']) || 0).getTime();
    if (!(t >= sinceMs)) continue;
    out.push({
      t, symbol: String(symbol), dir,
      lots: toNum(pick(o, ['lots', 'volume'])) || 0,
      pnl: round2((toNum(pick(o, ['profit'])) || 0) + (toNum(pick(o, ['swap'])) || 0) + (toNum(pick(o, ['commission'])) || 0))
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

class MtApiNetProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = cfg.mtapinet.baseUrl.replace(/\/$/, '');
    this.tracked = new Map();
    this.timers = [];
  }

  async start() {
    for (const c of this.cfg.accounts) {
      if (!c.id || !c.apiKey) continue;
      const e = { cfg: c, name: c.name || c.id, summary: null, positions: [], closed: [], lostAt: Date.now(), connected: false, error: null };
      this.tracked.set(c.id, e);
      this.pollLive(e);
      this.pollHistory(e);
      this.timers.push(setInterval(() => this.pollLive(e), 3000));
      this.timers.push(setInterval(() => this.pollHistory(e), 60000));
    }
    this.timers.forEach(t => t.unref && t.unref());
  }

  async get(e, endpoint, params) {
    const q = new URLSearchParams(Object.assign({ id: e.cfg.id }, params || {}));
    const res = await fetch(this.base + endpoint + '?' + q, {
      headers: { 'x-api-key': e.cfg.apiKey },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(endpoint + ' returned HTTP ' + res.status);
    return res.json();
  }

  async pollLive(e) {
    try {
      const [sum, opened] = await Promise.all([this.get(e, '/AccountSummary'), this.get(e, '/OpenedOrders')]);
      e.summary = mapSummary(sum);
      e.positions = mapOpened(opened);
      const synced = sum && typeof sum === 'object' && 'synced' in sum ? !!sum.synced : true;
      e.connected = synced;
      if (synced) e.lostAt = 0; else if (!e.lostAt) e.lostAt = Date.now();
      e.error = null;
    } catch (err) {
      e.connected = false;
      if (!e.lostAt) e.lostAt = Date.now();
      e.error = String(err.message || err);
    }
  }

  async pollHistory(e) {
    try {
      const from = startOfDay(this.cfg.timezone);
      const json = await this.get(e, '/OrderHistory', { from: from.toISOString(), to: new Date().toISOString() });
      e.closed = mapClosed(json, from.getTime());
    } catch (err) {
      e.error = e.error || String(err.message || err);
    }
  }

  async raw(id) {
    const e = this.tracked.get(id);
    if (!e) return { error: 'unknown account id' };
    const from = startOfDay(this.cfg.timezone);
    const out = {};
    for (const [k, ep, p] of [
      ['summary', '/AccountSummary'],
      ['opened', '/OpenedOrders'],
      ['history', '/OrderHistory', { from: from.toISOString(), to: new Date().toISOString() }]
    ]) {
      try { out[k] = await this.get(e, ep, p); } catch (err) { out[k] = { error: String(err.message || err) }; }
    }
    return out;
  }

  snapshot() {
    const accounts = [];
    const errors = [];
    for (const [id, e] of this.tracked) {
      if (e.error) errors.push({ name: e.name, message: e.error });
      const s = e.summary;
      if (!s || s.balance === undefined || s.equity === undefined) continue;
      const margin = s.margin || 0;
      accounts.push({
        id, name: e.name, group: e.cfg.group || null,
        server: String(s.server || ''), login: s.login !== undefined ? String(s.login) : '',
        currency: s.currency || 'USD',
        connected: e.connected, lostAt: e.connected ? 0 : e.lostAt,
        balance: s.balance, equity: s.equity, margin,
        marginLevel: margin > 0 ? (s.marginLevel || s.equity / margin * 100) : null,
        positions: e.positions, closed: e.closed
      });
    }
    return { accounts, expected: this.tracked.size, errors };
  }

  async stop() { this.timers.forEach(clearInterval); }
}

module.exports = { MtApiNetProvider, mapSummary, mapOpened, mapClosed };
