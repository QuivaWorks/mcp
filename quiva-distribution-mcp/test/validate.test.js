// Validator, examples and redaction checks. Run: npm test
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/validate.js';
import { readHarvested, readAuthored, listExamples, getExample } from '../src/examples.js';
import { GOTCHAS, TOPICS, getReference } from '../src/distribution-docs.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}

const product = (over = {}) => ({
  code: 'support-plan',
  name: 'Support plan',
  record_configs: [{ id: 'requests', label: 'Requests' }],
  actions: { requests: [{ type: 'create', label: 'New' }, { type: 'rate', label: 'All' }] },
  ...over,
});

// --- product ---
check('valid product passes', () => {
  const r = validate('product', product());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0);
});
check('missing code fails', () => assert.equal(validate('product', product({ code: '' })).valid, false));
check('code with a dot fails', () => assert.equal(validate('product', product({ code: 'a.b' })).valid, false));
check('code over 64 characters fails', () => assert.equal(validate('product', product({ code: 'x'.repeat(65) })).valid, false));
check('blank name fails', () => assert.equal(validate('product', product({ name: '  ' })).valid, false));
check('non-boolean active fails', () => assert.equal(validate('product', product({ active: 'yes' })).valid, false));
check('duplicate record config fails', () => {
  const r = validate('product', product({ record_configs: [{ id: 'requests' }, { id: 'requests' }] }));
  assert.ok(r.errors.some((e) => e.includes('repeats')));
});
check('bare-id record config is read, with a warning', () => {
  const r = validate('product', product({ record_configs: ['requests'] }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('bare id')));
});
check('action keyed by an unlisted record set fails', () => {
  const r = validate('product', product({ actions: { elsewhere: [{ type: 'create' }] } }));
  assert.ok(r.errors.some((e) => e.includes('not one of this product')));
});
check('action keyed by a platform bundle config passes', () => {
  const r = validate('product', product({ actions: { distribution_outcome: [{ type: 'list' }] } }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});
check('unknown action type fails', () => {
  const r = validate('product', product({ actions: { requests: [{ type: 'open' }] } }));
  assert.ok(r.errors.some((e) => e.includes('not a type')));
});
check('rate, bind, mta and cancellation are accepted without a warning', () => {
  for (const type of ['rate', 'bind', 'mta', 'cancellation']) {
    const r = validate('product', product({ actions: { requests: [{ type }] } }));
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    assert.equal(r.warnings.length, 0, type);
  }
});
check('retired "list" action type warns, not errors', () => {
  const r = validate('product', product({ actions: { requests: [{ type: 'list' }] } }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('#1544')));
});
check('action keyed by distribution_delivery_failure passes', () => {
  const r = validate('product', product({ actions: { distribution_delivery_failure: [{ type: 'create' }] } }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

// --- type, sla_business_days, entity_config, distributor_front_page_layouts ---
const errs = (over) => validate('product', product(over)).errors;
const entity = (over = {}) => ({ config_id: 'requests', identity_fields: ['email'], ...over });
const layout = (over = {}) => ({ id: 'front', config_id: 'requests', ...over });

check('type workitem with record_configs fails; unknown type fails', () => {
  assert.ok(errs({ type: 'workitem' }).some((e) => e.includes('workitem')));
  assert.ok(errs({ type: 'other' }).some((e) => e.includes('not a product type')));
  assert.equal(validate('product', product({ type: 'quote' })).valid, true);
});
check('sla_business_days: 0 and 260 pass, 261, -1 and 2.5 fail, null is absent', () => {
  for (const ok of [0, 2, 260, null]) assert.equal(validate('product', product({ sla_business_days: ok })).valid, true, String(ok));
  for (const bad of [261, -1, 2.5, '3']) assert.ok(errs({ sla_business_days: bad }).some((e) => e.includes('sla_business_days')), String(bad));
});
check('entity_config on one of the product record sets passes cleanly', () => {
  const r = validate('product', product({ entity_config: entity({ label: 'Customer', display_fields: ['name'] }) }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0);
});
check('entity_config.config_id must be a product record set, not a bundle config', () => {
  assert.ok(errs({ entity_config: entity({ config_id: 'elsewhere' }) }).some((e) => e.includes('record_configs')));
  assert.ok(errs({ entity_config: entity({ config_id: 'distribution_outcome' }) }).some((e) => e.includes('record_configs')));
  assert.ok(errs({ entity_config: { identity_fields: ['email'] } }).some((e) => e.includes('config_id')));
});
check('entity_config.identity_fields is required and names are checked', () => {
  assert.ok(errs({ entity_config: { config_id: 'requests' } }).some((e) => e.includes('identity_fields is required')));
  assert.ok(errs({ entity_config: entity({ identity_fields: [] }) }).some((e) => e.includes('identity_fields is required')));
  assert.ok(errs({ entity_config: entity({ identity_fields: ['a b'] }) }).some((e) => e.includes('not a field name')));
  assert.ok(errs({ entity_config: entity({ display_fields: ['ok', 'a.b'] }) }).some((e) => e.includes('display_fields[1]')));
  assert.ok(errs({ entity_config: entity({ identity_fields: [1] }) }).some((e) => e.includes('must be a string')));
  assert.ok(errs({ entity_config: 'x' }).some((e) => e.includes('must be an object')));
});
check('entity_config unknown key and repeated identity field warn', () => {
  const r = validate('product', product({ entity_config: entity({ identity_fields: ['email', 'email'], extra: 1 }) }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('entity_config.extra')));
  assert.ok(r.warnings.some((w) => w.includes('repeats a field')));
});
check('null entity_config and null layouts are absent', () => {
  assert.equal(validate('product', product({ entity_config: null, distributor_front_page_layouts: null })).valid, true);
});
check('front page layouts: valid array passes, bundle config_id passes', () => {
  const r = validate('product', product({ distributor_front_page_layouts: [layout(), layout({ id: 'alerts', config_id: 'distribution_delivery_failure' })] }));
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(!r.warnings.some((w) => w.includes('distributor_front_page_layouts')));
});
check('front page layouts: not an array, non-object item, bad id, repeat id, unknown config_id fail', () => {
  const at = (v) => errs({ distributor_front_page_layouts: v }).join(' | ');
  assert.match(at({}), /must be an array/);
  assert.match(at(['x']), /not a layout object/);
  assert.match(at([layout({ id: 'a.b' })]), /id "a.b"/);
  assert.match(at([layout({ id: '' })]), /id ""/);
  assert.match(at([layout(), layout()]), /repeats id front/);
  assert.match(at([layout({ config_id: 'nope' })]), /not a record set the distributor holds/);
  assert.match(at([{ id: 'x' }]), /config_id ""/);
});
check('front page layouts: 50 pass, 51 fail; over 256 KiB fails; body is not inspected', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => layout({ id: `l${i}` }));
  assert.equal(validate('product', product({ distributor_front_page_layouts: many(50) })).valid, true);
  assert.ok(errs({ distributor_front_page_layouts: many(51) }).some((e) => e.includes('51 layouts')));
  assert.ok(errs({ distributor_front_page_layouts: [layout({ blob: 'x'.repeat(256 * 1024) })] }).some((e) => e.includes('bytes')));
  const deep = validate('product', product({ distributor_front_page_layouts: [layout({ tabs: 'anything', cards: [1, 2] })] }));
  assert.equal(deep.valid, true, JSON.stringify(deep.errors));
});
check('new product fields are not reported as dropped', () => {
  const r = validate('product', product({ sla_business_days: 3, entity_config: entity(), distributor_front_page_layouts: [layout()] }));
  assert.ok(!r.warnings.some((w) => w.includes('is not a product field')));
});
check('repeated action type fails', () => {
  const r = validate('product', product({ actions: { requests: [{ type: 'create' }, { type: 'create' }] } }));
  assert.ok(r.errors.some((e) => e.includes('one button per type')));
});
check('actions that are not an array fail', () => {
  assert.equal(validate('product', product({ actions: { requests: { type: 'create' } } })).valid, false);
});
check('server-set fields warn', () => {
  const r = validate('product', product({ version: 3, published_at: 'x' }));
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('set by the service')));
});
check('non-object product fails', () => assert.equal(validate('product', 'x').valid, false));
check('unknown kind fails', () => assert.equal(validate('grant', {}).valid, false));

// --- amend ---
const amend = (over = {}) => ({ distributor_account_id: '1234567890', status: 'suspended', ...over });
check('valid status amendment passes', () => assert.equal(validate('amend', amend()).valid, true));
check('amendment without distributor fails', () => assert.equal(validate('amend', amend({ distributor_account_id: '' })).valid, false));
check('amendment that changes nothing fails', () => {
  const r = validate('amend', { distributor_account_id: '1' });
  assert.ok(r.errors.some((e) => e.includes('nothing to amend')));
});
check('pending is not an amendment target', () => assert.equal(validate('amend', amend({ status: 'pending' })).valid, false));
check('revoked warns that it is terminal', () => {
  const r = validate('amend', amend({ status: 'revoked' }));
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('TERMINAL')));
});
check('reason without status warns', () => {
  const r = validate('amend', { distributor_account_id: '1', reason: 'x', withdraw_products: ['a'] });
  assert.ok(r.warnings.some((w) => w.includes('reason')));
});
check('duplicate grant product fails case-insensitively', () => {
  const r = validate('amend', { distributor_account_id: '1', grant_products: [{ product_id: 'A' }, { product_id: 'a' }] });
  assert.ok(r.errors.some((e) => e.includes('listed twice')));
});
check('numeric version fails', () => {
  const r = validate('amend', { distributor_account_id: '1', grant_products: [{ product_id: 'a', version: 2 }] });
  assert.ok(r.errors.some((e) => e.includes('must be a string')));
});
check('non-numeric version fails', () => {
  const r = validate('amend', { distributor_account_id: '1', grant_products: [{ product_id: 'a', version: 'latest' }] });
  assert.ok(r.errors.some((e) => e.includes('not a version')));
});
check('"v2" version passes', () => {
  assert.equal(validate('amend', { distributor_account_id: '1', grant_products: [{ product_id: 'a', version: 'v2' }] }).valid, true);
});
check('bad withdraw id fails', () => assert.equal(validate('amend', { distributor_account_id: '1', withdraw_products: ['a b'] }).valid, false));
check('grant and withdraw of one product warns', () => {
  const r = validate('amend', { distributor_account_id: '1', grant_products: [{ product_id: 'a' }], withdraw_products: ['a'] });
  assert.ok(r.warnings.some((w) => w.includes('ends up granted')));
});

// --- examples ---
const harvested = readHarvested();
const authored = readAuthored();
check('harvested examples are bundled', () => assert.ok(harvested.length >= 6, `${harvested.length}`));
check('authored examples are bundled', () => assert.ok(authored.length >= 3));
check('every example has a teaches line', () => {
  for (const e of [...harvested, ...authored]) assert.ok(e.teaches, e.slug);
});
check('listExamples and getExample agree', () => {
  for (const e of listExamples().examples) assert.equal(getExample(e.slug).slug, e.slug);
});
check('authored write bodies pass the validator', () => {
  for (const e of authored.filter((x) => x.payload)) {
    const r = validate(e.of, e.payload);
    assert.equal(r.valid, true, `${e.slug}: ${JSON.stringify(r.errors)}`);
  }
});
check('authored create-product-with-entity passes with no warnings', () => {
  const e = getExample('create-product-with-entity');
  const r = validate(e.of, e.payload);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0);
});
check('a stored product version is accepted with warnings only', () => {
  const read = getExample('product-read-app-action-types').response.product;
  const r = validate('product', read);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.length > 0);
});
check('harvested refusals carry refusal_code', () => {
  const refused = getExample('refusals').responses.filter((x) => x.refused);
  assert.ok(refused.length >= 1);
  for (const x of refused) assert.ok(x.body.data.refusal_code);
});
check('harvested status is 200 with complete false', () => {
  const s = getExample('distributor-status').response;
  assert.equal(s.status, 200);
  assert.equal(s.body.data.complete, false);
});

