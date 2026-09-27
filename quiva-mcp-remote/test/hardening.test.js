// Pre-body guards, server timeouts and upstream header hygiene. No network.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { after, describe, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { AuthFailureCache, RateLimiter, clientIp } from '../src/limits.js';
import { createApp } from '../src/server.js';

const API_KEY = 'QK_TESTKEYABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BAD_KEY = 'QK_REVOKEDKEY0123456789ABCDEFGHIJKLMNOPQR';
const closers = [];

after(() => {
  for (const close of closers) close();
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A stub API that records requests and 401s BAD_KEY.
async function startStub() {
  const requests = [];
  const stub = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const status = req.headers['x-api-key'] === BAD_KEY ? 401 : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 401 ? { error: 'unauthorized' } : { configs: [] }));
  });
  const port = await listen(stub);
  closers.push(() => stub.close());
  return { requests, url: `http://127.0.0.1:${port}` };
}

async function startApp(env) {
  const stub = await startStub();
  const app = await createApp(loadConfig({ QUIVA_API_URL: stub.url, ...env }), { log: () => {} });
  const port = await listen(app.httpServer);
  closers.push(() => {
    app.httpServer.closeAllConnections();
    app.httpServer.close();
  });
  return { app, stub, port };
}

// node:http, so Host and X-Forwarded-For can be set freely.
function send(port, { method = 'POST', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
});
const listConfigs = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'records_list_record_configs', arguments: {} },
});

describe('server limits', () => {
  test('HTTP timeouts and maxConnections are set from config', async () => {
    const { app } = await startApp({});
    const s = app.httpServer;
    assert.equal(s.requestTimeout, 30_000);
    assert.equal(s.headersTimeout, 15_000);
    assert.equal(s.keepAliveTimeout, 5_000);
    assert.equal(s.maxConnections, 256);
    const custom = await startApp({ RECEIVE_TIMEOUT_MS: '20000', HEADERS_TIMEOUT_MS: '10000', MAX_CONNECTIONS: '7' });
    assert.equal(custom.app.httpServer.requestTimeout, 20_000);
    assert.equal(custom.app.httpServer.headersTimeout, 10_000);
    assert.equal(custom.app.httpServer.maxConnections, 7);
  });

  test('HOST defaults to all interfaces and is configurable', () => {
    assert.equal(loadConfig({}).host, '0.0.0.0');
    assert.equal(loadConfig({ HOST: '10.0.0.5' }).host, '10.0.0.5');
  });

  test('413 just over the default 1 MiB cap; a body at the cap is read', async () => {
    const { port } = await startApp({});
    const cap = 1024 * 1024;
    const pad = (n) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(n) });
    const overhead = pad(0).length;
    const over = await send(port, { headers: { Authorization: `Bearer ${API_KEY}` }, body: pad(cap - overhead + 1) });
    assert.equal(over.status, 413);
    const at = await send(port, { headers: { Authorization: `Bearer ${API_KEY}` }, body: pad(cap - overhead) });
    assert.notEqual(at.status, 413);
  });
});

describe('rate limit', () => {
  test('429 with Retry-After once the burst is spent, before any body is read', async () => {
    const { port } = await startApp({ RATE_LIMIT_PER_SEC: '1', RATE_LIMIT_BURST: '2' });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push(await send(port, { headers: { Authorization: `Bearer ${API_KEY}` }, body: initialize }));
    assert.deepEqual(statuses.map((r) => r.status), [200, 200, 429]);
    assert.equal(statuses[2].headers['retry-after'], '1');
    assert.equal(JSON.parse(statuses[2].text).jsonrpc, '2.0');
  });

  test('token bucket refills at the configured rate', () => {
    let now = 0;
    const limiter = new RateLimiter({ ratePerSec: 2, burst: 1, now: () => now });
    assert.equal(limiter.take('a'), 0);
    assert.equal(limiter.take('a'), 1);
    assert.equal(limiter.take('b'), 0, 'keys are independent');
    now = 500;
    assert.equal(limiter.take('a'), 0);
  });

  test('tracked keys are capped, evicting the least recently used', () => {
    const limiter = new RateLimiter({ ratePerSec: 1, burst: 1, maxKeys: 2 });
    limiter.take('a');
    limiter.take('b');
    limiter.take('a');
    limiter.take('c');
    assert.deepEqual([...limiter.buckets.keys()], ['a', 'c']);
  });
});

