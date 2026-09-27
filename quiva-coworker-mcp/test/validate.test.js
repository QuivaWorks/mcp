// Pure pre-check tests. Run: npm test (no network).
import assert from 'node:assert/strict';
import {
  checkScope, confirmGate, todoResumesRun, checkTodoUpdate, checkMemory, checkPersonalProfile,
  checkOrgProfile, isOrgProfileEmpty, normaliseOrgProfile, checkCorrections, checkEnvVar, isSecretRef, looksLikeCredentialKey, validate,
} from '../src/validate.js';
import { listReferenceTopics, getReference, GOTCHAS, ENDPOINTS } from '../src/coworker-docs.js';
import { listExamples, getExample, EXAMPLES } from '../src/examples.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
let count = 0;
function check(name, fn) {
  count++;
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}

// Scope
check('scope accepts organisation and user', () => {
  assert.equal(checkScope('organisation'), null);
  assert.equal(checkScope('user'), null);
});
check('scope rejects a typo the server would widen', () => {
  assert.ok(checkScope('personal'));
  assert.ok(checkScope('org'));
  assert.ok(checkScope(undefined));
});

// Confirm gate
check('confirm gate refuses without confirm', () => {
  const r = confirmGate({ confirm: undefined, what: 'X' });
  assert.equal(r.refused, true);
  assert.equal(r.needs_confirm, true);
});
check('confirm gate refuses a truthy non-true confirm', () => {
  assert.equal(confirmGate({ confirm: 'yes', what: 'X' }).refused, true);
});
check('confirm gate passes confirm: true', () => {
  assert.equal(confirmGate({ confirm: true, what: 'X' }), null);
});

// Todo resume rule
check('awaiting_user -> pending resumes', () => assert.equal(todoResumesRun('awaiting_user', 'pending'), true));
check('awaiting_user -> in_progress resumes', () => assert.equal(todoResumesRun('awaiting_user', 'in_progress'), true));
check('awaiting_user -> done does not resume', () => assert.equal(todoResumesRun('awaiting_user', 'done'), false));
check('pending -> in_progress does not resume', () => assert.equal(todoResumesRun('pending', 'in_progress'), false));

check('todo update needs a field', () => {
  const r = checkTodoUpdate({ scope: 'user', id: 't1' });
  assert.equal(r.valid, false);
});
check('todo follow_up_at requires awaiting_user', () => {
  assert.equal(checkTodoUpdate({ scope: 'user', id: 't1', follow_up_at: '2026-10-01T09:00:00Z' }).valid, false);
  assert.equal(checkTodoUpdate({ scope: 'user', id: 't1', status: 'awaiting_user', follow_up_at: '2026-10-01T09:00:00Z' }).valid, true);
});
check('todo rejects an unknown status', () => {
  assert.equal(checkTodoUpdate({ scope: 'user', id: 't1', status: 'blocked' }).valid, false);
});

// Memory
check('memory requires text', () => assert.equal(checkMemory({ scope: 'user', memory: ' ' }).valid, false));
check('memory 2048-byte cap counts bytes', () => {
  assert.equal(checkMemory({ scope: 'user', memory: 'a'.repeat(2048) }).valid, true);
  assert.equal(checkMemory({ scope: 'user', memory: 'é'.repeat(1025) }).valid, false);
});
check('memory topics capped at 10 and non-empty', () => {
  assert.equal(checkMemory({ scope: 'user', memory: 'x', topics: Array(11).fill('t') }).valid, false);
  assert.equal(checkMemory({ scope: 'user', memory: 'x', topics: [''] }).valid, false);
});

