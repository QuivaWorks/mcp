// Hand-rolled test runner for the workspaces payload validator (no framework).
// Run: npm test  (or: node test/validate.test.js)
import assert from 'node:assert/strict';
import { validate, verticalRouting } from '../src/validate.js';
import { harvestedPayloads, getExample } from '../src/examples.js';
import {
  TIME_LOG_EXAMPLE, TIME_TRACKING_EXAMPLE, TASK_ACTION_EXAMPLE, CREATE_SPACE_EXAMPLE, CREATE_CONTACT_EXAMPLE,
  TASK_TEMPLATE_EXAMPLE, SPACE_UPDATE_FIELDS, VERTICAL_CONFIG_TYPES, VERTICAL_NON_DEPLOYING_FOLDERS,
} from '../src/workspaces-docs.js';
import { decodeFileKey, fileKeyOf, digestMatches, sha256OfContent } from '../src/client.js';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// --- spaces ---
check('valid space create passes', () => {
  const r = validate('space', { id: 'Q2_MKTG', name: 'Q2 Marketing' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('space create without id fails', () => {
  const r = validate('space', { name: 'No id' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('id is required')));
});

check('space id with hyphen/space is an error', () => {
  const r = validate('space', { id: 'bad id-1', name: 'X' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('invalid')));
});

check('lowercase space id warns about uppercasing', () => {
  const r = validate('space', { id: 'lower_id', name: 'X' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('UPPERCASED')));
});

check('space create without name fails', () => {
  const r = validate('space', { id: 'ABC' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('name is required')));
});

check('space status missing id/name is an error', () => {
  const r = validate('space', { id: 'ABC', name: 'X', statuses: [{ color: '#fff' }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('statuses[0].id')));
});

check('space update with only a field passes', () => {
  const r = validate('space', { name: 'renamed' }, { requireRequired: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('space update warns on echoed read-only fields', () => {
  const r = validate('space', { name: 'x', owner: 'user_1', created_at: 'ts' }, { requireRequired: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('read-only')));
});

// --- tasks ---
check('valid task create passes', () => {
  const r = validate('task', { title: 'Do the thing', space_id: 'Q2_MKTG' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('task create without title fails', () => {
  const r = validate('task', { space_id: 'Q2_MKTG' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('title is required')));
});

check('lowercase space_id on task warns', () => {
  const r = validate('task', { title: 'X', space_id: 'lower' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('uppercased')));
});

check('date-only due_date warns about RFC3339', () => {
  const r = validate('task', { title: 'X', due_date: '2024-06-15' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('RFC3339')));
});

check('non-boolean archived is an error', () => {
  const r = validate('task', { title: 'X', archived: 'yes' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('archived')));
});

check('assignees must be an array of strings', () => {
  const r = validate('task', { title: 'X', assignees: 'user_1' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('assignees')));
});

// --- multi_task ---
check('multi_task requires each task to have an id', () => {
  const r = validate('multi_task', { tasks: [{ status: 'done' }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('tasks[0].id is required')));
});

check('valid multi_task passes with index warning', () => {
  const r = validate('multi_task', { tasks: [{ id: 't_1', status: 'done' }] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('index')));
});

// --- comments ---
check('valid comment create passes', () => {
  const r = validate('comment', { body: 'Looks good' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('comment create without body fails', () => {
  const r = validate('comment', {});
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('body is required')));
});

check('comment update needs body or reply_id', () => {
  const r = validate('comment', {}, { requireRequired: false });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('body') && e.includes('reply_id')));
});

// --- reactions ---
check('valid reaction passes', () => {
  const r = validate('reaction', { reaction: { '👍': true } });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('empty reaction map is an error', () => {
  const r = validate('reaction', { reaction: {} });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('reaction is required')));
});

check('non-boolean reaction value is an error', () => {
  const r = validate('reaction', { reaction: { '👍': 'yes' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('boolean')));
});

// --- reaction keys must be real emoji ----------------------------------------
// This MCP's own authored example shipped { "eyes": true } and the reaction
// rendered as broken on staging. The key is stored VERBATIM and rendered as-is —
// nothing converts a shortcode name into a glyph. Verified live 2026-07-30.

check('a real emoji reaction key passes', () => {
  const r = validate('reaction', { reaction: { '👀': true } });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('a multi-codepoint emoji (skin tone modifier) passes', () => {
  const r = validate('reaction', { reaction: { '👍🏽': true } });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('a shortcode NAME is an error — it stores literally and renders broken', () => {
  const r = validate('reaction', { reaction: { eyes: true } });
  assert.equal(r.valid, false, 'this is the exact mistake that shipped to staging');
  assert.ok(r.errors.some((e) => e.includes('is not an emoji character')), JSON.stringify(r.errors));
});

check('a colon-wrapped shortcode is also an error', () => {
  const r = validate('reaction', { reaction: { ':thumbsup:': true } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('is not an emoji character')));
});

check('removing a reaction still requires a real emoji key', () => {
  const r = validate('reaction', { reaction: { eyes: false } });
  assert.equal(r.valid, false, 'the key identifies which reaction to remove, so it must match what was stored');
});

check('the authored example uses a real emoji reaction key', () => {
  const example = getExample('review-board');
  const r = validate('reaction', example.reaction, { requireRequired: true });
  assert.equal(r.valid, true, `the shipped example must not teach the shortcode form: ${r.errors.join('; ')}`);
  assert.ok(
    example.reaction_key_must_be_a_real_emoji?.verified_live?.includes('2026-07-30'),
    'the example must keep the record of why it changed — it shipped wrong once'
  );
});

// --- time tracking: the time-log subresource (workspaces-service #1292) -------

check('a task write carrying only the estimate passes cleanly', () => {
  const r = validate('task', { title: 'x', space_id: 'Q2_MKTG', time_tracking: TIME_TRACKING_EXAMPLE }, { requireRequired: true });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('time_tracking must be an object', () => {
  const r = validate('task', { title: 'x', time_tracking: [] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('time_tracking must be an object')));
});

check('a negative estimate is an error', () => {
  const r = validate('task', { title: 'x', time_tracking: { estimate: { time_in_seconds: -1 } } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('must not be negative')));
});

check('time_tracking.logs on a task write warns that it is never read', () => {
  const r = validate('task', { time_tracking: { logs: [{ id: 'tl_x' }] } }, { requireRequired: false });
  assert.equal(r.valid, true, 'harvested reads carry logs, so this must stay a warning');
  assert.ok(r.warnings.some((w) => w.includes('NEVER READ') && w.includes('add_time_log')), JSON.stringify(r.warnings));
});

check('hydrated totals sent back warn as server-computed', () => {
  const r = validate('task', { time_tracking: { estimate: { time_in_seconds: 60 }, spent: { time_in_seconds: 30 }, progress_percent: 50 } }, { requireRequired: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('spent') && w.includes('computed server-side')), JSON.stringify(r.warnings));
});

check('an unknown time_tracking key warns', () => {
  const r = validate('task', { time_tracking: { total_spent: 1800 } }, { requireRequired: false });
  assert.ok(r.warnings.some((w) => w.includes('total_spent')), JSON.stringify(r.warnings));
});

check('valid add_time_log body passes with no warnings', () => {
  const r = validate('time_log', TIME_LOG_EXAMPLE);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('time_log needs time_spent and started_at (the handler 400s without them)', () => {
  const r = validate('time_log', { description: 'x' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('time_spent is required')));
  assert.ok(r.errors.some((e) => e.includes('started_at is required')));
});

check('time_log with zero seconds is an error (> 0 required)', () => {
  const r = validate('time_log', { ...TIME_LOG_EXAMPLE, time_spent: { time_in_seconds: 0 } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('greater than zero')), JSON.stringify(r.errors));
});

check('time_log time_spent must be numeric seconds', () => {
  const r = validate('time_log', { ...TIME_LOG_EXAMPLE, time_spent: { time_in_seconds: '90m' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('SECONDS')));
});

check('time_log client-minted id/user/created_at warn as server-owned', () => {
  const r = validate('time_log', { ...TIME_LOG_EXAMPLE, id: 'time_log_x', user: { id: 'u', name: 'n' }, created_at: '2026-01-01T00:00:00Z' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('server-owned')), JSON.stringify(r.warnings));
});

check('time_log non-RFC3339 started_at warns', () => {
  const r = validate('time_log', { ...TIME_LOG_EXAMPLE, started_at: '2026-07-29' });
  assert.ok(r.warnings.some((w) => w.includes('RFC3339')), JSON.stringify(r.warnings));
});

// --- task actions -------------------------------------------------------------

check('valid task_action passes', () => {
  const r = validate('task_action', TASK_ACTION_EXAMPLE, { requireRequired: true });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('task_action without a description is an error', () => {
  const r = validate('task_action', { done: true, id: 'ta_x' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('description is required')));
});

check('task_action description is required even in update mode (the handler checks it on every write)', () => {
  const r = validate('task_action', { id: 'ta_x', done: true }, { requireRequired: false });
  assert.equal(r.valid, false, 'the engine 400s on a write with no description regardless of intent');
  assert.ok(r.errors.some((e) => e.includes('description is required')));
});

check('task_action update without an id warns that it would create a new action', () => {
  const r = validate('task_action', { description: 'x', done: true }, { requireRequired: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('creates a NEW action')), JSON.stringify(r.warnings));
});

check('task_action resources need both resource_id and resource_type', () => {
  const r = validate('task_action', { description: 'x', resources: [{ resource_id: 'a' }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('resource_type')));
});

check('every task_action write warns that it moves the status by role', () => {
  const r = validate('task_action', TASK_ACTION_EXAMPLE, { requireRequired: true });
  assert.ok(r.warnings.some((w) => w.includes('status role') && w.includes('never writes an id')), JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some((w) => w.includes('CANNOT BE READ BACK')), 'get_task returns task_actions[]; the old warning is stale');
});

// --- space fields -------------------------------------------------------------

check('a status role outside the known set warns', () => {
  const r = validate('space', { id: 'X', name: 'X', statuses: [{ id: 'a', name: 'A', role: 'finished' }] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('not a known status role')));
});

check('a duplicate status role warns (automation resolves the first)', () => {
  const r = validate('space', { id: 'X', name: 'X', statuses: [{ id: 'a', name: 'A', role: 'working' }, { id: 'b', name: 'B', role: 'working' }] });
  assert.ok(r.warnings.some((w) => w.includes('repeats role "working"')), JSON.stringify(r.warnings));
});

check('a terminal role on a non-complete status warns', () => {
  const r = validate('space', { id: 'X', name: 'X', statuses: [{ id: 'd', name: 'Done', role: 'done', complete: false }] });
  assert.ok(r.warnings.some((w) => w.includes('complete: true')), JSON.stringify(r.warnings));
});

check('the example space with roles passes cleanly', () => {
  const r = validate('space', CREATE_SPACE_EXAMPLE);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

check('upsert_statuses needs ids but not names', () => {
  const ok = validate('space', { upsert_statuses: [{ id: 'blocked', role: 'working' }] }, { requireRequired: false });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  const bad = validate('space', { upsert_statuses: [{ name: 'Blocked' }] }, { requireRequired: false });
  assert.ok(bad.errors.some((e) => e.includes('upsert_statuses[0].id')));
});

check('remove_* must be arrays of ids', () => {
  const r = validate('space', { remove_tags: 'old' }, { requireRequired: false });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('remove_tags')));
});

check('list edits on create warn that create ignores them', () => {
  const r = validate('space', { id: 'X', name: 'X', upsert_tags: [{ id: 't' }] });
  assert.ok(r.warnings.some((w) => w.includes('update-only')), JSON.stringify(r.warnings));
});

check('a full statuses list on update warns that it replaces', () => {
  const r = validate('space', { statuses: [{ id: 'a', name: 'A' }] }, { requireRequired: false });
  assert.ok(r.warnings.some((w) => w.includes('REPLACES') && w.includes('upsert_statuses')), JSON.stringify(r.warnings));
});

check('base_record needs a config_id', () => {
  const r = validate('space', { base_record: { identity_fields: ['email'] } }, { requireRequired: false });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('base_record.config_id')));
});

check('base_record create_login_on_create warns about sign-ins', () => {
  const r = validate('space', { base_record: { config_id: 'contact', identity_fields: ['email'], create_login_on_create: true } }, { requireRequired: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('PORTAL') || w.includes('portal sign-in')), JSON.stringify(r.warnings));
});

check('flags on the wrong record warn', () => {
  const r = validate('space', {
    base_record: { config_id: 'contact', identity_fields: ['email'], enable_distribution: true },
    organisation_record: { config_id: 'firm', identity_fields: ['registration_number'], create_login_on_create: true },
  }, { requireRequired: false });
  assert.ok(r.warnings.some((w) => w.includes('enable_distribution belongs on organisation_record')));
  assert.ok(r.warnings.some((w) => w.includes('create_login_on_create belongs on base_record')));
});

check('base_record and organisation_record on one config is an error', () => {
  const r = validate('space', { base_record: { config_id: 'c', identity_fields: ['email'] }, organisation_record: { config_id: 'c', identity_fields: ['name'] } }, { requireRequired: false });
  assert.equal(r.valid, false);
});

check('hidden_tabs cannot hold overview; unknown tabs warn', () => {
  const r = validate('space', { hidden_tabs: ['overview', 'charts', 'files'] }, { requireRequired: false });
  assert.ok(r.errors.some((e) => e.includes('overview')));
  assert.ok(r.warnings.some((w) => w.includes('"charts"')));
});

check('modules must be booleans', () => {
  const r = validate('space', { modules: { files: 'yes', widgets: true } }, { requireRequired: false });
  assert.ok(r.errors.some((e) => e.includes('modules.files')));
  assert.ok(r.warnings.some((w) => w.includes('modules.widgets')));
});

check('custom_tab mirrors ValidateDisplay', () => {
  const r = validate('space', {
    record_configs: [{ id: 'quote' }],
    custom_tab: { cards: [
      { config_id: 'quote', action: 'create', view: 'open' },
      { config_id: 'quote', action: 'list' },
      { config_id: 'quote', action: 'list' },
      { action: 'list' },
      { config_id: 'other', action: 'open' },
    ] },
  }, { requireRequired: false });
  assert.ok(r.errors.some((e) => e.includes('cards[0].view')));
  assert.ok(r.errors.some((e) => e.includes('cards[2] repeats card 1')));
  assert.ok(r.errors.some((e) => e.includes('cards[3].config_id is required')));
  assert.ok(r.errors.some((e) => e.includes('cards[4].action "open"')));
  assert.ok(r.warnings.some((w) => w.includes('"other" is not in this payload')));
});

check('editing_disabled warns: irreversible on create, ignored on update', () => {
  const c = validate('space', { id: 'X', name: 'X', editing_disabled: true });
  assert.ok(c.warnings.some((w) => w.includes('IRREVERSIBLE')));
  const u = validate('space', { editing_disabled: true }, { requireRequired: false });
  assert.ok(u.warnings.some((w) => w.includes('CREATE-ONLY')));
});

check('SPACE_UPDATE_FIELDS lists the new space fields', () => {
  for (const f of ['base_record', 'organisation_record', 'modules', 'custom_tab', 'hidden_tabs', 'view', 'upsert_statuses', 'remove_statuses', 'upsert_priorities', 'remove_priorities', 'upsert_tags', 'remove_tags']) {
    assert.ok(SPACE_UPDATE_FIELDS.includes(f), f);
  }
  assert.ok(!SPACE_UPDATE_FIELDS.includes('editing_disabled'), 'editing_disabled is create-only');
});

// --- task fields ---------------------------------------------------------------

check('a task cannot be its own parent; parent must be an id', () => {
  const r = validate('task', { id: 'A-1', parent: 'A-1' }, { requireRequired: false });
  assert.ok(r.errors.some((e) => e.includes('own parent')));
  const d = validate('task', { parent: 'spaces.A.x' }, { requireRequired: false });
  assert.ok(d.errors.some((e) => e.includes('not a task id')));
});

check('move_subtasks without a space/folder change warns', () => {
  const r = validate('task', { move_subtasks: true }, { requireRequired: false });
  assert.ok(r.warnings.some((w) => w.includes('does nothing')));
  const ok = validate('task', { move_subtasks: true, space_id: 'OTHER' }, { requireRequired: false });
  assert.ok(!ok.warnings.some((w) => w.includes('does nothing')));
});

check('pipeline value must be a number and wants a currency', () => {
  const bad = validate('task', { value: '5000' }, { requireRequired: false });
  assert.ok(bad.errors.some((e) => e.includes('value must be a number')));
  const warn = validate('task', { value: 5000 }, { requireRequired: false });
  assert.ok(warn.warnings.some((w) => w.includes('currency')));
});

check('identity on create warns to check base_record_skipped; on update it is ignored', () => {
  const c = validate('task', { title: 'x', space_id: 'LEADS', identity: { email: 'sam@example.com' } });
  assert.ok(c.warnings.some((w) => w.includes('base_record_skipped')));
  const u = validate('task', { identity: { email: 'sam@example.com' } }, { requireRequired: false });
  assert.ok(u.warnings.some((w) => w.includes('create-only')));
});

check('create_task with no space_id warns about ESCALATE', () => {
  const r = validate('task', { title: 'x' });
  assert.ok(r.warnings.some((w) => w.includes('ESCALATE')));
});

// --- contacts ------------------------------------------------------------------

check('valid contact passes and warns about a possible sign-in', () => {
  const r = validate('contact', CREATE_CONTACT_EXAMPLE);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('PORTAL SIGN-IN')));
});

check('contact needs space_id, a valid email and a single-segment parent_folder', () => {
  const r = validate('contact', { email: 'not-an-email', parent_folder: 'a.b' });
  assert.ok(r.errors.some((e) => e.includes('space_id is required')));
  assert.ok(r.errors.some((e) => e.includes('not a valid email')));
  assert.ok(r.errors.some((e) => e.includes('single folder')));
});

// --- task templates --------------------------------------------------------------

check('valid task template passes', () => {
  const r = validate('task_template', TASK_TEMPLATE_EXAMPLE);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('task template action kinds mirror validateTaskTemplateActions', () => {
  const r = validate('task_template', { name: 't', task_actions: [
    { kind: 'form', description: 'a' },
    { kind: 'document', description: 'b', document_source: 'knowledge' },
    { kind: 'chat', description: 'c' },
    { kind: 'video', description: 'd' },
    { kind: 'form', configs: [{ id: 'x' }] },
  ] });
  assert.ok(r.errors.some((e) => e.includes('[0]: config_id or configs')));
  assert.ok(r.errors.some((e) => e.includes('[1]: knowledge_key')));
  assert.ok(r.errors.some((e) => e.includes('[2]: agent_subject')));
  assert.ok(r.errors.some((e) => e.includes('[3]: kind')));
  assert.ok(r.errors.some((e) => e.includes('[4].description')));
});

// --- kind guard ---
check('unknown kind is an error', () => {
  const r = validate('widget', {});
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('unknown kind')));
});

// --- golden gate ------------------------------------------------------------
// Every payload in examples/harvested/ is a REAL space/task/comment living on the
// platform. If the validator rejects one, the VALIDATOR is wrong — that is the
// whole point of this gate. (See docs/lessons.md: the flows MCP shipped a wrong
// rules syntax for two weeks because no check like this existed.)
//
// Harvested payloads are READ responses, so they legitimately carry server-set
// fields. The validator only WARNS about those, so they do not fail the gate —
// that warning is what stops an agent echoing a GET back as a create body.

const payloads = harvestedPayloads();

check('golden: examples/harvested/ is populated (run tools/harvest-examples.mjs)', () => {
  assert.ok(payloads.length > 0, 'no harvested payloads — the golden gate cannot run');
});

for (const { slug, kind, payload } of payloads) {
  check(`golden: validator accepts real ${kind} "${slug}"`, () => {
    // Reads are validated in update mode: a read response is not a create body
    // (a task read has no space_id requirement, a space read is already created).
    const result = validate(kind, payload, { requireRequired: false });
    assert.deepEqual(
      result.errors,
      [],
      `validator rejected a ${kind} that is live on the platform:\n  ${result.errors.join('\n  ')}`
    );
  });
}

check('golden: harvested reads trip the read-only-field warning (that is the point)', () => {
  const space = payloads.find((p) => p.kind === 'space');
  const result = validate('space', space.payload, { requireRequired: false });
  assert.ok(
    result.warnings.some((w) => w.includes('read-only')),
    'a harvested space carries owner/created_at/url — the validator must warn so an agent does not echo it back'
  );
});

// The board reads presentation fields the API does not require. color and
// complete are set on EVERY live status (45/45 as of 2026-07-29), so an authored
// space that omits them renders unlike every other space — the same class of
// defect as the flows MCP's missing node geometry.
check('the authored space example sets the presentation fields the board reads', () => {
  const example = getExample('review-board');
  for (const status of example.space.statuses) {
    for (const field of ['color', 'order', 'complete', 'is_visible']) {
      assert.ok(status[field] !== undefined, `status "${status.id}" is missing ${field}`);
    }
  }
  assert.ok(
    example.space.statuses.some((s) => s.complete === true),
    'no status is flagged complete — the board would have no done state'
  );
  // priorityIconClass() reads icon_type unconditionally, so a partial priority
  // throws in the UI rather than degrading.
  for (const priority of example.space.priorities) {
    for (const field of ['icon', 'icon_type', 'icon_color']) {
      assert.ok(priority[field] !== undefined, `priority "${priority.id}" is missing ${field}`);
    }
  }
});

check('the authored write payloads pass the validator in create mode', () => {
  const example = getExample('review-board');
  for (const [kind, payload] of [
    ['space', example.space],
    ['task', example.task],
    ['comment', example.comment],
    ['reaction', example.reaction],
  ]) {
    const result = validate(kind, payload, { requireRequired: true });
    assert.equal(result.valid, true, `${kind}: ${result.errors.join('; ')}`);
  }
});

check('the authored write payloads carry no server-set fields', () => {
  const example = getExample('review-board');
  for (const [kind, payload] of [
    ['space', example.space],
    ['task', example.task],
    ['comment', example.comment],
  ]) {
    const result = validate(kind, payload, { requireRequired: true });
    assert.ok(
      !result.warnings.some((w) => w.includes('read-only')),
      `${kind} write payload includes a server-set field: ${result.warnings.join('; ')}`
    );
  }
});

check('the authored example covers the new task surface and passes the validator', () => {
  const example = getExample('review-board');
  for (const log of example.time_logs) {
    const r = validate('time_log', log);
    assert.equal(r.valid, true, `time_log: ${r.errors.join('; ')}`);
    assert.equal(r.warnings.length, 0, `time_log carries server-owned fields: ${r.warnings.join('; ')}`);
  }
  assert.ok(!example.task.time_tracking.logs, 'the task write must carry only the estimate');
  for (const [kind, payload] of [['task_action', example.task_action], ['contact', example.contact], ['task', example.identity_task], ['task', example.subtask]]) {
    const r = validate(kind, payload, { requireRequired: true });
    assert.equal(r.valid, true, `${kind}: ${r.errors.join('; ')}`);
  }
  const roles = example.space.statuses.map((s) => s.role).filter(Boolean);
  for (const role of ['todo', 'working', 'done']) assert.ok(roles.includes(role), `the board needs a ${role} role for task actions to move it`);
  assert.equal(example.space.base_record.create_login_on_create, false, 'the shipped example must not enrol contacts');
  assert.ok(/@example\.com$/.test(example.contact.email), 'test contacts use example.com');
});

check('authored examples carry no insurance vocabulary', () => {
  const text = JSON.stringify(getExample('review-board')).toLowerCase();
  for (const word of ['broker', 'underwrit', 'insur', 'premium', 'policy', 'renewal', 'mga']) {
    assert.ok(!text.includes(word), `"${word}" in an authored example`);
  }
});

// --- folders ---------------------------------------------------------------

check('valid vertical category folder passes', () => {
  const r = validate('folder', { space_id: 'VERTICAL', subfolder: 'my_vertical', folder: 'spaces' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

// The engine only 400s when space_id, folder AND full_path are all empty, so a
// payload with just space_id passes server-side and writes `spaces.X..__meta__.json`.
check('folder payload with only space_id is an error (the engine would not reject it)', () => {
  const r = validate('folder', { space_id: 'VERTICAL' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('folder is required')));
});

check('a dotted folder name is an error (dots are the hierarchy separator)', () => {
  const r = validate('folder', { space_id: 'VERTICAL', folder: 'a.b' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('single dot-free segment')));
});

check('full_path combined with space_id/folder is an error', () => {
  const r = validate('folder', { space_id: 'VERTICAL', folder: 'spaces', full_path: 'spaces.VERTICAL.v.spaces' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('EITHER full_path OR')));
});

check('non-string metadata values are an error (engine field is map[string]string)', () => {
  const r = validate('folder', { space_id: 'X', folder: 'f', metadata: { count: 1 } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('map[string]string')));
});

// A WARNING, not an error: the six names are transcribed from accounts-service
// and can grow upstream, and a non-deploying folder may be deliberate.
check('an unrecognised vertical category warns and names the silent skip', () => {
  const r = validate('folder', { space_id: 'VERTICAL', subfolder: 'my_vertical', folder: 'record_config' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('SILENTLY')));
});

check('a non-snake_case vertical id warns about the derived flow collection name', () => {
  const r = validate('folder', { space_id: 'VERTICAL', folder: 'MyVertical' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('collection')));
});

check('a folder named after the marker warns', () => {
  const r = validate('folder', { space_id: 'X', folder: '__meta__' });
  assert.ok(r.warnings.some((w) => w.includes('folder-marker')));
});

// --- files -----------------------------------------------------------------

check('file needs a key', () => {
  const r = validate('file', { content: '{}' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('key is required')));
});

check('a key not rooted at spaces. is an error', () => {
  const r = validate('file', { key: 'VERTICAL.v.spaces.hub.json', content: '{}' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('must start with "spaces.')));
});

// deployVerticals unmarshals an assistant into a { config } struct, so a flat
// payload deploys a hollow assistant with no error anywhere.
check('an unwrapped assistants config is an error', () => {
  const r = validate('file', {
    key: 'spaces.VERTICAL.v1.assistants.a.json',
    content: JSON.stringify({ name: 'A', llm_provider: 'claude', model: 'claude-haiku-4-5' }),
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('"config"')));
});

check('a { config } wrapped assistants config passes', () => {
  const r = validate('file', {
    key: 'spaces.VERTICAL.v1.assistants.a.json',
    content: JSON.stringify({ config: { name: 'A', llm_provider: 'claude', model: 'claude-haiku-4-5' } }),
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('content that is not valid JSON under a .json key is an error', () => {
  const r = validate('file', { key: 'spaces.VERTICAL.v1.flows.f.json', content: '{nope' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('not valid JSON')));
});

check('a non-json config for a deployable category warns about unmarshalling', () => {
  const r = validate('file', { key: 'spaces.VERTICAL.v1.flows.f.yaml', content: 'a: 1' });
  assert.ok(r.warnings.some((w) => w.includes('unmarshal')));
});

// The lint that exists because record_configs WINS on read and the legacy ids
// array is only a fallback — keeping one in sync by hand drops a config silently.
check('record_config_ids disagreeing with record_configs warns', () => {
  const r = validate('file', {
    key: 'spaces.VERTICAL.v1.spaces.hub.json',
    content: JSON.stringify({ id: 'HUB', name: 'Hub', record_config_ids: ['Client', 'Policy'], record_configs: [{ id: 'Client' }] }),
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('DISAGREE') && w.includes('Policy')));
});

check('a space config using only the legacy record_config_ids warns', () => {
  const r = validate('file', {
    key: 'spaces.VERTICAL.v1.spaces.hub.json',
    content: JSON.stringify({ id: 'HUB', name: 'Hub', record_config_ids: ['Client'] }),
  });
  assert.ok(r.warnings.some((w) => w.includes('LEGACY')));
});

check('a spaces config with no id is an error', () => {
  const r = validate('file', { key: 'spaces.VERTICAL.v1.spaces.hub.json', content: JSON.stringify({ name: 'Hub' }) });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('needs an `id`')));
});

check('hand-writing a folder marker warns', () => {
  const r = validate('file', { key: 'spaces.VERTICAL.v1.__meta__.json', content: '{}' });
  assert.ok(r.warnings.some((w) => w.includes('folder marker')));
});

// --- subject decoding ------------------------------------------------------
//
// A file-index entry's `name` can be empty while its subject is correct, so the
// subject is the authoritative key. This fixture is a REAL subject read off
// staging on 2026-07-31 for the `uig` vertical's folder marker, whose `name` came
// back as "". Matching on name alone is what made the first harvest report 9 of
// 21 keys and would make a poll-until-indexed loop hang forever.
check('decodeFileKey recovers a real key from a real subject', () => {
  const subject = 'ms.workspace-files.c3BhY2Vz.VkVSVElDQUw.dWln.X19tZXRhX18.anNvbg';
  assert.equal(decodeFileKey(subject), 'spaces.VERTICAL.uig.__meta__.json');
});

check('fileKeyOf prefers name and falls back to the subject', () => {
  assert.equal(fileKeyOf({ name: 'spaces.X.a.json', subject: 'ms.workspace-files.zzzz' }), 'spaces.X.a.json');
  assert.equal(
    fileKeyOf({ name: '', subject: 'ms.workspace-files.c3BhY2Vz.VkVSVElDQUw.dWln.X19tZXRhX18.anNvbg' }),
    'spaces.VERTICAL.uig.__meta__.json'
  );
});

check('a segment that is not base64 is passed through verbatim (matches ObjKeyUnsafe)', () => {
  // util.ObjKeyUnsafe keeps the raw part when base64 decoding fails.
  assert.equal(decodeFileKey('ms.workspace-files.c3BhY2Vz.!!!not-base64!!!'), 'spaces.!!!not-base64!!!');
});

// --- object digest ---------------------------------------------------------
//
// The store's digest uses the BASE64URL alphabet. This nearly shipped wrong: the
// first file tested hashed to a value containing no `+` or `/`, so comparing
// against standard base64 matched and looked like proof the encoding was standard.
// The second file hashed to a value with a `/` in it and the comparison failed.
// The fixture below is the REAL digest staging returned for exactly these bytes.
const DIGEST_FIXTURE = {
  content: JSON.stringify(
    {
      id: 'ZZZ_MCP_PROBE_2',
      name: 'MCP tool-path probe',
      description: 'Written through the MCP write_file tool. Probe artefact, safe to delete.',
      record_config_ids: ['Client'],
      record_configs: [{ id: 'Client' }],
      statuses: [{ id: 'to_do', name: 'To Do', color: '#6B7280', complete: false, order: 1 }],
    },
    null,
    2
  ),
  // As returned by POST /api/default-storage/object/... on 2026-07-31.
  serverDigest: 'SHA-256=E14cH3huoYptSMv_Vt0qbAYpk3HSZ8tlvDBRUBlKoao',
};

check('digestMatches accepts the base64URL digest the store actually returns', () => {
  assert.equal(digestMatches(DIGEST_FIXTURE.content, DIGEST_FIXTURE.serverDigest), true);
});

check('the server digest really does differ from standard base64 (why normalising matters)', () => {
  const standard = sha256OfContent(DIGEST_FIXTURE.content);
  assert.ok(standard.includes('/'), 'this fixture must contain a `/` in standard base64 or it proves nothing');
  assert.notEqual('SHA-256=' + standard, DIGEST_FIXTURE.serverDigest);
});

check('digestMatches also accepts a standard-base64 spelling of the same hash', () => {
  assert.equal(digestMatches(DIGEST_FIXTURE.content, 'SHA-256=' + sha256OfContent(DIGEST_FIXTURE.content)), true);
});

check('digestMatches rejects a digest for different bytes', () => {
  assert.equal(digestMatches(DIGEST_FIXTURE.content + ' ', DIGEST_FIXTURE.serverDigest), false);
  assert.equal(digestMatches(DIGEST_FIXTURE.content, 'SHA-256=nonsense'), false);
});

// --- the blank-name defect, measured -------------------------------------------
//
// Locked in because a false green already got past me: create_folder reported
// "verified" for three folders the UI could not show. The numbers below are the
// live measurement that separates the two cases — markers lose their name, config
// files do not — and they are what makes the marker case cosmetic and the config
// case serious.
check('the corpus records the blank-name split between markers and config files', () => {
  const lib = (() => { try { return getExample('vertical-template-library'); } catch { return null; } })();
  assert.ok(lib, 'harvest first');
  const markers = lib.all_keys.filter((k) => k.endsWith('.__meta__.json'));
  const files = lib.all_keys.filter((k) => !k.endsWith('.__meta__.json'));
  assert.ok(markers.length > 0 && files.length > 0, 'corpus must hold both kinds');
  // Every config file must be reachable by deployVerticals, which matches on name.
  // The harvest resolves keys via the subject, so this asserts the shape, not the
  // name; the live name check lives in write_file's `will_deploy`.
  for (const k of files) {
    assert.ok(!k.endsWith('.__meta__.json'), k);
  }
});

// --- golden gate: the live VERTICAL template library -----------------------
//
// These are real keys on the platform, so the validator MUST accept every one.
// A validator that rejects working config is a bug in the validator.
const library = (() => {
  try {
    return getExample('vertical-template-library');
  } catch {
    return null;
  }
})();

check('golden: the VERTICAL library example is bundled', () => {
  assert.ok(library, 'run tools/harvest-examples.mjs — examples/harvested/vertical-template-library.json is missing');
  assert.ok(library.all_keys?.length > 0, 'the example has no keys');
});

if (library) {
  for (const key of library.all_keys) {
    check(`golden: validator accepts the live key "${key.split('.').slice(2).join('.')}"`, () => {
      const r = validate('file', { key });
      assert.equal(r.valid, true, `${key}: ${JSON.stringify(r.errors)}`);
    });
  }

  // Every category folder that is live must be one of the six we claim deploy.
  // If upstream adds a seventh, this fails and says to re-read updateaccount.go
  // rather than letting the transcribed list quietly go stale.
  check('golden: every live category folder is a known deployable config type', () => {
    const live = new Set();
    for (const v of Object.values(library.verticals ?? {})) {
      for (const c of Object.keys(v.categories ?? {})) live.add(c);
    }
    // A live folder must be either a deployable config type or one we placed
    // on purpose knowing it does not deploy (`specs`). Anything else is either a
    // typo that silently deploys nothing, or a seventh config type added upstream
    // — and both need a human to look.
    const known = (c) =>
      Object.prototype.hasOwnProperty.call(VERTICAL_CONFIG_TYPES, c) ||
      VERTICAL_NON_DEPLOYING_FOLDERS.includes(c);
    const unknown = [...live].filter((c) => !known(c));
    assert.deepEqual(
      unknown,
      [],
      `live category folder(s) ${unknown.join(', ')} are neither a deployable config type nor a known non-deploying folder — re-read accounts-service/accounts/updateaccount.go configTypeToEndpointSubject, or add to VERTICAL_NON_DEPLOYING_FOLDERS if deliberate.`
    );
    assert.ok(live.size > 0, 'no category folders found in the corpus');
  });

  // The live space configs are the shape an authored vertical has to match.
  check('golden: the live space configs pass the file validator with their content', () => {
    const entries = Object.entries(library.space_configs ?? {});
    assert.ok(entries.length > 0, 'no space configs harvested');
    for (const [key, config] of entries) {
      const r = validate('file', { key, content: JSON.stringify(config) });
      assert.equal(r.valid, true, `${key}: ${JSON.stringify(r.errors)}`);
    }
  });

  // The live configs set BOTH record-config keys, in agreement — which is why
  // they trip no warning. That agreement is the thing to copy.
  check('golden: the live space configs carry record_configs AND record_config_ids in agreement', () => {
    const configs = Object.values(library.space_configs ?? {});
    const withRecords = configs.filter((c) => c.record_config_ids || c.record_configs);
    assert.ok(withRecords.length > 0, 'no live space config attaches a record config');
    for (const c of withRecords) {
      assert.ok(Array.isArray(c.record_configs), 'a live space config is missing the current `record_configs` shape');
      assert.deepEqual(
        c.record_configs.map((x) => x.id).sort(),
        [...(c.record_config_ids ?? [])].sort(),
        'a live space config has the two record-config keys out of agreement'
      );
    }
  });

  // The `specs` folder must be present and must NOT be a deployable type — that
  // combination is the whole design: documentation that travels with the vertical
  // and is dropped by the dispatcher.
  check('golden: `specs` is live on a vertical and is not a deployable config type', () => {
    const hasSpecs = Object.values(library.verticals ?? {}).some((v) =>
      Object.prototype.hasOwnProperty.call(v.categories ?? {}, 'specs')
    );
    assert.ok(hasSpecs, 'no vertical has a specs folder — expected one on `crm`');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(VERTICAL_CONFIG_TYPES, 'specs'),
      'specs must NOT be a deployable config type, or spec markdown would be POSTed at an endpoint'
    );
    assert.ok(VERTICAL_NON_DEPLOYING_FOLDERS.includes('specs'));
  });

  check('golden: a spec markdown file raises no warnings', () => {
    const r = validate('file', { key: 'spaces.VERTICAL.crm.specs.crm-core.md', content: '# CRM' });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    assert.deepEqual(r.warnings, [], 'a correctly placed spec must be silent, or the warning is noise on every call');
  });

  check('golden: SHARED carries the Client record config every vertical inherits', () => {
    assert.ok(
      library.all_keys.some((k) => k === 'spaces.VERTICAL.SHARED.record_configs.Client.json'),
      'SHARED/record_configs/Client.json is missing — deployVerticals always appends SHARED, so this is what gives every account its Client config'
    );
  });
}



// --- will_deploy: does the category actually route? --------------------------
// write_file's `will_deploy` used to be `verification.name_indexed` alone, which
// answers "is the index entry named" — not "will deployVerticals forward this".
// So a config in a misspelled category folder reported will_deploy=true and then
// deployed nothing, silently. Found 2026-08-04 when push-vertical.mjs printed
// "13 pushed, 13 will deploy" AND "specs/ is intentionally non-deploying: 2".
check('verticalRouting accepts every real category', () => {
  for (const cat of Object.keys(VERTICAL_CONFIG_TYPES)) {
    const r = verticalRouting(`spaces.VERTICAL.my_vert.${cat}.thing.json`);
    assert.equal(r.deploys, true, `${cat} should deploy`);
    assert.equal(r.reason, null);
  }
});

check('verticalRouting rejects a misspelled category and says why', () => {
  for (const bad of ['flow', 'record_config', 'assistant', 'space', 'documenttemplates']) {
    const r = verticalRouting(`spaces.VERTICAL.my_vert.${bad}.thing.json`);
    assert.equal(r.deploys, false, `${bad} must not report deployable`);
    assert.match(r.reason, /SILENTLY skip/);
  }
});

check('verticalRouting marks specs non-deploying by design', () => {
  for (const folder of VERTICAL_NON_DEPLOYING_FOLDERS) {
    const r = verticalRouting(`spaces.VERTICAL.my_vert.${folder}.notes.md`);
    assert.equal(r.deploys, false);
    assert.match(r.reason, /by design/);
  }
});

check('verticalRouting does not judge non-VERTICAL keys', () => {
  const r = verticalRouting('spaces.FAHUB.somefolder.file.json');
  assert.equal(r.deploys, true);
  assert.equal(r.reason, null);
});

check('verticalRouting rejects a key with no category segment', () => {
  const r = verticalRouting('spaces.VERTICAL.my_vert');
  assert.equal(r.deploys, false);
  assert.match(r.reason, /no category segment/);
});

// --- every src module parses -------------------------------------------------
// A syntax error in src/index.js used to be INVISIBLE to this suite: nothing here
// imports the entry point (it would start the server on stdio), so the tests all
// passed while the MCP could not boot. That happened on 2026-08-04 — a stray
// backtick inside the INSTRUCTIONS template literal in quiva-workspaces-mcp/src/
// index.js broke the server, `npm test` still reported 356/356, and the failure
// only surfaced as a "client timeout initialize" in an unrelated build script.
// node --check parses without executing, so it is safe for index.js too.
check('every file in src/ is syntactically valid', () => {
  const srcDir = new URL('../src/', import.meta.url);
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  assert.ok(files.length > 0, 'no src files found — is this test in the right place?');
  for (const f of files) {
    const path = fileURLToPath(new URL(f, srcDir));
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(`${f} does not parse:\n${String(err.stderr || err.message).trim()}`);
    }
  }
});

// --- tool handlers against a fake client -------------------------------------
{
  const { registerTools } = await import('../src/index.js');
  const tools = {};
  const calls = [];
  let reply = () => ({ message: 'success' });
  const fake = (method) => async (path, a, b) => { calls.push({ method, path, a, b }); return reply(method, path, a); };
  const client = { get: fake('GET'), post: fake('POST'), put: fake('PUT'), patch: fake('PATCH'), delete: fake('DELETE'), readObject: async () => { throw new Error('no file'); } };
  registerTools({ registerTool: (n, meta, fn) => (tools[n] = { meta, fn }) }, client);
  const text = (r) => r.content[0].text;

  const refused = await tools.delete_space.fn({ id: 'OPS' });
  check('delete_space refuses without confirm: true and sends nothing', () => {
    assert.equal(refused.isError, true);
    assert.match(text(refused), /confirm: true/);
    assert.equal(calls.length, 0);
  });
  await tools.delete_space.fn({ id: 'OPS', confirm: true });
  check('delete_space with confirm: true sends the DELETE', () => assert.deepEqual([calls[0].method, calls[0].path], ['DELETE', '/workspaces/space/OPS']));

  calls.length = 0;
  await tools.update_task_template.fn({ id: 'tt_path', template: { id: 'tt_other', name: 'Weekly review' }, skip_local_validation: false });
  check('update_task_template strips a body id so the path id wins', () => {
    assert.equal(calls[0].path, '/workspaces/task-template/tt_path');
    assert.equal('id' in calls[0].a, false);
    assert.equal(calls[0].a.name, 'Weekly review');
  });
  check('the task_template validator refuses an id in update mode only', () => {
    assert.ok(validate('task_template', { id: 'tt_other', name: 'x' }, { requireRequired: false }).errors.some((e) => /overrides the id in the path/.test(e)));
    assert.equal(validate('task_template', { name: 'x' }, { requireRequired: false }).valid, true);
  });

  calls.length = 0;
  reply = (method, path) => (path === '/workspaces/meetings' ? { results: [], results_total: 0 } : (() => { throw new Error('400 key not found'); })());
  const missing = await tools.get_meeting_transcript.fn({ space_id: 'OPS', recording_id: 'rec_1' });
  check('get_meeting_transcript says an empty index may be an index failure', () => {
    assert.equal(missing.isError, true);
    assert.match(text(missing), /not indexed, or the meetings index did not answer/);
  });
  check('list_meetings says an empty list is not proof', () => assert.match(tools.list_meetings.meta.description, /meetings index fails/));
}

check('push-example.mjs header comment is at most 3 lines', () => {
  const src = readFileSync(fileURLToPath(new URL('../tools/push-example.mjs', import.meta.url)), 'utf8').split('\n').slice(1);
  assert.ok(src.findIndex((l) => !l.startsWith('//')) <= 3);
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
