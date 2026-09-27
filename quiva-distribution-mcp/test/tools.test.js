// Every tool against a stub client and server: routes, query params, confirm gates. No network.
import assert from 'node:assert/strict';
import { registerTools, instructions } from '../src/index.js';
import { QuivaClient, unwrapData, unwrapEnvelope, refusalOf, extractError } from '../src/client.js';

let failures = 0;
const pending = [];
// Run in order: two checks swap globalThis.fetch.
function check(name, fn) {
  pending.push({ name, fn });
}

function refusal(status, code) {
  const err = new Error(`refused ${code}`);
  err.status = status;
  err.refusal = { status: 'refused', refusal_code: code, detail: 'x' };
  return err;
}

// responder(method, path, arg) returns a value or throws.
function harness(responder = () => ({})) {
  const calls = [];
  const client = {};
  for (const m of ['get', 'post', 'patch', 'delete']) {
    client[m] = async (path, arg) => {
      calls.push({ method: m.toUpperCase(), path, arg });
      return responder(m.toUpperCase(), path, arg);
    };
  }
  const tools = {};
  const server = { registerTool: (name, _meta, fn) => (tools[name] = fn) };
  registerTools(server, client);
  const call = async (name, args) => {
    const res = await tools[name](args);
    const text = res.content[0].text;
    return { isError: Boolean(res.isError), text, data: res.isError ? null : JSON.parse(text) };
  };
  return { calls, tools, call };
}

const EXPECTED = [
  'list_reference_topics', 'get_distribution_reference', 'list_examples', 'get_example', 'validate_payload',
  'list_distributions', 'get_distribution', 'get_distribution_status', 'amend_distribution',
  'list_products', 'get_product', 'create_product', 'update_product', 'list_granted_products',
  'list_product_definition_versions', 'list_distribution_invites', 'list_invite_inbox', 'withdraw_distribution_invite',
];

check('registers exactly the expected tools', () => {
  assert.deepEqual(Object.keys(harness().tools).sort(), [...EXPECTED].sort());
});

check('prefix is applied to every tool', () => {
  const names = [];
  registerTools({ registerTool: (n) => names.push(n) }, {}, { prefix: 'dist_' });
  assert.ok(names.length === EXPECTED.length && names.every((n) => n.startsWith('dist_')));
});

check('instructions carry the gotchas', () => assert.ok(instructions.includes('401') && instructions.includes('terminal')));

check('list_distributions sends side only for distributor', async () => {
  const h = harness();
  await h.call('list_distributions', {});
  await h.call('list_distributions', { side: 'distributor' });
  assert.deepEqual(h.calls.map((c) => c.arg.side), [undefined, 'distributor']);
  assert.ok(h.calls.every((c) => c.path === '/accounts/distributions' && c.method === 'GET'));
});

check('get_distribution needs exactly one counterparty', async () => {
  const h = harness();
  assert.ok((await h.call('get_distribution', {})).isError);
  assert.ok((await h.call('get_distribution', { publisher_account_id: 'a', distributor_account_id: 'b' })).isError);
  assert.equal(h.calls.length, 0);
  await h.call('get_distribution', { publisher_account_id: 'a', product_id: 'p' });
  assert.deepEqual(h.calls[0].arg, { distributor_account_id: undefined, publisher_account_id: 'a', product_id: 'p' });
});

check('get_distribution_status notes an incomplete result', async () => {
  const h = harness(() => ({ complete: false, missing: ['distribution_record_present'] }));
  const r = await h.call('get_distribution_status', { account_id: 'x' });
  assert.ok(r.data.note.includes('No grant exists'));
});

check('amend_distribution sends nothing without confirm', async () => {
  const h = harness();
  const r = await h.call('amend_distribution', { amendment: { distributor_account_id: 'd', status: 'revoked' } });
  assert.equal(r.data.sent, false);
  assert.ok(r.data.reason.includes('never be undone'));
  assert.equal(h.calls.length, 0);
});