describe('client IP', () => {
  const req = (xff, remoteAddress = '::ffff:10.1.2.3') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress } });

  test('TRUST_PROXY off: the socket address, whatever X-Forwarded-For says', () => {
    assert.equal(clientIp(req('203.0.113.9'), false), '10.1.2.3');
    assert.equal(clientIp(req(undefined, '198.51.100.4'), false), '198.51.100.4');
  });

  test('TRUST_PROXY on: the last hop, which the proxy appended', () => {
    assert.equal(clientIp(req('1.1.1.1, 203.0.113.9'), true), '203.0.113.9');
    assert.equal(clientIp(req('203.0.113.9'), true), '203.0.113.9');
    assert.equal(clientIp(req('2001:db8::1'), true), '2001:db8::1');
    assert.equal(clientIp(req('garbage'), true), '10.1.2.3', 'non-IP falls back to the socket');
    assert.equal(clientIp(req(undefined), true), '10.1.2.3');
    assert.equal(loadConfig({}).trustProxy, false);
    assert.equal(loadConfig({ TRUST_PROXY: 'true' }).trustProxy, true);
  });

  test('a spoofed first hop cannot mint a fresh bucket', async () => {
    const { port } = await startApp({ TRUST_PROXY: 'true', RATE_LIMIT_PER_SEC: '1', RATE_LIMIT_BURST: '1' });
    const auth = { Authorization: `Bearer ${API_KEY}` };
    const a = await send(port, { headers: { ...auth, 'X-Forwarded-For': '1.1.1.1, 203.0.113.9' }, body: initialize });
    const b = await send(port, { headers: { ...auth, 'X-Forwarded-For': '2.2.2.2, 203.0.113.9' }, body: initialize });
    const c = await send(port, { headers: { ...auth, 'X-Forwarded-For': '203.0.113.10' }, body: initialize });
    assert.deepEqual([a.status, b.status, c.status], [200, 429, 200]);
  });
});

describe('Host check', () => {
  test('ALLOWED_HOSTS set: another Host -> 403; a listed Host passes the SDK check too', async () => {
    const { port } = await startApp({ ALLOWED_HOSTS: '10.0.0.5:8080' });
    const auth = { Authorization: `Bearer ${API_KEY}` };
    assert.equal((await send(port, { headers: { ...auth, Host: 'evil.example' }, body: initialize })).status, 403);
    assert.equal((await send(port, { headers: { ...auth, Host: '10.0.0.5:8080' }, body: initialize })).status, 200);
  });

  test('ALLOWED_HOSTS unset: any Host passes', async () => {
    const { port } = await startApp({});
    const res = await send(port, { headers: { Authorization: `Bearer ${API_KEY}`, Host: 'anything.example' }, body: initialize });
    assert.equal(res.status, 200);
  });
});

describe('upstream headers', () => {
  test('X-Forwarded-For never reaches the API, even from a trusted proxy', async () => {
    const { port, stub } = await startApp({ TRUST_PROXY: 'true' });
    const res = await send(port, { headers: { Authorization: `Bearer ${API_KEY}`, 'X-Forwarded-For': '203.0.113.9' }, body: listConfigs });
    assert.equal(res.status, 200);
    assert.equal(stub.requests.length, 1);
    assert.equal(stub.requests[0].headers['x-forwarded-for'], undefined);
  });
});

describe('upstream 401 cache', () => {
  test('off by default', () => {
    assert.equal(loadConfig({}).authFailureTtlMs, 0);
    const cache = new AuthFailureCache({ ttlMs: 0 });
    cache.add({ apiKey: BAD_KEY });
    assert.equal(cache.has({ apiKey: BAD_KEY }), false);
    assert.equal(cache.entries.size, 0);
  });

  test('a rejected key is refused before its body for the TTL; only a hash is kept', async () => {
    const { app, port, stub } = await startApp({ AUTH_FAILURE_CACHE_SECONDS: '60' });
    const first = await send(port, { headers: { Authorization: `Bearer ${BAD_KEY}` }, body: listConfigs });
    assert.equal(first.status, 200, 'the first call reports the API 401 as a tool error');
    assert.equal(stub.requests.length, 1);

    const second = await send(port, { headers: { Authorization: `Bearer ${BAD_KEY}` }, body: listConfigs });
    assert.equal(second.status, 401);
    assert.match(second.headers['www-authenticate'] ?? '', /^Bearer/);
    assert.equal(stub.requests.length, 1, 'no second upstream call');

    const good = await send(port, { headers: { Authorization: `Bearer ${API_KEY}` }, body: listConfigs });
    assert.equal(good.status, 200);

    const keys = [...app.authFailures.entries.keys()];
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^[0-9a-f]{64}$/);
    const dump = JSON.stringify([...app.authFailures.entries]);
    assert.ok(!dump.includes(BAD_KEY) && !dump.includes('REVOKEDKEY'), 'raw credential is not stored');
    assert.equal(second.text.includes(BAD_KEY), false);
  });

  test('entries expire', () => {
    let now = 0;
    const cache = new AuthFailureCache({ ttlMs: 60_000, now: () => now });
    cache.add({ bearerToken: 'a.b.c' });
    assert.equal(cache.has({ bearerToken: 'a.b.c' }), true);
    assert.equal(cache.has({ apiKey: 'a.b.c' }), false, 'kind is part of the key');
    now = 60_000;
    assert.equal(cache.has({ bearerToken: 'a.b.c' }), false);
    assert.equal(cache.entries.size, 0);
  });
});
