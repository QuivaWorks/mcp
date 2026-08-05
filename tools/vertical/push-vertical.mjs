// Step 2 of the original three: copy verticals/crm/** into the VERTICAL space so
// the vertical becomes installable. Verifies will_deploy on every file, because
// a file whose index entry has a blank name is silently skipped at deploy.
import { readFileSync, readdirSync } from 'node:fs';
import { open } from './mcp.mjs';
const ROOT = process.env.MCP_REPO ?? process.cwd();  // run from the repo root
const V = process.argv[2];
if (!V) { console.error('usage: node tools/vertical/push-vertical.mjs <vertical>'); process.exit(1); }
const CATEGORIES = ['record_configs', 'spaces', 'flows', 'assistants', 'meeting_templates', 'document_templates', 'specs'];
const m = open(`${ROOT}/quiva-workspaces-mcp/bin/run.sh`);
await m.ready;

const rows = [];
for (const cat of CATEGORIES) {
  let files = [];
  try { files = readdirSync(`${ROOT}/verticals/${V}/${cat}`); } catch { continue; }
  for (const f of files) {
    if (f === '.gitkeep') continue;
    if (f.endsWith('.docx')) { rows.push({ key: `${cat}/${f}`, skipped: 'binary — lives in microstrate-documents, not the vertical' }); continue; }
    const content = readFileSync(`${ROOT}/verticals/${V}/${cat}/${f}`, 'utf8');
    const key = `spaces.VERTICAL.${V}.${cat}.${f}`;
    const r = await m.call('write_file', { key, content }, 180000);
    rows.push({
      key: `${cat}/${f}`, bytes: content.length,
      verified: r?.verified, will_deploy: r?.will_deploy,
      warnings: (r?.warnings ?? []).length, err: r?._error ? String(r._error).slice(0, 120) : null,
    });
    if (r?.warnings?.length) for (const w of r.warnings) console.log(`   warn [${f}] ${String(w).slice(0, 160)}`);
  }
}

console.log('\nfile'.padEnd(46), 'bytes'.padStart(6), 'verified', 'will_deploy');
for (const r of rows) {
  if (r.skipped) { console.log(String(r.key).padEnd(46), '  -- skipped:', r.skipped); continue; }
  console.log(String(r.key).padEnd(46), String(r.bytes).padStart(6), String(r.verified ?? '-').padEnd(9), String(r.will_deploy ?? '-'), r.err ? '| ' + r.err : '');
}
const pushed = rows.filter(r => !r.skipped);
const deployable = pushed.filter(r => r.will_deploy === true);
const nonSpec = pushed.filter(r => !r.key.startsWith('specs/'));
console.log(`\n${pushed.length} pushed, ${deployable.length} will deploy`);
console.log(`(specs/ is intentionally non-deploying: ${pushed.length - nonSpec.length} file(s))`);
const bad = nonSpec.filter(r => r.will_deploy !== true);
console.log(bad.length ? 'PROBLEM — these would be silently skipped at deploy:\n  ' + bad.map(r => r.key).join('\n  ') : 'all deployable files confirmed will_deploy=true');
m.close(); process.exit(0);
