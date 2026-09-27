// HTTP client for Abbie's settings API (hub-service, /hub/coworker/* and /hub/agent/model-pool).
// Auth precedence: QUIVA_API_KEY, then QUIVA_BEARER_TOKEN, then QUIVA_EMAIL + QUIVA_PASSWORD.

const DEFAULT_API_URL = 'https://api.quiva.ai';

export class QuivaClient {
  constructor({ apiUrl, apiKey = '', bearerToken = '', email = '', password = '', account = '' } = {}) {
    this.baseUrl = (apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.bearerToken = bearerToken;
    this.email = email;
    this.password = password;
    this.account = account;
    this.sessionToken = null;
  }

  // Stdio entrypoints only; in-process composition passes explicit options.
  static fromEnv(env = process.env) {
    return new QuivaClient({
      apiUrl: env.QUIVA_API_URL,
      apiKey: env.QUIVA_API_KEY,
      bearerToken: env.QUIVA_BEARER_TOKEN,
      email: env.QUIVA_EMAIL,
      password: env.QUIVA_PASSWORD,
      account: env.QUIVA_ACCOUNT,
    });
  }

  hasCredentials() {
    return Boolean(this.apiKey || this.bearerToken || (this.email && this.password));
  }

  async login() {
    if (!this.email || !this.password) {
      throw new Error('No credentials configured. Set QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL + QUIVA_PASSWORD.');
    }
    const body = { email: this.email, password: this.password };
    if (this.account) body.account = this.account;
    const res = await fetch(`${this.baseUrl}/accounts/auth-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseBody(res);
    if (!res.ok) throw new Error(`Login failed (${res.status}): ${extractError(data)}`);
    const token = data?.data?.auth_token ?? data?.body?.data?.auth_token ?? data?.auth_token;
    if (!token) throw new Error('Login succeeded but the response carried no auth_token.');
    this.sessionToken = token;
    return token;
  }

  async authHeaders() {
    if (this.apiKey) return { 'X-Api-Key': this.apiKey };
    if (this.bearerToken) return { Authorization: `Bearer ${this.bearerToken}` };
    if (!this.sessionToken) await this.login();
    return { Authorization: `Bearer ${this.sessionToken}` };
  }

  async request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const doFetch = async () => {
      const headers = { ...(await this.authHeaders()) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      return fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    };
    let res = await doFetch();
    // A session JWT may have expired: re-login once.
    if (res.status === 401 && !this.apiKey && !this.bearerToken && this.email) {
      this.sessionToken = null;
      res = await doFetch();
    }
    const data = await parseBody(res);
    const inner = unwrapEnvelope(data);
    // hub-service can carry an error status inside a 200 envelope.
    const status = envelopeStatus(data) ?? res.status;
    if (!res.ok || status >= 400) {
      const err = new Error(`${method} ${path} failed (${status}): ${extractError(data)}`);
      err.status = status;
      err.body = inner;
      throw err;
    }
    return inner;
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }
  post(path, body, query) {
    return this.request('POST', path, { body, query });
  }
  put(path, body, query) {
    return this.request('PUT', path, { body, query });
  }
  delete(path, query) {
    return this.request('DELETE', path, { query });
  }
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isEnvelope(data) {
  return data && typeof data === 'object' && !Array.isArray(data) && 'body' in data && 'status_code' in data;
}

// hub-service wraps every response as { status_code, body } (hub-service/response/response.go).
export function unwrapEnvelope(data) {
  return isEnvelope(data) ? data.body : data;
}

function envelopeStatus(data) {
  return isEnvelope(data) && typeof data.status_code === 'number' ? data.status_code : null;
}

function extractError(data) {
  if (data == null) return 'no response body';
  if (typeof data === 'string') return data.slice(0, 500);
  const msg = data.error ?? data.message ?? data.body?.error ?? data.body?.message;
  return typeof msg === 'string' ? msg : JSON.stringify(data).slice(0, 500);
}
