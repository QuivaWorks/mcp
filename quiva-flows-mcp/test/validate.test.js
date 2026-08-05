// Spot checks for the local validator. Run: node test/validate.test.js
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { applyGeometry } from '../src/geometry.js';
import { validate } from '../src/validate.js';
import { NODE_TYPES } from '../src/node-docs.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}\n     ${err.message}`);
  }
}

const agentNode = (id, extra = {}) => ({
  id,
  data: {
    id,
    node_type: 'agent',
    payload: {
      agent: {
        name: 'test_agent',
        llm_provider: 'claude',
        model: 'claude-haiku-4-5',
      },
      prompt: 'Say hi',
      await: true,
    },
    ...extra,
  },
});

check('flat agent payload is rejected with nesting suggestion', () => {
  const result = validate({
    nodes: [
      {
        id: 'A',
        data: {
          id: 'A',
          node_type: 'agent',
          payload: { api_key: 'KEY', llm_provider: 'claude', model: 'claude-haiku-4-5', prompt: 'hi' },
        },
      },
    ],
    edges: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('payload.agent')), JSON.stringify(result.errors));
});

check('valid simple agent flow passes', () => {
  const result = validate({ nodes: [agentNode('AGENT_A')], edges: [] });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

check('spec example 2 (complexMultiAgent shapes) passes with eval/function/integration', () => {
  const result = validate({
    nodes: [
      agentNode('CODE_EXPERT'),
      {
        id: 'CLEAN_UP',
        data: {
          id: 'CLEAN_UP',
          node_type: 'eval',
          payload: { code: "c.trim()", params: { c: '$.CODE_EXPERT.result' } },
        },
      },
      {
        id: 'ENCODE',
        data: {
          id: 'ENCODE',
          node_type: 'function',
          subject: 'ms.compute.1753641292.function.230114167',
          payload: '$.CLEAN_UP',
        },
      },
      {
        id: 'SLACK',
        data: {
          id: 'SLACK',
          node_type: 'integration',
          integration_id: 'slack',
          payload: {
            base_url: 'https://slack.com/api',
            url: '/chat.postMessage',
            method: 'post',
            data: { channel: '#eng', text: '$.CODE_EXPERT.result' },
          },
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'CODE_EXPERT', target: 'CLEAN_UP' },
      { id: 'e2', source: 'CLEAN_UP', target: 'ENCODE' },
      { id: 'e3', source: 'CODE_EXPERT', target: 'SLACK' },
    ],
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

check('wait node type is rejected with delay suggestion', () => {
  const result = validate({
    nodes: [{ id: 'W', data: { id: 'W', node_type: 'wait', payload: { time_ms: 100 } } }],
    edges: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"delay"')), JSON.stringify(result.errors));
});

check('baseURL is rejected with base_url suggestion', () => {
  const result = validate({
    nodes: [
      {
        id: 'H',
        data: {
          id: 'H',
          node_type: 'http',
          payload: { baseURL: 'https://x.com', url: '/y', method: 'get' },
        },
      },
    ],
    edges: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('base_url')), JSON.stringify(result.errors));
});

check('cycle is detected', () => {
  const result = validate({
    nodes: [agentNode('A'), agentNode('B')],
    edges: [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'e2', source: 'B', target: 'A' },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('cycle')), JSON.stringify(result.errors));
});

check('reserved node id is rejected', () => {
  const result = validate({
    nodes: [agentNode('trigger')],
    edges: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('reserved')), JSON.stringify(result.errors));
});

check('function node without subject is rejected', () => {
  const result = validate({
    nodes: [{ id: 'F', data: { id: 'F', node_type: 'function', payload: '$.trigger' } }],
    edges: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('subject is required')), JSON.stringify(result.errors));
});

check('edge to missing node is rejected', () => {
  const result = validate({
    nodes: [agentNode('A')],
    edges: [{ id: 'e1', source: 'A', target: 'GHOST' }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('target node not found')), JSON.stringify(result.errors));
});

// --- condition / rules DSL --------------------------------------------------
// Shapes below mirror the production "Client Folder Creation" flow
// (examples/client-folder-creation.json) — the payload IS the branch array.

const conditionNode = (id, payload) => ({ id, data: { id, node_type: 'condition', payload } });

const chain = (target) => [
  { condition: { operator: '=', input: ['$.A.duplicate_exists', false] }, outcome: target },
  { outcome: 'RESOLVE_ERROR' },
];

check('condition with bad branch target is rejected; RESOLVE_* allowed', () => {
  const nodes = (target) => [agentNode('A'), conditionNode('C', chain(target))];

  const bad = validate({ nodes: nodes('NOPE'), edges: [{ id: 'e', source: 'A', target: 'C' }] });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes('next step not found')), JSON.stringify(bad.errors));

  const good = validate({ nodes: nodes('A'), edges: [{ id: 'e', source: 'A', target: 'C' }] });
  assert.equal(good.valid, true, JSON.stringify(good.errors));
});

check('legacy { if, then, else } condition payload is rejected with the v2 replacement', () => {
  const result = validate({
    nodes: [
      agentNode('A'),
      conditionNode('C', { rules: [{ if: '$.A.result == "x"', then: ['A'], else: ['RESOLVE_ERROR'] }] }),
    ],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.includes('must BE the conditional chain')),
    JSON.stringify(result.errors)
  );
});

check('bare { if, then, else } branches (no rules wrapper) are rejected', () => {
  const result = validate({
    nodes: [agentNode('A'), conditionNode('C', [{ if: '$.A.x', then: ['A'], else: ['RESOLVE_ERROR'] }])],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('NOT understood by the rules engine')), JSON.stringify(result.errors));
});

check('condition payload that is not a chain is rejected', () => {
  const result = validate({
    nodes: [conditionNode('C', { foo: 'bar' })],
    edges: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be an ARRAY')), JSON.stringify(result.errors));
});

check('unknown rule operator is a hard error (engine silently yields undefined)', () => {
  const result = validate({
    nodes: [
      agentNode('A'),
      conditionNode('C', [
        { condition: { operator: 'doesNotContain', input: ['$.A.result', 'x'] }, outcome: 'A' },
        { outcome: 'RESOLVE_ERROR' },
      ]),
    ],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, false);
  assert.ok(
    result.errors.some((e) => e.includes('not implemented by the rules engine') && e.includes('visual builder')),
    JSON.stringify(result.errors)
  );
});

check('engine-only operator (jPath) is allowed but warns about the editor schema', () => {
  const result = validate({
    nodes: [
      agentNode('A'),
      conditionNode('C', [
        { condition: { operator: 'jPath', input: ['$.A.result', '$.0'] }, outcome: 'A' },
        { outcome: 'RESOLVE_ERROR' },
      ]),
    ],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.some((w) => w.includes('flow editor')), JSON.stringify(result.warnings));
});

check('a condition string instead of an expression object is rejected', () => {
  const result = validate({
    nodes: [agentNode('A'), conditionNode('C', [{ condition: '$.A.result == 200', outcome: 'A' }])],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be an expression object')), JSON.stringify(result.errors));
});

check('chain with no catch-all branch warns', () => {
  const result = validate({
    nodes: [
      agentNode('A'),
      conditionNode('C', [{ condition: { operator: '=', input: ['$.A.result', 'x'] }, outcome: 'A' }]),
    ],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.some((w) => w.includes('no catch-all')), JSON.stringify(result.warnings));
});

check('branch target without a matching edge warns', () => {
  const result = validate({
    nodes: [agentNode('A'), conditionNode('C', chain('A'))],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.ok(result.warnings.some((w) => w.includes('has no edge C -> A')), JSON.stringify(result.warnings));
});

check('non-string outcome is rejected', () => {
  const result = validate({
    nodes: [agentNode('A'), conditionNode('C', [{ condition: { operator: '=', input: ['$.A.x', 1] }, outcome: 42 }])],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be a node id string')), JSON.stringify(result.errors));
});

check('rules node requires a rules MAP, not an array', () => {
  const bad = validate({
    nodes: [{ id: 'R', data: { id: 'R', node_type: 'rules', payload: { rules: [{ outcome: true }] } } }],
    edges: [],
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes('must be a MAP')), JSON.stringify(bad.errors));

  const good = validate({
    nodes: [
      {
        id: 'R',
        data: {
          id: 'R',
          node_type: 'rules',
          payload: {
            facts: { 'score.value': '$.trigger.score' },
            rules: {
              'high_risk.value': [
                { condition: { operator: '>', input: ['@fact:score.value', 80] }, outcome: true },
                { outcome: false },
              ],
            },
          },
        },
      },
    ],
    edges: [],
  });
  assert.equal(good.valid, true, JSON.stringify(good.errors));
});

check('malformed @fact reference is rejected', () => {
  const result = validate({
    nodes: [
      {
        id: 'R',
        data: {
          id: 'R',
          node_type: 'rules',
          payload: { rules: { 'x.value': [{ condition: { operator: '=', input: ['@fact:9bad', 1] }, outcome: true }] } },
        },
      },
    ],
    edges: [],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('fact key')), JSON.stringify(result.errors));
});

check('scalar expression input warns but stays valid (the engine wraps it)', () => {
  // Mirrors the live "Authorise CIP Test" flow:
  // { operator: "empty", input: "$.NODE.body.results" }. resolveDynamicValue
  // wraps a lone operand into [value], so this runs; only the editor's schema
  // insists on an array.
  const result = validate({
    nodes: [
      agentNode('A'),
      conditionNode('C', [
        { condition: { operator: 'empty', input: '$.A.result' }, outcome: 'A' },
        { outcome: 'RESOLVE_ERROR' },
      ]),
    ],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.ok(result.warnings.some((w) => w.includes('wraps a single operand')), JSON.stringify(result.warnings));
});

check('expression with no input at all is rejected', () => {
  const result = validate({
    nodes: [agentNode('A'), conditionNode('C', [{ condition: { operator: '=' }, outcome: 'A' }])],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('is missing "input"')), JSON.stringify(result.errors));
});

check('unresolvable $.X reference produces a warning', () => {
  const result = validate({
    nodes: [
      agentNode('A'),
      {
        id: 'M',
        data: { id: 'M', node_type: 'map', payload: { x: '$.MISSING.result' } },
      },
    ],
    edges: [{ id: 'e', source: 'A', target: 'M' }],
  });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes('MISSING')), JSON.stringify(result.warnings));
});

check('duplicate node ids rejected', () => {
  const result = validate({ nodes: [agentNode('A'), agentNode('A')], edges: [] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate node id')), JSON.stringify(result.errors));
});

check('static node with JSONPath gets a warning', () => {
  const result = validate({
    nodes: [{ id: 'S', data: { id: 'S', node_type: 'static', payload: { a: '$.trigger.x' } } }],
    edges: [],
  });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes('LITERAL')), JSON.stringify(result.warnings));
});

check('input node with notify block gets a warning', () => {
  const result = validate({
    nodes: [
      {
        id: 'I',
        data: {
          id: 'I',
          node_type: 'input',
          payload: { message: 'confirm?', notify: { email: { addresses: ['a@b.c'] } } },
        },
      },
    ],
    edges: [],
  });
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes('notify')), JSON.stringify(result.warnings));
});

// --- geometry ---------------------------------------------------------------

check('applyGeometry fills node and edge presentation fields without clobbering', () => {
  const config = {
    nodes: [
      agentNode('A'),
      { ...conditionNode('C', chain('A')), position: { x: 999, y: 999 } },
    ],
    edges: [{ source: 'A', target: 'C' }],
  };
  const { config: out, added } = applyGeometry(config);

  const [a, c] = out.nodes;
  assert.equal(a.type, 'custom');
  assert.deepEqual(a.measured, { width: 96, height: 96 });
  assert.ok(a.position && typeof a.position.x === 'number');
  assert.deepEqual(c.position, { x: 999, y: 999 }, 'existing position must be preserved');

  const [edge] = out.edges;
  assert.equal(edge.sourceHandle, 'A');
  assert.equal(edge.targetHandle, 'C');
  assert.equal(edge.type, 'custom');
  assert.equal(edge.edgeType, 'custom');
  assert.ok(edge.id.includes('xy-edge__'));
  assert.ok(added.length > 0);
});

check('applyGeometry lays out a chain left to right by depth', () => {
  const node = (id) => ({ id, data: { id, node_type: 'map', payload: { x: 1 } } });
  const { config: out } = applyGeometry({
    nodes: [node('A'), node('B'), node('C')],
    edges: [
      { source: 'A', target: 'B' },
      { source: 'B', target: 'C' },
    ],
  });
  const x = Object.fromEntries(out.nodes.map((n) => [n.id, n.position.x]));
  assert.ok(x.A < x.B && x.B < x.C, JSON.stringify(x));
});

check('config with no positions warns that the editor would stack the nodes', () => {
  const result = validate({ nodes: [agentNode('A')], edges: [] });
  assert.ok(result.warnings.some((w) => w.includes('stacked at the origin')), JSON.stringify(result.warnings));
});

// --- golden gate ------------------------------------------------------------
// Every bundled example is a REAL published workflow harvested from the
// platform, so it demonstrably runs. If the validator rejects one, the
// validator is wrong. This is the check that would have caught the
// { if, then, else } condition defect on day one.

const examplesDir = new URL('../examples/', import.meta.url);
let exampleFiles = [];
try {
  exampleFiles = readdirSync(examplesDir).filter((f) => f.endsWith('.json'));
} catch {
  exampleFiles = [];
}

check('golden: examples/ is populated (run tools/harvest-examples.mjs)', () => {
  assert.ok(exampleFiles.length > 0, 'no examples found — the golden gate cannot run');
});

// Known, documented reasons a LIVE config can still fail the validator. These
// are divergences in the platform, not validator bugs — each one must have an
// explanation, and anything not on this list is a validator bug by definition.
const ALLOWED_GOLDEN_FAILURES = [
  {
    match: /invalid id — must start with a letter or underscore/,
    why: 'The flow editor creates nanoid node ids containing hyphens. The server only runs validate.ValidateID when a request carries validate=true, and the editor never sends it — so these ids exist in production but cannot be re-sent with validation on. Use server_validate=false to update such a flow.',
  },
];

for (const file of exampleFiles) {
  const example = JSON.parse(readFileSync(new URL(file, examplesDir), 'utf8'));
  check(`golden: validator accepts real config "${example.slug}"`, () => {
    const result = validate(example.config);
    const unexplained = result.errors.filter(
      (e) => !ALLOWED_GOLDEN_FAILURES.some(({ match }) => match.test(e))
    );
    assert.deepEqual(
      unexplained,
      [],
      `this config is live on ${example.source?.environment} (${example.source?.subject}) so any error the allowlist does not explain is a validator bug:\n     ${unexplained.join('\n     ')}`
    );
    for (const error of result.errors) {
      const allowed = ALLOWED_GOLDEN_FAILURES.find(({ match }) => match.test(error));
      if (allowed) console.log(`     (known divergence) ${allowed.why.split('.')[0]}.`);
    }
  });

  check(`golden: "${example.slug}" carries no credential-shaped values`, () => {
    const text = JSON.stringify(example.config);
    for (const pattern of [/ms[rk]?-[A-Z0-9]{20,}/, /eyJ[A-Za-z0-9_-]{20,}\./]) {
      assert.ok(!pattern.test(text), `example matches ${pattern} — re-run tools/harvest-examples.mjs`);
    }
  });
}

check('golden: the condition example really uses the v2 branch shape', () => {
  const file = exampleFiles.find((f) => f.includes('client-folder-creation'));
  assert.ok(file, 'client-folder-creation example missing');
  const example = JSON.parse(readFileSync(new URL(file, examplesDir), 'utf8'));
  const condition = example.config.nodes.find((n) => n.data?.node_type === 'condition');
  assert.ok(condition, 'no condition node in the example');
  assert.ok(Array.isArray(condition.data.payload), 'condition payload must be the branch array itself');
  for (const branch of condition.data.payload) {
    assert.ok('outcome' in branch, 'every branch needs an "outcome"');
    assert.ok(!('then' in branch) && !('if' in branch), 'no if/then/else in a real config');
  }
});

// --- record triggers (hub-service #1287) -------------------------------------
// The one node id that must contain a dot. hub-service dispatches record events by
// glob on `ms.hub.config.workflow-node.*.*.record.<configID>`, and the node subject
// is the flow subject + "." + node.id — so the id has to be `record.<configID>` or
// the trigger silently never fires. ValidateID rejects that id, which is why this
// is a warning (send with server_validate=false) and not an error.

const recordTriggerFlow = (overrides = {}) => ({
  name: 'record trigger flow',
  nodes: [
    {
      id: 'record.risk_programme',
      position: { x: 0, y: 0 },
      type: 'custom',
      data: {
        id: 'record.risk_programme',
        name: 'On risk programme record',
        node_type: 'trigger',
        trigger_type: 'record',
        payload: { record_config_id: 'risk_programme', event_type: ['record-created'] },
        ...overrides,
      },
    },
  ],
  edges: [],
});

check('a record trigger node id containing a dot is accepted', () => {
  const r = validate(recordTriggerFlow());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('a record trigger id warns that server-side validation will still reject it', () => {
  const r = validate(recordTriggerFlow());
  assert.ok(
    r.warnings.some((w) => w.includes('server_validate=false')),
    'the caller must be told the create/update needs server_validate=false'
  );
});

check('a dotted id on a NON-record node is still an error', () => {
  const r = validate({
    name: 'x',
    nodes: [
      {
        id: 'my.node',
        position: { x: 0, y: 0 },
        type: 'custom',
        data: { id: 'my.node', name: 'n', node_type: 'eval', payload: { expression: '1' } },
      },
    ],
    edges: [],
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('invalid id')), JSON.stringify(r.errors));
});

check('a dotted id on a trigger that is not trigger_type record is still an error', () => {
  const r = validate(recordTriggerFlow({ trigger_type: 'manual' }));
  assert.equal(r.valid, false, 'only a record trigger legitimises the dot');
  assert.ok(r.errors.some((e) => e.includes('invalid id')));
});

check('the trigger reference documents all three live trigger types and the id rule', () => {
  const trigger = NODE_TYPES.trigger;
  for (const type of ['record', 'object-store', 'email']) {
    assert.ok(
      trigger.nodeLevelProps.trigger_type.includes(type),
      `trigger_type must list "${type}" — hub-service dispatches on it (data.TriggerType*)`
    );
  }
  assert.ok(
    trigger.record_trigger?.the_id_rule?.includes('record.<record_config_id>'),
    'the id rule is the whole reason a record trigger fails silently — it must be documented'
  );
  assert.ok(
    trigger.record_trigger?.published_only?.includes('draft'),
    'a record trigger on a draft never fires; that must be documented'
  );
  assert.equal(
    NODE_TYPES.trigger.record_trigger_example.id,
    NODE_TYPES.trigger.record_trigger_example.data.payload.record_config_id
      ? `record.${NODE_TYPES.trigger.record_trigger_example.data.payload.record_config_id}`
      : null,
    'the example id must be record.<record_config_id> or it teaches the wrong thing'
  );
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

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
