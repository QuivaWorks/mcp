// Local pre-checks for Abbie settings writes. Limits mirror hub-service; each cites its source.
// Every check returns { valid, errors, warnings } and never calls the API.

export const SCOPES = ['organisation', 'user'];
export const TODO_STATUSES = ['pending', 'in_progress', 'done', 'awaiting_user', 'cancelled'];
export const CORRECTIONS_MAX_ENTRIES = 6;

const runes = (s) => [...String(s ?? '')].length;
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const result = (errors, warnings = []) => ({ valid: errors.length === 0, errors, warnings });

// Refusal returned by a tool instead of sending the request.
export function refusal(reason, extra = {}) {
  return { refused: true, reason, ...extra };
}

// The server widens any scope other than exactly "user" (memory, env) or
// "organisation" (todos) silently, so scope is checked here and never defaulted.
export function checkScope(scope) {
  return SCOPES.includes(scope) ? null : `scope must be "organisation" or "user" (got ${JSON.stringify(scope)})`;
}

// Writes that change Abbie's behaviour for everyone in the account.
export function confirmGate({ confirm, what }) {
  if (confirm === true) return null;
  return refusal(
    `${what} changes Abbie's behaviour for everyone in the account. Re-send with confirm: true once the user has agreed.`,
    { needs_confirm: true }
  );
}

// hub-service/handler/coworker_todo_work.go coworkerTodoUnparks.
export function todoResumesRun(beforeStatus, nextStatus) {
  return beforeStatus === 'awaiting_user' && (nextStatus === 'pending' || nextStatus === 'in_progress');
}

// hub-service/handler/coworker_todo.go PutCoworkerTodoHandler.
export function checkTodoUpdate(body = {}) {
  const errors = [];
  const scopeErr = checkScope(body.scope);
  if (scopeErr) errors.push(scopeErr);
  if (!str(body.id)) errors.push('id is required');
  if (body.status !== undefined && !TODO_STATUSES.includes(body.status)) {
    errors.push(`status must be one of ${TODO_STATUSES.join(', ')}`);
  }
  const fields = ['status', 'content', 'details', 'follow_up_at'];
  if (!fields.some((f) => body[f] !== undefined) && body.acknowledge !== true) {
    errors.push('at least one of status, content, details, follow_up_at, acknowledge is required');
  }
  if (str(body.follow_up_at) && body.status !== 'awaiting_user') {
    errors.push('follow_up_at must be sent together with status "awaiting_user"');
  }
  return result(errors);
}

// hub-service/handler/org_memory.go validateOrgMemoryInput (lengths are bytes there).
export function checkMemory(body = {}) {
  const errors = [];
  const scopeErr = checkScope(body.scope);
  if (scopeErr) errors.push(scopeErr);
  if (!str(body.memory)) errors.push('memory is required');
  else if (bytes(body.memory) > 2048) errors.push('memory must be 2048 bytes or fewer');
  const topics = body.topics ?? [];
  if (!Array.isArray(topics)) errors.push('topics must be an array of strings');
  else {
    if (topics.length > 10) errors.push('at most 10 topics are allowed');
    for (const t of topics) {
      if (!str(t)) errors.push('topics must not contain empty strings');
      else if (bytes(t) > 64) errors.push(`topic "${t}" must be 64 bytes or fewer`);
    }
  }
  return result(errors);
}

export const PERSONAL_PROFILE_FIELDS = ['about_me', 'how_i_work', 'constraints'];

export function isPersonalProfileEmpty(p = {}) {
  return PERSONAL_PROFILE_FIELDS.every((f) => !str(p[f]));
}

// hub-service/handler/coworker_personal_profile.go: 1000 runes per field, 3000 in total.
export function checkPersonalProfile(p = {}) {
  const errors = [];
  let total = 0;
  for (const f of PERSONAL_PROFILE_FIELDS) {
    const n = runes(str(p[f]));
    total += n;
    if (n > 1000) errors.push(`${f} must be 1000 characters or fewer (got ${n})`);
  }
  if (total > 3000) errors.push(`the whole personal profile must be 3000 characters or fewer (got ${total})`);
  if (isPersonalProfileEmpty(p)) {
    errors.push('refusing to save an empty personal profile: it would clear what Abbie knows about you. Clear it in the app if that is intended.');
  }
  return result(errors);
}

