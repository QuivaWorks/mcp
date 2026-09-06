import { readFileSync } from 'node:fs';
import { open } from './mcp.mjs';
const ROOT = process.env.MCP_REPO ?? process.cwd();  // run from the repo root
const [V, ...names] = process.argv.slice(2);
if (!V || !names.length) { console.error('usage: node tools/vertical/build-records.mjs <vertical> <Name> [Name...]'); process.exit(1); }
const m = open(`${ROOT}/quiva-records-mcp/bin/run.sh`);
await m.ready;

for (const name of names) {
  const cfg = JSON.parse(readFileSync(`${ROOT}/verticals/${V}/record_configs/${name}.json`, 'utf8'));
  console.log(`\n=== ${name} ===`);

  const v = await m.call('validate_record_config', { config: cfg });
  if (v?._error) { console.error('validate errored:', String(v._error).slice(0, 300)); continue; }
  console.log('validate:', v.valid ? 'valid' : 'INVALID');
  for (const e of v.errors ?? []) console.log('  ERROR  ', e);
  for (const w of v.warnings ?? []) console.log('  warn   ', w);
  if (!v.valid) continue;

  const created = await m.call('create_record_config', cfg);
  if (created?._error) { console.error('create FAILED:', String(created._error).slice(0, 300)); continue; }

  // read back — never trust the write response
  const back = await m.call('get_record_config', { id: cfg.id });
  if (back?._error) { console.error('read-back FAILED:', String(back._error).slice(0, 200)); continue; }
  const got = back.config ?? back.body ?? back;
  const sFields = Object.keys(cfg.schema.properties);
  const gFields = Object.keys(got.schema?.properties ?? {});
  const gForm = got.views?.forms?.[0]?.layout;
  const countFields = n => { let c = 0; (function w(x){ if(x?.type==='field') c++; (x?.children||[]).forEach(w); })(n); return c; };
  const checks = {
    name_matches: got.name === cfg.name,
    schema_field_count: gFields.length === sFields.length,
    no_missing_fields: sFields.every(f => gFields.includes(f)),
    form_present: Boolean(gForm),
    form_field_count: countFields(gForm) === countFields(cfg.views.forms[0].layout),
    table_cols: (got.views?.table?.columns ?? []).length === cfg.views.table.columns.length,
  };
  for (const [k, val] of Object.entries(checks)) console.log(' ', val ? 'ok  ' : 'FAIL', k);
  console.log(`  schema ${gFields.length}/${sFields.length} fields, form ${countFields(gForm)}/${countFields(cfg.views.forms[0].layout)} nodes`);
  console.log(Object.values(checks).every(Boolean) ? '  PASS' : '  FAIL');
}
m.close();
process.exit(0);