// --- redaction and copy hygiene ---
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f === '.env') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(PKG);
const text = (p) => readFileSync(p, 'utf8');

check('harvested files hold no email, uuid or bare account number', () => {
  for (const e of readdirSync(join(PKG, 'examples', 'harvested'))) {
    const t = text(join(PKG, 'examples', 'harvested', e));
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(t), `${e}: email`);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t), `${e}: uuid`);
    assert.ok(!/"\d{8,12}"|[.\s]\d{9,12}\b/.test(t.replace(/"expires_at": \d+/g, '')), `${e}: account-like number`);
  }
});
check('no staging host anywhere in the package', () => {
  const host = ['microstrate', 'io'].join('.');
  for (const p of files) assert.ok(!text(p).includes(host), p);
});
check('shipped copy uses no domain vocabulary', () => {
  const banned = /\b(insur\w*|underwrit\w*|premium|polic(y|ies)|broker(s|age)?\b(?!_)|endorse\w*)/i;
  const shipped = files.filter((p) => /src\/|README|examples\/authored/.test(p));
  for (const p of shipped) {
    const lines = text(p).split('\n').filter((l) => !/brokerage_name|refuseSecondGrantToOneBrokerage/.test(l));
    const hit = lines.find((l) => banned.test(l));
    assert.ok(!hit, `${p}: ${hit}`);
  }
});