const ORG_SCALARS = {
  legal_name: 500, what_we_do: 1000, industry: 200, regulator: 500, size: 200, locations: 500,
  financial_year_end: 100, working_hours: 300, timezone: 100, house_style: 1000, data_handling: 1000,
};
const ORG_LISTS = { trading_names: [10, 200], always: [20, 300], never: [20, 300] };
export const ORG_PROFILE_FIELDS = [...Object.keys(ORG_SCALARS), ...Object.keys(ORG_LISTS), 'systems_of_record', 'glossary'];

const ORG_PAIRS = { systems_of_record: [20, 'system', 200, 'authoritative_for', 300], glossary: [40, 'term', 100, 'meaning', 300] };

// hub-service/handler/coworker_profile.go capStringList/capSystemsOfRecord/capGlossary:
// list entries are trimmed and blank ones dropped before any cap or emptiness test.
export function normaliseOrgProfile(p = {}) {
  const out = { ...p };
  for (const f of Object.keys(ORG_LISTS)) {
    if (Array.isArray(p[f])) out[f] = p[f].map(str).filter(Boolean);
  }
  for (const [f, [, a, , b]] of Object.entries(ORG_PAIRS)) {
    if (!Array.isArray(p[f])) continue;
    out[f] = p[f]
      .map((e) => ({ ...e, [a]: str(e?.[a]), [b]: str(e?.[b]) }))
      .filter((e) => e[a] || e[b]);
  }
  return out;
}

// hub-service/handler/coworker_profile.go coworkerOrgProfileIsEmpty, tested after
// normalisation. The server stores a whitespace-only scalar as-is; it is treated as empty here.
export function isOrgProfileEmpty(p = {}) {
  const n = normaliseOrgProfile(p);
  return ORG_PROFILE_FIELDS.every((f) => (Array.isArray(n[f]) ? n[f].length === 0 : !str(n[f])));
}

// hub-service/handler/coworker_profile.go normaliseCoworkerOrgProfile caps. Scalars are not
// trimmed there, so their length counts as sent.
export function checkOrgProfile(p = {}) {
  const errors = [];
  let total = 0;
  for (const [f, max] of Object.entries(ORG_SCALARS)) {
    const n = runes(p[f]);
    total += n;
    if (n > max) errors.push(`${f} must be ${max} characters or fewer (got ${n})`);
  }
  for (const f of [...Object.keys(ORG_LISTS), ...Object.keys(ORG_PAIRS)]) {
    if (p[f] !== undefined && p[f] !== null && !Array.isArray(p[f])) {
      errors.push(`${f} must be an array of ${f in ORG_PAIRS ? 'objects' : 'strings'}`);
    }
  }
  const n = normaliseOrgProfile(p);
  for (const [f, [maxEntries, maxRunes]] of Object.entries(ORG_LISTS)) {
    const list = Array.isArray(n[f]) ? n[f] : [];
    if (list.length > maxEntries) errors.push(`${f} allows at most ${maxEntries} entries`);
    for (const v of list) {
      total += runes(v);
      if (runes(v) > maxRunes) errors.push(`each ${f} entry must be ${maxRunes} characters or fewer`);
    }
  }
  for (const [f, [maxEntries, a, aMax, b, bMax]] of Object.entries(ORG_PAIRS)) {
    const list = Array.isArray(n[f]) ? n[f] : [];
    if (list.length > maxEntries) errors.push(`${f} allows at most ${maxEntries} entries`);
    for (const e of list) {
      total += runes(e[a]) + runes(e[b]);
      if (runes(e[a]) > aMax) errors.push(`${f}[].${a} must be ${aMax} characters or fewer`);
      if (runes(e[b]) > bMax) errors.push(`${f}[].${b} must be ${bMax} characters or fewer`);
    }
  }
  if (total > 8000) errors.push(`the whole organisation profile must be 8000 characters or fewer (got ${total})`);
  if (isOrgProfileEmpty(p)) {
    errors.push('refusing to save an empty organisation profile (every value blank or missing): the server treats that as "clear it" for every member. Clear it in the app if that is intended.');
  }
  return result(errors);
}

