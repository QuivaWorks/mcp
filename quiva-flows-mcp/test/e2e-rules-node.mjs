#!/usr/bin/env node
// Live check for the "rules" NODE — the one node type with zero examples
// anywhere on the platform, so its docs were derived from the engine handler
// rather than proven by execution.
//
// The test case is the worked rule from form-creator.md, TRANSLATED between the
// two dialects. That document specifies records FORM rules (json-logic-engine):
//
//     { "id": "AvatarUrl.visible", "property": "visible",
//       "logic": { ">=": [ { "var": "Age" }, 18 ] } }
//
// Flows use a different engine (rule-engine v2), so the same intent becomes:
//
//     "AvatarUrl.visible": [
//       { "condition": { "operator": ">=", "input": ["@fact:Age", 18] }, "outcome": true },
//       { "outcome": false }
//     ]
//
// Running it proves: the { rules, facts, context } envelope, "@fact:" resolution,
// derived-fact CHAINING (one rule reading another rule's outcome), the node's
// return shape, and the rules -> condition handoff.
//
// Usage: node test/e2e-rules-node.mjs   [KEEP=1 to leave the flow in place]

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_SH = join(HERE, '..', 'bin', 'run.sh');
const COLLECTION = 'ms.hub.config.collection.workflow.805092869'; // "Test Flows"
const FLOW_NAME = `mcp-verification-rules-node-${process.env.RUN_TAG || 'a'}`;

let pass = 0;
let fail = 0;
const step = (ok, name, detail = '') => {
  if (ok) {
    pass++;
    console.log(`ok   ${name}`);
  } else {
    fail++;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
};

class McpStdio {
  constructor() {
    this.child = spawn('sh', [RUN_SH], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const resolver = this.pending.get(message.id);
        if (resolver) {
          this.pending.delete(message.id);
          resolver(message);
        }
      }
    });
  }

  send(method, params) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 180000);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  async call(name, args = {}) {
    const response = await this.send('tools/call', { name, arguments: args });
    const text = response?.result?.content?.[0]?.text ?? '';
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { data, isError: Boolean(response?.result?.isError), text };
  }

  close() {
    this.child.kill();
  }
}

// The rules node payload: facts declared from the trigger, three rules, the
// third CHAINING off the first two via "@fact:".
const rulesPayload = {
  facts: {
    Age: '$.trigger.age',
    Email: '$.trigger.email',
  },
  rules: {
    // form-creator.md: { ">=": [ { "var": "Age" }, 18 ] }
    'AvatarUrl.visible': [
      { condition: { operator: '>=', input: ['@fact:Age', 18] }, outcome: true },
      { outcome: false },
    ],
    'Email.present': [
      { condition: { operator: 'notEmpty', input: ['@fact:Email'] }, outcome: true },
      { outcome: false },
    ],
    // Chained: reads the two rule outcomes above as facts.
    profile_complete: [
      {
        condition: { operator: 'and', input: ['@fact:AvatarUrl.visible', '@fact:Email.present'] },
        outcome: 'complete',
      },
      { outcome: 'incomplete' },
    ],
  },
  context: {},
};

const flowConfig = {
  nodes: [
    { id: 'TRIGGER', data: { id: 'TRIGGER', name: 'Manual', node_type: 'trigger', trigger_type: 'manual', payload: {} } },
    { id: 'FORM_RULES', data: { id: 'FORM_RULES', name: 'Evaluate form rules', node_type: 'rules', payload: rulesPayload } },
    {
      id: 'SHOW',
      data: {
        id: 'SHOW',
        name: 'Inspect rule outcomes',
        node_type: 'map',
        payload: {
          all: '$.FORM_RULES',
          chained: '$.FORM_RULES.profile_complete',
          dotted_key: '$.FORM_RULES.AvatarUrl.visible',
        },
      },
    },
    {
      id: 'GATE',
      data: {
        id: 'GATE',
        name: 'Gate on rule outcome',
        node_type: 'condition',
        payload: [
          { condition: { operator: '=', input: ['$.FORM_RULES.profile_complete', 'complete'] }, outcome: 'ONBOARD' },
          { outcome: 'REQUEST_MORE_INFO' },
        ],
      },
    },
    { id: 'ONBOARD', data: { id: 'ONBOARD', name: 'Onboard', node_type: 'map', payload: { status: 'onboarded' } } },
    {
      id: 'REQUEST_MORE_INFO',
      data: { id: 'REQUEST_MORE_INFO', name: 'Request more info', node_type: 'map', payload: { status: 'more_info_required' } },
    },
  ],
  edges: [
    { source: 'TRIGGER', target: 'FORM_RULES' },
    { source: 'FORM_RULES', target: 'SHOW' },
    { source: 'FORM_RULES', target: 'GATE' },
    { source: 'GATE', target: 'ONBOARD' },
    { source: 'GATE', target: 'REQUEST_MORE_INFO' },
  ],
  result: {
    outcomes: '$.FORM_RULES',
    chained: '$.SHOW.chained',
    dotted_key: '$.SHOW.dotted_key',
    onboarded: '$.ONBOARD.status',
    more_info: '$.REQUEST_MORE_INFO.status',
  },
};

