'use strict';
// Simulated accounts and prices, for trying the dashboard without any broker connection.
const { startOfDay } = require('../tz');

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss() {
  let u = 0; while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

const SYM = {
  XAUUSD: { price: 4112.35, vol: 0.00009, unit: 90 },
  USDJPY: { price: 151.82, vol: 0.000025, unit: 55 },
  GBPUSD: { price: 1.3105, vol: 0.000022, unit: 70 }
};
const GROUP_SYMBOL = { gold: 'XAUUSD', usdjpy: 'USDJPY', gbpusd: 'GBPUSD' };

const DEFS = [
  { g: 'gold', name: 'Gold 01', server: 'ICMarketsSC-Live19', bal: 21245.92 },
  { g: 'gold', name: 'Gold 02', server: 'Pepperstone-Edge12', bal: 6000.00, special: 'margin' },
  { g: 'gold', name: 'Gold 03', server: 'VantageInternational-Live 3', bal: 12880.40 },
  { g: 'gold', name: 'Gold 04', server: 'ICMarketsSC-Live07', bal: 15000.00, special: 'offline' },
  { g: 'gold', name: 'Gold 05', server: 'FPMarketsLtd-Live', bal: 8420.15 },
  { g: 'gold', name: 'Gold 06', server: 'Pepperstone-Edge07', bal: 30112.78 },
  { g: 'usdjpy', name: 'USDJPY 01', server: 'ICMarketsSC-Live19', bal: 18200.00 },
  { g: 'usdjpy', name: 'USDJPY 02', server: 'FPMarketsLtd-Live', bal: 9540.62 },
  { g: 'usdjpy', name: 'USDJPY 03', server: 'VantageInternational-Live 3', bal: 10000.00, special: 'drawdown' },
  { g: 'usdjpy', name: 'USDJPY 04', server: 'Pepperstone-Edge12', bal: 25310.05 },
  { g: 'gbpusd', name: 'GBPUSD 01', server: 'ICMarketsSC-Live07', bal: 14720.33 },
  { g: 'gbpusd', name: 'GBPUSD 02', server: 'Pepperstone-Edge07', bal: 7810.90 },
  { g: 'gbpusd', name: 'GBPUSD 03', server: 'FPMarketsLtd-Live', bal: 19955.48 },
  { g: 'gbpusd', name: 'GBPUSD 04', server: 'VantageInternational-Live 3', bal: 5260.00 },
  { g: 'gbpusd', name: 'GBPUSD 05', server: 'ICMarketsSC-Live19', bal: 11390.71 }
];

function pnlOf(sym, dir, lots, open, cur) {
  const d = (cur - open) * dir;
  if (sym === 'XAUUSD') return d * 100 * lots;
  if (sym === 'USDJPY') return d * 100000 * lots / cur;
  return d * 100000 * lots;
}
function marginOf(sym, lots, price, lev) {
  if (sym === 'XAUUSD') return lots * 100 * price / lev;
  if (sym === 'USDJPY') return lots * 100000 / lev;
  return lots * 100000 * price / lev;
}
function lotsFor(sym, bal, scale) {
  const base = sym === 'XAUUSD' ? bal / 30000 : bal / 10000;
  return Math.max(sym === 'XAUUSD' ? 0.05 : 0.1, Math.round(base * scale * 100) / 100);
}

class MockProvider {
  constructor(cfg) {
    this.cfg = cfg;
    this.rnd = mulberry32(20261023);
    this.accts = [];
    this.timer = null;
  }

  between(a, b) { return a + (b - a) * this.rnd(); }
  pick(arr) { return arr[Math.floor(this.rnd() * arr.length)]; }

  mkPos(sym, dir, lots, off, stale) {
    const s = SYM[sym];
    return {
      ticket: String(70000000 + Math.floor(this.rnd() * 9000000)),
      symbol: sym, dir, lots,
      open: s.price + off,
      cur: s.price + (stale || 0)
    };
  }

  async start() {
    const now = Date.now();
    const since = startOfDay(this.cfg.timezone, new Date(now)).getTime();
    this.accts = DEFS.map((d, idx) => {
      const sym = GROUP_SYMBOL[d.g];
      const a = {
        id: 'mock-' + (idx + 1), name: d.name, group: d.g, server: d.server,
        login: String(50000000 + Math.floor(this.rnd() * 9000000)),
        currency: 'USD', lev: 500, balance: d.bal, connected: true, lostAt: 0, demo: [2, 8, 12].includes(idx),
        positions: [], closed: []
      };
      if (d.special === 'margin') {
        a.positions.push(this.mkPos('XAUUSD', 1, 1.2, 0.6), this.mkPos('XAUUSD', 1, 1.0, 0.9), this.mkPos('XAUUSD', 1, 0.6, 0.2));
      } else if (d.special === 'drawdown') {
        a.positions.push(this.mkPos('USDJPY', 1, 1.2, 0.58), this.mkPos('USDJPY', 1, 0.8, 0.62));
      } else if (d.special === 'offline') {
        a.positions.push(this.mkPos('XAUUSD', -1, 0.3, -1.8, -0.9), this.mkPos('XAUUSD', 1, 0.25, -3.1, -0.9));
        a.connected = false;
        a.lostAt = now - 4 * 60000 - 17000;
      } else {
        const n = this.pick([0, 1, 1, 2, 2, 3, 3, 4]);
        for (let k = 0; k < n; k++) {
          const lots = lotsFor(sym, d.bal, this.between(0.4, 1.2));
          const off = sym === 'XAUUSD' ? this.between(-6, 6) : sym === 'USDJPY' ? this.between(-0.45, 0.45) : this.between(-0.0035, 0.0035);
          a.positions.push(this.mkPos(sym, this.rnd() < 0.5 ? 1 : -1, lots, off));
        }
      }
      const span = now - since - 120000;
      const cn = span < 8 * 60000 ? 0 : Math.floor(this.between(2, 9));
      for (let k = 0; k < cn; k++) {
        const lots = lotsFor(sym, d.bal, this.between(0.3, 1.0));
        a.closed.push({
          t: Math.floor(since + this.rnd() * span), symbol: sym,
          dir: this.rnd() < 0.5 ? 1 : -1, lots,
          pnl: Math.round(lots * SYM[sym].unit * this.between(-0.9, 1.3) * 100) / 100
        });
      }
      a.closed.sort((x, y) => y.t - x.t);
      return a;
    });
    this.timer = setInterval(() => this.tick(), 1000);
    if (this.timer.unref) this.timer.unref();
  }

  // Fill the history store with a plausible last 24 hours.
  seedHistory(history) {
    const now = Date.now();
    for (const a of this.accts) {
      const eq = this.compute(a).equity;
      let v = eq;
      const sd = a.balance * 0.0016;
      const pts = [];
      for (let k = 0; k < 96; k++) {
        pts.push([now - k * 15 * 60000, v]);
        v += (this.rnd() - 0.5) * 2 * sd * 1.7 - a.balance * 0.00002;
      }
      pts.reverse().forEach(([t, val]) => history.add(a.id, t, val));
    }
  }

  tick() {
    for (const k in SYM) SYM[k].price *= 1 + gauss() * SYM[k].vol;
    for (const a of this.accts) {
      if (!a.connected) continue;
      for (const p of a.positions) p.cur = SYM[p.symbol].price;
    }
  }

  compute(a) {
    let fl = 0, mu = 0;
    const positions = a.positions.map(p => {
      const pnl = pnlOf(p.symbol, p.dir, p.lots, p.open, p.cur);
      fl += pnl;
      mu += marginOf(p.symbol, p.lots, p.cur, a.lev);
      return { ticket: p.ticket, symbol: p.symbol, dir: p.dir, lots: p.lots, open: p.open, cur: p.cur, pnl };
    });
    const equity = a.balance + fl;
    return { positions, equity, margin: mu, marginLevel: mu > 0 ? equity / mu * 100 : null };
  }

  snapshot() {
    const accounts = this.accts.map(a => {
      const c = this.compute(a);
      return {
        id: a.id, name: a.name, group: a.group, server: a.server, login: a.login,
        currency: a.currency, demo: !!a.demo, connected: a.connected, lostAt: a.lostAt,
        balance: a.balance, equity: c.equity, margin: c.margin, marginLevel: c.marginLevel,
        positions: c.positions, closed: a.closed
      };
    });
    return { accounts, expected: accounts.length, errors: [] };
  }

  async stop() { if (this.timer) clearInterval(this.timer); }
}

module.exports = { MockProvider };
