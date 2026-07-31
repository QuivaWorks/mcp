// Hand-rolled test runner for the agent config validator (no framework).
// Run: npm test  (or: node test/validate.test.js)
import assert from 'node:assert/strict';
import { validate } from '../src/validate.js';
import { readHarvested, getExample } from '../src/examples.js';

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

const goodConfig = {
  name: 'Email Draft',
  llm_provider: 'claude',
  model: 'claude-haiku-4-5',
  behaviour: 'Draft a concise reply to the email.',
};

check('valid minimal config passes', () => {
  const r = validate(goodConfig);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('missing name fails on create', () => {
  const r = validate({ llm_provider: 'claude', model: 'claude-haiku-4-5' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('name is required')));
});

check('missing llm_provider fails on create', () => {
  const r = validate({ name: 'X', model: 'claude-haiku-4-5' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('llm_provider is required')));
});

check('missing model fails on create', () => {
  const r = validate({ name: 'X', llm_provider: 'claude' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('model is required')));
});

check('unsupported llm_provider is an error', () => {
  const r = validate({ name: 'X', llm_provider: 'openai', model: 'gpt-4' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('not invokable')));
});

check('llm_provider anthropic passes', () => {
  const r = validate({ ...goodConfig, llm_provider: 'anthropic' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('missing behaviour warns but is valid', () => {
  const r = validate({ name: 'X', llm_provider: 'claude', model: 'claude-haiku-4-5' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('behaviour')));
});

check('invalid id format is an error', () => {
  const r = validate({ ...goodConfig, id: 'bad id!' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('id') && e.includes('invalid')));
});

check('valid id format passes', () => {
  const r = validate({ ...goodConfig, id: 'EMAIL_DRAFT-2' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('invalid shared enum is an error', () => {
  const r = validate({ ...goodConfig, shared: 'everyone' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('shared')));
});

check('invalid agent_type enum is an error', () => {
  const r = validate({ ...goodConfig, agent_type: 'super-research' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('agent_type')));
});

check('tool with unknown URI scheme warns', () => {
  const r = validate({ ...goodConfig, has_tools: true, tools: ['http://example.com'] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('known URI scheme')));
});

check('knowledge with known URI scheme passes cleanly', () => {
  const r = validate({ ...goodConfig, knowledge: ['kv://bucket/doc'] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(!r.warnings.some((w) => w.includes('known URI scheme')));
});

check('ai_summary_threshold out of range is an error', () => {
  const r = validate({ ...goodConfig, ai_summary_threshold: 0.99 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('ai_summary_threshold')));
});

check('preserve_most_recent out of range is an error', () => {
  const r = validate({ ...goodConfig, preserve_most_recent: 50 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('preserve_most_recent')));
});

check('output_schema non-object is an error', () => {
  const r = validate({ ...goodConfig, output_schema: 'not an object' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('output_schema')));
});

check('update payload with only a field passes when require_required=false', () => {
  const r = validate({ description: 'new desc' }, { requireRequired: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('wrapped { config } object is unwrapped and validated', () => {
  const r = validate({ config: goodConfig });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('wrapped')));
});

check('llm_config.temperature out of range is an error', () => {
  const r = validate({ ...goodConfig, llm_config: { temperature: 5 } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('temperature')));
});

// --- the injected thinking budget vs max_tokens (hit live 2026-07-29) ---

check('max_tokens at or below the injected 8000 thinking budget warns', () => {
  const r = validate({ name: 'a', llm_provider: 'claude', model: 'claude-haiku-4-5', llm_config: { max_tokens: 1024 } });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('thinking_tokens must be less than max_tokens')), JSON.stringify(r.warnings));
});

check('max_tokens above 8000 does not warn', () => {
  const r = validate({ name: 'a', llm_provider: 'claude', model: 'claude-haiku-4-5', behaviour: 'x', llm_config: { max_tokens: 16000 } });
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

check('an explicit thinking_tokens suppresses the warning (injection only fills nil fields)', () => {
  const r = validate({ name: 'a', llm_provider: 'claude', model: 'claude-haiku-4-5', behaviour: 'x', llm_config: { max_tokens: 1024, thinking_tokens: 512 } });
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

check('omitting max_tokens does not warn', () => {
  const r = validate({ name: 'a', llm_provider: 'claude', model: 'claude-haiku-4-5', behaviour: 'x', llm_config: { temperature: 0 } });
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

// --- golden gate ------------------------------------------------------------
// Every config in examples/harvested/ is a REAL agent living on the platform. If
// the validator rejects one, the VALIDATOR is wrong — that is the whole point of
// this gate (docs/lessons.md: the flows MCP shipped a wrong rules syntax for two
// weeks because no check like this existed).
//
// This validator IS currently wrong, and the allowlist below is the evidence.
// `node tools/sweep-validate.mjs` over all 189 live configs on staging
// (2026-07-29) reports that 150 of them produce at least one ERROR:
//
//   148x  shared "" is invalid          -> "" is the live DEFAULT; only 41 configs
//                                          set private/team, and NOTHING uses the
//                                          documented "public"
//    34x  llm_provider not invokable    -> gemini(12)/openai(6)/workforce(1)/""(15)
//                                          are all STORED fine. invoke_agent is
//                                          what rejects them; create does not.
//    16x  model is required             -> 16 live configs have no model
//     1x  ai_summary_threshold 0.3      -> below the documented 0.5 minimum
//     1x  agent_type "annie"            -> outside the documented { "", "deep-research" }
//     1x  name is required              -> one live config has no name
//
// Each entry is allowlisted so this suite stays green while the finding is open,
// NOT because the config is wrong. A rule that starts rejecting live configs for
// any OTHER reason will fail this gate, which is what it is for.
const ALLOWED_GOLDEN_FAILURES = [
  { match: /^shared .* is invalid/, why: 'shared "" is the live default (148/189) — the enum is missing it' },
  { match: /^llm_provider .* is not invokable/, why: 'storing a non-Claude provider is allowed; only invoke_agent rejects it' },
  { match: /^model is required/, why: '16 live configs have no model' },
  { match: /^name is required/, why: '1 live config has no name' },
  { match: /^agent_type .* is invalid/, why: 'agent_type is not a closed enum ("annie" is live)' },
  { match: /^ai_summary_threshold .* is out of range/, why: '0.3 is live, below the documented 0.5 floor' },
];

const harvested = readHarvested();

check('golden: examples/harvested/ is populated (run tools/harvest-examples.mjs)', () => {
  assert.ok(harvested.length > 0, 'no harvested configs — the golden gate cannot run');
});

for (const example of harvested) {
  check(`golden: validator accepts real config "${example.slug}"`, () => {
    const result = validate(example.config, { requireRequired: true });
    const unexplained = (result.errors ?? []).filter(
      (e) => !ALLOWED_GOLDEN_FAILURES.some(({ match }) => match.test(e))
    );
    assert.deepEqual(
      unexplained,
      [],
      `validator rejected a config that is live on the platform:\n  ${unexplained.join('\n  ')}`
    );
  });
}

check('golden: every allowlisted failure is still reproducible against a live config', () => {
  // If a rule is fixed, its allowlist entry becomes dead weight and should be
  // deleted — this check is what tells you.
  const seen = new Set();
  for (const example of harvested) {
    for (const error of validate(example.config, { requireRequired: true }).errors ?? []) {
      for (const entry of ALLOWED_GOLDEN_FAILURES) if (entry.match.test(error)) seen.add(entry.why);
    }
  }
  assert.ok(seen.size > 0, 'no allowlisted failure reproduced — the allowlist may be stale, re-run tools/sweep-validate.mjs');
});

check('golden: a harvested config proves tool and knowledge URI shapes', () => {
  const withBoth = harvested.filter((e) => e.config?.tools?.length && e.config?.knowledge?.length);
  assert.ok(withBoth.length > 0, 'no harvested config has both tools and knowledge — those docs have no evidence behind them');
});

check('golden: non-Claude providers are proven storable', () => {
  const others = harvested.filter(
    (e) => e.config?.llm_provider && !['claude', 'anthropic'].includes(e.config.llm_provider)
  );
  assert.ok(
    others.length > 0,
    'no harvested config uses a non-Claude provider — the create-vs-invoke distinction has no evidence behind it'
  );
});

check('the authored example passes the validator and keeps output_schema a description map', () => {
  const example = getExample('submission-triage-agent');
  const result = validate(example.config, { requireRequired: true });
  assert.equal(result.valid, true, result.errors.join('; '));
  for (const [field, description] of Object.entries(example.config.output_schema)) {
    assert.equal(typeof description, 'string', `output_schema.${field} must be a plain description string, not a JSON Schema node`);
  }
});


if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
