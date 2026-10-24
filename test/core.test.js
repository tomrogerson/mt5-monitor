'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { startOfDay } = require('../lib/tz');
const { History } = require('../lib/history');
const auth = require('../lib/auth');
const { groupFor, DEFAULT_GROUPS } = require('../lib/config');
const { MockProvider } = require('../lib/providers/mock');
const { createApp } = require('../server');

test('startOfDay respects Europe/London across BST', () => {
  const now = Date.UTC(2026, 9, 23, 20, 0, 0); // 21:00 BST on 23 Oct
  assert.strictEqual(startOfDay('Europe/London', new Date(now)).getTime(), Date.UTC(2026, 9, 22, 23, 0, 0));
  const winter = Date.UTC(2026, 11, 10, 12, 0, 0);
  assert.strictEqual(startOfDay('Europe/London', new Date(winter)).getTime(), Date.UTC(2026, 11, 10, 0, 0, 0));
});

test('history series: nulls before first sample, last point is live equity', () => {
  const h = new History(fs.mkdtempSync(path.join(os.tmpdir(), 'h-')));
  const now = Date.now();
  h.add('a', now - 60 * 60000, 100);
  h.add('a', now - 30 * 60000, 110);
  const s = h.series('a', 120, now, 96, 15 * 60000);
  assert.strictEqual(s.length, 96);
  assert.strictEqual(s[0], null);
  assert.strictEqual(s[95], 120);
  assert.ok(s.slice(91, 95).every(v => v === 110 || v === 100));
});

test('history persists to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
  const h = new History(dir); h.add('a', Date.now(), 5); h.save();
  const h2 = new History(dir); h2.load();
  assert.strictEqual(h2.series('a', 7, Date.now(), 4, 60000)[3], 7);
});

test('auth tokens verify, tamper and expire', () => {
  const t = auth.makeToken('secret', 1000);
  assert.ok(auth.verifyToken('secret', t, 2000));
  assert.ok(!auth.verifyToken('other', t, 2000));
  assert.ok(!auth.verifyToken('secret', t + 'x', 2000));
  assert.ok(!auth.verifyToken('secret', t, 1000 + 31 * 24 * 3600 * 1000));
  assert.ok(auth.checkPassword('pw', 'pw') && !auth.checkPassword('px', 'pw'));
});

test('login limiter blocks after repeated failures', () => {
  const l = new auth.LoginLimiter(3, 60000);
  for (let i = 0; i < 3; i++) l.fail('ip');
  assert.ok(l.blocked('ip'));
  l.ok('ip');
  assert.ok(!l.blocked('ip'));
});

test('groupFor matches names and falls back to other', () => {
  assert.strictEqual(groupFor('Gold 03', DEFAULT_GROUPS), 'gold');
  assert.strictEqual(groupFor('USDJPY-5', DEFAULT_GROUPS), 'usdjpy');
  assert.strictEqual(groupFor('Mystery', DEFAULT_GROUPS), 'other');
});

test('mock provider snapshot has 15 accounts with required fields', async () => {
  const p = new MockProvider({});
  await p.start();
  const s = p.snapshot();
  await p.stop();
  assert.strictEqual(s.accounts.length, 15);
  for (const a of s.accounts) for (const k of ['id', 'name', 'balance', 'equity', 'positions', 'closed', 'connected']) assert.ok(k in a, k);
});

function req(port, method, p, opts = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method, path: p, headers: opts.headers }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