// hub-service/handler/coworker_corrections.go normaliseCoworkerCorrections.
export function checkCorrections(list) {
  const errors = [];
  if (!Array.isArray(list)) return result(['corrections must be an array']);
  if (list.length > CORRECTIONS_MAX_ENTRIES) {
    errors.push(`at most ${CORRECTIONS_MAX_ENTRIES} corrections are kept (this change would leave ${list.length}). Remove one first.`);
  }
  const seen = new Set();
  list.forEach((c, i) => {
    if (!str(c?.situation)) errors.push(`corrections[${i}].situation is required`);
    else if (runes(str(c.situation)) > 150) errors.push(`corrections[${i}].situation must be 150 characters or fewer`);
    if (!str(c?.instead)) errors.push(`corrections[${i}].instead is required`);
    else if (runes(str(c.instead)) > 200) errors.push(`corrections[${i}].instead must be 200 characters or fewer`);
    if (c?.id) {
      if (seen.has(c.id)) errors.push(`corrections[${i}] repeats id "${c.id}"`);
      seen.add(c.id);
    }
  });
  return result(errors);
}

// coworkerenv/secretref.go SecretRefName: ^SECRET::([^:]+)::$ after trimming.
export function isSecretRef(value) {
  return /^SECRET::[^:]+::$/.test(str(value));
}

// Whole _-separated words only: a credential under an innocent key name is not caught.
const CREDENTIAL_WORDS = new Set([
  'KEY', 'APIKEY', 'TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'PWD', 'CREDENTIAL', 'CREDENTIALS',
  'AUTH', 'BEARER', 'DSN', 'ACCESS', 'SIGNING', 'PRIVATE', 'CERT', 'PAT',
]);
export const looksLikeCredentialKey = (key) => String(key).split('_').some((w) => CREDENTIAL_WORDS.has(w));

// A literal env value is shown to the model; only a SECRET:: reference is not (coworkerenv/coworkerenv.go).
export function checkEnvVar(body = {}) {
  const errors = [];
  const scopeErr = checkScope(body.scope);
  if (scopeErr) errors.push(scopeErr);
  const key = str(body.key);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || key.length > 64) {
    errors.push('key must match ^[A-Z_][A-Z0-9_]*$ and be 64 characters or fewer');
  }
  const value = str(body.value);
  if (!value) errors.push('value is required');
  const looksLikeRef = value.startsWith('SECRET::');
  if (typeof body.secret !== 'boolean') errors.push('secret (true or false) is required');
  if (body.secret === true && !isSecretRef(value)) {
    errors.push('a secret must be a SECRET::<name>:: reference to a stored secret, never the credential itself');
  }
  if (body.secret === false && looksLikeRef) {
    errors.push(isSecretRef(value) ? 'value is a SECRET:: reference, so set secret: true' : 'value looks like a malformed SECRET::<name>:: reference');
  }
  if (body.secret === false && !looksLikeRef && looksLikeCredentialKey(key)) {
    errors.push(`${key} looks like a credential. Literal values are shown to Abbie's model: store it as a secret and pass SECRET::<name>:: with secret: true`);
  }
  return result(errors);
}

export function validate(kind, payload) {
  switch (kind) {
    case 'todo_update': return checkTodoUpdate(payload);
    case 'memory': return checkMemory(payload);
    case 'personal_profile': return checkPersonalProfile(payload);
    case 'org_profile': return checkOrgProfile(payload);
    case 'corrections': return checkCorrections(payload?.corrections ?? payload);
    case 'env_var': return checkEnvVar(payload);
    default: return result([`unknown kind "${kind}"`]);
  }
}
