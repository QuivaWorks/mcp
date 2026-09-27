#!/usr/bin/env node
// Remote Quiva MCP: stateless Streamable HTTP, one McpServer + transport per request.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { API_KEY_HINT, credentialFrom, redact } from './auth.js';
import { assertUniqueTools, buildServer } from './compose.js';
import { loadConfig } from './config.js';
import { AuthFailureCache, RateLimiter, clientIp } from './limits.js';
import { loadPackages } from './packages.js';

// Upstream fetches inherit the request's abort signal, and report API 401s back to the request.
// No X-Forwarded-For is added: cerberus keys its limits by TCP peer and ignores it (DEPLOY.md).
const requestScope = new AsyncLocalStorage();
const baseFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const scope = requestScope.getStore();
  const res = await baseFetch(input, scope?.signal && !init.signal ? { ...init, signal: scope.signal } : init);
  if (res.status === 401 && scope && sameOrigin(input, scope.apiUrl)) scope.onUpstream401();
  return res;
};

function sameOrigin(input, apiUrl) {
  try {
    return new URL(typeof input === 'string' ? input : input.url ?? String(input)).origin === new URL(apiUrl).origin;
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function sendRpcError(res, status, code, message, headers) {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

function readBody(req, limit) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, -32600, `Request body exceeds ${limit} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(new HttpError(413, -32600, `Request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const UNAUTHORIZED = { 'WWW-Authenticate': 'Bearer realm="quiva"' };

async function handleMcpPost(req, res, { config, loaded, log, authFailures }) {
  const credential = credentialFrom(req.headers);
  if (!credential) {
    throw new HttpError(401, -32001, `Missing credential: send "Authorization: Bearer <API key>". ${API_KEY_HINT}.`, UNAUTHORIZED);
  }
  if (authFailures.has(credential)) {
    throw new HttpError(401, -32001, `The Quiva API rejected this credential in the last ${config.authFailureTtlMs / 1000} s. ${API_KEY_HINT}.`, UNAUTHORIZED);
  }

  // The deadline covers the body read as well as the tool calls.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, -32603, `Request timed out after ${config.requestTimeoutMs} ms`)), config.requestTimeoutMs);
  });
  try {
    const raw = await Promise.race([readBody(req, config.maxBodyBytes), timeout]);
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpError(400, -32700, 'Parse error: body is not valid JSON');
    }

    const controller = new AbortController();
    const { server } = buildServer(loaded, { apiUrl: config.apiUrl, credential });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: config.allowedHosts.size > 0,
      allowedHosts: [...config.allowedHosts],
    });
    res.on('close', () => {
      controller.abort();
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    transport.onerror = (err) => log(`[quiva-mcp-remote] transport error: ${redact(err?.message, credential)}`);

    const scope = { signal: controller.signal, apiUrl: config.apiUrl, onUpstream401: () => authFailures.add(credential) };
    await requestScope.run(scope, async () => {
      await server.connect(transport);
      await Promise.race([transport.handleRequest(req, res, body), timeout]);
    });
  } catch (err) {
    err.credential = credential;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function createApp(config = loadConfig(), { log = console.error } = {}) {
  const loaded = await loadPackages({ log });
  const counts = assertUniqueTools(loaded, config.apiUrl);
  const limiter = new RateLimiter({ ratePerSec: config.rateLimitPerSec, burst: config.rateLimitBurst });
  const authFailures = new AuthFailureCache({ ttlMs: config.authFailureTtlMs });

  const serverOptions = {
    requestTimeout: config.receiveTimeoutMs,
    headersTimeout: config.headersTimeoutMs,
    keepAliveTimeout: config.keepAliveTimeoutMs,
    connectionsCheckingInterval: Math.min(5_000, config.headersTimeoutMs),
  };
  const httpServer = createServer(serverOptions, async (req, res) => {
    const started = Date.now();
    const path = (req.url || '/').split('?')[0];
    res.on('finish', () => log(`[quiva-mcp-remote] ${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`));
    try {
      if (path === '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, -32000, 'Method not allowed');
        return sendJson(res, 200, { ok: true });
      }
      if (path !== '/mcp') return sendJson(res, 404, { error: 'not found' });

      const retryAfter = limiter.take(clientIp(req, config.trustProxy));
      if (retryAfter) throw new HttpError(429, -32000, 'Too many requests', { 'Retry-After': String(retryAfter) });
      const host = String(req.headers.host ?? '').toLowerCase();
      if (config.allowedHosts.size && !config.allowedHosts.has(host)) {
        throw new HttpError(403, -32000, 'Host not allowed');
      }
      const origin = req.headers.origin;
      if (origin && !config.allowedOrigins.has(origin.replace(/\/+$/, ''))) {
        throw new HttpError(403, -32000, 'Origin not allowed');
      }
      if (req.method === 'POST') return await handleMcpPost(req, res, { config, loaded, log, authFailures });
      throw new HttpError(405, -32000, 'Method not allowed: this server is stateless and accepts POST only', { Allow: 'POST' });
    } catch (err) {
      if (err instanceof HttpError) return sendRpcError(res, err.status, err.code, err.message, err.headers);
      log(`[quiva-mcp-remote] error: ${redact(err?.stack || err?.message, err?.credential)}`);
      return sendRpcError(res, 500, -32603, 'Internal server error');
    }
  });
  httpServer.maxConnections = config.maxConnections;
  return { httpServer, loaded, counts, authFailures };
}

async function main() {
  const config = loadConfig();
  const { httpServer, counts } = await createApp(config);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  httpServer.listen(config.port, config.host, () => {
    console.error(`[quiva-mcp-remote] listening on ${config.host}:${config.port} — API ${config.apiUrl} — ${total} tools ${JSON.stringify(counts)}`);
  });
  const stop = () => httpServer.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[quiva-mcp-remote] fatal:', err?.message ?? err);
    process.exit(1);
  });
}
