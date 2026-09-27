// Guards that run before a request body is read: client IP, per-IP rate limit, recent upstream 401s.
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

function socketIp(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

// Cerberus appends its TCP peer to any client-sent X-Forwarded-For, so only the last hop is trustworthy.
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',');
    const last = hops[hops.length - 1].trim();
    if (isIP(last)) return last;
  }
  return socketIp(req) || 'unknown';
}

// Token bucket per key. The Map is kept least-recently-used first, so the cap evicts idle keys.
export class RateLimiter {
  constructor({ ratePerSec, burst, maxKeys = 100_000, now = Date.now }) {
    Object.assign(this, { ratePerSec, burst, maxKeys, now });
    this.buckets = new Map();
  }

  // Returns 0 when allowed, otherwise the seconds until a token is available.
  take(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (b) {
      b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.ratePerSec);
      b.at = t;
      this.buckets.delete(key);
    } else {
      b = { tokens: this.burst, at: t };
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
    }
    this.buckets.set(key, b);
    if (b.tokens < 1) return Math.ceil((1 - b.tokens) / this.ratePerSec);
    b.tokens -= 1;
    return 0;
  }
}

// Credentials the API rejected recently, keyed by SHA-256 so the credential itself is never held.
export class AuthFailureCache {
  constructor({ ttlMs, maxKeys = 10_000, now = Date.now }) {
    Object.assign(this, { ttlMs, maxKeys, now });
    this.entries = new Map();
  }

  static key(credential) {
    const raw = credential.apiKey ? `key:${credential.apiKey}` : `bearer:${credential.bearerToken}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  add(credential) {
    if (!this.ttlMs) return;
    const key = AuthFailureCache.key(credential);
    this.entries.delete(key);
    if (this.entries.size >= this.maxKeys) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, this.now() + this.ttlMs);
  }

  has(credential) {
    if (!this.ttlMs) return false;
    const key = AuthFailureCache.key(credential);
    const expires = this.entries.get(key);
    if (expires === undefined) return false;
    if (expires > this.now()) return true;
    this.entries.delete(key);
    return false;
  }
}
