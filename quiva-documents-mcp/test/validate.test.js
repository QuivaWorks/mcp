// Hand-rolled test runner for the template validator (no framework).
// Run: npm test  (or: node test/validate.test.js)
import assert from 'node:assert/strict';
import { validate, lintExpression } from '../src/validate.js';
import { readHarvestedTemplates, getExample } from '../src/examples.js';
import { GOTCHAS } from '../src/documents-docs.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF = 'application/pdf';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL - ${name}\n      ${err.message}`);
  }
}

check('valid minimal template (key only) passes', () => {
  const r = validate({ key: 'invoice-template' });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('missing key fails on create', () => {
  const r = validate({ label: 'X' });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('key is required')));
});

check('key optional on update (require_key=false)', () => {
  const r = validate({ label: 'New label' }, { requireKey: false });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

check('source without content_type errors', () => {
  const r = validate({ key: 't', source: { key: 'a.docx' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('source.content_type is required')));
});

check('invalid output.content_type errors', () => {
  const r = validate({ key: 't', output: { content_type: 'text/plain' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('output.content_type must be')));
});

check('PDF source with DOCX output errors', () => {
  const r = validate({ key: 't', source: { key: 'a.pdf', content_type: PDF }, output: { content_type: DOCX } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('PDF->DOCX')));
});

check('valid full template with signatory + sub_template passes', () => {
  const r = validate({
    key: 'invoice-template',
    source: { key: 'invoice.docx', content_type: DOCX },
    output: { name: 'invoice-{invoice_number}', content_type: PDF },
    signatories: [{ name: '{client_name}', email: '{client_email}', validity: { day: 7 }, order: 0 }],
    sub_templates: [{ key: 'terms-eu', conditions: { operator: '=', input: ['@fact:region.value', 'EU'] } }],
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

// --- sub_templates[].conditions (rule-engine v2) ---------------------------
// The { all: [...] } form was DOCUMENTED AND ENFORCED here until 2026-07-29, and
// verified live to silently drop the sub-template from the generated document.

check('conditions in the json-rules-engine { all: [...] } form is an error', () => {
  const r = validate({ key: 't', sub_templates: [{ key: 'terms', conditions: { all: [{ fact: 'a.value', operator: 'equal', value: 'x' }] } }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('SILENTLY DROPPED')), JSON.stringify(r.errors));
});

check('conditions in the { any: [...] } form is an error too', () => {
  const r = validate({ key: 't', sub_templates: [{ key: 'terms', conditions: { any: [] } }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('json-rules-engine')));
});

check('conditions as a v2 expression object passes clean', () => {
  const r = validate({ key: 't', sub_templates: [{ key: 'terms', conditions: { operator: '=', input: ['@fact:region.value', 'EU'] } }] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, [], JSON.stringify(r.warnings));
});

check('a fact reference missing the .value suffix warns', () => {
  const r = validate({ key: 't', sub_templates: [{ key: 'terms', conditions: { operator: '=', input: ['@fact:region', 'EU'] } }] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('@fact:region.value')), JSON.stringify(r.warnings));
});

check('conditions with neither operator nor outcome warns', () => {
  const r = validate({ key: 't', sub_templates: [{ key: 'terms', conditions: { fact: 'region', value: 'EU' } }] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('will not recognise it as a rule cell')));
});

check('an unknown v2 operator warns rather than blocking', () => {
  const r = validate({ key: 't', sub_templates: [{ key: 'terms', conditions: { operator: 'sounds-like', input: ['@fact:a.value', 'x'] } }] });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('not in the transcribed rule-engine v2 operator set')));
});

check('non-object conditions is an error naming the v2 shape', () => {
  const r = validate({ key: 't', sub_templates: [{ key: 'terms', conditions: [{ operator: '=' }] }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('v2 expression OBJECT')));
});

check('signatory missing validity errors', () => {
  const r = validate({ key: 't', signatories: [{ name: 'A', email: 'a@b.com' }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('validity is required')));
});

check('sub_template missing key errors', () => {
  const r = validate({ key: 't', sub_templates: [{ conditions: {} }] });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('sub_templates[0].key is required')));
});

check('output.name with extension warns', () => {
  const r = validate({ key: 't', output: { name: 'invoice-{n}.pdf', content_type: PDF } });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.ok(r.warnings.some((w) => w.includes('should NOT include a .pdf')));
});

check('unbalanced braces in output.name errors', () => {
  const r = validate({ key: 't', output: { name: 'invoice-{invoice_number', content_type: PDF } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes('unbalanced braces')));
});

check('key with special chars warns about subject re-encoding', () => {
  const r = validate({ key: 'my invoice/2026' });
  assert.equal(r.valid, true);
  assert.ok(r.warnings.some((w) => w.includes('re-encoded')));
});

// --- expression linter ---

check('balanced loop expression is clean', () => {
  const r = lintExpression('{#line_items}{description} — {qty * price}{/line_items}');
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
});

check('unclosed section tag errors', () => {
  const r = lintExpression('{#line_items}{description}');
  assert.ok(r.errors.some((e) => e.includes('unclosed section')));
});

check('close tag without open errors', () => {
  const r = lintExpression('{description}{/line_items}');
  assert.ok(r.errors.some((e) => e.includes('no matching open')));
});

check('mismatched close tag warns', () => {
  const r = lintExpression('{#items}{x}{/rows}');
  assert.ok(r.warnings.some((w) => w.includes('does not match')));
});

check('formatdate missing args warns', () => {
  const r = lintExpression('{invoice_date | formatdate:"yyyy-MM-dd"}');
  assert.ok(r.warnings.some((w) => w.includes('formatdate needs 3')));
});

check('implicit {/} close is accepted', () => {
  const r = lintExpression('{#discount > 0}Discount applies{/}');
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
});

// --- golden gate ------------------------------------------------------------
// Every template in examples/harvested/ is a REAL template living on the
// platform. If the validator rejects one, the VALIDATOR is wrong — that is the
// whole point of this gate. Anything not explained by the allowlist below is a
// bug by definition. (See docs/lessons.md: the flows MCP shipped a wrong rules
// syntax for two weeks because no check like this existed.)

const ALLOWED_GOLDEN_FAILURES = [
  // Reads carry event-sourcing fields the validator does not know about; those
  // are response-only and never sent on a write, so they are not errors.
];

const harvestedTemplates = readHarvestedTemplates();

check('golden: examples/harvested/ is populated (run tools/harvest-examples.mjs)', () => {
  assert.ok(harvestedTemplates.length > 0, 'no harvested templates — the golden gate cannot run');
});

for (const example of harvestedTemplates) {
  check(`golden: validator accepts real template "${example.slug}"`, () => {
    const result = validate(example.config);
    const unexplained = (result.errors ?? []).filter(
      (e) => !ALLOWED_GOLDEN_FAILURES.some(({ match }) => match.test(e))
    );
    assert.deepEqual(
      unexplained,
      [],
      `validator rejected a template that is live on the platform:\n  ${unexplained.join('\n  ')}`
    );
  });
}

check('golden: a harvested template proves the signatory shape', () => {
  const withSignatories = harvestedTemplates.filter((e) => (e.config?.signatories ?? []).length > 0);
  assert.ok(
    withSignatories.length > 0,
    'no harvested template has signatories — e-signature guidance has no evidence behind it'
  );
});

// The engine evaluates sub_templates[].conditions with rule-engine v2
// (template-trigger.ts:274 requires ...outcome === true), but this MCP's docs and
// validator still describe json-rules-engine {all:[{fact,operator,value}]}. That
// form has no `outcome`, so a sub-template carrying it is SILENTLY DROPPED.
// This check pins the fact that no live template relies on either form, so the
// documentation can be corrected without breaking anything already deployed.
check('golden: no live template uses sub_templates[].conditions (checked 2026-07-29)', () => {
  const users = harvestedTemplates.filter((e) =>
    (e.config?.sub_templates ?? []).some((s) => s.conditions !== undefined)
  );
  assert.deepEqual(
    users.map((e) => e.slug),
    [],
    'a live template now uses conditions — verify it is the v2 { operator, input } form, ' +
      'not { all: [...] }: the latter is silently dropped from the generated document'
  );
});

check('the authored example teaches the v2 conditions form, not the json-rules-engine one', () => {
  const example = getExample('certificate-of-currency');
  const conditions = example.config.sub_templates[0].conditions;
  assert.ok(conditions.operator !== undefined, 'authored example must use { operator, input } (rule-engine v2)');
  assert.ok(conditions.all === undefined, 'authored example must NOT use the { all: [...] } form');
  assert.ok(
    example.wrong_conditions_negative_control?.conditions?.all !== undefined,
    'the negative control should keep the wrong form for comparison'
  );
});

// --- payload must match the DOCX placeholders (the blank-certificate bug) -------
// The first version of the certificate example sent invented keys against a DOCX
// expecting camelCase ones, and shipped a completely blank PDF. Nothing errored.
// These checks keep the corrected mapping and the explanation from drifting back.

check('the certificate example payload covers every placeholder in the DOCX', () => {
  const example = getExample('certificate-of-currency');
  const declared = example.placeholders_actually_in_this_docx?.names ?? [];
  assert.ok(declared.length > 0, 'the example must record which placeholders the DOCX actually has');
  const payloadKeys = new Set(Object.keys(example.trigger_payload ?? {}));
  const missing = declared.filter((name) => !payloadKeys.has(name));
  assert.deepEqual(
    missing,
    [],
    `payload is missing DOCX placeholder(s) ${missing.join(', ')} — each merges to an empty string with NO error, which is how a blank certificate shipped`
  );
});

check('the example keeps the extra keys the config itself needs', () => {
  const example = getExample('certificate-of-currency');
  const payloadKeys = new Set(Object.keys(example.trigger_payload ?? {}));
  // output.name is "certificate-{policy_number}" and the sub-template condition
  // reads @fact:risk_state.value. Neither is a DOCX placeholder, so neither is
  // covered by the check above.
  assert.ok(payloadKeys.has('policy_number'), 'output.name interpolates {policy_number} into the filename');
  assert.ok(payloadKeys.has('risk_state'), 'the sub-template condition reads @fact:risk_state.value');
});

check('the example does not claim DOCX contents it cannot back up', () => {
  const example = getExample('certificate-of-currency');
  assert.equal(
    example.expressions_used_in_the_docx,
    undefined,
    'that field name asserted these expressions were in the source file when they were only syntax examples — it is part of why the blank PDF went unnoticed. Use expression_syntax_reference.'
  );
  assert.ok(example.expression_syntax_reference?.examples?.length, 'the syntax reference should survive the rename');
  assert.ok(
    example.placeholder_mismatch_is_silent?.why_nothing_complained?.includes('empty string'),
    'the explanation of the silent failure must stay in the example'
  );
});

check('the gotchas warn that an unmatched placeholder fails silently', () => {
  assert.ok(
    GOTCHAS.some((g) => g.includes('EMPTY STRING') && g.includes('validate_docx')),
    'an agent reading only the gotchas must learn that validate_docx does not check payload/placeholder agreement'
  );
  assert.ok(
    GOTCHAS.some((g) => g.includes('HelloSign anchor')),
    'a leftover [sig|...] anchor in the output is expected when no signature request is created — say so'
  );
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
