// Spot checks for the local validator. Run: node test/validate.test.js
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { applyGeometry } from '../src/geometry.js';
import { validate, validateFlowConfig } from '../src/validate.js';
import { GOTCHAS, NODE_TYPES } from '../src/node-docs.js';
import { VISUAL_BUILDER_ONLY } from '../src/rules-docs.js';
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

check('unknown rule operator is a hard error (engine refuses it in rules_validate.go)', () => {
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

check('operator lists track hub-service/jseval/rules_validate.go', () => {
  for (const op of ['string-contains', 'boolean', ' !']) assert.equal(VISUAL_BUILDER_ONLY.has(op), false, op);
  assert.deepEqual([...VISUAL_BUILDER_ONLY].sort(), ['condition', 'doesNotContain', 'stringFormat']);
  const result = validate({
    nodes: [agentNode('A'), conditionNode('C', [{ condition: { operator: 'not-empty', input: ['$.A.result'] }, outcome: 'A' }, { outcome: 'RESOLVE_ERROR' }])],
    edges: [{ id: 'e', source: 'A', target: 'C' }],
  });
  assert.ok(!result.errors.some((e) => e.includes('"not-empty"')), JSON.stringify(result.errors));
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
              'high_priority.value': [
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

// --- record triggers ----------------------------------------------------------
// hub-service dispatches record events by glob on the node subject, so the id must be
// exactly `record:<configID>`; it refuses the legacy dotted form and a mismatch on
// create and update (create-workflow.go checkRecordTriggerID).

const recordTriggerFlow = (overrides = {}, id = 'record:enquiry') => ({
  name: 'record trigger flow',
  nodes: [
    {
      id,
      position: { x: 0, y: 0 },
      type: 'custom',
      data: {
        id,
        name: 'On enquiry record',
        node_type: 'trigger',
        trigger_type: 'record',
        payload: { record_config_id: 'enquiry', event_type: ['record-created'] },
        ...overrides,
      },
    },
  ],
  edges: [],
});

check('a record trigger id of record:<record_config_id> is valid', () => {
  const r = validate(recordTriggerFlow());
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(!r.warnings.some((w) => w.includes('server_validate=false')), 'a colon id needs no workaround');
});

check('a legacy dotted record trigger id is refused', () => {
  const r = validate(recordTriggerFlow({}, 'record.enquiry'));
  assert.equal(r.valid, false, 'hub refuses the dotted form on create and update');
  assert.ok(r.errors.some((e) => e.includes('legacy dot')), JSON.stringify(r.errors));
});

check('a record trigger id that does not address its record_config_id is refused', () => {
  const r = validate(recordTriggerFlow({}, 'record:other_config'));
  assert.equal(r.valid, false, 'a mismatched id is a trigger that never fires');
  assert.ok(r.errors.some((e) => e.includes('record:enquiry')), JSON.stringify(r.errors));
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

check('a dotted id on a trigger that is not trigger_type record is an invalid id', () => {
  const r = validate(recordTriggerFlow({ trigger_type: 'manual' }, 'record.enquiry'));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('invalid id')));
});

check('the trigger reference documents the live hub trigger types and the id rule', () => {
  const trigger = NODE_TYPES.trigger;
  for (const type of ['record', 'object-store', 'email', 'task']) {
    assert.ok(
      trigger.nodeLevelProps.trigger_type.includes(type),
      `trigger_type must list "${type}" — hub-service dispatches on it (data.TriggerType*)`
    );
  }
  assert.ok(
    trigger.record_trigger?.the_id_rule?.includes('record:<record_config_id>'),
    'the id rule is the whole reason a record trigger fails silently — it must be documented'
  );
  assert.ok(
    trigger.record_trigger?.published_only?.includes('draft'),
    'a record trigger on a draft never fires; that must be documented'
  );
  assert.equal(
    NODE_TYPES.trigger.record_trigger_example.id,
    NODE_TYPES.trigger.record_trigger_example.data.payload.record_config_id
      ? `record:${NODE_TYPES.trigger.record_trigger_example.data.payload.record_config_id}`
      : null,
    'the example id must be record:<record_config_id> or it teaches the wrong thing'
  );
});

// --- node types and rules added 2026-09-27 ------------------------------------
// Engine truth: hub-service/model/request.go KnownNodeTypes, data/task_endpoints.go,
// validate/workflow.go checkTaskNode, validate/schedule_attempts.go.

const one = (data, extra = {}) => ({ nodes: [{ id: data.id, data, ...extra }], edges: [] });
const errs = (config) => validateFlowConfig(config).errors;
const hasError = (config, needle) => {
  const e = errs(config);
  assert.ok(e.some((x) => x.includes(needle)), `expected an error containing "${needle}", got ${JSON.stringify(e)}`);
};
const noErrors = (config) => assert.deepEqual(errs(config), []);

check('every node-type reference example passes the per-node validator', () => {
  for (const [type, doc] of Object.entries(NODE_TYPES)) {
    const examples = Object.entries(doc).filter(([k, v]) => k.endsWith('example') && v?.data);
    assert.ok(examples.length > 0, `${type} has no example`);
    for (const [key, example] of examples) {
      const e = errs({ nodes: [example], edges: [] });
      assert.deepEqual(e, [], `${type}.${key}: ${JSON.stringify(e)}`);
    }
  }
});

check('email, verify-signature and sign-envelope are known node types', () => {
  for (const type of ['email', 'verify-signature', 'sign-envelope']) {
    assert.ok(NODE_TYPES[type], `${type} missing from node-docs`);
  }
});

check('email: a list in "to" is refused (one email per recipient)', () => {
  hasError(one({ id: 'E', node_type: 'email', payload: { to: ['a@example.com'], subject: 's', text: 't' } }), 'ONE address');
});

check('email: missing body and missing subject are refused; html alone is enough', () => {
  hasError(one({ id: 'E', node_type: 'email', payload: { to: '$.trigger.email', subject: 's' } }), 'no body');
  hasError(one({ id: 'E', node_type: 'email', payload: { to: '$.trigger.email', html: '<p>x</p>' } }), 'requires "subject"');
  noErrors(one({ id: 'E', node_type: 'email', payload: { to: '$.trigger.email', subject: 's', html: '<p>x</p>' } }));
});

check('email: an operation other than send_email is refused', () => {
  hasError(one({ id: 'E', node_type: 'email', operation: 'send_bulk', payload: { to: 'a@example.com', subject: 's', text: 't' } }), 'unknown email operation');
});

check('verify-signature: expected_kind and nonce_bucket are required', () => {
  hasError(one({ id: 'V', node_type: 'verify-signature', payload: { headers: '$.env.headers', nonce_bucket: 'n' } }), 'expected_kind');
  hasError(one({ id: 'V', node_type: 'verify-signature', payload: { headers: '$.env.headers', expected_kind: [] , nonce_bucket: 'n' } }), 'expected_kind');
  hasError(one({ id: 'V', node_type: 'verify-signature', payload: { expected_kind: 'order' } }), 'nonce_bucket');
});

check('verify-signature: a leading pipe on headers/body and a SECRET:: keyring are refused', () => {
  const base = { expected_kind: 'order', nonce_bucket: 'n' };
  hasError(one({ id: 'V', node_type: 'verify-signature', payload: { ...base, headers: '|$.env.headers' } }), 'starts with a pipe');
  hasError(one({ id: 'V', node_type: 'verify-signature', payload: { ...base, body: '|$.trigger' } }), 'starts with a pipe');
  hasError(one({ id: 'V', node_type: 'verify-signature', payload: { ...base, keyring: 'SECRET::RING::' } }), 'PREFIX');
});

check('sign-envelope: kind, sender_account_id, body and a seed source are required', () => {
  hasError(one({ id: 'S', node_type: 'sign-envelope', payload: { kind: 'order', sender_account_id: '$.static.account_id', body: '$.X' } }), '"seed"');
  hasError(one({ id: 'S', node_type: 'sign-envelope', payload: { distribution_id: 'd1', sender_account_id: 'a', body: {} } }), 'requires "kind"');
  hasError(one({ id: 'S', node_type: 'sign-envelope', payload: { distribution_id: 'bad id!', kind: 'k', sender_account_id: 'a', body: {} } }), '^[A-Za-z0-9_-]+$');
  noErrors(one({ id: 'S', node_type: 'sign-envelope', payload: { seed: 'SECRET::SIGNING::', kind: 'k', sender_account_id: 'a', body: {} } }));
});

const ENGINE_TASK_OPERATIONS = [
  'create_task', 'update_task', 'set_task_status', 'assign_task', 'comment_task', 'complete_task_action',
  'list_tasks', 'delete_tasks_in_folder', 'delete_task', 'schedule_task_event', 'reschedule_task_event',
  'unschedule_task_event', 'list_task_schedules',
];

check('task node documents exactly the 13 visible engine operations', () => {
  assert.deepEqual(Object.keys(NODE_TYPES.task.operations).sort(), [...ENGINE_TASK_OPERATIONS].sort());
});

check('task node: every engine operation is accepted on data.operation', () => {
  for (const op of ENGINE_TASK_OPERATIONS) {
    noErrors(one({ id: 'T', node_type: 'task', operation: op, payload: { task_id: 'LEADS-1' } }));
  }
});

check('task node: payload.operation, a missing operation and an unknown one are refused', () => {
  hasError(one({ id: 'T', node_type: 'task', payload: { operation: 'create_task', title: 'x' } }), 'reads data.operation, not payload.operation');
  hasError(one({ id: 'T', node_type: 'task', payload: { title: 'x' } }), 'needs data.operation');
  hasError(one({ id: 'T', node_type: 'task', operation: 'list_task_actions', payload: {} }), 'unknown task operation');
});

const scheduleNode = (extra = {}) => ({
  id: 'SCHED',
  node_type: 'schedule',
  payload: { flow_subject: 'ms.hub.config.workflow.1.2', trigger: {}, trigger_in: '1h', name: 'reminder:|$.trigger.id' },
  ...extra,
});

check('schedule node: payload.name is accepted, a non-string name is refused', () => {
  noErrors(one(scheduleNode()));
  hasError(one(scheduleNode({ payload: { flow_subject: 'x', trigger: {}, trigger_in: '1h', name: 42 } })), '"name" must be a string');
});

check('schedule node: options.attempts > 1 is refused; attempts 1 is allowed', () => {
  hasError(one(scheduleNode({ options: { attempts: 3 } })), 'options.attempts is not allowed');
  noErrors(one(scheduleNode({ options: { attempts: 1 } })));
});

check('quiva-endpoint calling schedule-flow / unschedule-flow refuses attempts; other subjects do not', () => {
  for (const subject of ['microstrate.hub.post.schedule-flow', 'microstrate.hub.delete.unschedule-flow']) {
    hasError(one({ id: 'Q', node_type: 'quiva-endpoint', subject, options: { attempts: 2 }, payload: {} }), 'options.attempts is not allowed');
  }
  noErrors(one({ id: 'Q', node_type: 'quiva-endpoint', subject: 'microstrate.storage.get.kv-entry', options: { attempts: 3 }, payload: {} }));
});

check('graph ids: an edge or top-level node id with . * > @ or whitespace is refused', () => {
  const config = {
    nodes: [
      { id: 'A', data: { id: 'A', node_type: 'static', payload: {} } },
      { id: 'B', data: { id: 'B', node_type: 'static', payload: {} } },
    ],
    edges: [{ id: 'A.B', source: 'A', target: 'B' }],
  };
  hasError(config, 'cannot contain');
  hasError(one({ id: 'N', node_type: 'static', payload: {} }, { id: 'N@1' }), 'cannot contain');
  for (const bad of ['a b', 'a\tb', 'a\nb', 'a*', 'a>']) hasError(one({ id: 'N', node_type: 'static', payload: {} }, { id: bad }), 'cannot contain');
});

check('graph ids: whitespace the server does not list (\\r, non-breaking space) is accepted, as on the server', () => {
  for (const id of ['a\rb', 'a\u00a0b', 'a-b']) {
    const r = validateFlowConfig({ nodes: [{ id, data: { id, node_type: 'static', payload: {} } }], edges: [] });
    assert.ok(!r.errors.some((e) => e.includes('cannot contain')), JSON.stringify(r.errors));
  }
});

check('the server-accepted editor types (chat, agent_* sub-nodes, empty node_type) are not errors', () => {
  const r = validateFlowConfig({
    nodes: [
      { id: 'C', data: { id: 'C', node_type: 'chat', payload: {} } },
      { id: 'agent_tools_1', data: { id: 'agent_tools_1', node_type: 'agent_tools', payload: {} } },
      { id: 'NEW', data: { id: 'NEW', payload: {} } },
    ],
    edges: [],
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('"chat"')), JSON.stringify(r.warnings));
  assert.ok(r.warnings.some((w) => w.includes('no node_type')), JSON.stringify(r.warnings));
});

check('docs recommend current model aliases and name the remap', () => {
  const agentGotcha = GOTCHAS.find((g) => g.startsWith('Agent nodes'));
  for (const alias of ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5']) {
    assert.ok(agentGotcha.includes(alias), `agent gotcha does not recommend ${alias}`);
  }
  assert.ok(/remapped/.test(agentGotcha));
});

check('docs cover the flow-author role 403 and the run-queue statuses', () => {
  const text = GOTCHAS.join('\n');
  assert.ok(text.includes('root, admin or developer'), 'role gotcha missing');
  for (const code of ['429', '504', '409', 'Retry-After']) assert.ok(text.includes(code), `run-queue ${code} missing`);
});

check('integration node bound to an integration_id needs no url/method in the payload', () => {
  noErrors(one({ id: 'I', node_type: 'integration', integration_id: 'slack', payload: { data: { text: 'hi' } } }));
  hasError(one({ id: 'H', node_type: 'http', payload: {} }), 'requires "url"');
});

check('no staging host in shipped source', () => {
  const srcDir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(srcDir)) {
    const text = readFileSync(new URL(f, srcDir), 'utf8');
    assert.ok(!text.includes('microstrate.io'), `${f} mentions microstrate.io`);
  }
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
  const fake = (method) => async (path, a) => { calls.push({ method, path, query: a }); return { message: 'success' }; };
  registerTools({ registerTool: (n, meta, fn) => (tools[n] = { meta, fn }) }, { get: fake('GET'), post: fake('POST'), put: fake('PUT'), delete: fake('DELETE') });
  const subject = 'ms.hub.config.workflow.draft.abc.def';

  const refused = await tools.delete_workflow.fn({ subject, keep_draft: false });
  check('delete_workflow refuses without confirm: true and sends nothing', () => {
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /confirm: true/);
    assert.equal(calls.length, 0);
  });
  const done = await tools.delete_workflow.fn({ subject, keep_draft: false, confirm: true });
  check('delete_workflow with confirm: true deletes both versions', () => {
    assert.equal(done.isError, undefined, JSON.stringify(done));
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].query.draft, 'true');
  });
  check('run_workflow states that it runs every node for real', () => {
    assert.match(tools.run_workflow.meta.description, /spend LLM tokens/);
  });
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall checks passed');
