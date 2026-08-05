import { open } from './mcp.mjs';
const m = open((process.env.MCP_REPO ?? process.cwd()) + '/quiva-workspaces-mcp/bin/run.sh');
await m.ready;
const r = await m.call('list_files', { space_id: 'VERTICAL' });
const V = process.argv[2];
if (!V) { console.error('usage: node tools/vertical/verify-vertical.mjs <vertical>'); process.exit(1); }
const rows = r.results ?? [];
const crm = rows.filter(x => String(x.key ?? '').startsWith(`spaces.VERTICAL.${V}.`));
const SIX = ['assistants','document_templates','flows','meeting_templates','record_configs','spaces'];
const byCat = {};
let blanks = 0;
for (const f of crm) {
  const seg = String(f.key).split('.')[3];
  const isMarker = /__meta__\.json$|metadata\.json$/.test(f.key);
  if (isMarker) continue;
  byCat[seg] = (byCat[seg] ?? 0) + 1;
  if (f.name_missing) blanks++;
}
console.log(`${V} entries in the VERTICAL index: ${crm.length} (incl. folder markers)`);
console.log('deployable configs by category:');
for (const [c, n] of Object.entries(byCat).sort()) console.log(`  ${SIX.includes(c) ? 'DEPLOYS ' : 'skipped '} ${c}: ${n}`);
console.log(`entries with a blank name (invisible to deploy): ${blanks}`);
const total = Object.entries(byCat).filter(([c]) => SIX.includes(c)).reduce((a, [, n]) => a + n, 0);
console.log(`\n=> ${total} config file(s) will be deployed when ${V} is switched on for an account`);
m.close(); process.exit(0);
