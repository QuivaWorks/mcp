// Prove a vertical's document templates actually substitute their placeholders —
// the check this repo exists because of.
//
// HOW, AND WHY THIS WAY
//
// The payload is built FROM THE PLACEHOLDERS EXTRACTED OUT OF THE .docx, never from a
// hand-written list, so it cannot miss a key. Each value is `ZZZ-<field>-OK`, which is
// unmistakable in the output and names the placeholder it came from.
//
// The output is requested as DOCX, not PDF. Substitution happens on the DOCX and PDF
// conversion is a later step, so a DOCX output exercises the identical substitution
// path while leaving the result as plain readable XML. Checking the PDF instead is a
// trap: its text is stored in a subset font with hex/CID encoding, and a naive grep
// finds nothing. On 2026-08-04 that produced a 0/28 result that looked exactly like a
// blank document — a FALSE NEGATIVE from the checking tool. The tell was that the same
// grep could not find the static text "BUILDERS RISK" or "Deductible" either, and
// those are certainly in the file. If you want to check a PDF, you need pdftotext,
// pypdf, pymupdf or Quartz — none of which is guaranteed present.
//
// The run also asserts static text survived, so an empty extraction cannot pass as
// "everything substituted".
//
// It writes to a `zzz.verify` folder so its output is obviously disposable.
//
// usage: node tools/vertical/verify-documents.mjs <vertical> <key> [<key>...]

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { open } from './mcp.mjs';

const ROOT = process.env.MCP_REPO ?? process.cwd();
const [V, ...keys] = process.argv.slice(2);
if (!V || !keys.length) {
  console.error('usage: node tools/vertical/verify-documents.mjs <vertical> <key> [<key>...]');
  process.exit(1);
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FOLDER = 'zzz.verify';
const TMP = process.env.TMPDIR ?? '/tmp';

// bin/run.sh loads a server's .env; importing the client directly bypasses that.
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

function docxPlaceholders(path) {
  const py = `import zipfile,re,json;print(json.dumps(sorted(set(re.findall(r'\\{([^{}]{1,60})\\}', zipfile.ZipFile(${JSON.stringify(path)}).read('word/document.xml').decode())))))`;
  return JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8' }));
}

function docxBodyXml(path) {
  const py = `import zipfile,sys;sys.stdout.write(zipfile.ZipFile(${JSON.stringify(path)}).read('word/document.xml').decode())`;
  return execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const m = open(`${ROOT}/quiva-documents-mcp/bin/run.sh`);
await m.ready;

let failures = 0;
for (const key of keys) {
  const dir = `${ROOT}/verticals/${V}/document_templates`;
  const cfg = JSON.parse(readFileSync(`${dir}/${key}.json`, 'utf8'));
  const srcDocx = `${dir}/${key}.docx`;
  const names = docxPlaceholders(srcDocx);
  console.log(`\n=== ${key} ===`);
  console.log(`  ${names.length} placeholders extracted from the .docx`);

  // Keep the committed config's documented list honest against the file.
  const declared = (cfg._notes?.placeholders ?? []).map((p) => p.replace(/[{}]/g, ''));
  if (declared.length) {
    const undocumented = names.filter((n) => !declared.includes(n));
    const stale = declared.filter((n) => !names.includes(n));
    const agrees = !undocumented.length && !stale.length;
    console.log(`  _notes.placeholders agrees with the file: ${agrees ? 'yes' : 'NO'}`);
    if (undocumented.length) { console.log(`    in file, not documented: ${undocumented.join(', ')}`); failures++; }
    if (stale.length) { console.log(`    documented, not in file: ${stale.join(', ')}`); failures++; }
  }

  const payload = {};
  for (const n of names) payload[n] = `ZZZ-${n}-OK`;

  const outName = `zzzverify-${key}`;
  const fired = await m.call('trigger_templates', {
    payload,
    list: [{ template: cfg.key, output: { name: outName, content_type: DOCX_MIME, folder: FOLDER } }],
  }, 180000);
  if (fired?._error) { console.log(`  trigger FAILED: ${String(fired._error).slice(0, 300)}`); failures++; continue; }
  const row = (Array.isArray(fired) ? fired : [fired])[0] ?? {};
  if (row.errors?.length) { console.log(`  trigger errors: ${JSON.stringify(row.errors).slice(0, 300)}`); failures++; continue; }
  console.log(`  queued: ${row.subject ?? JSON.stringify(row).slice(0, 160)}`);

  // Generation is async. Poll the OBJECT, not get_document — and note get_document
  // takes `key` (the output filepath), NOT the subject it just handed you.
  const objKey = `${FOLDER}.${outName}.docx`;
  let buf = null;
  for (let i = 0; i < 40; i++) {
    try {
      const got = await objects.readObject('microstrate-documents', objKey);
      buf = Buffer.from(got.content, 'base64');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  if (!buf) { console.log(`  never appeared at microstrate-documents/${objKey}`); failures++; continue; }

  const local = `${TMP}/${outName}.docx`;
  writeFileSync(local, buf);
  let xml;
  try {
    xml = docxBodyXml(local);
  } catch (err) {
    console.log(`  output is not a readable docx: ${String(err.message).slice(0, 200)}`);
    failures++;
    continue;
  }

  const found = names.filter((n) => xml.includes(`ZZZ-${n}-OK`));
  const missing = names.filter((n) => !xml.includes(`ZZZ-${n}-OK`));
  const leftover = names.filter((n) => xml.includes(`{${n}}`));
  // Guard against a silently empty extraction passing as success.
  const staticSurvived = xml.length > 500 && /<w:t/.test(xml);

  console.log(`  output ${buf.length} bytes, static content present: ${staticSurvived}`);
  console.log(`  substituted: ${found.length}/${names.length}`);
  if (missing.length) console.log(`  RENDERED EMPTY: ${missing.join(', ')}`);
  if (leftover.length) console.log(`  BRACES LEFT UNSUBSTITUTED: ${leftover.join(', ')}`);

  const pass = !missing.length && !leftover.length && staticSurvived;
  if (!pass) failures++;
  console.log(pass ? '  PASS — every placeholder resolved to its value' : '  FAIL');
}

console.log(`\n${failures ? `${failures} problem(s)` : 'substitution verified for every template'}`);
console.log(`Disposable output was written under the "${FOLDER}" document folder.`);
m.close();
process.exit(failures ? 1 : 0);
