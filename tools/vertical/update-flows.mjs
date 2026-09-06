// Update a vertical's already-created flows from their repo files and republish.
//
// build-flows.mjs only CREATES. Once a flow exists you need this, and two things
// about it are easy to get wrong:
//   1. Updating a PUBLISHED workflow creates a new DRAFT. The published version keeps
//      running the old config until you publish again — so an update alone changes
//      nothing that runs, silently.
//   2. A record-trigger node id contains a dot (`record.<config_id>`), which the
//      server's ValidateID rejects. Send server_validate=false for those flows or the
//      update is refused.
//
// It matches flows to files by the `name` field, reads the config back after
// publishing, and compares the eval code so a stale publish cannot pass as success.
//
// usage: node tools/vertical/update-flows.mjs <vertical> <flow-file> [<flow-file>...]

import { readFileSync } from 'node:fs';
import { open } from './mcp.mjs';

const ROOT = process.env.MCP_REPO ?? process.cwd();
const [V, ...names] = process.argv.slice(2);
if (!V || !names.length) {
  console.error('usage: node tools/vertical/update-flows.mjs <vertical> <flow-file> [<flow-file>...]');
  process.exit(1);
}
const COLLECTION_NAME = V.split('_').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');

const m = open(`${ROOT}/quiva-flows-mcp/bin/run.sh`);
await m.ready;

const cols = await m.call('list_collections', { collection_type: 'workflow' });
const colRows = cols.results ?? cols.body?.results ?? [];
const col = colRows.find((c) => (c.name ?? c.config?.name) === COLLECTION_NAME);
if (!col) { console.error(`collection "${COLLECTION_NAME}" not found`); process.exit(1); }
const topic = String(col.subject ?? col.id).split('.').pop();
console.log(`collection: ${COLLECTION_NAME} (topic ${topic})`);

const existing = await m.call('list_workflows', { collection_topic: topic });
const rows = existing.results ?? existing.body?.results ?? [];

// Compare the eval-node code between what we sent and what came back, so a stale
// publish is caught rather than assumed away.
function evalCode(cfg) {
  return (cfg.nodes ?? [])
    .filter((n) => (n.data?.node_type ?? n.node_type) === 'eval')
    .map((n) => String((n.data?.payload ?? n.payload)?.code ?? ''))
    .join('\n---\n');
}

let failures = 0;
for (const name of names) {
  const f = JSON.parse(readFileSync(`${ROOT}/verticals/${V}/flows/${name}.json`, 'utf8'));
  console.log(`\n=== ${name} ===`);

  const match = rows.filter((r) => (r.name ?? r.config?.name) === f.name);
  const subject = match.map((r) => r.subject).find((s) => String(s).includes('.draft.'))
    ?? match[0]?.subject;
  if (!subject) { console.log(`  no existing flow named "${f.name}" — use build-flows.mjs first`); failures++; continue; }

  const lint = await m.call('validate_flow_config', { config: f.config });
  if (!lint?.valid) {
    console.log('  INVALID');
    for (const e of lint?.errors ?? []) console.log('    ERROR ', e);
    failures++;
    continue;
  }

  const hasRecordTrigger = f.config.nodes.some((n) => n.data?.trigger_type === 'record');
  const upd = await m.call('update_workflow', {
    subject,
    name: f.name,
    description: f.description,
    config: f.config,
    server_validate: !hasRecordTrigger,
  }, 180000);
  if (upd?._error) { console.log(`  update FAILED: ${String(upd._error).slice(0, 300)}`); failures++; continue; }

  const draftSubject = upd.subject ?? upd.body?.subject ?? subject;
  const pub = await m.call('publish_workflow', { subject: draftSubject, commit: `Update from ${name}.json` }, 180000);
  if (pub?._error) { console.log(`  publish FAILED: ${String(pub._error).slice(0, 300)}`); failures++; continue; }

  const publishedSubject = String(draftSubject).replace('.draft.', '.');
  const back = await m.call('get_workflow', { subject: publishedSubject, draft: false }, 120000);
  const cfg = back?.config ?? back?.body?.config ?? back;
  const sentCode = evalCode(f.config);
  const gotCode = evalCode(cfg ?? {});
  const checks = {
    node_count: (cfg?.nodes ?? []).length === f.config.nodes.length,
    eval_code_matches: sentCode === gotCode,
  };
  for (const [k, v] of Object.entries(checks)) console.log('  ', v ? 'ok  ' : 'FAIL', k);
  console.log(`  published: ${publishedSubject}`);
  const pass = Object.values(checks).every(Boolean);
  if (!pass) failures++;
  console.log(pass ? '  PASS' : '  FAIL');
}

console.log(`\n${failures ? `${failures} flow(s) FAILED` : 'all flows updated and republished'}`);
m.close();
process.exit(failures ? 1 : 0);
