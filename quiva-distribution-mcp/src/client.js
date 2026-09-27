// HTTP client for the Quiva distribution API (accounts-service, /accounts/*).
// Auth, first configured wins: QUIVA_API_KEY, QUIVA_BEARER_TOKEN, then QUIVA_EMAIL + QUIVA_PASSWORD login (re-login once on 401).

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

  // Stdio entrypoints build a client from the environment; in-process hosts pass options.
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

  // GET parameters must travel in the query string: the handlers read
  // x-param-query-<name> first (accounts-service/accounts/distributionregister.go distributionParam).
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
    if (res.status === 401 && !this.apiKey && !this.bearerToken && this.email) {
      this.sessionToken = null;
      res = await doFetch();
    }

    const data = unwrapEnvelope(await parseBody(res));
    if (!res.ok) {
      const err = new Error(`${method} ${path} failed (${res.status}): ${extractError(data)}`);
      err.status = res.status;
      err.body = data;
      const refusal = refusalOf(data);
      if (refusal) err.refusal = refusal;
      if (res.status === 401) err.message += ' — a role gate also answers 401, so a valid credential with too low a role reads the same as a bad one.';
      throw err;
    }
    return unwrapData(data);
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }
  post(path, body, query) {
    return this.request('POST', path, { body, query });
  }
  patch(path, body, query) {
    return this.request('PATCH', path, { body, query });
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

// The service answers { status_code, body }; the gateway usually strips it to the body.
export function unwrapEnvelope(data) {
  if (data && typeof data === 'object' && !Array.isArray(data) && 'body' in data && 'status_code' in data) {
    return data.body;
  }
  return data;
}

// Success bodies are { message?, data }. Keep a non-empty message: it can carry a warning.
export function unwrapData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !('data' in data)) return data;
  const inner = data.data;
  const message = typeof data.message === 'string' ? data.message : '';
  if (!message) return inner;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return { ...inner, message };
  return { result: inner, message };
}

// A named refusal is { data: { status: "refused", refusal_code, detail, ... } } with 403/404/409.
export function refusalOf(data) {
  const inner = data?.data ?? data;
  if (inner && typeof inner === 'object' && inner.status === 'refused' && inner.refusal_code) return inner;
  return null;
}

export function extractError(data) {
  if (data == null) return 'no response body';
  if (typeof data === 'string') return data.slice(0, 500);
  const refusal = refusalOf(data);
  if (refusal) return `refused (${refusal.refusal_code}): ${refusal.detail ?? ''}`.trim();
  const msg = data.error ?? data.message ?? data.body?.error ?? data.body?.message;
  return typeof msg === 'string' ? msg : JSON.stringify(data).slice(0, 500);
}
