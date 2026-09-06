// HTTP client for the Quiva records API.
//
// Auth precedence (first one configured wins):
//   1. QUIVA_API_KEY      -> X-Api-Key header
//   2. QUIVA_BEARER_TOKEN -> Authorization: Bearer
//   3. QUIVA_EMAIL + QUIVA_PASSWORD (+ optional QUIVA_ACCOUNT)
//      -> POST /accounts/auth-with-password, JWT cached, re-login once on 401.
//
// Note: the records-service engine itself only reads Authorization: Bearer
// (and only on the query-records path, to derive the tenant); X-Api-Key is
// resolved by the API gateway in front of the service. All three options are
// supported here for parity with quiva-flows-mcp and because the gateway
// accepts them.

const DEFAULT_API_URL = 'https://api.microstrate.io';

export class QuivaClient {
  constructor(env = process.env) {
    this.baseUrl = (env.QUIVA_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
    this.apiKey = env.QUIVA_API_KEY || '';
    this.bearerToken = env.QUIVA_BEARER_TOKEN || '';
    this.email = env.QUIVA_EMAIL || '';
    this.password = env.QUIVA_PASSWORD || '';
    this.account = env.QUIVA_ACCOUNT || '';
    this.sessionToken = null; // JWT from auth-with-password
  }

  hasCredentials() {
    return Boolean(this.apiKey || this.bearerToken || (this.email && this.password));
  }

  async login() {
    if (!this.email || !this.password) {
      throw new Error(
        'No credentials configured. Set QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL + QUIVA_PASSWORD.'
      );
    }
    const body = { email: this.email, password: this.password };
    if (this.account) body.account = this.account;

    const res = await fetch(`${this.baseUrl}/accounts/auth-with-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseBody(res);
    if (!res.ok) {
      throw new Error(`Login failed (${res.status}): ${extractError(data)}`);
    }
    const token =
      data?.data?.auth_token ?? data?.body?.data?.auth_token ?? data?.auth_token;
    if (!token) {
      throw new Error(`Login succeeded but no auth_token in response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    this.sessionToken = token;
    return token;
  }

  async authHeaders() {
    if (this.apiKey) return { 'X-Api-Key': this.apiKey };
    if (this.bearerToken) return { Authorization: `Bearer ${this.bearerToken}` };
    if (!this.sessionToken) await this.login();
    return { Authorization: `Bearer ${this.sessionToken}` };
  }

  // request('POST', '/records/config', { body: {...} })
  async request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const doFetch = async () => {
      const headers = { ...(await this.authHeaders()) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      return fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };

    let res = await doFetch();

    // Session JWT may have expired — re-login once and retry.
    if (res.status === 401 && !this.apiKey && !this.bearerToken && this.email) {
      this.sessionToken = null;
      res = await doFetch();
    }

    const data = await parseBody(res);
    if (!res.ok) {
      const err = new Error(`${method} ${path} failed (${res.status}): ${extractError(data)}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }
  post(path, body, query) {
    return this.request('POST', path, { body, query });
  }
  // Records and record configs are updated with PUT (not PATCH). The service's
  // update handlers still merge partially (record data is merged key-by-key;
  // config fields are applied only when present) — the method is PUT, the
  // semantics are a partial update.
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

function extractError(data) {
  if (data == null) return 'no response body';
  if (typeof data === 'string') return data.slice(0, 500);
  const msg = data.error ?? data.message ?? data.body?.error ?? data.body?.message;
  return typeof msg === 'string' ? msg : JSON.stringify(data).slice(0, 500);
}
