// Build a vertical's document templates: lint the config, lint the DOCX server-side,
// upload the DOCX, create the template and publish it — then read each thing back.
//
// Four traps this encodes, all hit for real:
//   1. Object writes are POST. A PUT returns 200 and stores NOTHING. So the upload is
//      verified by reading the object back and comparing BYTE LENGTH, not by trusting
//      the write response.
//   2. Only the PUBLISHED version of a template generates documents. A created-but-
//      unpublished template looks fine and produces nothing.
//   3. validate_docx does NOT check payload keys against placeholders — it never sees
//      a payload. That check is make-docx.py's job (it extracts from the written file)
//      and the config's _notes.placeholders. It is the check that actually matters.
//   4. There is no object tool on the documents MCP and `write_file` on the workspaces
//      MCP takes a STRING into the workspaces bucket with vertical-config validation —
//      wrong on both counts for a binary .docx in microstrate-documents. So the object
//      half uses the workspaces client directly, which POSTs a Buffer.
//
// usage: node tools/vertical/build-documents.mjs <vertical> <key> [<key>...]
//        (key = the basename shared by the .json config and the .docx beside it)

import { readFileSync, statSync, existsSync } from 'node:fs';
import { open } from './mcp.mjs';

const ROOT = process.env.MCP_REPO ?? process.cwd();
const [V, ...keys] = process.argv.slice(2);
if (!V || !keys.length) {
  console.error('usage: node tools/vertical/build-documents.mjs <vertical> <key> [<key>...]');
  process.exit(1);
}

// bin/run.sh is what normally loads a server's .env; importing the client directly
// bypasses that, so load it here (without clobbering anything already exported).
const envFile = `${ROOT}/quiva-workspaces-mcp/.env`;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1);
  }
}
const { QuivaClient } = await import(`${ROOT}/quiva-workspaces-mcp/src/client.js`);
const objects = new QuivaClient();

const m = open(`${ROOT}/quiva-documents-mcp/bin/run.sh`);
await m.ready;

let failures = 0;
for (const key of keys) {
  const dir = `${ROOT}/verticals/${V}/document_templates`;
  const cfg = JSON.parse(readFileSync(`${dir}/${key}.json`, 'utf8'));
  const docxPath = `${dir}/${key}.docx`;
  const bytes = readFileSync(docxPath);
  const ref = String(cfg.source.key).replace(/^obj:\/\//, '');
  const bucket = ref.split('/')[0];
  const objKey = ref.slice(bucket.length + 1);
  console.log(`\n=== ${key} ===`);
  console.log(`  docx ${statSync(docxPath).size} bytes -> ${bucket}/${objKey}`);

  const lint = await m.call('validate_template_config', { template: cfg });
  console.log('  config:', lint?.valid ? 'valid' : 'INVALID');
  for (const e of lint?.errors ?? []) console.log('    ERROR ', e);
  for (const w of lint?.warnings ?? []) console.log('    warn  ', w);
  if (!lint?.valid) { failures++; continue; }

  const dv = await m.call('validate_docx', {
    content_type: cfg.source.content_type,
    content: bytes.toString('base64'),
  }, 180000);
  const docxOk = dv?.is_valid ?? dv?.valid;
  console.log('  docx  :', docxOk ? 'valid' : `INVALID ${JSON.stringify(dv).slice(0, 300)}`);
  if (!docxOk) { failures++; continue; }

  let byteMatch = false;
  try {
    const entry = await objects.writeObject(bucket, objKey, bytes);
    const back = await objects.readObject(bucket, objKey);
    byteMatch = back.bytes === bytes.length;
    console.log(`  object: wrote digest=${String(entry?.digest ?? '-').slice(0, 16)}…, read back ${back.bytes}/${bytes.length} bytes  ${byteMatch ? 'ok' : 'MISMATCH'}`);
  } catch (err) {
    console.log(`  object: FAILED ${err.message.slice(0, 250)}`);
  }
  if (!byteMatch) failures++;

  // create_template takes the template's fields FLAT, not wrapped in { template }.
  // `_notes` is repo-only documentation and is not a field the tool accepts, so it is
  // dropped here rather than sent — it stays in the committed config for the reader.
  const { _notes, ...wire } = cfg;
  const created = await m.call('create_template', wire, 180000);
  if (created?._error) console.log('  create:', String(created._error).slice(0, 250));

  const pub = await m.call('publish_template', { key: cfg.key }, 180000);
  if (pub?._error) { console.log('  publish FAILED:', String(pub._error).slice(0, 300)); failures++; continue; }

  const got = await m.call('get_template', { key: cfg.key }, 180000);
  const t = got?.config ?? got?.body ?? got;
  const checks = {
    label_matches: t?.label === cfg.label,
    source_key_matches: t?.source?.key === cfg.source.key,
    output_name_matches: t?.output?.name === cfg.output.name,
    output_is_pdf: t?.output?.content_type === 'application/pdf',
  };
  for (const [k, v] of Object.entries(checks)) console.log('  ', v ? 'ok  ' : 'FAIL', k);
  const pass = Object.values(checks).every(Boolean) && byteMatch;
  if (!pass) failures++;
  console.log(pass ? '  PASS' : '  FAIL');
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all templates OK'}`);
m.close();
process.exit(failures ? 1 : 0);
