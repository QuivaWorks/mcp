#!/usr/bin/env node
// Push the authored template example onto the platform, publish it, and generate
// two documents — one where the conditional sub-template SHOULD be included and
// one where it should be excluded — so the artefact can be checked in the UI.
//
// This is also the live test of the open `conditions` question
// (docs/quiva-mcp-handoff.md §4): the engine evaluates sub_templates[].conditions
// with rule-engine v2 and requires `...outcome === true`, while this MCP's docs and
// validator describe json-rules-engine { all: [ { fact, operator, value } ] }.
// Pass --negative-control to re-trigger with the WRONG form so the two can be
// compared: if the wrong form silently drops the sub-template, the two documents
// are identical and that is the bug, reproduced.
//
// No e-signature request is sent: the trigger payload deliberately omits
// insured_email, and a signatory whose rendered email is missing is silently
// skipped (so no HelloSign request is created and nothing is emailed).
//
// Usage:
//   node tools/push-example.mjs                    create + publish + trigger both cases
//   node tools/push-example.mjs --negative-control  also trigger with the {all:[...]} form
//   node tools/push-example.mjs --cleanup           delete the templates afterwards

import { QuivaClient } from '../src/client.js';
import { getExample } from '../src/examples.js';
import { validate } from '../src/validate.js';

const NEGATIVE_CONTROL = process.argv.includes('--negative-control');
const CLEANUP = process.argv.includes('--cleanup');
// There is NO /hub/documents route — it redirects to the hub. Templates live in
// the account Specialization dashboard (SpecializationDashboard -> subtab
// "documents" -> TemplatesConfigSection), and generated files are only browsable
// through the object-store manager.
const UI_TEMPLATES = 'https://app.microstrate.io/en/hub/account?tab=specialization&subtab=documents';
const UI_STORAGE = 'https://app.microstrate.io/en/hub/resources/storage/obj/manage?bucket=microstrate-documents';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Create-or-update: POST returns 402 when the key already exists, and PATCH is a
// create-or-overwrite upsert of the draft, so the script is re-runnable.
async function upsertTemplate(client, template) {
  try {
    await client.post('/templates', template);
    return 'created';
  } catch (err) {
    if (err.status === 402 || /exists/i.test(err.body?.error ?? '')) {
      await client.patch(`/templates/${encodeURIComponent(template.key)}`, template);
      return 'updated';
    }
    throw err;
  }
}

