#!/usr/bin/env node
// Regression sweep: run the local validator over EVERY workflow on the
// configured environment and group the results.
//
// Purpose: the golden gate only covers the two bundled examples. This proves
// the tightened validator (rules DSL, operators, condition targets) does not
// reject configs that are already live — and surfaces existing flows that are
// genuinely broken.
//
// Usage: node tools/sweep-validate.mjs [--verbose]

import { QuivaClient } from '../src/client.js';
import { validate } from '../src/validate.js';

const VERBOSE = process.argv.includes('--verbose');
const client = new QuivaClient();

const classify = (error) => {
  if (/invalid id — must start with a letter/.test(error)) return 'node id (editor nanoid — validate=true not sent by UI)';
  if (/NOT understood by the rules engine|must BE the conditional chain|must be an ARRAY of/.test(error)) return 'RULES DSL — broken condition/rules payload';
  if (/not implemented by the rules engine/.test(error)) return 'RULES DSL — unknown operator';
  if (/next step not found|must be a node id string/.test(error)) return 'condition branch target';
  if (/payload is required|payload requires|must be an object/.test(error)) return 'missing/invalid payload';
  if (/a subject is required/.test(error)) return 'missing subject';
  if (/cycle detected/.test(error)) return 'cycle';
  if (/source node not found|target node not found/.test(error)) return 'dangling edge';
  if (/flat agent payload/.test(error)) return 'agent payload flat (silently dropped at runtime)';
  if (/reserved word/.test(error)) return 'reserved node id';
  if (/unknown node_type/.test(error)) return 'unknown node_type';
  if (/duplicate node id/.test(error)) return 'duplicate node id';
  return 'other';
};

async function main() {
  if (!client.hasCredentials()) {
    console.error('No credentials configured.');
    process.exit(1);
  }
  console.log(`sweeping ${client.baseUrl}\n`);

  const all = await client.get('/hub/workflows', {});
  const workflows = all?.results ?? [];
  console.log(`${workflows.length} workflow version(s) listed\n`);

  const buckets = new Map();
  const conditionShapes = { v2: 0, legacy: 0, other: 0 };
  let ok = 0;
  let failed = 0;
  let fetchErrors = 0;
  let withCondition = 0;
  let withRules = 0;

  for (const workflow of workflows) {
    const subject = workflow.subject;
    const isDraft = subject.includes('.draft.');
    const parts = subject.split('.');
    const flowTopic = parts[parts.length - 1];
    const collectionTopic = parts[parts.length - 2];

    let flow;
    try {
      flow = await client.get(`/hub/workflows/${collectionTopic}/${flowTopic}`, { draft: String(isDraft) });
    } catch (err) {
      fetchErrors++;
      if (VERBOSE) console.log(`  ?  ${workflow.name}: fetch failed (${err.message})`);
      continue;
    }

    const config = flow?.config;
    if (!config || !Array.isArray(config.nodes)) {
      fetchErrors++;
      continue;
    }

    // What shape are the condition nodes in the wild?
    for (const node of config.nodes) {
      const type = node?.data?.node_type;
      if (type === 'rules') withRules++;
      if (type !== 'condition') continue;
      withCondition++;
      const payload = node.data.payload;
      const branches = Array.isArray(payload) ? payload : [payload];
      if (branches.some((b) => b && typeof b === 'object' && ('if' in b || 'then' in b))) conditionShapes.legacy++;
      else if (branches.every((b) => b && typeof b === 'object' && 'outcome' in b)) conditionShapes.v2++;
      else conditionShapes.other++;
    }

    const result = validate(config);
    if (result.valid) {
      ok++;
      continue;
    }
    failed++;
    for (const error of result.errors) {
      const kind = classify(error);
      if (!buckets.has(kind)) buckets.set(kind, []);
      buckets.get(kind).push({ name: workflow.name, subject, error });
    }
  }

  console.log(`validator: ${ok} valid, ${failed} with errors, ${fetchErrors} unreadable\n`);
  console.log(`condition nodes found: ${withCondition} (v2 shape: ${conditionShapes.v2}, legacy if/then/else: ${conditionShapes.legacy}, unrecognised: ${conditionShapes.other})`);
  console.log(`rules nodes found: ${withRules}\n`);

  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [kind, items] of sorted) {
    const flows = new Set(items.map((i) => i.name));
    console.log(`${String(items.length).padStart(4)}  ${kind}  (${flows.size} flow(s))`);
    if (VERBOSE) {
      for (const item of items.slice(0, 6)) console.log(`        ${item.name}: ${item.error.slice(0, 160)}`);
    }
  }

  const dslFailures = sorted
    .filter(([kind]) => kind.startsWith('RULES DSL'))
    .reduce((n, [, items]) => n + items.length, 0);
  console.log(`\nRULES DSL errors: ${dslFailures}`);
  if (dslFailures === 0) {
    console.log('=> the tightened rules validation rejects nothing that is live. No regression.');
  } else {
    console.log('=> inspect these: either a live flow is genuinely broken, or the validator is too strict.');
  }
}

main().catch((err) => {
  console.error('sweep failed:', err.message);
  process.exit(1);
});