check('amend_distribution refuses an invalid body before any call', async () => {
  const h = harness();
  const r = await h.call('amend_distribution', { amendment: { distributor_account_id: 'd' }, confirm: true });
  assert.equal(r.data.sent, false);
  assert.equal(h.calls.length, 0);
});

check('amend_distribution refuses a transition out of revoked without writing', async () => {
  const h = harness(() => ({ distribution: { status: 'revoked' } }));
  const r = await h.call('amend_distribution', { amendment: { distributor_account_id: 'd', status: 'active' }, confirm: true });
  assert.equal(r.data.sent, false);
  assert.ok(!h.calls.some((c) => c.method === 'PATCH'));
});

check('amend_distribution refuses an unpublished product unless allowed', async () => {
  const responder = (m, p) => {
    if (p === '/accounts/distribution-product') throw refusal(404, 'product_not_found');
    return { distribution: { status: 'active' } };
  };
  const body = { amendment: { distributor_account_id: 'd', grant_products: [{ product_id: 'x' }] }, confirm: true };
  const h = harness(responder);
  assert.equal((await h.call('amend_distribution', body)).data.sent, false);
  assert.ok(!h.calls.some((c) => c.method === 'PATCH'));
  const h2 = harness(responder);
  await h2.call('amend_distribution', { ...body, allow_unpublished_products: true });
  assert.ok(h2.calls.some((c) => c.method === 'PATCH'));
});

check('amend_distribution PATCHes the body without confirm', async () => {
  const h = harness(() => ({ distribution: { status: 'active' } }));
  await h.call('amend_distribution', { amendment: { distributor_account_id: 'd', status: 'suspended', confirm: true }, confirm: true });
  const patch = h.calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.path, '/accounts/distribution');
  assert.deepEqual(patch.arg, { distributor_account_id: 'd', status: 'suspended' });
});

const goodProduct = { code: 'p', name: 'P', record_configs: [{ id: 'r', label: 'R' }], actions: { r: [{ type: 'create' }] } };

check('create_product validates locally first', async () => {
  const h = harness();
  const r = await h.call('create_product', { product: { code: 'p' } });
  assert.equal(r.data.published, false);
  assert.equal(h.calls.length, 0);
});

check('create_product posts, then reads the version back', async () => {
  const h = harness((m) => (m === 'POST' ? { code: 'p', version: 1 } : { code: 'p', product: { version: 1 }, versions: [1] }));
  const r = await h.call('create_product', { product: goodProduct });
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.path}`), ['POST /accounts/distribution-product', 'GET /accounts/distribution-product']);
  assert.deepEqual(h.calls[1].arg, { code: 'p', version: '1' });
  assert.equal(r.data.published, true);
});

check('create_product reports product_exists as a refusal', async () => {
  const h = harness((m) => {
    if (m === 'POST') throw refusal(409, 'product_exists');
    return {};
  });
  const r = await h.call('create_product', { product: goodProduct });
  assert.equal(r.data.refused, true);
  assert.equal(r.data.refusal_code, 'product_exists');
});

check('update_product uses PATCH and flags an unconfirmed read-back', async () => {
  const h = harness((m) => (m === 'PATCH' ? { code: 'p', version: 2 } : { product: { version: 1 } }));
  const r = await h.call('update_product', { product: goodProduct });
  assert.equal(h.calls[0].method, 'PATCH');
  assert.equal(r.data.published, false);
});

check('get_product returns a refusal as data', async () => {
  const h = harness(() => {
    throw refusal(404, 'product_not_found');
  });
  const r = await h.call('get_product', { code: 'x', version: '2' });
  assert.equal(r.data.refusal_code, 'product_not_found');
  assert.deepEqual(h.calls[0].arg, { code: 'x', version: '2' });
});

check('list_granted_products warns on notices', async () => {
  const h = harness(() => ({ products: [], notices: ['A has no definition'] }));
  const r = await h.call('list_granted_products', { publisher_account_id: 'p' });
  assert.ok(r.data.warning);
});

check('read tools hit the right routes', async () => {
  const h = harness();
  await h.call('list_products', {});
  await h.call('list_product_definition_versions', { config_id: 'c' });
  await h.call('list_distribution_invites', { state: 'expired' });
  await h.call('list_invite_inbox', {});
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.path}`), [
    'GET /accounts/distribution-products',
    'GET /accounts/product-definitions',
    'GET /accounts/distribution-invites',
    'GET /accounts/distribution-invite-inbox',
  ]);
  assert.deepEqual(h.calls[2].arg, { state: 'expired' });
});

