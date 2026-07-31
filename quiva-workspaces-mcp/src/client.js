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

import { createHash } from 'node:crypto';

const DEFAULT_API_URL = 'https://api.microstrate.io';

// The object store that backs space FILES lives at a DIFFERENT URL root from
// /workspaces/*, and it is absent from the gateway route registry
// (specs/openapi/quiva-endpoints.json), so it cannot be discovered from there —
// it was found by reading what the UI calls
// (microstrate/src/services/api/storage/storage.api.ts downloadFileBinary /
// uploadObjFileBinary). Read and write share one root and differ only by method:
//
//   GET  {base}/api/default-storage/object/{bucket}/{key}  -> the raw bytes
//   POST {base}/api/default-storage/object/{bucket}/{key}  -> { name, size, digest, ... }
//
// Verified live 2026-07-31: an API key is sufficient for both, and the write
// response carries a `digest` over the exact bytes stored (see digestMatches
// below for its encoding), so a write can be integrity-checked without a second
// round trip. Reading the file back is still the stronger check.
//
// Neither response is wrapped in the workspaces `{ status_code, body }` envelope,
// and a read returns file content rather than JSON — so these bypass both
// parseBody and unwrapEnvelope.
const OBJECT_ROOT = '/api/default-storage/object';

// Bucket holding every space's files. workspaces-service/data/const.go
// WorkspacesObjectStoreBucketName.
export const WORKSPACES_BUCKET = 'microstrate-workspaces';

// The write response carries `digest: "SHA-256=<hash>"`. The hash uses the
// BASE64URL alphabet (`-` and `_`, not `+` and `/`) with padding retained.
//
// This was very nearly wrong: the first digest compared during development
// happened to contain neither `+` nor `/`, so a plain-base64 comparison matched
// and read as proof that the encoding was standard base64. The second file
// hashed to a value containing a `/` and the check failed. So both sides are
// NORMALISED here — alphabet folded and padding stripped — rather than trusting
// either encoding. A comparison that can pass for the wrong reason is not a check.
export function sha256OfContent(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return createHash('sha256').update(buf).digest('base64');
}

function normaliseDigest(value) {
  return String(value ?? '')
    .replace(/^SHA-256=/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Does `returned` (the store's digest string) describe exactly these bytes?
export function digestMatches(content, returned) {
  const expected = normaliseDigest(sha256OfContent(content));
  return expected !== '' && normaliseDigest(returned) === expected;
}

// The digest string as the store would express it, for diagnostics.
export function expectedDigestString(content) {
  return 'SHA-256=' + sha256OfContent(content).replace(/\+/g, '-').replace(/\//g, '_');
}

// A file-index entry's `name` can be EMPTY while its `subject` is correct —
// observed live 2026-07-31 on all twelve folder markers in the VERTICAL space
// after the #1291 marker rename rolled through, while markers created natively by
// the new code kept their name. This is a known state, not a surprise: the engine
// itself falls back to decoding the subject in exactly this case
// (workspaces-service DeleteFolderHandler -> transform.ObjKeyUnsafe). So the
// SUBJECT is the authoritative key and `name` is a convenience.
//
// Subject shape: `ms.workspace-files.<b64seg>.<b64seg>...`, one segment per path
// segment, base64 RawStdEncoding (standard alphabet, NO padding). A segment that
// does not decode is passed through verbatim — mirroring util.ObjKeyUnsafe.
const FILE_SUBJECT_PREFIX = 'ms.workspace-files.';

export function decodeFileKey(subject) {
  if (typeof subject !== 'string' || subject === '') return '';
  const body = subject.startsWith(FILE_SUBJECT_PREFIX) ? subject.slice(FILE_SUBJECT_PREFIX.length) : subject;
  return body
    .split('.')
    .map((part) => {
      try {
        const decoded = Buffer.from(part, 'base64');
        // Node's base64 decoder is lenient, so round-trip to decide whether the
        // segment really was base64 — Go returns the raw part on a decode error.
        if (decoded.toString('base64').replace(/=+$/, '') !== part) return part;
        return decoded.toString('utf8');
      } catch {
        return part;
      }
    })
    .join('.');
}

// The key of a file-index entry, preferring `name` and falling back to the subject.
export function fileKeyOf(entry) {
  return entry?.name && entry.name !== '' ? entry.name : decodeFileKey(entry?.subject);
}

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

  // --- Object store (space files) ------------------------------------------
  // Keys are dotted paths: `spaces.<SPACE_ID>.<folder>...<name>.<ext>`. The key
  // is percent-encoded because live keys DO contain spaces — the alex-test
  // templates write `spaces.FAHUB.<Owner Name>.<file>.pdf`. encodeURIComponent
  // leaves `.`, `-`, `_` and `~` alone, so a normal dotted key is unchanged.
  objectUrl(bucket, key) {
    return `${this.baseUrl}${OBJECT_ROOT}/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
  }

  // Read one object's bytes. Returns { key, bucket, bytes, encoding, content }:
  // text for JSON/markdown/plain keys, base64 otherwise (a vertical
  // document_templates folder holds .docx).
  async readObject(bucket, key) {
    const res = await fetch(this.objectUrl(bucket, key), { headers: await this.authHeaders() });
    if (!res.ok) {
      const data = await parseBody(res);
      const err = new Error(`GET object ${key} failed (${res.status}): ${extractError(data)}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const textual = /\.(json|md|txt|csv|ya?ml|html?|svg)$/i.test(key);
    return {
      bucket,
      key,
      bytes: buf.length,
      encoding: textual ? 'utf8' : 'base64',
      content: textual ? buf.toString('utf8') : buf.toString('base64'),
    };
  }

  // Write one object. `content` is a string (utf8) or a Buffer. Returns the
  // storage entry, whose `digest` proves what landed.
  async writeObject(bucket, key, content) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const res = await fetch(this.objectUrl(bucket, key), {
      method: 'POST',
      body,
      // The UI sends application/json regardless of the payload, and the store
      // does not inspect it — it stores the bytes as given.
      headers: { 'Content-Type': 'application/json', ...(await this.authHeaders()) },
    });
    const data = await parseBody(res);
    if (!res.ok) {
      const err = new Error(`POST object ${key} failed (${res.status}): ${extractError(data)}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
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
