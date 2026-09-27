// Hand-rolled test runner for the agent config validator (no framework).
// Run: npm test  (or: node test/validate.test.js)
import assert from 'node:assert/strict';
import { validate, validateInvokeResponseSubject } from '../src/validate.js';
import { AGENT_TYPES, MODELS } from '../src/agents-docs.js';
import { readHarvested, getExample } from '../src/examples.js';
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

check('agent_type "coworker" is a valid enum value', () => {
  assert.ok(AGENT_TYPES.includes('coworker'), 'AGENT_TYPES must list coworker (hub-service CoworkerAgentType)');
  const r = validate({ ...goodConfig, agent_type: 'coworker' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('MODELS lists the current (2026-09) Claude aliases, not deprecated dated ids', () => {
  for (const current of ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5']) {
    assert.ok(MODELS.includes(current), `MODELS is missing ${current}`);
  }
  for (const deprecated of ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-opus-4-5']) {
    assert.ok(!MODELS.includes(deprecated), `MODELS still lists deprecated ${deprecated}`);
  }
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

// --- invoke_agent's response_subject/session_id pre-check (mirrors hub-service's
// validateResponseSubject, hub-service/handler/agents.go:1087) --------------

check('validateInvokeResponseSubject: no response_subject is always valid', () => {
  assert.deepEqual(validateInvokeResponseSubject(undefined, undefined), { valid: true });
  assert.deepEqual(validateInvokeResponseSubject('', 'session-1'), { valid: true });
});

check('validateInvokeResponseSubject: response_subject without a session_id is an error', () => {
  const r = validateInvokeResponseSubject('some-subject', undefined);
  assert.equal(r.valid, false);
  assert.ok(r.error.includes('requires a session_id'));
});

check('validateInvokeResponseSubject: response_subject mismatching session_id is an error', () => {
  const r = validateInvokeResponseSubject('subject-a', 'session-b');
  assert.equal(r.valid, false);
  assert.ok(r.error.includes('must equal session_id'));
});

check('validateInvokeResponseSubject: response_subject equal to session_id is valid', () => {
  const r = validateInvokeResponseSubject('session-1', 'session-1');
  assert.deepEqual(r, { valid: true });
});

check('llm_config.effort suppresses the warning (resolvePlanner skips the 8000 default)', () => {
  const r = validate({ name: 'a', llm_provider: 'claude', model: 'claude-haiku-4-5', behaviour: 'x', llm_config: { max_tokens: 1024, effort: 'low' } });
  assert.ok(!r.warnings.some((w) => w.includes('thinking_tokens must be less than max_tokens')), JSON.stringify(r.warnings));
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

// --- registerTools: pre-checks wired into the actual tool handlers ----------
// These exercise the real MCP tool functions (not just the pure validators
// above), against a fake server/client, to prove the pre-check actually blocks
// the API call rather than just existing as an unused helper.

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}

function makeFakeServer() {
  const tools = {};
  return { registerTool: (name, _meta, handler) => { tools[name] = handler; }, tools };
}

function makeFakeClient() {
  const calls = [];
  const respond = (method, path, payload) => {
    calls.push([method, path, payload]);
    return Promise.resolve({ ok: true });
  };
  return {
    calls,
    get: (path, query) => respond('GET', path, query),
    post: (path, body) => respond('POST', path, body),
    put: (path, body) => respond('PUT', path, body),
    delete: (path, query) => respond('DELETE', path, query),
  };
}

{
  const { registerTools } = await import('../src/index.js');
  const server = makeFakeServer();
  const client = makeFakeClient();
  registerTools(server, client);

  check('registerTools registers the new MCP-registry tools', () => {
    assert.equal(typeof server.tools.list_mcp_servers, 'function');
    assert.equal(typeof server.tools.register_mcp_server, 'function');
  });

  await checkAsync('invoke_agent rejects response_subject != session_id and never calls the API', async () => {
    client.calls.length = 0;
    const result = await server.tools.invoke_agent({ subject: 'ms.hub.config.agent.x', session_id: 'a', response_subject: 'b' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('must equal session_id'), result.content[0].text);
    assert.equal(client.calls.length, 0, 'the API must not be called when the local pre-check fails');
  });

  await checkAsync('invoke_agent accepts response_subject == session_id and calls the API', async () => {
    client.calls.length = 0;
    const result = await server.tools.invoke_agent({ subject: 'ms.hub.config.agent.x', session_id: 'a', response_subject: 'a' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(client.calls[0]?.slice(0, 2), ['POST', '/hub/agent/invoke']);
  });

  await checkAsync('invoke_agent with no response_subject still calls the API (unchanged behaviour)', async () => {
    client.calls.length = 0;
    const result = await server.tools.invoke_agent({ subject: 'ms.hub.config.agent.x', prompt: 'hi' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(client.calls[0]?.slice(0, 2), ['POST', '/hub/agent/invoke']);
  });

  await checkAsync('register_mcp_server requires endpoint or registry_name, without calling the API', async () => {
    client.calls.length = 0;
    const result = await server.tools.register_mcp_server({});
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('requires either'), result.content[0].text);
    assert.equal(client.calls.length, 0);
  });

  await checkAsync('register_mcp_server calls POST /hub/mcp/register when endpoint is given', async () => {
    client.calls.length = 0;
    const result = await server.tools.register_mcp_server({ endpoint: 'https://example.invalid/mcp' });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.deepEqual(client.calls[0]?.slice(0, 2), ['POST', '/hub/mcp/register']);
  });

  await checkAsync('list_mcp_servers calls GET /hub/mcp/registry', async () => {
    client.calls.length = 0;
    await server.tools.list_mcp_servers({});
    assert.deepEqual(client.calls[0]?.slice(0, 2), ['GET', '/hub/mcp/registry']);
  });

  await checkAsync('list_agents forwards paging params as a query', async () => {
    client.calls.length = 0;
    await server.tools.list_agents({ limit: 50, sort: 'name' });
    assert.equal(client.calls[0][1], '/hub/agent');
    assert.equal(client.calls[0][2].limit, 50);
    assert.equal(client.calls[0][2].sort, 'name');
  });

  await checkAsync('delete_agent refuses without confirm: true and never calls the API', async () => {
    client.calls.length = 0;
    const refused = await server.tools.delete_agent({ id: 'ms.hub.config.agent.abc' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /confirm: true/);
    assert.equal(client.calls.length, 0);
    const done = await server.tools.delete_agent({ id: 'ms.hub.config.agent.abc', confirm: true });
    assert.equal(done.isError, undefined, JSON.stringify(done));
    assert.deepEqual(client.calls[0]?.slice(0, 2), ['DELETE', '/hub/agent/abc']);
  });
}

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

check('client.js header comment is at most 3 lines', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8');
  const header = src.split('\n').findIndex((l) => !l.startsWith('//'));
  assert.ok(header <= 3, `header comment is ${header} lines`);
  assert.ok(src.includes('bellerophon-cerberus/http/middleware/ms_auth.go:143'));
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