// --- reference ---
check('every topic resolves', () => {
  for (const t of TOPICS) assert.ok(!getReference(t).error, t);
});
check('unknown topic returns an error', () => assert.ok(getReference('nope').error));
check('not-exposed names the signing-key route', () => {
  assert.ok(getReference('not-exposed').table.some((r) => r.route.includes('distribution-signing-key')));
});
check('reference carries the PR #1560 topics and refusal', () => {
  for (const t of ['product-sync', 'connected-accounts', 'filing', 'delivery-failure', 'layout-action-flows']) assert.ok(TOPICS.includes(t), t);
  const msgs = getReference('messages').body.join('\n');
  for (const needle of ['revoke-result', 'offer_record_id', 'deleted, gone, refused', 'sender_space_id', 'version is 1']) assert.ok(msgs.includes(needle), needle);
  assert.ok(getReference('envelope-and-refusals').refusal_codes.some((r) => r.code === 'entity_config_conflict'));
  const filing = getReference('filing').body.join('\n');
  assert.ok(filing.includes('filing.entity') && filing.includes('NEVER names a folder'));
  assert.ok(getReference('layout-action-flows').body.join('\n').includes('ok: false, code, reason'));
});
check('gotchas cite engine files', () => {
  assert.ok(GOTCHAS.filter((g) => /accounts-service\/[\w/]+\.go/.test(g)).length >= 8);
});

check('header comments of client.js, examples.js and harvest-examples.mjs are at most 3 lines', () => {
  for (const f of ['src/client.js', 'src/examples.js', 'tools/harvest-examples.mjs']) {
    const lines = readFileSync(join(PKG, f), 'utf8').split('\n');
    const body = lines[0].startsWith('#!') ? lines.slice(1) : lines;
    const n = body.findIndex((l) => !l.startsWith('//'));
    assert.ok(n >= 1 && n <= 3, `${f}: ${n} lines`);
  }
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall validate checks passed');