async function main() {
  const mcp = new McpStdio();
  let draftSubject = null;
  let publishedSubject = null;

  try {
    await mcp.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-rules', version: '0' },
    });

    // 1. The validator accepts the translated rules payload, and warns about
    //    notEmpty (engine-valid, absent from the editor's rule schema).
    const check = await mcp.call('validate_flow_config', { config: flowConfig });
    step(check.data?.valid === true, 'validator accepts the rules-node payload', JSON.stringify(check.data?.errors));
    step(
      (check.data?.warnings ?? []).some((w) => w.includes('notEmpty') && w.includes('flow editor')),
      'validator warns that notEmpty is engine-only',
      JSON.stringify(check.data?.warnings)
    );

    // 2. The json-logic form dialect must NOT validate as a flows rule.
    const wrongDialect = JSON.parse(JSON.stringify(flowConfig));
    wrongDialect.nodes[1].data.payload.rules = {
      'AvatarUrl.visible': { property: 'visible', logic: { '>=': [{ var: 'Age' }, 18] } },
    };
    const dialectCheck = await mcp.call('validate_flow_config', { config: wrongDialect });
    step(
      dialectCheck.data?.valid === false,
      'validator rejects a json-logic (records form) rule in a flows rules node',
      JSON.stringify(dialectCheck.data?.errors)
    );

    // 3. Create, publish
    const created = await mcp.call('create_workflow', {
      name: FLOW_NAME,
      collection: COLLECTION,
      description: 'Throwaway flow proving the rules node: facts, @fact chaining, and the rules -> condition handoff. Rule translated from form-creator.md.',
      config: flowConfig,
    });
    step(!created.isError && created.data?.created !== false, 'create_workflow succeeded', created.text.slice(0, 400));

    const list = await mcp.call('list_workflows', { collection_topic: '805092869', version: 'draft' });
    draftSubject = (list.data?.results ?? []).find((w) => w.name === FLOW_NAME)?.subject ?? null;
    step(Boolean(draftSubject), 'draft subject resolved');
    if (!draftSubject) throw new Error('no draft subject');

    await mcp.call('publish_workflow', { subject: draftSubject, commit: 'rules node verification' });
    const pubList = await mcp.call('list_workflows', { collection_topic: '805092869', version: 'published' });
    publishedSubject = (pubList.data?.results ?? []).find((w) => w.name === FLOW_NAME)?.subject ?? null;
    step(Boolean(publishedSubject), 'published');

    // 4. Adult + email -> all three rules true -> ONBOARD
    const adult = await mcp.call('run_workflow', {
      subject: publishedSubject,
      trigger: { age: 25, email: 'ada@example.com' },
      await: true,
    });
    const a = adult.data?.result ?? {};
    step(!adult.isError, 'run (age=25, email set) completed', adult.text.slice(0, 500));
    console.log(`     outcomes: ${JSON.stringify(a.outcomes)}`);
    step(a.outcomes?.['AvatarUrl.visible'] === true, 'rules node returned { <ruleName>: outcome } with the dotted key', JSON.stringify(a.outcomes));
    step(a.outcomes?.['Email.present'] === true, 'notEmpty resolved against a declared fact');
    step(a.outcomes?.profile_complete === 'complete', 'CHAINING: a rule read two earlier rule outcomes via @fact', JSON.stringify(a.outcomes));
    step(a.chained === 'complete', 'downstream node read $.FORM_RULES.profile_complete', JSON.stringify(a.chained));
    step(a.onboarded === 'onboarded', 'condition branched on the rules outcome -> ONBOARD', JSON.stringify(a));
    step(a.more_info !== 'more_info_required', 'the other branch was skipped');
    console.log(`     dotted-key read via JSONPath ($.FORM_RULES.AvatarUrl.visible): ${JSON.stringify(a.dotted_key)}`);

    // 5. Minor -> first rule false -> chain yields incomplete -> other branch
    const minor = await mcp.call('run_workflow', {
      subject: publishedSubject,
      trigger: { age: 16, email: 'kid@example.com' },
      await: true,
    });
    const m = minor.data?.result ?? {};
    step(!minor.isError, 'run (age=16) completed', minor.text.slice(0, 500));
    console.log(`     outcomes: ${JSON.stringify(m.outcomes)}`);
    step(m.outcomes?.['AvatarUrl.visible'] === false, 'age 16 -> AvatarUrl.visible false (the form-creator rule, translated)', JSON.stringify(m.outcomes));
    step(m.outcomes?.profile_complete === 'incomplete', 'chained rule followed the changed input', JSON.stringify(m.outcomes));
    step(m.more_info === 'more_info_required', 'condition took the catch-all branch -> REQUEST_MORE_INFO', JSON.stringify(m));
    step(m.onboarded !== 'onboarded', 'ONBOARD was skipped');

    // 6. Empty email -> only the email rule flips
    const noEmail = await mcp.call('run_workflow', {
      subject: publishedSubject,
      trigger: { age: 30, email: '' },
      await: true,
    });
    const n = noEmail.data?.result ?? {};
    console.log(`     outcomes: ${JSON.stringify(n.outcomes)}`);
    step(n.outcomes?.['AvatarUrl.visible'] === true, 'age 30 -> visible true');
    step(n.outcomes?.['Email.present'] === false, 'empty email -> Email.present false', JSON.stringify(n.outcomes));
    step(n.outcomes?.profile_complete === 'incomplete', 'chain reflects the single changed fact', JSON.stringify(n.outcomes));
  } catch (err) {
    fail++;
    console.error(`FAIL harness: ${err.message}`);
  } finally {
    if (draftSubject && !process.env.KEEP) {
      const deleted = await mcp.call('delete_workflow', { subject: draftSubject });
      step(!deleted.isError, 'cleanup: flow deleted');
      const after = await mcp.call('list_workflows', { collection_topic: '805092869' });
      const gone = !(after.data?.results ?? []).some((w) => w.name === FLOW_NAME);
      step(gone, 'cleanup VERIFIED: flow no longer listed (not just a success response)');
    } else if (draftSubject) {
      console.log(`     KEEP=1 — left in place: ${draftSubject}`);
    }
    mcp.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
