#!/usr/bin/env node
// Live end-to-end check against a real Quiva environment, driven through the
// MCP server over stdio (so it exercises the actual tool surface, not just the
// library). Creates a throwaway multi-node flow, proves the condition node
// branches BOTH ways, proves the round-trip keeps flow-editor geometry, proves
// the legacy { if, then, else } shape really does fail at runtime, then cleans up.
//
// Usage: node test/e2e-staging.mjs            (reads .env via bin/run.sh)
//        KEEP=1 node test/e2e-staging.mjs     (leave the flow in place to inspect in the UI)

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_SH = join(HERE, '..', 'bin', 'run.sh');
const COLLECTION = 'ms.hub.config.collection.workflow.805092869'; // "Test Flows"
const FLOW_NAME = `mcp-verification-condition-v2-${process.env.RUN_TAG || 'a'}`;

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

// --- minimal MCP stdio client ---------------------------------------------

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
    const isError = Boolean(response?.result?.isError);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { data, isError, text };
  }

  close() {
    this.child.kill();
  }
}

// --- the flow under test --------------------------------------------------
// 6 nodes: trigger -> eval -> condition -> (high | low), high -> notify.
// Exercises: v2 condition branching, pipe concatenation, eval params,
// object config.result, and geometry auto-fill.

const flowConfig = {
  nodes: [
    { id: 'TRIGGER', data: { id: 'TRIGGER', name: 'Manual', node_type: 'trigger', trigger_type: 'manual', payload: {} } },
    {
      id: 'SCORE',
      data: {
        id: 'SCORE',
        name: 'Normalise score',
        node_type: 'eval',
        payload: {
          code: '({ score: Number(raw), band: Number(raw) > 50 ? "high" : "low" })',
          params: { raw: '$.trigger.score' },
        },
      },
    },
    {
      id: 'CLASSIFY',
      data: {
        id: 'CLASSIFY',
        name: 'Classify score',
        node_type: 'condition',
        payload: [
          { condition: { operator: '>', input: ['$.SCORE.score', 50] }, outcome: 'HIGH_PATH' },
          { outcome: 'LOW_PATH' },
        ],
      },
    },
    {
      id: 'HIGH_PATH',
      data: { id: 'HIGH_PATH', name: 'High branch', node_type: 'map', payload: { band: 'high', score: '$.SCORE.score' } },
    },
    {
      id: 'NOTIFY_HIGH',
      data: {
        id: 'NOTIFY_HIGH',
        name: 'Compose message',
        node_type: 'map',
        payload: { message: 'High score of |$.SCORE.score| detected' },
      },
    },
    {
      id: 'LOW_PATH',
      data: { id: 'LOW_PATH', name: 'Low branch', node_type: 'map', payload: { band: 'low', score: '$.SCORE.score' } },
    },
  ],
  edges: [
    { source: 'TRIGGER', target: 'SCORE' },
    { source: 'SCORE', target: 'CLASSIFY' },
    { source: 'CLASSIFY', target: 'HIGH_PATH' },
    { source: 'CLASSIFY', target: 'LOW_PATH' },
    { source: 'HIGH_PATH', target: 'NOTIFY_HIGH' },
  ],
  result: {
    band_high: '$.HIGH_PATH.band',
    band_low: '$.LOW_PATH.band',
    message: '$.NOTIFY_HIGH.message',
    score: '$.SCORE.score',
  },
};

const legacyConditionConfig = JSON.parse(JSON.stringify(flowConfig));
legacyConditionConfig.nodes[2].data.payload = {
  rules: [{ if: '$.SCORE.score > 50', then: ['HIGH_PATH'], else: ['LOW_PATH'] }],
};

const findStep = (log, id) => {
  const entries = Array.isArray(log) ? log : [];
  return entries.filter((e) => e?.id === id);
};

