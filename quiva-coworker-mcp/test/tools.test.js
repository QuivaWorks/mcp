// Tool-level refusal tests against a fake client: every guard must refuse before any write is sent.
import assert from 'node:assert/strict';
import { registerTools, instructions } from '../src/index.js';
import { QuivaClient, unwrapEnvelope } from '../src/client.js';

let failures = 0;
let count = 0;
async function check(name, fn) {
  count++;
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}

// Records every call; `reads` maps "METHOD path" to a response or a function of (query, body).
function fakeClient(reads = {}) {
  const calls = [];
  const respond = (method, path, query, body) => {
    calls.push({ method, path, query, body });
    const r = reads[`${method} ${path}`];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(query, body) : r ?? {};
  };
  return {
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    get: async (p, q) => respond('GET', p, q),
    post: async (p, b, q) => respond('POST', p, q, b),
    put: async (p, b, q) => respond('PUT', p, q, b),
    delete: async (p, q) => respond('DELETE', p, q),
  };
}

function harness(reads) {
  const tools = {};
  const server = { registerTool: (name, meta, fn) => (tools[name] = { meta, fn }) };
  const client = fakeClient(reads);
  registerTools(server, client);
  const call = async (name, args) => {
    const res = await tools[name].fn(args);
    const text = res.content[0].text;
    return res.isError ? { isError: true, text } : JSON.parse(text);
  };
  return { tools, client, call };
}

const todos = (status) => ({ items: [{ id: 't1', scope: 'user', status, content: 'Chase the report' }], count: 1 });

await check('registers the expected tools, with a prefix', async () => {
  const names = [];
  registerTools({ registerTool: (n) => names.push(n) }, fakeClient(), { prefix: 'coworker_' });
  for (const t of ['coworker_list_todos', 'coworker_update_org_profile', 'coworker_set_env', 'coworker_list_corrections']) {
    assert.ok(names.includes(t), t);
  }
  assert.ok(!names.some((n) => n.includes('todos_admin')), 'todos-admin must stay out');
  assert.ok(!names.some((n) => n.includes('invoke')), 'chat must stay out');
});

await check('instructions name Abbie', async () => assert.ok(instructions.includes('Abbie')));

// update_todo resume guard
await check('awaiting_user -> pending is refused without confirm', async () => {
  const h = harness({ 'GET /hub/coworker/todos': todos('awaiting_user') });
  const r = await h.call('update_todo', { scope: 'user', id: 't1', status: 'pending' });
  assert.equal(r.refused, true);
  assert.equal(r.needs_confirm, true);
  assert.equal(h.client.writes().length, 0);
});
await check('awaiting_user -> in_progress is refused without confirm', async () => {
  const h = harness({ 'GET /hub/coworker/todos': todos('awaiting_user') });
  assert.equal((await h.call('update_todo', { scope: 'user', id: 't1', status: 'in_progress' })).refused, true);
});
await check('awaiting_user -> pending goes through with confirm', async () => {
  const h = harness({ 'PUT /hub/coworker/todo': { id: 't1', status: 'pending' } });
  const r = await h.call('update_todo', { scope: 'user', id: 't1', status: 'pending', confirm: true });
  assert.equal(r.status_verified, true);
  assert.equal(h.client.writes().length, 1);
});
await check('a failed status read refuses rather than guessing', async () => {
  const h = harness({ 'GET /hub/coworker/todos': new Error('502') });
  const r = await h.call('update_todo', { scope: 'user', id: 't1', status: 'pending' });
  assert.equal(r.refused, true);
  assert.equal(h.client.writes().length, 0);
});
await check('pending -> in_progress needs no confirm', async () => {
  const h = harness({ 'GET /hub/coworker/todos': todos('pending'), 'PUT /hub/coworker/todo': { id: 't1', status: 'in_progress' } });
  const r = await h.call('update_todo', { scope: 'user', id: 't1', status: 'in_progress' });
  assert.equal(r.refused, undefined);
  assert.equal(h.client.writes().length, 1);
});
await check('the guard matches on scope as well as id', async () => {
  const h = harness({ 'GET /hub/coworker/todos': todos('awaiting_user'), 'PUT /hub/coworker/todo': { id: 't1', status: 'pending' } });
  const r = await h.call('update_todo', { scope: 'organisation', id: 't1', status: 'pending' });
  assert.equal(r.refused, undefined);
});
await check('follow_up_at without awaiting_user is refused locally', async () => {
  const h = harness();
  const r = await h.call('update_todo', { scope: 'user', id: 't1', follow_up_at: '2026-10-01T09:00:00Z' });
  assert.equal(r.refused, true);
  assert.equal(h.client.calls.length, 0);
});
await check('promote surfaces a half-done promotion', async () => {
  const h = harness({ 'POST /hub/coworker/todo/promote/task': { task: { id: 'OPS-1' }, error: 'workspace task created but the todo item could not be updated' } });
  const r = await h.call('promote_todo_to_task', { scope: 'user', id: 't1' });
  assert.ok(r.warning);
});

