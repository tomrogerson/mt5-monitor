'use strict';
// Single-password login with a signed, expiring cookie. No dependencies.
const crypto = require('crypto');

const COOKIE = 'mt5s';
const MAX_AGE_S = 30 * 24 * 3600;

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function checkPassword(given, expected) {
  return crypto.timingSafeEqual(sha(given), sha(expected));
}

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function makeToken(secret, now) {
  const exp = Math.floor((now || Date.now()) / 1000) + MAX_AGE_S;
  const payload = b64u(JSON.stringify({ exp }));
  return payload + '.' + sign(secret, payload);
}

function verifyToken(secret, token, now) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const good = sign(secret, payload);
  if (sig.length !== good.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(exp) && exp > Math.floor((now || Date.now()) / 1000);
  } catch (e) { return false; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieHeader(token, secure) {
  return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + MAX_AGE_S + (secure ? '; Secure' : '');
}

function clearCookieHeader(secure) {
  return COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : '');
}

// Allow a handful of wrong passwords per address, then slow down.
class LoginLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  blocked(ip, now) {
    now = now || Date.now();
    const h = this.hits.get(ip);
    if (!h) return false;
    if (now > h.reset) { this.hits.delete(ip); return false; }
    return h.count >= this.max;
  }
  fail(ip, now) {
    now = now || Date.now();
    const h = this.hits.get(ip);
    if (!h || now > h.reset) this.hits.set(ip, { count: 1, reset: now + this.windowMs });
    else h.count++;
  }
  ok(ip) { this.hits.delete(ip); }
}

module.exports = {
  COOKIE, checkPassword, makeToken, verifyToken, parseCookies,
  cookieHeader, clearCookieHeader, LoginLimiter
};