// Profiles
check('empty personal profile is refused', () => {
  const r = checkPersonalProfile({ about_me: '', how_i_work: '  ', constraints: '' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('empty personal profile')));
});
check('personal profile field cap is 1000 characters', () => {
  assert.equal(checkPersonalProfile({ about_me: 'a'.repeat(1001) }).valid, false);
  assert.equal(checkPersonalProfile({ about_me: 'a'.repeat(1000) }).valid, true);
});
check('personal profile counts characters, not bytes', () => {
  assert.equal(checkPersonalProfile({ about_me: 'é'.repeat(1000) }).valid, true);
});
check('empty organisation profile is refused', () => {
  const r = checkOrgProfile({ legal_name: '', trading_names: [], glossary: [] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('empty organisation profile')));
});
check('org profile with only a glossary is not empty', () => {
  assert.equal(isOrgProfileEmpty({ glossary: [{ term: 'OKR', meaning: 'objectives' }] }), false);
  assert.equal(checkOrgProfile({ glossary: [{ term: 'OKR', meaning: 'objectives' }] }).valid, true);
});
check('org profile of only blanks is empty, as the server normalises it', () => {
  const blanks = { always: ['  ', ''], glossary: [{ term: ' ', meaning: '' }], systems_of_record: [{ system: '', authoritative_for: '\t' }], what_we_do: '   ' };
  assert.equal(isOrgProfileEmpty(blanks), true);
  const r = checkOrgProfile(blanks);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('empty organisation profile')));
});
check('a half-filled glossary entry is kept, like capGlossary', () => {
  assert.equal(isOrgProfileEmpty({ glossary: [{ term: 'OKR', meaning: ' ' }] }), false);
  assert.deepEqual(normaliseOrgProfile({ glossary: [{ term: ' OKR ', meaning: ' ' }] }).glossary, [{ term: 'OKR', meaning: '' }]);
});
check('blank list entries do not count toward the entry cap', () => {
  assert.equal(checkOrgProfile({ always: [...Array(20).fill('x'), ' ', ''] }).valid, true);
  assert.equal(checkOrgProfile({ always: Array(21).fill('x') }).valid, false);
});
check('org profile caps list entries', () => {
  assert.equal(checkOrgProfile({ always: Array(21).fill('x') }).valid, false);
});

// Corrections
const correction = (n) => ({ situation: `situation ${n}`, instead: `instead ${n}` });
check('six corrections pass', () => assert.equal(checkCorrections([1, 2, 3, 4, 5, 6].map(correction)).valid, true));
check('seven corrections are refused', () => {
  const r = checkCorrections([1, 2, 3, 4, 5, 6, 7].map(correction));
  assert.equal(r.valid, false);
  assert.ok(r.errors[0].includes('at most 6'));
});
check('correction lengths are capped', () => {
  assert.equal(checkCorrections([{ situation: 'a'.repeat(151), instead: 'b' }]).valid, false);
  assert.equal(checkCorrections([{ situation: 'a', instead: 'b'.repeat(201) }]).valid, false);
});
check('correction ids must be unique', () => {
  assert.equal(checkCorrections([{ id: 'c_1', ...correction(1) }, { id: 'c_1', ...correction(2) }]).valid, false);
});

// Env and secrets
check('secret ref grammar matches coworkerenv', () => {
  assert.equal(isSecretRef('SECRET::api_token::'), true);
  assert.equal(isSecretRef(' SECRET::api_token:: '), true);
  for (const bad of ['SECRET::', 'SECRET::::', 'SECRET::a::b::', 'SECRET::a:b::', 'xSECRET::a::']) {
    assert.equal(isSecretRef(bad), false, bad);
  }
});
check('secret: true refuses a literal', () => {
  const r = checkEnvVar({ scope: 'user', key: 'REPORTING_API_TOKEN', value: 'abc123', secret: true });
  assert.equal(r.valid, false);
});
check('credential-looking key refuses a literal', () => {
  const r = checkEnvVar({ scope: 'user', key: 'REPORTING_API_TOKEN', value: 'abc123', secret: false });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('looks like a credential')));
});
check('malformed reference is refused', () => {
  assert.equal(checkEnvVar({ scope: 'user', key: 'A_TOKEN', value: 'SECRET::a::b::', secret: true }).valid, false);
  assert.equal(checkEnvVar({ scope: 'user', key: 'REGION', value: 'SECRET::a:b::', secret: false }).valid, false);
});
check('a reference must be marked secret', () => {
  assert.equal(checkEnvVar({ scope: 'user', key: 'REGION', value: 'SECRET::region::', secret: false }).valid, false);
});
check('well-formed secret and plain literal pass', () => {
  assert.equal(checkEnvVar({ scope: 'user', key: 'REPORTING_API_TOKEN', value: 'SECRET::reporting::', secret: true }).valid, true);
  assert.equal(checkEnvVar({ scope: 'organisation', key: 'REPORT_TIMEZONE', value: 'Europe/London', secret: false }).valid, true);
});
check('secret flag is required', () => {
  assert.equal(checkEnvVar({ scope: 'user', key: 'REGION', value: 'eu' }).valid, false);
});
check('credential words match whole segments only', () => {
  assert.equal(looksLikeCredentialKey('SERVICE_API_KEY'), true);
  assert.equal(looksLikeCredentialKey('AUTH_HEADER'), true);
  assert.equal(looksLikeCredentialKey('AUTHOR_NAME'), false);
  assert.equal(looksLikeCredentialKey('MONKEY_COUNT'), false);
});
check('extended credential words are caught', () => {
  for (const k of ['DB_PASS', 'DB_PASSWD', 'BEARER_VALUE', 'SENTRY_DSN', 'AWS_ACCESS_ID', 'SIGNING_SALT', 'PRIVATE_PEM']) {
    assert.equal(looksLikeCredentialKey(k), true, k);
  }
  assert.equal(looksLikeCredentialKey('PASSENGER_COUNT'), false);
});
check('env key shape is enforced', () => {
  assert.equal(checkEnvVar({ scope: 'user', key: 'lower_case', value: 'x', secret: false }).valid, false);
});

