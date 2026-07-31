// HTTP client for the Quiva Workspaces API (workspaces-service, /workspaces/*).
//
// Auth precedence (first one configured wins):
//   1. QUIVA_API_KEY      -> X-Api-Key header
//   2. QUIVA_BEARER_TOKEN -> Authorization: Bearer
//   3. QUIVA_EMAIL + QUIVA_PASSWORD (+ optional QUIVA_ACCOUNT)
//      -> POST /accounts/auth-with-password, JWT cached, re-login once on 401.
//
// Auth reality (workspaces-service/handler/*.go): the core space/task/comment
// CRUD works with an API key alone, but user-attribution fields (owner,
// created_by, comment author, comment reactions) are only populated when a
// Bearer JWT is present — the handlers read the user id from the token and
// silently skip attribution when it is missing. A few endpoints not exposed
// here (my-tasks, watch/mute, export) are hard 401 without a JWT. Prefer a
// bearer token or email/password so attribution and reactions work.

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

  // request('POST', '/workspaces/space', { body: {...} })
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
    return unwrapEnvelope(data);
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }
  post(path, body, query) {
    return this.request('POST', path, { body, query });
  }
  // Spaces, tasks, and comments are updated with PATCH (not PUT) — the
  // workspaces-service update handlers are registered under the `patch` route
  // group. Space/comment updates are a partial merge over the event stream;
  // task update is a DeepMerge of the fields you send.
  patch(path, body, query) {
    return this.request('PATCH', path, { body, query });
  }
  // PUT is the odd one out: only the task-action and task-event-schedule routes
  // use it (service/service.go "put" group). Task actions are a create-OR-update
  // upsert on that single verb — there is no separate POST.
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

// workspaces-service wraps every response in { status_code, body }. When the
// gateway passes that envelope straight through, unwrap it so tools return the
// inner payload directly. If the shape is anything else, return it untouched.
function unwrapEnvelope(data) {
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    'body' in data &&
    'status_code' in data
  ) {
    return data.body;
  }
  return data;
}

function extractError(data) {
  if (data == null) return 'no response body';
  if (typeof data === 'string') return data.slice(0, 500);
  const msg = data.error ?? data.message ?? data.body?.error ?? data.body?.message;
  return typeof msg === 'string' ? msg : JSON.stringify(data).slice(0, 500);
}
