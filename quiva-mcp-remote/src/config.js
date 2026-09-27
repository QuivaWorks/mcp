// Runtime config. Env only; credentials never come from here.
export const DEFAULT_API_URL = 'https://api.quiva.ai';

function positiveInt(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

function nonNegativeInt(value, fallback, name) {
  return String(value).trim() === '0' ? 0 : positiveInt(value, fallback, name);
}

function list(value) {
  return String(value || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const config = {
    apiUrl: (env.QUIVA_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
    host: env.HOST || '0.0.0.0',
    port: positiveInt(env.PORT, 8080, 'PORT'),
    // Fits a base64 DOCX of about 760 KB; README says when to raise it.
    maxBodyBytes: positiveInt(env.MAX_BODY_BYTES, 1024 * 1024, 'MAX_BODY_BYTES'),
    requestTimeoutMs: positiveInt(env.REQUEST_TIMEOUT_MS, 120_000, 'REQUEST_TIMEOUT_MS'),
    receiveTimeoutMs: positiveInt(env.RECEIVE_TIMEOUT_MS, 30_000, 'RECEIVE_TIMEOUT_MS'),
    headersTimeoutMs: positiveInt(env.HEADERS_TIMEOUT_MS, 15_000, 'HEADERS_TIMEOUT_MS'),
    keepAliveTimeoutMs: positiveInt(env.KEEP_ALIVE_TIMEOUT_MS, 5_000, 'KEEP_ALIVE_TIMEOUT_MS'),
    maxConnections: positiveInt(env.MAX_CONNECTIONS, 256, 'MAX_CONNECTIONS'),
    rateLimitPerSec: positiveInt(env.RATE_LIMIT_PER_SEC, 10, 'RATE_LIMIT_PER_SEC'),
    rateLimitBurst: positiveInt(env.RATE_LIMIT_BURST, 40, 'RATE_LIMIT_BURST'),
    trustProxy: /^(true|1)$/i.test(String(env.TRUST_PROXY || '').trim()),
    // Off by default: a scoped API key 401s outside its scope, so one 401 doesn't prove a bad key.
    authFailureTtlMs: nonNegativeInt(env.AUTH_FAILURE_CACHE_SECONDS, 0, 'AUTH_FAILURE_CACHE_SECONDS') * 1000,
    allowedHosts: new Set(list(env.ALLOWED_HOSTS).map((h) => h.toLowerCase())),
    allowedOrigins: new Set(list(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, ''))),
  };
  if (config.headersTimeoutMs > config.receiveTimeoutMs) {
    throw new Error('HEADERS_TIMEOUT_MS must not exceed RECEIVE_TIMEOUT_MS');
  }
  return config;
}