check('validate dispatches every kind', () => {
  for (const kind of ['todo_update', 'memory', 'personal_profile', 'org_profile', 'corrections', 'env_var']) {
    assert.equal(typeof validate(kind, {}).valid, 'boolean', kind);
  }
  assert.equal(validate('nope', {}).valid, false);
});

// Docs and examples
check('every reference topic resolves', () => {
  for (const { topic } of listReferenceTopics()) assert.equal(getReference(topic).error, undefined, topic);
  assert.ok(getReference('nope').error);
});
check('not-exposed records the withheld and unmapped routes', () => {
  const doc = JSON.stringify(getReference('not-exposed'));
  for (const s of ['todos-admin', 'PUT /hub/agent/model-pool', 'skill-discover', 'todo/schedule']) assert.ok(doc.includes(s), s);
});
check('endpoint table covers only /hub routes', () => {
  assert.ok(ENDPOINTS.length > 20);
  for (const e of ENDPOINTS) assert.ok(e.path.startsWith('/hub/'), e.path);
});
check('authored examples pass their own validators', () => {
  const kinds = { create_memory: 'memory', set_env: 'env_var', update_personal_profile: 'personal_profile', update_org_profile: 'org_profile' };
  for (const e of listExamples()) {
    const ex = getExample(e.slug);
    const kind = kinds[ex.tool];
    if (kind) assert.equal(validate(kind, ex.payload).valid, true, `${e.slug}: ${JSON.stringify(validate(kind, ex.payload).errors)}`);
  }
  assert.ok(Object.keys(EXAMPLES).length >= 5);
});
check('gotchas are non-empty strings', () => assert.ok(GOTCHAS.every((g) => typeof g === 'string' && g.length > 20)));

// Shipped copy stays production-only, vertical-agnostic and uses the product name.
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === '.env') return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
check('shipped copy stays production-only and vertical-agnostic', () => {
  // Built from fragments so this file does not itself contain the banned words.
  const banned = [['micro', 'strate\\.io'], ['\\bAn', 'nie\\b'], ['\\bbro', 'ker\\b'], ['\\bM', 'GA\\b'], ['under', 'writ'], ['\\bprem', 'ium\\b'], ['\\bins', 'ur']]
    .map(([a, b]) => new RegExp(a + b, /^\\bM/.test(a) || /An/.test(a) ? '' : 'i'));
  for (const f of files(PKG)) {
    const text = readFileSync(f, 'utf8');
    for (const re of banned) assert.ok(!re.test(text), `${f} matches ${re}`);
  }
});

check('engine citations are full paths, so engine/sync.mjs tracks them', () => {
  for (const f of files(join(PKG, 'src'))) {
    const bare = readFileSync(f, 'utf8').match(/(?<![A-Za-z0-9/_.-])[a-z_]+\.go\b/g);
    assert.equal(bare, null, `${f} cites ${bare}`);
  }
});

console.log(`\n${count - failures}/${count} checks passed`);
if (failures) process.exit(1);
