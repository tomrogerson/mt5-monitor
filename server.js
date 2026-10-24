'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, validateConfig, groupFor } = require('./lib/config');
const { History } = require('./lib/history');
const auth = require('./lib/auth');

const PUBLIC = path.join(__dirname, 'public');
const N = 96;
const STEP_MS = 15 * 60 * 1000;
const CURRENCY_SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', CHF: 'CHF ' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json'
};
const OPEN_FILES = new Set(['/login.html', '/manifest.webmanifest', '/icon-180.png', '/icon-512.png', '/icon.svg']);

function createProvider(cfg) {
  if (cfg.provider === 'metaapi') return new (require('./lib/providers/metaapi').MetaApiProvider)(cfg);
  if (cfg.provider === 'push') return new (require('./lib/providers/push').PushProvider)(cfg);
  if (cfg.provider === 'mtapinet') return new (require('./lib/providers/mtapinet').MtApiNetProvider)(cfg);
  return new (require('./lib/providers/mock').MockProvider)(cfg);
}

function createApp(cfg, provider, history) {
  const limiter = new auth.LoginLimiter(8, 10 * 60 * 1000);
  const clients = new Set();
  let samplerTimer = null, pushTimer = null, saveTimer = null;

  function visibleGroups(accounts) {
    const used = new Set(accounts.map(a => a.group));
    const list = cfg.groups.filter(g => used.has(g.key)).map(g => ({ key: g.key, label: g.label, tag: g.tag }));
    if (used.has('other')) list.push({ key: 'other', label: 'Other', tag: '' });
    return list;
  }

  function buildLive() {
    const snap = provider.snapshot();
    const accounts = snap.accounts.map(a => Object.assign({}, a, { group: groupFor(a.name, cfg.groups, a.group) }));
    const currencies = [...new Set(accounts.map(a => a.currency))];
    const notices = [];
    let symbol = '$';
    if (currencies.length === 1) symbol = CURRENCY_SYMBOLS[currencies[0]] || currencies[0] + ' ';
    if (currencies.length > 1) {
      notices.push('Accounts use different currencies (' + currencies.join(', ') + '). Totals add the amounts together without converting.');
    }
    return {
      now: Date.now(),
      provider: cfg.provider,
      demo: cfg.provider === 'mock',
      groups: visibleGroups(accounts),
      currencySymbol: symbol,
      notices,
      expected: snap.expected,
      pending: Math.max(0, snap.expected - accounts.length),
      errors: snap.errors || [],
      accounts
    };
  }

  // range -> number of points and spacing
  const RANGES = {
    '24h': { n: 96, step: 15 * 60 * 1000 },
    '7d': { n: 168, step: 3600 * 1000 },
    '30d': { n: 120, step: 6 * 3600 * 1000 },
    '1y': { n: 183, step: 2 * 24 * 3600 * 1000 }
  };
  function buildSeries(range) {
    const r = RANGES[range] || RANGES['24h'];
    const snap = provider.snapshot();
    const now = Date.now();
    const series = {};
    for (const a of snap.accounts) series[a.id] = history.series(a.id, a.equity, now, r.n, r.step);
    return { now, range: RANGES[range] ? range : '24h', step: r.step, n: r.n, series };
  }

  function sample() {
    const snap = provider.snapshot();
    const now = Date.now();
    for (const a of snap.accounts) if (a.connected) history.add(a.id, now, a.equity);
  }

  function send(res, status, body, headers) {
    res.writeHead(status, Object.assign({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY'
    }, headers || {}));
    res.end(body);
  }
  const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  }
  const isSecure = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  const authed = req => auth.verifyToken(cfg.sessionSecret, auth.parseCookies(req.headers.cookie)[auth.COOKIE]);

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function serveFile(res, rel, extra) {
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) return send(res, 404, 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      const headers = Object.assign({
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      }, extra || {});
      if (path.extname(file) === '.html') {
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'";
      }
      send(res, 200, data, headers);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    if (p === '/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (limiter.blocked(ip)) return send(res, 302, '', { Location: '/login?e=2' });
      let body = '';
      try { body = await readBody(req, 4096); } catch (e) { return send(res, 400, 'Bad request'); }
      const pw = new URLSearchParams(body).get('password') || '';
      if (auth.checkPassword(pw, cfg.password)) {
        limiter.ok(ip);
        return send(res, 302, '', {
          Location: '/',
          'Set-Cookie': auth.cookieHeader(auth.makeToken(cfg.sessionSecret), isSecure(req)),
          'Cache-Control': 'no-store'
        });
      }
      limiter.fail(ip);
      return send(res, 302, '', { Location: '/login?e=1' });
    }
    if (p === '/login') {
      if (authed(req)) return send(res, 302, '', { Location: '/' });
      return serveFile(res, 'login.html');
    }
    if (p === '/logout') {
      return send(res, 302, '', { Location: '/login', 'Set-Cookie': auth.clearCookieHeader(isSecure(req)) });
    }

    if (p === '/api/ingest' && req.method === 'POST') {
      if (typeof provider.ingest !== 'function' || !cfg.ingestToken) return json(res, 404, { error: 'not enabled' });
      const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!auth.checkPassword(given, cfg.ingestToken)) return json(res, 401, { error: 'unauthorised' });
      let body;
      try { body = JSON.parse(await readBody(req, 1024 * 1024)); provider.ingest(body); } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
      return json(res, 200, { ok: true });
    }

    if (OPEN_FILES.has(p)) return serveFile(res, p.slice(1));

    if (!authed(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'unauthorised' });
      return send(res, 302, '', { Location: '/login' });
    }

    if (p === '/' || p === '/index.html') return serveFile(res, 'index.html');
    if (p === '/api/state') return json(res, 200, buildLive());
    if (p === '/api/series') return json(res, 200, buildSeries(url.searchParams.get('range')));
    if (p === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');
      res.write('data: ' + JSON.stringify(buildLive()) + '\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (p.startsWith('/api/debug/') && typeof provider.raw === 'function') {
      return json(res, 200, await provider.raw(decodeURIComponent(p.slice('/api/debug/'.length))));
    }
    return send(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error('Request failed:', err);
      if (!res.headersSent) send(res, 500, 'Server error'); else res.end();
    });
  });

  function startTimers() {
    samplerTimer = setInterval(sample, 60 * 1000);
    saveTimer = setInterval(() => history.save(), 5 * 60 * 1000);
    pushTimer = setInterval(() => {
      if (!clients.size) return;
      let payload;
      try { payload = 'data: ' + JSON.stringify(buildLive()) + '\n\n'; } catch (e) { return; }
      for (const c of clients) c.write(payload);
    }, cfg.pushMs);
    // keep proxies from closing idle streams
    const ka = setInterval(() => { for (const c of clients) c.write(': keep-alive\n\n'); }, 20000);
    server._ka = ka;
    [samplerTimer, saveTimer, pushTimer, ka].forEach(t => t.unref && t.unref());
  }

  async function stop() {
    clearInterval(samplerTimer); clearInterval(saveTimer); clearInterval(pushTimer); clearInterval(server._ka);
    for (const c of clients) { try { c.end(); } catch (e) { /* ignore */ } }
    clients.clear();
    history.save();
    await provider.stop();
    await new Promise(r => server.close(r));
  }

  return { server, startTimers, stop, buildLive, buildSeries, sample };
}

async function main() {
  const cfg = loadConfig();
  const problems = validateConfig(cfg);
  if (problems.length) {
    console.error('Cannot start:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  if (cfg.sessionSecretIsRandom) {
    console.warn('SESSION_SECRET is not set: logins will reset whenever the server restarts. Set a long random value.');
  }

  const history = new History(cfg.dataDir);
  history.load();
  const provider = createProvider(cfg);
  const app = createApp(cfg, provider, history);

  console.log('Provider: ' + cfg.provider + (cfg.demo ? ' (demo)' : ''));
  await provider.start();
  if (cfg.provider === 'mock') provider.seedHistory(history);
  app.startTimers();
  setTimeout(() => { try { app.sample(); } catch (e) { /* ignore */ } }, 5000).unref();

  app.server.listen(cfg.port, () => {
    console.log('Dashboard on http://localhost:' + cfg.port + (cfg.demo ? '  (demo password: ' + cfg.password + ')' : ''));
  });

  const shutdown = async () => { try { await app.stop(); } finally { process.exit(0); } };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { createApp, createProvider };
