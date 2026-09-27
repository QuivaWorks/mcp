import { readFileSync } from 'node:fs';
import { open } from './mcp.mjs';
const ROOT = process.env.MCP_REPO ?? process.cwd();  // run from the repo root
const [V, ...names] = process.argv.slice(2);
if (!V || !names.length) { console.error('usage: node tools/vertical/build-flows.mjs <vertical> <flow-file> [flow-file...]'); process.exit(1); }
// deployVerticals derives the collection name from the vertical id: split on _, capitalise each part, join with a space.
const COLLECTION_NAME = V.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
const m = open(`${ROOT}/quiva-flows-mcp/bin/run.sh`);
await m.ready;

// 1. Collection — reuse if it exists, else create.
let cols = await m.call('list_collections', { collection_type: 'workflow' });
let rows = cols.results ?? cols.body?.results ?? [];
let col = rows.find(c => (c.name ?? c.config?.name) === COLLECTION_NAME);
if (!col) {
  const made = await m.call('create_collection', { name: COLLECTION_NAME, description: 'CRM vertical flows' });
  if (made?._error) { console.error('collection FAILED:', String(made._error).slice(0, 300)); process.exit(1); }
  cols = await m.call('list_collections', { collection_type: 'workflow' });
  rows = cols.results ?? cols.body?.results ?? [];
  col = rows.find(c => (c.name ?? c.config?.name) === COLLECTION_NAME);
}
const collection = col?.subject ?? col?.id;
console.log(`collection: ${COLLECTION_NAME} -> ${collection}`);

for (const name of names) {
  const f = JSON.parse(readFileSync(`${ROOT}/verticals/${V}/flows/${name}.json`, 'utf8'));
  console.log(`\n=== ${name} ===`);

  const v = await m.call('validate_flow_config', { config: f.config });
  console.log('validate:', v.valid ? 'valid' : 'INVALID');
  for (const e of v.errors ?? []) console.log('  ERROR  ', e);
  for (const w of v.warnings ?? []) console.log('  warn   ', w);
  if (!v.valid) continue;

  // record-trigger node ids contain a dot, which server ValidateID rejects
  const hasRecordTrigger = f.config.nodes.some(n => n.data?.trigger_type === 'record');
  const created = await m.call('create_workflow', {
    name: f.name, description: f.description, collection, config: f.config,
    server_validate: !hasRecordTrigger,
  });
  if (created?._error) { console.error('create FAILED:', String(created._error).slice(0, 400)); continue; }
  const draftSubject = created.subject ?? created.body?.subject;
  console.log('draft:', draftSubject);

  // A record trigger only fires on a PUBLISHED node subject — publishing is mandatory, not optional.
  const pub = await m.call('publish_workflow', { subject: draftSubject, commit: 'Initial build from crm.md' });
  if (pub?._error) { console.error('publish FAILED:', String(pub._error).slice(0, 400)); continue; }

  const publishedSubject = String(draftSubject).replace('.draft.', '.');
  const back = await m.call('get_workflow', { subject: publishedSubject, draft: false });
  if (back?._error) { console.error('read-back FAILED:', String(back._error).slice(0, 300)); continue; }
  const cfg = back.config ?? back.body?.config ?? back;
  const gotNodes = (cfg.nodes ?? []).map(n => n.id ?? n.data?.id);
  const wantNodes = f.config.nodes.map(n => n.id);
  const checks = {
    published: Boolean(cfg.nodes?.length),
    node_count: gotNodes.length === wantNodes.length,
    all_nodes_present: wantNodes.every(id => gotNodes.includes(id)),
    edge_count: (cfg.edges ?? []).length === f.config.edges.length,
    trigger_id_intact: !hasRecordTrigger || gotNodes.some(id => String(id).startsWith('record.')),
  };
  for (const [k, val] of Object.entries(checks)) console.log(' ', val ? 'ok  ' : 'FAIL', k);
  console.log('  published subject:', publishedSubject);
  console.log(Object.values(checks).every(Boolean) ? '  PASS' : '  FAIL');
}
m.close(); process.exit(0);