// Confirm gates on account-wide writes
const gated = [
  ['create_memory', { scope: 'organisation', memory: 'Month-end close finishes on day three.' }],
  ['update_memory', { scope: 'organisation', id: 'm1', memory: 'x', topics: [] }],
  ['delete_memory', { scope: 'organisation', id: 'm1' }],
  ['update_org_profile', { what_we_do: 'We build scheduling software.' }],
  ['set_task_space', { space_id: 'OPS' }],
  ['set_env', { scope: 'organisation', key: 'REPORT_TIMEZONE', value: 'Europe/London', secret: false }],
  ['delete_env', { scope: 'organisation', key: 'REPORT_TIMEZONE' }],
];
for (const [name, args] of gated) {
  await check(`${name} refuses an account-wide write without confirm`, async () => {
    const h = harness();
    const r = await h.call(name, args);
    assert.equal(r.refused, true, JSON.stringify(r));
    assert.equal(r.needs_confirm, true);
    assert.equal(h.client.calls.length, 0, 'nothing may be sent, not even a read');
  });
}
await check('user-scope memory needs no confirm', async () => {
  const h = harness({
    'POST /hub/coworker/org-memory': { id: 'm1', memory: 'I prefer short answers.' },
    'GET /hub/coworker/org-memories': { memories: [{ id: 'm1', memory: 'I prefer short answers.', topics: [] }], total: 1 },
  });
  const r = await h.call('create_memory', { scope: 'user', memory: 'I prefer short answers.' });
  assert.equal(r.verified, true);
  assert.deepEqual(h.client.writes()[0].query, { scope: 'user' });
});
await check('org memory with confirm is sent with scope=organisation', async () => {
  const h = harness({
    'POST /hub/coworker/org-memory': { id: 'm2', memory: 'Fact' },
    'GET /hub/coworker/org-memories': { memories: [{ id: 'm2', memory: 'Fact', topics: [] }] },
  });
  await h.call('create_memory', { scope: 'organisation', memory: 'Fact', confirm: true });
  assert.equal(h.client.writes()[0].query.scope, 'organisation');
});
await check('a scope typo is refused, never widened', async () => {
  const h = harness();
  const r = await h.call('create_memory', { scope: 'personal', memory: 'x' });
  assert.equal(r.refused, true);
  assert.equal(h.client.calls.length, 0);
});
await check('update_memory keeps stored topics when none are sent', async () => {
  const stored = { id: 'm1', memory: 'old', topics: ['finance'] };
  const h = harness({
    'GET /hub/coworker/org-memories': (q) => ({ memories: [stored] }),
    'PUT /hub/coworker/org-memory/m1': (q, b) => Object.assign(stored, b),
  });
  await h.call('update_memory', { scope: 'user', id: 'm1', memory: 'new' });
  assert.deepEqual(h.client.writes()[0].body.topics, ['finance']);
});

// Empty-profile refusal
await check('update_personal_profile refuses a result that would be empty', async () => {
  const h = harness({ 'GET /hub/coworker/personal-profile': { about_me: '', how_i_work: '', constraints: '', revision: 3 } });
  const r = await h.call('update_personal_profile', { about_me: '   ' });
  assert.equal(r.refused, true);
  assert.equal(h.client.writes().length, 0);
});
await check('update_personal_profile merges and sends if_revision', async () => {
  let stored = { about_me: 'I run the operations team.', how_i_work: '', constraints: 'No meetings on Fridays.', revision: 7 };
  const h = harness({
    'GET /hub/coworker/personal-profile': () => stored,
    'PUT /hub/coworker/personal-profile': (q, b) => (stored = { ...b, revision: 8 }),
  });
  const r = await h.call('update_personal_profile', { how_i_work: 'Answer first, detail after.' });
  const sent = h.client.writes()[0].body;
  assert.equal(sent.if_revision, 7);
  assert.equal(sent.about_me, 'I run the operations team.');
  assert.equal(sent.constraints, 'No meetings on Fridays.');
  assert.equal(r.verified, true);
});
await check('update_org_profile refuses a result that would be empty, even with confirm', async () => {
  const h = harness({ 'GET /hub/coworker/profile': { is_default: true, revision: 1 } });
  const r = await h.call('update_org_profile', { legal_name: '', confirm: true });
  assert.equal(r.refused, true);
  assert.equal(h.client.writes().length, 0);
});
await check('update_org_profile refuses a blanks-only payload over an empty profile', async () => {
  const h = harness({ 'GET /hub/coworker/profile': { is_default: true, revision: 1, glossary: [], always: [] } });
  const r = await h.call('update_org_profile', { glossary: [{ term: ' ', meaning: '' }], always: ['  '], confirm: true });
  assert.equal(r.refused, true);
  assert.equal(h.client.writes().length, 0);
});
await check('update_org_profile sends blank list entries already dropped', async () => {
  let stored = { legal_name: 'Example Ltd', revision: 2 };
  const h = harness({
    'GET /hub/coworker/profile': () => stored,
    'PUT /hub/coworker/profile': (q, b) => (stored = { ...b, revision: 3 }),
  });
  const r = await h.call('update_org_profile', { always: [' Cite the source ', ''], confirm: true });
  assert.deepEqual(h.client.writes()[0].body.always, ['Cite the source']);
  assert.equal(r.verified, true);
});
await check('update_org_profile merges over the stored profile', async () => {
  let stored = { legal_name: 'Example Ltd', glossary: [], revision: 4, is_default: false };
  const h = harness({
    'GET /hub/coworker/profile': () => stored,
    'PUT /hub/coworker/profile': (q, b) => (stored = { ...b, revision: 5 }),
  });
  await h.call('update_org_profile', { timezone: 'Europe/London', confirm: true });
  const sent = h.client.writes()[0].body;
  assert.equal(sent.legal_name, 'Example Ltd');
  assert.equal(sent.if_revision, 4);
  assert.equal('is_default' in sent, false);
});