async function main() {
  const mcp = new McpStdio();
  let draftSubject = null;
  let publishedSubject = null;

  try {
    await mcp.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0' },
    });

    // 1. Tool surface
    const tools = await mcp.send('tools/list', {});
    const names = (tools?.result?.tools ?? []).map((t) => t.name);
    for (const required of ['list_reference_topics', 'get_flows_reference', 'list_examples', 'get_example']) {
      step(names.includes(required), `tool registered: ${required}`);
    }
    console.log(`     (${names.length} tools)`);

    // 2. Reference topics resolve and carry the corrected truth
    const topics = await mcp.call('list_reference_topics');
    step(
      Array.isArray(topics.data?.topics) && topics.data.topics.some((t) => t.topic === 'rules-syntax'),
      'list_reference_topics includes rules-syntax'
    );

    const rulesRef = await mcp.call('get_flows_reference', { topic: 'rules-syntax' });
    const refText = rulesRef.data?.reference ?? '';
    step(refText.includes('IT IS NOT'), 'rules-syntax warns against { if, then, else }');
    step(refText.includes('"condition"') && refText.includes('"outcome"'), 'rules-syntax documents the branch shape');
    step(refText.includes('jPath'), 'rules-syntax lists engine-only operators');

    // 3. Examples are real and teach the right shape
    const examples = await mcp.call('list_examples');
    step((examples.data?.examples ?? []).length >= 2, 'examples are bundled');
    const example = await mcp.call('get_example', { slug: 'client-folder-creation' });
    const exampleCondition = (example.data?.config?.nodes ?? []).find((n) => n.data?.node_type === 'condition');
    step(Array.isArray(exampleCondition?.data?.payload), 'example condition payload is a branch array');

    // 4. The validator rejects the legacy shape and accepts the real one
    const legacyCheck = await mcp.call('validate_flow_config', { config: legacyConditionConfig });
    step(legacyCheck.data?.valid === false, 'validator rejects the legacy { if, then, else } condition');
    const goodCheck = await mcp.call('validate_flow_config', { config: flowConfig });
    step(goodCheck.data?.valid === true, 'validator accepts the v2 condition', JSON.stringify(goodCheck.data?.errors));

    // 5. Create — geometry should be auto-filled
    const created = await mcp.call('create_workflow', {
      name: FLOW_NAME,
      collection: COLLECTION,
      description: 'Throwaway flow verifying the condition-node rules syntax and editor geometry via MCP.',
      config: flowConfig,
    });
    step(!created.isError && created.data?.created !== false, 'create_workflow succeeded', created.text.slice(0, 400));
    step((created.data?.geometry_added ?? []).length > 0, 'create_workflow reported auto-filled geometry');

    draftSubject = created.data?.subject ?? created.data?.body?.subject ?? null;
    if (!draftSubject) {
      const list = await mcp.call('list_workflows', { collection_topic: '805092869', version: 'draft' });
      draftSubject = (list.data?.results ?? []).find((w) => w.name === FLOW_NAME)?.subject ?? null;
    }
    step(Boolean(draftSubject), 'draft subject resolved', JSON.stringify(created.data).slice(0, 300));
    if (!draftSubject) throw new Error('cannot continue without a draft subject');

    // 6. Round-trip: what the platform stored must carry the editor fields
    const fetched = await mcp.call('get_workflow', { subject: draftSubject, draft: true });
    const storedNodes = fetched.data?.config?.nodes ?? [];
    const storedEdges = fetched.data?.config?.edges ?? [];
    step(storedNodes.length === 6, `round-trip kept all 6 nodes (got ${storedNodes.length})`);
    step(
      storedNodes.every((n) => n.position && typeof n.position.x === 'number' && n.type === 'custom' && n.measured),
      'round-trip: every node has position/type/measured'
    );
    step(
      new Set(storedNodes.map((n) => n.position.x)).size > 1,
      'round-trip: nodes are laid out across the canvas, not stacked'
    );
    step(
      storedEdges.every((e) => e.sourceHandle && e.targetHandle && e.type === 'custom' && e.edgeType === 'custom'),
      'round-trip: every edge has handles and custom type'
    );
    const storedCondition = storedNodes.find((n) => n.data?.node_type === 'condition');
    step(
      Array.isArray(storedCondition?.data?.payload) && storedCondition.data.payload.length === 2,
      'round-trip: condition payload stored as the branch array'
    );

    // 7. Publish
    const published = await mcp.call('publish_workflow', { subject: draftSubject, commit: 'e2e verification' });
    step(!published.isError, 'publish_workflow succeeded', published.text.slice(0, 300));
    const pubList = await mcp.call('list_workflows', { collection_topic: '805092869', version: 'published' });
    publishedSubject = (pubList.data?.results ?? []).find((w) => w.name === FLOW_NAME)?.subject ?? null;
    step(Boolean(publishedSubject), 'published subject has no ".published." segment');

    // 8. Run the HIGH branch. The run returns config.result, so a node that was
    // skipped leaves its reference unresolved (an empty array) — that is how we
    // prove the branch was taken AND the other was not.
    const high = await mcp.call('run_workflow', { subject: publishedSubject, trigger: { score: 90 }, await: true });
    const highResult = high.data?.result ?? {};
    step(!high.isError, 'run (score=90) completed', high.text.slice(0, 500));
    step(highResult.band_high === 'high', 'run (score=90) took the HIGH_PATH branch', JSON.stringify(highResult));
    step(highResult.band_low !== 'low', 'run (score=90) skipped LOW_PATH', JSON.stringify(highResult.band_low));
    step(highResult.message === 'High score of 90 detected', 'pipe concatenation produced "High score of 90 detected"', JSON.stringify(highResult.message));
    step(
      !high.text.includes('failed to determine next steps') && !high.text.includes('value has to be a string'),
      'run (score=90) hit no rules-engine error'
    );

    // 9. Run the LOW branch — proves the catch-all (no "condition") works
    const low = await mcp.call('run_workflow', { subject: publishedSubject, trigger: { score: 10 }, await: true });
    const lowResult = low.data?.result ?? {};
    step(!low.isError, 'run (score=10) completed', low.text.slice(0, 500));
    step(lowResult.band_low === 'low', 'run (score=10) took the catch-all LOW_PATH branch', JSON.stringify(lowResult));
    step(lowResult.band_high !== 'high', 'run (score=10) skipped HIGH_PATH', JSON.stringify(lowResult.band_high));
    step(lowResult.message !== 'High score of 10 detected', 'run (score=10) skipped NOTIFY_HIGH too', JSON.stringify(lowResult.message));

    // 10. Negative control: the OLD documented shape must actually fail at
    // runtime. If this passes, the original docs were fine and our fix is wrong.
    const brokenUpdate = await mcp.call('update_workflow', {
      subject: draftSubject,
      config: legacyConditionConfig,
      skip_local_validation: true,
    });
    step(!brokenUpdate.isError, 'update to legacy shape accepted (validation bypassed)', brokenUpdate.text.slice(0, 300));
    await mcp.call('publish_workflow', { subject: draftSubject, commit: 'negative control' });
    const brokenRun = await mcp.call('run_workflow', { subject: publishedSubject, trigger: { score: 90 }, await: true });
    const brokenText = `${brokenRun.text}`;
    const rulesEngineFailure =
      brokenText.includes('value has to be a string or an array of strings') ||
      brokenText.includes('failed to determine next steps') ||
      brokenText.includes('next step not found');
    step(rulesEngineFailure, 'NEGATIVE CONTROL: legacy { if, then, else } fails at runtime', brokenText.slice(0, 600));
    if (rulesEngineFailure) {
      const which = ['value has to be a string or an array of strings', 'failed to determine next steps', 'next step not found']
        .find((m) => brokenText.includes(m));
      console.log(`     engine error: "${which}"`);
    }
  } catch (err) {
    fail++;
    console.error(`FAIL harness: ${err.message}`);
  } finally {
    if (draftSubject && !process.env.KEEP) {
      const deleted = await mcp.call('delete_workflow', { subject: draftSubject });
      step(!deleted.isError, 'cleanup: throwaway flow deleted');
    } else if (draftSubject) {
      console.log(`     KEEP=1 — flow left in place: ${draftSubject}`);
    }
    mcp.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
