'use strict';
// MetaApi cloud provider (https://metaapi.cloud). Streams each account in real time.
const { startOfDay } = require('../tz');

const TRADE_TYPES = new Set(['DEAL_TYPE_BUY', 'DEAL_TYPE_SELL']);
const CLOSE_ENTRIES = new Set(['DEAL_ENTRY_OUT', 'DEAL_ENTRY_INOUT', 'DEAL_ENTRY_OUT_BY']);

const round2 = v => Math.round(v * 100) / 100;
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// Closed positions since `sinceMs`, from MetaApi history deals.
// One row per position: its closing deals plus the commission charged when it opened today.
function closedSince(deals, sinceMs) {
  const entryCommission = new Map();
  for (const d of deals || []) {
    if (d.entryType !== 'DEAL_ENTRY_IN' || !TRADE_TYPES.has(d.type) || !d.positionId) continue;
    const t = new Date(d.time).getTime();
    if (!(t >= sinceMs)) continue;
    entryCommission.set(d.positionId, (entryCommission.get(d.positionId) || 0) + num(d.commission, 0));
  }
  const groups = new Map();
  for (const d of deals || []) {
    if (!TRADE_TYPES.has(d.type) || !CLOSE_ENTRIES.has(d.entryType)) continue;
    const t = new Date(d.time).getTime();
    if (!(t >= sinceMs)) continue;
    const key = d.positionId || d.id;
    let g = groups.get(key);
    if (!g) {
      // A closing SELL deal closes a BUY position, and the other way round.
      g = { key, t, symbol: d.symbol || '', dir: d.type === 'DEAL_TYPE_SELL' ? 1 : -1, lots: 0, pnl: 0 };
      groups.set(key, g);
    }
    g.lots += num(d.volume, 0);
    g.pnl += num(d.profit, 0) + num(d.swap, 0) + num(d.commission, 0);
    if (t > g.t) g.t = t;
  }
  return [...groups.values()]
    .map(g => ({
      t: g.t, symbol: g.symbol, dir: g.dir,
      lots: round2(g.lots), pnl: round2(g.pnl + (entryCommission.get(g.key) || 0))
    }))
    .sort((a, b) => b.t - a.t);
}

function mapPositions(positions) {
  return (positions || []).map(p => ({
    ticket: String(p.id),
    symbol: p.symbol,
    dir: p.type === 'POSITION_TYPE_BUY' ? 1 : -1,
    lots: num(p.volume, 0),
    open: num(p.openPrice, 0),
    cur: num(p.currentPrice, num(p.openPrice, 0)),
    pnl: round2(
      num(p.unrealizedProfit, num(p.profit, 0)) +
      num(p.unrealizedSwap, 0) + num(p.unrealizedCommission, 0)
    )
  }));
}

// Pure function: turn MetaApi objects into the dashboard's account shape.
function buildAccount({ id, name, group, info, positions, deals, connected, lostAt, sinceMs }) {
  info = info || {};
  const balance = num(info.balance, 0);
  const equity = num(info.equity, balance);
  const margin = num(info.margin, 0);
  let marginLevel = null;
  if (margin > 0) marginLevel = num(info.marginLevel, equity / margin * 100) || equity / margin * 100;
  return {
    id, name: name || info.name || id, group: group || null,
    server: info.server || '', login: info.login !== undefined ? String(info.login) : '',
    currency: info.currency || 'USD',
    connected: !!connected, lostAt: connected ? 0 : (lostAt || 0),
    balance, equity, margin, marginLevel,
    positions: mapPositions(positions),
    closed: closedSince(deals, sinceMs)
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class MetaApiProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.tracked = new Map();
    this.api = null;
  }

  async start() {
    const MetaApi = require('metaapi.cloud-sdk').default;
    const opts = {};
    if (this.cfg.metaapi.region) opts.region = this.cfg.metaapi.region;
    this.api = new MetaApi(this.cfg.metaapi.token, opts);
    let list = this.cfg.accounts.filter(a => a && a.id);
    if (!list.length) list = await this.discover();
    for (const a of list) this.track(a);
  }

  // No accounts.json: use every account found in the MetaApi account.
  async discover() {
    const found = await this.api.metatraderAccountApi.getAccountsWithInfiniteScrollPagination({ limit: 1000 });
    return found.map(a => ({ id: a.id, name: a.name }));
  }

  track(c) {
    const e = { cfg: c, name: c.name, conn: null, account: null, lostAt: Date.now(), error: null };
    this.tracked.set(c.id, e);
    this.connectLoop(e).catch(err => { e.error = String(err && err.message || err); });
  }

  async connectLoop(e) {
    for (let attempt = 0; ; attempt++) {
      try {
        const account = await this.api.metatraderAccountApi.getAccount(e.cfg.id);
        e.account = account;
        e.name = e.cfg.name || account.name;
        if (account.state !== 'DEPLOYED') {
          if (!this.cfg.metaapi.autoDeploy) throw new Error('Account is not deployed (AUTO_DEPLOY is off)');
          await account.deploy();
        }
        await account.waitConnected(300);
        const since = new Date(startOfDay(this.cfg.timezone).getTime() - 24 * 3600 * 1000);
        const conn = account.getStreamingConnection(undefined, since);
        await conn.connect();
        await conn.waitSynchronized({ timeoutInSeconds: 300 });
        e.conn = conn;
        e.error = null;
        return;
      } catch (err) {
        e.error = String(err && err.message || err);
        console.error('[metaapi] ' + (e.name || e.cfg.id) + ': ' + e.error);
        await sleep(Math.min(60000, 5000 * (attempt + 1)));
      }
    }
  }

  snapshot() {
    const now = Date.now();
    const sinceMs = startOfDay(this.cfg.timezone, new Date(now)).getTime();
    const accounts = [];
    const errors = [];
    for (const [id, e] of this.tracked) {
      if (e.error) errors.push({ name: e.name || id, message: e.error });
      if (!e.conn) continue;
      const ts = e.conn.terminalState;
      const info = ts.accountInformation;
      if (!info) continue;
      const connected = !!(ts.connected && ts.connectedToBroker);
      if (connected) e.lostAt = 0; else if (!e.lostAt) e.lostAt = now;
      accounts.push(buildAccount({
        id, name: e.name, group: e.cfg.group, info,
        positions: ts.positions, deals: e.conn.historyStorage.deals,
        connected, lostAt: e.lostAt, sinceMs
      }));
    }
    return { accounts, expected: this.tracked.size, errors };
  }

  async stop() {
    for (const e of this.tracked.values()) {
      try { if (e.conn) await e.conn.close(); } catch (err) { /* ignore */ }
    }
  }
}

module.exports = { MetaApiProvider, buildAccount, closedSince, mapPositions };
