// End-to-end over HTTP against a local stub API. No network.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { DENYLIST, loadPackages } from '../src/packages.js';
import { createApp } from '../src/server.js';

const API_KEY = 'QK_TESTKEYABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const JWT = 'eyJhbGciOiJFZDI1NTE5In0.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';

let stub;
let stubRequests = [];
let app;
let base;
const logs = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  stub = createServer((req, res) => {
    stubRequests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ configs: [] }));
  });
  const stubPort = await listen(stub);
  const config = loadConfig({
    QUIVA_API_URL: `http://127.0.0.1:${stubPort}`,
    MAX_BODY_BYTES: '65536',
    REQUEST_TIMEOUT_MS: '10000',
    ALLOWED_ORIGINS: 'https://allowed.example',
    RATE_LIMIT_BURST: '1000',
  });
  app = await createApp(config, { log: (line) => logs.push(line) });
  base = `http://127.0.0.1:${await listen(app.httpServer)}`;
});

after(() => {
  app?.httpServer.close();
  stub?.close();
});

function rpc(body, headers = {}) {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${API_KEY}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
};

async function expectedToolCount() {
  let total = 0;
  for (const pkg of await loadPackages({ log: () => {} })) {
    const names = [];
    const fake = { registerTool: (n) => names.push(n), tool: (n) => names.push(n) };
    pkg.registerTools(fake, new pkg.QuivaClient({ apiKey: 'x' }), { prefix: pkg.prefix });
    total += names.filter((n) => !DENYLIST.has(n)).length;
  }
  return total;
}

describe('MCP round trip', () => {
  test('initialize returns server info and the merged instructions', async () => {
    const res = await rpc(initialize);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.serverInfo.name, 'quiva');
    assert.match(body.result.instructions, /flows_\*/);
    assert.match(body.result.instructions, /list_reference_topics/);
    assert.ok(body.result.instructions.length < 2000, 'instructions stay a short index');
    assert.equal(res.headers.get('mcp-session-id'), null, 'stateless: no session id');
  });

  test('tools/list: prefixed, unique, and every package counted', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    const names = result.tools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length, 'names are unique');
    const prefixes = app.loaded.map((p) => p.prefix);
    for (const n of names) assert.ok(prefixes.some((p) => n.startsWith(p)), `${n} is prefixed`);
    assert.equal(names.length, await expectedToolCount());
    for (const p of ['flows_', 'records_', 'documents_', 'workspaces_', 'assistants_']) {
      assert.ok(names.includes(`${p}list_reference_topics`), `${p}list_reference_topics present`);
    }
  });

  test('an API key is forwarded as X-Api-Key', async () => {
    stubRequests = [];
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'records_list_record_configs', arguments: {} } });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(stubRequests.length, 1);
    assert.match(stubRequests[0].url, /^\/records\/config/);
    assert.equal(stubRequests[0].headers['x-api-key'], API_KEY);
    assert.equal(stubRequests[0].headers.authorization, undefined);
  });

  test('X-Api-Key is accepted directly', async () => {
    stubRequests = [];
    const res = await rpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'records_list_record_configs', arguments: {} } },
      { Authorization: '', 'X-Api-Key': API_KEY }
    );
    assert.equal(res.status, 200);
    assert.equal(stubRequests[0].headers['x-api-key'], API_KEY);
  });

  test('a JWT-shaped bearer is forwarded as Authorization: Bearer', async () => {
    stubRequests = [];
    const res = await rpc(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'records_list_record_configs', arguments: {} } },
      { Authorization: `Bearer ${JWT}` }
    );
    assert.equal(res.status, 200);
    assert.equal(stubRequests[0].headers.authorization, `Bearer ${JWT}`);
    assert.equal(stubRequests[0].headers['x-api-key'], undefined);
  });

  test('credentials never reach the logs', () => {
    const all = logs.join('\n');
    assert.ok(!all.includes(API_KEY) && !all.includes(JWT));
  });
});

describe('HTTP guards', () => {
  test('missing credential -> 401 with WWW-Authenticate and the API-key hint', async () => {
    const res = await rpc(initialize, { Authorization: '' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/);
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.match(body.error.message, /Settings → API keys/);
  });

  test('Basic auth is not a credential', async () => {
    const res = await rpc(initialize, { Authorization: 'Basic dXNlcjpwYXNz' });
    assert.equal(res.status, 401);
  });

  test('oversized body -> 413', async () => {
    const big = JSON.stringify({ ...initialize, pad: 'x'.repeat(70_000) });
    const res = await rpc(big);
    assert.equal(res.status, 413);
  });

  test('invalid JSON -> 400 parse error', async () => {
    const res = await rpc('{not json');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, -32700);
  });

  test('disallowed Origin -> 403; allowed Origin passes', async () => {
    assert.equal((await rpc(initialize, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await rpc(initialize, { Origin: 'https://allowed.example' })).status, 200);
  });

  test('GET and DELETE /mcp -> 405 JSON-RPC error', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method, headers: { Authorization: `Bearer ${API_KEY}` } });
      assert.equal(res.status, 405);
      assert.equal((await res.json()).jsonrpc, '2.0');
    }
  });

  test('a gateway-prefixed path (/<subdomain>/mcp) is served; other paths 404', async () => {
    const post = (p) => fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(initialize),
    });
    assert.equal((await post('/api/mcp')).status, 200);
    assert.equal((await post('/api/other')).status, 404);
  });

  test('GET /healthz -> 200 {ok:true}', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe('request timeout', () => {
  test('a slow upstream -> 504, and the upstream call is aborted', async () => {
    let upstreamClosed = false;
    const slow = createServer((req, res) => {
      res.on('close', () => (upstreamClosed = !res.writableFinished));
      setTimeout(() => res.end('{}'), 3000).unref();
    });
    const port = await listen(slow);
    const timed = await createApp(
      loadConfig({ QUIVA_API_URL: `http://127.0.0.1:${port}`, REQUEST_TIMEOUT_MS: '200' }),
      { log: () => {} }
    );
    const url = `http://127.0.0.1:${await listen(timed.httpServer)}/mcp`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Api-Key': API_KEY },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'records_list_record_configs', arguments: {} } }),
      });
      assert.equal(res.status, 504);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(upstreamClosed, 'upstream request was aborted');
    } finally {
      timed.httpServer.close();
      slow.closeAllConnections();
      slow.close();
    }
  });
});
