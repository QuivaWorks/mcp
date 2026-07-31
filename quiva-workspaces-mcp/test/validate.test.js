// Hand-rolled test runner for the workspaces payload validator (no framework).
// Run: npm test  (or: node test/validate.test.js)
import assert from 'node:assert/strict';
import { validate } from '../src/validate.js';
import { harvestedPayloads, getExample } from '../src/examples.js';
import { TIME_LOG_EXAMPLE, TIME_TRACKING_EXAMPLE, TASK_ACTION_EXAMPLE, VERTICAL_CONFIG_TYPES } from '../src/workspaces-docs.js';
import { decodeFileKey, fileKeyOf, digestMatches, sha256OfContent } from '../src/client.js';

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
  const example = getExample('renewal-review-board');
  const r = validate('reaction', example.reaction, { requireRequired: true });
  assert.equal(r.valid, true, `the shipped example must not teach the shortcode form: ${r.errors.join('; ')}`);
  assert.ok(
    example.reaction_key_must_be_a_real_emoji?.verified_live?.includes('2026-07-30'),
    'the example must keep the record of why it changed — it shipped wrong once'
  );
});

// --- time tracking (workspaces-service #1281) ---------------------------------

check('valid time_tracking passes', () => {
  const r = validate('task', { title: 'x', time_tracking: TIME_TRACKING_EXAMPLE }, { requireRequired: true });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('time_tracking must be an object', () => {
  const r = validate('task', { title: 'x', time_tracking: [] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('time_tracking must be an object')));
});

check('a time log without an id is an error (the backend never generates one)', () => {
  const { id, ...noId } = TIME_LOG_EXAMPLE;
  const r = validate('task', { title: 'x', time_tracking: { logs: [noId] } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('logs[0].id is required')), JSON.stringify(r.errors));
});

check('duplicate time log ids are an error', () => {
  const r = validate('task', { title: 'x', time_tracking: { logs: [TIME_LOG_EXAMPLE, TIME_LOG_EXAMPLE] } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('duplicated')), JSON.stringify(r.errors));
});

check('time_spent must carry a numeric time_in_seconds', () => {
  const r = validate('task', {
    title: 'x',
    time_tracking: { logs: [{ ...TIME_LOG_EXAMPLE, time_spent: { time_in_seconds: '90m' } }] },
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('SECONDS')), JSON.stringify(r.errors));
});

check('a negative estimate is an error', () => {
  const r = validate('task', { title: 'x', time_tracking: { estimate: { time_in_seconds: -1 }, logs: [] } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('must not be negative')));
});

// The four merge cases below are what the live probe established. The validator
// cannot change them, but it must WARN in the two that silently lose data.
check('a non-empty logs[] warns that it replaces rather than appends', () => {
  const r = validate('task', { title: 'x', time_tracking: { logs: [TIME_LOG_EXAMPLE] } }, { requireRequired: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('REPLACES')), JSON.stringify(r.warnings));
});

check('time_tracking without logs warns that existing logs are preserved, not cleared', () => {
  const r = validate('task', { time_tracking: { estimate: { time_in_seconds: 3600 } } }, { requireRequired: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('PRESERVES')), JSON.stringify(r.warnings));
});

check('a derived total sent back is flagged as not part of the model', () => {
  const r = validate('task', {
    title: 'x',
    time_tracking: { estimate: { time_in_seconds: 3600 }, logs: [], total_spent: 1800 },
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('total_spent')), JSON.stringify(r.warnings));
});

check('a time log missing its user snapshot warns', () => {
  const { user, ...noUser } = TIME_LOG_EXAMPLE;
  const r = validate('task', { title: 'x', time_tracking: { logs: [noUser] } });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('user is missing')), JSON.stringify(r.warnings));
});

check('a non-RFC3339 started_at warns', () => {
  const r = validate('task', {
    title: 'x',
    time_tracking: { logs: [{ ...TIME_LOG_EXAMPLE, started_at: '2026-07-29' }] },
  });
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

check('every task_action write warns that it cannot be read back', () => {
  const r = validate('task_action', TASK_ACTION_EXAMPLE, { requireRequired: true });
  assert.ok(
    r.warnings.some((w) => w.includes('CANNOT BE READ BACK')),
    'the missing GET route is the single most important thing to say about a task action'
  );
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
  const example = getExample('renewal-review-board');
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
  const example = getExample('renewal-review-board');
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
  const example = getExample('renewal-review-board');
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
  const example = getExample('renewal-review-board');

  const tt = validate('task', { title: example.task.title, time_tracking: example.time_tracking }, { requireRequired: true });
  assert.equal(tt.valid, true, `time_tracking: ${tt.errors.join('; ')}`);
  assert.ok(example.time_tracking.logs.length >= 2, 'one log does not demonstrate that logs[] replaces the whole array');

  const action = validate('task_action', example.task_action, { requireRequired: true });
  assert.equal(action.valid, true, `task_action: ${action.errors.join('; ')}`);

  // The example must keep saying the write is unverifiable, or the next reader
  // will assume a 200 means the action is stored.
  assert.ok(
    example.task_action_cannot_be_verified?.cause?.includes('put.task-action'),
    'the example must name the misrouted GET as the reason a task action cannot be read back'
  );
  assert.ok(
    example.time_tracking_merge_semantics_verified_live?.['logs: [one entry]']?.includes('REPLACED'),
    'the example must record that logs[] replaces rather than appends'
  );
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
    const unknown = [...live].filter((c) => !Object.prototype.hasOwnProperty.call(VERTICAL_CONFIG_TYPES, c));
    assert.deepEqual(
      unknown,
      [],
      `live category folder(s) ${unknown.join(', ')} are not in VERTICAL_CONFIG_TYPES — re-read accounts-service/accounts/updateaccount.go configTypeToEndpointSubject and update the list.`
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

  check('golden: SHARED carries the Client record config every vertical inherits', () => {
    assert.ok(
      library.all_keys.some((k) => k === 'spaces.VERTICAL.SHARED.record_configs.Client.json'),
      'SHARED/record_configs/Client.json is missing — deployVerticals always appends SHARED, so this is what gives every account its Client config'
    );
  });
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