async function pollDocument(client, key, { attempts = 12, delay = 2500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await sleep(delay);
    try {
      const res = await client.get(`/documents/${encodeURIComponent(key)}`);
      const doc = res?.body ?? res;
      if (doc?.output?.key || doc?.errors) return doc;
    } catch {
      // A missing document 500s with "resource not found" until the job lands.
    }
  }
  return null;
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  const example = getExample('certificate-of-currency');
  const main = example.config;
  const subKey = main.sub_templates[0].key;
  console.log(`pushing "${example.slug}" to ${client.baseUrl}/file-generator\n`);

  const validation = validate(main, { requireKey: true });
  check('local validate', validation.valid, validation.errors.join('; '));
  if (!validation.valid) process.exit(1);

  // --- the conditional sub-template, sharing the main template's DOCX source ---
  const sub = {
    key: subKey,
    label: 'VIC terms (MCP verification sub-template)',
    source: main.source,
    output: { content_type: main.output.content_type },
  };
  console.log(`ok   - sub-template ${await upsertTemplate(client, sub)}: ${subKey}`);
  await client.post(`/templates/${encodeURIComponent(subKey)}/publish`, { key: subKey });
  const subPublished = await client.get(`/templates/${encodeURIComponent(subKey)}`);
  check('sub-template published', Boolean((subPublished?.body ?? subPublished)?.key));

  // --- the main template ---
  console.log(`ok   - main template ${await upsertTemplate(client, main)}: ${main.key}`);
  await client.post(`/templates/${encodeURIComponent(main.key)}/publish`, { key: main.key });
  const published = (await client.get(`/templates/${encodeURIComponent(main.key)}`))?.body;
  check('main template published', published?.key === main.key, JSON.stringify(published).slice(0, 200));
  check(
    'sub_templates[].conditions round-tripped in the v2 { operator, input } form',
    published?.sub_templates?.[0]?.conditions?.operator === '=',
    JSON.stringify(published?.sub_templates)
  );
  check(
    'output.name expression round-tripped',
    published?.output?.name === main.output.name,
    JSON.stringify(published?.output)
  );

  // --- trigger ---
  // The payload omits insured_email on purpose, so the signatory is skipped and NO
  // e-signature request is sent (the [sig|...] anchor then stays in the PDF as
  // literal text, which is expected).
  //
  // It must also cover every placeholder the DOCX actually contains. An unmatched
  // placeholder merges to an EMPTY STRING with no error anywhere, so a payload of
  // plausible-but-wrong keys produces a blank document that passes every check
  // below. That is exactly what happened on 2026-07-30. Guarded here so it cannot
  // recur silently.
  const basePayload = { ...example.trigger_payload };
  delete basePayload.insured_email;
  delete basePayload._why_these_keys;

  const declaredPlaceholders = example.placeholders_actually_in_this_docx?.names ?? [];
  const unmatched = declaredPlaceholders.filter((name) => basePayload[name] === undefined);
  check(
    `payload covers all ${declaredPlaceholders.length} placeholders in the source DOCX`,
    declaredPlaceholders.length > 0 && unmatched.length === 0,
    unmatched.length
      ? `missing ${unmatched.join(', ')} — each merges to an empty string with NO error, producing a blank document that still passes every check in this script`
      : 'the example does not record the DOCX placeholder names, so this cannot be checked — extract them and add placeholders_actually_in_this_docx.names'
  );
  if (unmatched.length) process.exit(1);

  const runs = [
    { label: 'condition TRUE  (risk_state VIC -> sub-template SHOULD be merged)', state: 'VIC', suffix: '-vic' },
    { label: 'condition FALSE (risk_state NSW -> sub-template should be omitted)', state: 'NSW', suffix: '-nsw' },
  ];

  const generated = [];
  for (const run of runs) {
    const payload = { ...basePayload, risk_state: run.state, policy_number: `${basePayload.policy_number}${run.suffix}` };
    const response = await client.post('/templates/trigger', {
      payload,
      list: [{ template: main.key }],
    });
    // The 200 is a BARE ARRAY: { template, subject } queued, { template, errors } failed.
    const entries = Array.isArray(response) ? response : (response?.body ?? []);
    const entry = Array.isArray(entries) ? entries[0] : entries;
    check(`trigger queued — ${run.label}`, Boolean(entry?.subject) && !entry?.errors, JSON.stringify(entry).slice(0, 300));
    if (!entry?.subject) continue;

    const docKey = `${main.output.folder}.certificate-${payload.policy_number}.pdf`;
    const doc = await pollDocument(client, docKey);
    check(`document generated — ${run.state}`, Boolean(doc?.output?.key) && !doc?.errors, `key=${docKey} doc=${JSON.stringify(doc).slice(0, 300)}`);
    // A signatory whose rendered email is missing is skipped, and the field comes
    // back as an EMPTY ARRAY (not null) — so length is what to assert. Verified
    // live 2026-07-29: `signatures: []` with insured_email omitted from the payload.
    check(
      `no e-signature request was created — ${run.state}`,
      !doc?.signatures?.length,
      `signatures: ${JSON.stringify(doc?.signatures)}`
    );
    generated.push({ state: run.state, key: docKey, output: doc?.output?.key, errors: doc?.errors });
  }

  if (NEGATIVE_CONTROL) {
    console.log('\nnegative control: re-publishing with the WRONG (json-rules-engine) conditions form');
    const wrong = { ...main, sub_templates: [example.wrong_conditions_negative_control] };
    await client.patch(`/templates/${encodeURIComponent(main.key)}`, wrong);
    await client.post(`/templates/${encodeURIComponent(main.key)}/publish`, { key: main.key });
    const payload = { ...basePayload, risk_state: 'VIC', policy_number: `${basePayload.policy_number}-wrongform` };
    const response = await client.post('/templates/trigger', { payload, list: [{ template: main.key }] });
    const entries = Array.isArray(response) ? response : (response?.body ?? []);
    const entry = Array.isArray(entries) ? entries[0] : entries;
    check('negative-control trigger queued', Boolean(entry?.subject), JSON.stringify(entry).slice(0, 200));
    const docKey = `${main.output.folder}.certificate-${payload.policy_number}.pdf`;
    const doc = await pollDocument(client, docKey);
    check('negative-control document generated', Boolean(doc?.output?.key), JSON.stringify(doc).slice(0, 200));
    generated.push({ state: 'VIC (wrong conditions form)', key: docKey, output: doc?.output?.key, errors: doc?.errors });
    // Restore the correct form so the artefact left on staging is the right one.
    await client.patch(`/templates/${encodeURIComponent(main.key)}`, main);
    await client.post(`/templates/${encodeURIComponent(main.key)}/publish`, { key: main.key });
    console.log('     restored the v2 conditions form on the published template');
  }

  console.log('\nGenerated documents:');
  for (const g of generated) {
    console.log(`  ${g.state.padEnd(30)} ${g.key}`);
    console.log(`  ${''.padEnd(30)} -> ${g.output ?? `FAILED: ${JSON.stringify(g.errors)}`}`);
  }

  console.log(`\nCheck it in the UI:`);
  console.log(`  Templates : ${UI_TEMPLATES}`);
  console.log(`              (Account -> Specialization -> Documents. There is no`);
  console.log(`               /hub/documents route; that URL redirects to the hub.)`);
  console.log(`  PDFs      : ${UI_STORAGE}`);
  console.log(`              (generated files are only browsable via the object-store`);
  console.log(`               manager — the bucket is set by output.bucket)`);
  console.log(`  What to look for: open the VIC and NSW PDFs side by side. The VIC one`);
  console.log(`  should carry the extra sub-template section, the NSW one should not.`);
  console.log(`  If they are IDENTICAL, the v2 conditions form is not being honoured and`);
  console.log(`  the sub-template is being dropped in both cases — report that.`);
  if (NEGATIVE_CONTROL) {
    console.log(`  The "-wrongform" PDF uses the { all: [...] } form the docs describe. If it`);
    console.log(`  matches the NSW output rather than the VIC output, the documented form is`);
    console.log(`  silently dropping the sub-template — the bug, reproduced.`);
  }

  if (CLEANUP) {
    console.log('\ncleaning up (deletes are verified, not trusted)');
    for (const key of [main.key, subKey]) {
      await client.delete(`/templates/${encodeURIComponent(key)}`); // published
      await client.delete(`/templates/${encodeURIComponent(key)}`, { draft: true }); // draft
      const listed = (await client.get('/templates'))?.body?.results ?? [];
      check(`template ${key} really deleted`, !listed.some((t) => t.key === key));
    }
    console.log('     NOTE: the generated document records and the PDFs in storage are left in place.');
  } else {
    console.log('\nLeft on staging. Re-run with --cleanup to remove the templates.');
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((err) => {
  console.error('push failed:', err.message, err.body ? JSON.stringify(err.body).slice(0, 300) : '');
  process.exit(1);
});