// Corrections cap
const existing = [1, 2, 3, 4, 5].map((n) => ({ id: `c_${n}`, situation: `s${n}`, instead: `i${n}`, source: 'manual' }));
await check('adding past the corrections cap is refused', async () => {
  const h = harness({ 'GET /hub/coworker/corrections': { corrections: existing, max_entries: 6 } });
  const r = await h.call('update_corrections', { add: [{ situation: 'a', instead: 'b' }, { situation: 'c', instead: 'd' }] });
  assert.equal(r.refused, true);
  assert.ok(r.reason.includes('at most 6'));
  assert.equal(h.client.writes().length, 0);
});
await check('remove then add stays within the cap', async () => {
  let stored = existing;
  const h = harness({
    'GET /hub/coworker/corrections': () => ({ corrections: stored }),
    'PUT /hub/coworker/corrections': (q, b) => (stored = b.corrections),
  });
  const r = await h.call('update_corrections', { remove: ['c_1'], add: [{ situation: 'a', instead: 'b' }, { situation: 'c', instead: 'd' }] });
  assert.equal(r.verified, true);
  assert.equal(h.client.writes()[0].body.corrections.length, 6);
});
await check('update_corrections refuses when the list moved before the PUT', async () => {
  let reads = 0;
  const h = harness({
    'GET /hub/coworker/corrections': () => ({ corrections: reads++ === 0 ? existing : [...existing, { id: 'c_9', situation: 'x', instead: 'y' }] }),
  });
  const r = await h.call('update_corrections', { add: [{ situation: 'a', instead: 'b' }] });
  assert.equal(r.refused, true);
  assert.ok(r.reason.includes('changed since'));
  assert.equal(h.client.writes().length, 0);
});
await check('removing an unknown correction id is refused', async () => {
  const h = harness({ 'GET /hub/coworker/corrections': { corrections: existing } });
  assert.equal((await h.call('update_corrections', { remove: ['c_99'] })).refused, true);
});

// SECRET::-only rule
await check('set_env refuses a credential literal before any call', async () => {
  const h = harness();
  const r = await h.call('set_env', { scope: 'user', key: 'SERVICE_API_KEY', value: 'plain-text', secret: false });
  assert.equal(r.refused, true);
  assert.equal(h.client.calls.length, 0);
});
await check('set_env refuses secret: true with a literal', async () => {
  const h = harness();
  assert.equal((await h.call('set_env', { scope: 'user', key: 'REGION', value: 'eu', secret: true })).refused, true);
});
await check('set_env creates with POST, then updates with PUT', async () => {
  let vars = [];
  const reads = {
    'GET /hub/coworker/env': () => ({ scope: 'user', vars }),
    'POST /hub/coworker/env': (q, b) => { vars = [{ ...b, secret: true }]; return vars[0]; },
    'PUT /hub/coworker/env': (q, b) => { vars = [{ ...b, secret: true }]; return vars[0]; },
  };
  const h = harness(reads);
  const args = { scope: 'user', key: 'SERVICE_API_KEY', value: 'SECRET::service_key::', secret: true, description: 'Service key' };
  const a = await h.call('set_env', args);
  const b = await h.call('set_env', { ...args, value: 'SECRET::service_key_v2::', description: undefined });
  assert.equal(a.action, 'created');
  assert.equal(b.action, 'updated');
  assert.equal(b.verified, true);
  assert.equal(h.client.writes()[1].body.description, 'Service key', 'description kept on update');
});

// Client
await check('client defaults to production', async () => {
  assert.equal(new QuivaClient().baseUrl, 'https://api.quiva.ai');
  assert.equal(QuivaClient.fromEnv({}).baseUrl, 'https://api.quiva.ai');
});
await check('client unwraps the hub envelope', async () => {
  assert.deepEqual(unwrapEnvelope({ status_code: 200, body: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapEnvelope({ a: 1 }), { a: 1 });
});
await check('client treats an error status inside a 200 envelope as a failure', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status_code: 403, body: { error: 'admin role required' } }), { status: 200 });
  try {
    const c = new QuivaClient({ apiKey: 'k' });
    await assert.rejects(c.get('/hub/coworker/profile'), /403.*admin role required/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${count - failures}/${count} checks passed`);
if (failures) process.exit(1);