test('server: login flow, gated API, state shape', async () => {
  const cfg = {
    provider: 'mock', port: 0, password: 'pw', sessionSecret: 'x'.repeat(32), pushMs: 500,
    timezone: 'Europe/London', trustProxy: false, groups: DEFAULT_GROUPS, dataDir: os.tmpdir()
  };
  const provider = new MockProvider(cfg); await provider.start();
  const history = new History(fs.mkdtempSync(path.join(os.tmpdir(), 'h-')));
  const app = createApp(cfg, provider, history);
  await new Promise(r => app.server.listen(0, r));
  const port = app.server.address().port;
  try {
    assert.strictEqual((await req(port, 'GET', '/healthz')).status, 200);
    assert.strictEqual((await req(port, 'GET', '/api/state')).status, 401);
    assert.strictEqual((await req(port, 'GET', '/')).headers.location, '/login');
    const bad = await req(port, 'POST', '/login', { body: 'password=no', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(bad.headers.location, '/login?e=1');
    const good = await req(port, 'POST', '/login', { body: 'password=pw', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = good.headers['set-cookie'][0].split(';')[0];
    const st = JSON.parse((await req(port, 'GET', '/api/state', { headers: { cookie } })).body);
    assert.strictEqual(st.accounts.length, 15);
    assert.strictEqual(st.groups.length, 3);
    const se = JSON.parse((await req(port, 'GET', '/api/series', { headers: { cookie } })).body);
    assert.strictEqual(se.n, 96);
    assert.ok(se.series['mock-1']);
  } finally {
    await app.stop();
  }
});

test('push provider: ingest, staleness and validation', () => {
  const { PushProvider, STALE_MS } = require('../lib/providers/push');
  const p = new PushProvider({ expectedAccounts: 3 });
  const t0 = 1_000_000;
  p.ingest({ id: 's:1', name: 'Gold 02', balance: 100, equity: 90, positions: [{ ticket: 1, symbol: 'XAUUSD', dir: -1, lots: 0.1, open: 1, cur: 2, pnl: -5 }], closed: [{ t: 5, symbol: 'X', dir: 1, lots: 1, pnl: 2 }, { t: 9, symbol: 'X', dir: 1, lots: 1, pnl: 3 }] }, t0);
  p.ingest({ id: 's:2', name: 'Gold 01', balance: 50, equity: 55, connected: false }, t0);
  let s = p.snapshot(t0 + 1000);
  assert.strictEqual(s.expected, 3);
  assert.deepStrictEqual(s.accounts.map(a => a.name), ['Gold 01', 'Gold 02']);
  assert.strictEqual(s.accounts[0].connected, false);
  assert.strictEqual(s.accounts[1].connected, true);
  assert.strictEqual(s.accounts[1].closed[0].t, 9);
  s = p.snapshot(t0 + STALE_MS + 1);
  assert.ok(s.accounts.every(a => !a.connected));
  assert.throws(() => p.ingest({ id: 'x', balance: 'a', equity: 1 }));
  assert.throws(() => p.ingest({ balance: 1, equity: 1 }));
});

test('server: /api/ingest needs the token and feeds the dashboard', async () => {
  const { PushProvider } = require('../lib/providers/push');
  const cfg = {
    provider: 'push', port: 0, password: 'pw', sessionSecret: 'x'.repeat(32), pushMs: 500, ingestToken: 'T'.repeat(30),
    timezone: 'Europe/London', trustProxy: false, groups: DEFAULT_GROUPS, dataDir: os.tmpdir(), expectedAccounts: 0
  };
  const provider = new PushProvider(cfg);
  const app = createApp(cfg, provider, new History(fs.mkdtempSync(path.join(os.tmpdir(), 'h-'))));
  await new Promise(r => app.server.listen(0, r));
  const port = app.server.address().port;
  const body = JSON.stringify({ id: 'a:1', name: 'USDJPY 01', balance: 1000, equity: 1010, currency: 'GBP' });
  try {
    assert.strictEqual((await req(port, 'POST', '/api/ingest', { body })).status, 401);
    assert.strictEqual((await req(port, 'POST', '/api/ingest', { body, headers: { authorization: 'Bearer nope' } })).status, 401);
    assert.strictEqual((await req(port, 'POST', '/api/ingest', { body: '{"id":"a"}', headers: { authorization: 'Bearer ' + cfg.ingestToken } })).status, 400);
    assert.strictEqual((await req(port, 'POST', '/api/ingest', { body, headers: { authorization: 'Bearer ' + cfg.ingestToken } })).status, 200);
    const good = await req(port, 'POST', '/login', { body: 'password=pw', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const cookie = good.headers['set-cookie'][0].split(';')[0];
    const st = JSON.parse((await req(port, 'GET', '/api/state', { headers: { cookie } })).body);
    assert.strictEqual(st.accounts.length, 1);
    assert.strictEqual(st.accounts[0].group, 'usdjpy');
    assert.strictEqual(st.currencySymbol, '£');
    assert.strictEqual(st.demo, false);
  } finally {
    await app.stop();
  }
});

test('push provider remembers accounts across restarts and flags demo', async () => {
  const { PushProvider, STALE_MS, FORGET_MS } = require('../lib/providers/push');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-'));
  const a = new PushProvider({ dataDir: dir });
  await a.start();
  a.ingest({ id: 's:1', name: 'Tom', balance: 10, equity: 11, demo: true }, Date.now());
  a.ingest({ id: 's:2', name: 'Old', balance: 1, equity: 1 }, Date.now() - FORGET_MS - 1000);
  await a.stop();

  const b = new PushProvider({ dataDir: dir });
  await b.start();
  const snap = b.snapshot(Date.now() + STALE_MS + 1000);
  await b.stop();
  assert.strictEqual(snap.accounts.length, 1, 'week-old account is forgotten, recent one kept');
  assert.strictEqual(snap.accounts[0].name, 'Tom');
  assert.strictEqual(snap.accounts[0].connected, false);
  assert.strictEqual(snap.accounts[0].demo, true);
  assert.strictEqual(snap.accounts[0].equity, 11);
});

test('push provider treats a server name containing "demo" as a demo account', () => {
  const { clean } = require('../lib/providers/push');
  const base = { id: 'x', balance: 1, equity: 1 };
  assert.strictEqual(clean({ ...base, server: 'PUPrime-Demo' }).demo, true);
  assert.strictEqual(clean({ ...base, server: 'ICMarketsSC-DEMO-2' }).demo, true);
  assert.strictEqual(clean({ ...base, server: 'ICMarketsSC-MT5-2' }).demo, false);
  assert.strictEqual(clean({ ...base, server: 'Live', demo: true }).demo, true);
});

test('history: hourly tier serves old ranges and survives save/load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h-'));
  const h = new History(dir);
  const now = Date.now();
  // 10 days of per-30-minute samples, equity rising 1 per sample
  for (let k = 480; k >= 0; k--) h.add('a', now - k * 30 * 60000, 1000 + (480 - k));
  h.save();
  const h2 = new History(dir); h2.load();
  const week = h2.series('a', 1481, now, 168, 3600000);
  assert.strictEqual(week.length, 168);
  assert.ok(week.filter(v => v === null).length === 0);
  assert.ok(week[0] < week[100]);
  const month = h2.series('a', 1481, now, 120, 6 * 3600000);
  assert.strictEqual(month[0], null);          // before first sample
  assert.ok(month[119] === 1481);
});

test('startOfWeek is a Monday 00:00 London', () => {
  const { startOfWeek } = require('../lib/tz');
  const w = startOfWeek('Europe/London', new Date('2026-10-24T02:00:00Z'));  // Saturday
  assert.strictEqual(w.toISOString(), '2026-10-18T23:00:00.000Z');          // Mon 19 Oct 00:00 BST
});

test('drawdown: lowest floating P&L, weekly reset, ignores settle period and deposits', () => {
  const h = new History(null);
  const t0 = 1_000_000;
  h.track('a', -5, 1000, 1, t0);              // inside settle period: ignored
  assert.strictEqual(h.drawdown('a', 1), null);
  for (let k = 1; k <= 6; k++) h.track('a', 0, 1000, 1, t0 + k * 10000);   // steady reports, no loss
  h.track('a', -2, 1000, 1, t0 + 61000);
  h.track('a', -30, 1000, 1, t0 + 62000);
  h.track('a', -10, 1000, 1, t0 + 63000);     // recovering never lowers the worst
  h.track('a', 50, 1000, 1, t0 + 64000);
  let d = h.drawdown('a', 1);
  assert.strictEqual(d.all.amt, 30); assert.strictEqual(d.all.pct, 3); assert.strictEqual(d.week.amt, 30);
  // a deposit changes balance and equity together, so floating (and drawdown) is untouched
  h.track('a', 0, 6000, 1, t0 + 65000);
  assert.strictEqual(h.drawdown('a', 1).all.amt, 30);
  // new week
  h.track('a', -4, 6000, 2, t0 + 66000);
  d = h.drawdown('a', 2);
  assert.strictEqual(d.week.amt, 4); assert.strictEqual(d.all.amt, 30);
  // reset
  h.reset('a');
  d = h.drawdown('a', 2);
  assert.strictEqual(d.week.amt, 0); assert.strictEqual(d.all.amt, 0);
  // a gap in reports starts a new settle period
  h.track('a', -99, 1000, 2, t0 + 200000);
  assert.strictEqual(h.drawdown('a', 2).all.amt, 0);
});

test('FORGET_ACCOUNTS removes a stored account and its history on startup', async () => {
  const { PushProvider } = require('../lib/providers/push');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f-'));
  const base = { dataDir: dir, expectedAccounts: 0, forgetAccounts: [] };
  const p1 = new PushProvider(base);
  const mk = (id, login) => ({ id, name: 'n' + login, server: 'S', login, balance: 1, equity: 1, positions: [], closed: [] });
  p1.ingest(mk('S:111', '111')); p1.ingest(mk('S:222', '222'));
  p1.dirty = true; p1.save();
  const p2 = new PushProvider(Object.assign({}, base, { forgetAccounts: ['111'] }));
  p2.load();
  assert.deepStrictEqual(p2.snapshot().accounts.map(a => a.id), ['S:222']);
  assert.deepStrictEqual(p2.forgotten, ['S:111']);
  p2.save();
  const p3 = new PushProvider(base); p3.load();
  assert.strictEqual(p3.snapshot().accounts.length, 1);   // stays gone once the setting is removed
  const h = new History(null); h.add('S:111', Date.now(), 5); h.forget(['S:111']);
  assert.strictEqual(h.series('S:111', 1, Date.now(), 3, 60000)[0], null);
});
