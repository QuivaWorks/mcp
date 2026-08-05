import { readFileSync } from 'node:fs';
import { open } from './mcp.mjs';
const ROOT = process.env.MCP_REPO ?? process.cwd();  // run from the repo root
const [V, FILE] = process.argv.slice(2);
if (!V || !FILE) { console.error('usage: node tools/vertical/build-space.mjs <vertical> <file.json>'); process.exit(1); }
const space = JSON.parse(readFileSync(`${ROOT}/verticals/${V}/spaces/${FILE}`, 'utf8'));
const m = open(`${ROOT}/quiva-workspaces-mcp/bin/run.sh`);
await m.ready;

const v = await m.call('validate_payload', { kind: 'space', mode: 'create', payload: space });
console.log('validate:', v.valid ? 'valid' : 'INVALID');
for (const e of v.errors ?? []) console.log('  ERROR  ', e);
for (const w of v.warnings ?? []) console.log('  warn   ', w);

if (v.valid) {
  const created = await m.call('create_space', { space });
  if (created?._error) console.error('create:', String(created._error).slice(0, 300));

  // read back
  const back = await m.call('get_space', { id: space.id });
  if (back?._error) { console.error('read-back FAILED:', String(back._error).slice(0, 200)); m.close(); process.exit(1); }
  const g = back.body ?? back;
  const gotStatuses = (g.statuses ?? []).map(s => s.id);
  const wantStatuses = space.statuses.map(s => s.id);
  const gotRcids = g.record_config_ids ?? (g.record_configs ?? []).map(r => r.id) ?? [];
  const checks = {
    name_matches: g.name === space.name,
    default_status: g.default_status === space.default_status,
    statuses_match: JSON.stringify(gotStatuses) === JSON.stringify(wantStatuses),
    client_linked: gotRcids.includes('Client'),
    all_five_linked: space.record_config_ids.every(id => gotRcids.includes(id)),
  };
  for (const [k, val] of Object.entries(checks)) console.log(' ', val ? 'ok  ' : 'FAIL', k);
  console.log('  statuses :', gotStatuses.join(', '));
  console.log('  linked   :', gotRcids.join(', ') || '(none)');
  console.log('  url      :', g.url ?? '(none)');
  console.log(Object.values(checks).every(Boolean) ? '  PASS' : '  FAIL');
}
m.close(); process.exit(0);
