#!/usr/bin/env node
// Push the form-elements showcase config onto the platform, then READ IT BACK and
// check the element tree survived, so the artefact can be inspected in the UI.
//
// A write response is not proof: quiva-flows-mcp's delete_workflow returned
// {"message":"success"} while orphaning every draft (docs/quiva-mcp-handoff.md).
// Everything here is verified by re-reading.
//
// Why this exists: `element` view nodes only started rendering when
// record-view-renderer gained an `{:else if view.type === 'element'}` branch. The
// records-service stores `views` as an opaque []map[string]any and validates
// nothing inside it, so the API will happily accept an element tree that renders
// as blank space. The only way to know is to look — hence the UI checklist at the
// end.
//
// Usage:
//   node tools/push-form-elements.mjs            create/update + verify, leave it live
//   node tools/push-form-elements.mjs --cleanup  delete afterwards + verify it is gone

import { QuivaClient } from '../src/client.js';
import { getExample } from '../src/examples.js';
import { validate } from '../src/validate.js';
import { ELEMENT_KINDS } from '../src/records-docs.js';

const CLEANUP = process.argv.includes('--cleanup');
const UI = 'https://app.microstrate.io/en/hub/records/configs';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

// Walk a view tree collecting every node, so assertions can be made about the
// whole layout rather than the parts this script happens to name.
function collect(node, path = '', out = []) {
  if (Array.isArray(node)) {
    node.forEach((c, i) => collect(c, `${path}[${i}]`, out));
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.type === 'string') out.push({ path, node });
  for (const [key, value] of Object.entries(node)) collect(value, `${path}.${key}`, out);
  return out;
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  const example = getExample('form-elements-showcase');
  const config = example.config;
  const configId = config.id;
  console.log(`pushing "${example.slug}" (${configId}) to ${client.baseUrl}\n`);

  // --- local validation: the element tree must be clean, not merely valid ---
  const validation = validate(config, { requireId: true });
  check('local validate: no errors', validation.valid, validation.errors.join('; '));
  check(
    'local validate: no warnings either',
    validation.warnings.length === 0,
    `an element showcase with warnings is teaching the wrong thing:\n       ${validation.warnings.join('\n       ')}`
  );
  if (!validation.valid) process.exit(1);

  // --- create, or update if it is already there (re-runnable) ---
  const existing = await client.get(`/records/config/${encodeURIComponent(configId)}`).catch(() => null);
  if (existing?.id === configId) {
    console.log(`ok   - config ${configId} already exists, updating`);
    await client.put(`/records/config/${encodeURIComponent(configId)}`, config);
  } else {
    await client.post('/records/config', config);
    console.log(`ok   - created config ${configId}`);
  }

  // --- read back ---
  const read = await client.get(`/records/config/${encodeURIComponent(configId)}`);
  const stored = read?.body ?? read;
  check('config read back by id', stored?.id === configId, `got ${JSON.stringify(stored?.id)}`);
  check('name round-tripped', stored?.name === config.name, `got ${JSON.stringify(stored?.name)}`);

  const forms = stored?.views?.forms ?? [];
  check('views.forms survived the round trip', forms.length === 1, `got ${forms.length} form(s)`);
  const layout = forms[0]?.layout;
  check('the form layout root is a grid', layout?.type === 'grid', `got ${JSON.stringify(layout?.type)}`);

  const nodes = collect(layout);
  const elements = nodes.filter(({ node }) => node.type === 'element');
  const authored = collect(config.views.forms[0].layout).filter(({ node }) => node.type === 'element');

  check(
    'every element node came back',
    elements.length === authored.length,
    `authored ${authored.length}, stored ${elements.length} — records-service stores views as opaque []map[string]any, so a loss here means the transport mangled it`
  );

  const storedKinds = new Set(elements.map(({ node }) => node.element));
  check(
    'all seven element kinds are present',
    ELEMENT_KINDS.every((k) => storedKinds.has(k)),
    `missing: ${ELEMENT_KINDS.filter((k) => !storedKinds.has(k)).join(', ') || 'none'}`
  );

  // The prop that is easiest to lose and hardest to notice: a note's alignment
  // key. The builder writes textAlign, the renderer reads align.
  const note = elements.find(({ node }) => node.element === 'text-note')?.node;
  check(
    'the text-note kept `align` (NOT textAlign — the renderer only reads align for a note)',
    note?.props?.align === 'left' && note?.props?.textAlign === undefined,
    `got ${JSON.stringify(note?.props)}`
  );

  // helpText must stay an object; a stringified one renders nothing.
  const heading = elements.find(({ node }) => node.element === 'text-heading')?.node;
  check(
    'helpText survived as an object, not a string',
    heading?.props?.helpText && typeof heading.props.helpText === 'object' && typeof heading.props.helpText.markdown === 'string',
    `got ${JSON.stringify(heading?.props?.helpText)}`
  );

  // Element rules are the part that actually behaves at runtime.
  const withRules = elements.filter(({ node }) => Array.isArray(node.rules) && node.rules.length);
  check(
    'element rules round-tripped',
    withRules.length >= 2,
    `expected the alert (2 rules) and the card (1 rule); got ${withRules.length} element(s) with rules`
  );
  const card = elements.find(({ node }) => node.element === 'card')?.node;
  check(
    'the card kept its `visible` rule (the one the builder catalog will not offer)',
    (card?.rules ?? []).some((r) => r.property === 'visible'),
    `got ${JSON.stringify(card?.rules)}`
  );

  // Container children must still be grid rows — this is what breaks layouts.
  for (const kind of ['card', 'card-collapsable']) {
    const container = elements.find(({ node }) => node.element === kind)?.node;
    check(
      `${kind} children are all grid rows`,
      Array.isArray(container?.children) && container.children.every((c) => c?.type === 'grid'),
      `got ${JSON.stringify((container?.children ?? []).map((c) => c?.type))}`
    );
  }

  // Re-validate what the SERVER returned, not what we sent. The service does not
  // validate views at all, so this is the only check that the stored shape is
  // still one the renderer can use.
  const revalidated = validate(stored, { requireId: true });
  check(
    'the config as STORED still passes the validator',
    revalidated.valid && revalidated.warnings.length === 0,
    `errors: ${revalidated.errors.join('; ')} warnings: ${revalidated.warnings.join('; ')}`
  );

  console.log(`\nCheck it in the UI:`);
  console.log(`  Config : ${UI}/${configId}`);
  console.log(`  Form   : ${UI}/${configId}/forms/default`);
  console.log(`  Use the PREVIEW tab — the Edit tab sets pointer-events: none, so`);
  console.log(`  inputs will not respond there.`);
  console.log(`\n  What to look for:`);
  for (const line of example.how_to_verify_on_staging.slice(2)) {
    console.log(`    - ${line}`);
  }
  console.log(`\n  And the one thing that is EXPECTED to look wrong:`);
  console.log(`    - open the note inside the Cover card in the builder's inspector and`);
  console.log(`      change its alignment. It will not move: the inspector writes`);
  console.log(`      props.textAlign and the renderer reads props.align for a note.`);
  console.log(`      That is the frontend bug this example documents.`);

  if (CLEANUP) {
    console.log('\ncleaning up (deletes are verified, not trusted)');
    await client.delete(`/records/config/${encodeURIComponent(configId)}`);
    const after = await client.get(`/records/config/${encodeURIComponent(configId)}`).catch(() => null);
    check('config really deleted', !after || after?.id !== configId, `still readable: ${JSON.stringify(after?.id)}`);
  } else {
    console.log('\nLeft on staging. Re-run with --cleanup to remove it.');
  }

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((err) => {
  console.error('push failed:', err.message, err.body ? JSON.stringify(err.body).slice(0, 400) : '');
  process.exit(1);
});
