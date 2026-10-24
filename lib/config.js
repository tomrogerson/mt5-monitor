'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadDotEnv } = require('./env');

const DEFAULT_GROUPS = [
  { key: 'gold',   label: 'Gold',    tag: 'XAUUSD', match: 'gold|xau' },
  { key: 'usdjpy', label: 'USD/JPY', tag: 'USDJPY', match: 'usd.?jpy|jpy' },
  { key: 'gbpusd', label: 'GBP/USD', tag: 'GBPUSD', match: 'gbp.?usd|gbp' }
];

function readAccountsFile(env) {
  if (env.ACCOUNTS_JSON) return JSON.parse(env.ACCOUNTS_JSON);
  const p = env.ACCOUNTS_FILE || path.join(__dirname, '..', 'accounts.json');
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  return {};
}

function loadConfig() {
  loadDotEnv();
  const env = process.env;
  const demo = process.argv.includes('--demo');
  const file = readAccountsFile(env);

  let provider = demo ? 'mock' : (env.PROVIDER || (env.METAAPI_TOKEN ? 'metaapi' : 'mock'));
  provider = String(provider).toLowerCase();

  const groups = (file.groups && file.groups.length ? file.groups : DEFAULT_GROUPS).map(g => ({
    key: String(g.key),
    label: g.label || String(g.key),
    tag: g.tag || '',
    match: g.match || ''
  }));

  const cfg = {
    demo,
    provider,
    port: Number(env.PORT) || 3000,
    password: env.DASHBOARD_PASSWORD || (demo ? 'demo' : ''),
    sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    sessionSecretIsRandom: !env.SESSION_SECRET,
    timezone: file.timezone || env.TIMEZONE || 'Europe/London',
    dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
    trustProxy: env.TRUST_PROXY !== 'false',
    pushMs: Math.max(500, Number(env.PUSH_MS) || 2000),
    ingestToken: env.INGEST_TOKEN || '',
    expectedAccounts: Number(env.EXPECTED_ACCOUNTS) || 0,
    // accounts to remove for good on startup: login numbers or full ids, comma separated
    forgetAccounts: String(env.FORGET_ACCOUNTS || '').split(',').map(x => x.trim()).filter(Boolean),
    groups,
    accounts: Array.isArray(file.accounts) ? file.accounts : [],
    metaapi: {
      token: env.METAAPI_TOKEN || '',
      region: env.METAAPI_REGION || '',
      autoDeploy: env.AUTO_DEPLOY !== 'false'
    },
    mtapinet: {
      baseUrl: env.MTAPINET_BASE_URL || 'https://api.metatraderapi.net'
    }
  };
  return cfg;
}

function validateConfig(cfg) {
  const problems = [];
  if (!cfg.password) problems.push('DASHBOARD_PASSWORD is not set. Choose a long password and set it in your host settings.');
  if (cfg.provider === 'metaapi' && !cfg.metaapi.token) problems.push('METAAPI_TOKEN is not set.');
  if (cfg.provider === 'mtapinet' && !cfg.accounts.length) problems.push('The mtapinet provider needs accounts (with id and apiKey) in accounts.json.');
  if (cfg.provider === 'push' && String(cfg.ingestToken).length < 24) problems.push('INGEST_TOKEN must be set to a random string of at least 24 characters (the collectors use it to send data).');
  if (!['mock', 'metaapi', 'mtapinet', 'push'].includes(cfg.provider)) problems.push('PROVIDER must be mock, metaapi, mtapinet or push.');
  return problems;
}

function groupFor(name, groups, explicit) {
  if (explicit && groups.some(g => g.key === explicit)) return explicit;
  for (const g of groups) {
    if (!g.match) continue;
    try { if (new RegExp(g.match, 'i').test(name || '')) return g.key; } catch (e) { /* bad regex: ignore */ }
  }
  return 'other';
}

module.exports = { loadConfig, validateConfig, groupFor, DEFAULT_GROUPS };