check('withdraw_distribution_invite needs confirm, then verifies by listing', async () => {
  const h = harness((m) => (m === 'GET' ? { results: [{ invite_id: 'i1' }] } : { message: 'Invitation withdrawn' }));
  assert.equal((await h.call('withdraw_distribution_invite', { invite_id: 'i1' })).data.sent, false);
  assert.equal(h.calls.length, 0);
  const r = await h.call('withdraw_distribution_invite', { invite_id: 'i1', confirm: true });
  assert.deepEqual(h.calls[0], { method: 'DELETE', path: '/accounts/distribution-invite', arg: { id: 'i1' } });
  assert.equal(r.data.withdrawn, true);
});

check('validate_payload parses a JSON string payload', async () => {
  const r = await harness().call('validate_payload', { kind: 'amend', payload: '{"distributor_account_id":"d","status":"active"}' });
  assert.equal(r.data.valid, true);
});

// --- client ---
check('client defaults to production', () => assert.equal(new QuivaClient().baseUrl, 'https://api.quiva.ai'));
check('fromEnv reads the environment it is given', () => {
  const c = QuivaClient.fromEnv({ QUIVA_API_URL: 'https://example.test/', QUIVA_API_KEY: 'k' });
  assert.equal(c.baseUrl, 'https://example.test');
  assert.ok(c.hasCredentials());
});
check('unwrapData keeps a non-empty message', () => {
  assert.deepEqual(unwrapData({ data: { a: 1 }, message: 'm' }), { a: 1, message: 'm' });
  assert.deepEqual(unwrapData({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapData({ message: 'only' }), { message: 'only' });
});
check('unwrapEnvelope strips status_code/body', () => assert.deepEqual(unwrapEnvelope({ status_code: 200, body: { data: 1 } }), { data: 1 }));
check('refusalOf and extractError read a refusal', () => {
  const body = { data: { status: 'refused', refusal_code: 'not_a_party', detail: 'd' }, message: 'Refused' };
  assert.equal(refusalOf(body).refusal_code, 'not_a_party');
  assert.ok(extractError(body).includes('not_a_party'));
  assert.equal(extractError({ error: 'plain' }), 'plain');
});
check('request sends query params and surfaces a refusal', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: { status: 'refused', refusal_code: 'product_not_found', detail: 'x' }, message: 'Refused' }), { status: 404 });
  };
  try {
    const c = new QuivaClient({ apiKey: 'k' });
    await assert.rejects(c.get('/accounts/distribution-product', { code: 'a', version: '' }), (err) => err.refusal?.refusal_code === 'product_not_found');
    assert.equal(seen[0].url, 'https://api.quiva.ai/accounts/distribution-product?code=a');
    assert.equal(seen[0].init.headers['X-Api-Key'], 'k');
  } finally {
    globalThis.fetch = realFetch;
  }
});
check('a 401 says a role gate may be the cause', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  try {
    await assert.rejects(new QuivaClient({ apiKey: 'k' }).get('/accounts/distributions'), (err) => err.message.includes('role gate'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

for (const { name, fn } of pending) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall tool checks passed');
