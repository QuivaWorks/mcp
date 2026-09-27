// Documents (file-generator) reference data — derived from the service engine
// source (file-generator-service/src: handlers, service.ts, type/*.ts,
// data/*.ts, request.ts, utils/subject.ts) and confirmed against staging,
// NOT just the OpenAPI spec. Where the spec and engine disagree the engine
// wins and the discrepancy is captured in GOTCHAS.

export const GOTCHAS = [
  // Content correctness vs mechanical success — the failure mode that produced a
  // completely blank document on staging while every check passed.
  'A placeholder in the source DOCX with no matching key in the trigger payload resolves to an EMPTY STRING — silently. No error, no warning, no `errors` entry on the document: trigger_templates returns a subject, the job succeeds, and a blank PDF lands in the bucket. Every mechanical signal is green (template published, trigger queued, document generated, byte sizes differ between runs) while the content is entirely empty. validate_docx does NOT check payload/placeholder agreement. So before authoring a payload, EXTRACT THE PLACEHOLDERS FROM THE DOCX and key the payload to exactly those names: python3 -c "import zipfile,re;print(sorted(set(re.findall(r\'{[^{}]{1,60}}\', zipfile.ZipFile(F).read(\'word/document.xml\').decode()))))". The tell in the output is stranded literal punctuation — an address line rendering as \'Mailing Address: , , \' is three empty placeholders with the DOCX\'s own commas between them. Hit live 2026-07-30: this MCP\'s own document-verification example sent invented keys (signer_name, total_amount, monthly_fee) against a DOCX expecting the camelCase names already sitting in that file, and shipped a blank document that was only caught when a human opened the PDF.',
  // Signature anchors are not expressions.
  'A HelloSign anchor in the DOCX (e.g. `[sig|req|signer1]`) is NOT an expression and is not substituted by the document engine. It is consumed by HelloSign when a signature request is created; if no request is created — because every signatory was skipped, e.g. the rendered email is missing — the anchor stays in the PDF as LITERAL TEXT. Seeing `Sig: [sig|req|signer1]` in output means no e-signature request was made, which may be intentional.',
  // Discrepancy #1 — REST base path (confirmed live on staging).
  'Every route lives under the `/file-generator` gateway prefix (e.g. GET /file-generator/templates). The spec\'s top-level /templates and /documents paths return 404. Single resources use a path param: GET /file-generator/templates/{key} — NOT ?key=.',
  // Update method.
  'Templates and documents are updated with PATCH (not PUT). PATCH is a merge-style upsert over the event stream: partial bodies are fine, untouched fields are preserved. To REMOVE a field use the .../unset endpoint. `key` is read from the request body, so always include it. Creating a template with an existing key returns 402; PATCH create-or-overwrites the draft.',
  // Draft -> published lifecycle.
  'Templates follow a draft -> published model. POST/PATCH always write the DRAFT; POST /templates/{key}/publish promotes the draft to published. Document GENERATION only ever uses the PUBLISHED version — draft edits do nothing until re-published. GET/DELETE take ?draft=true to target the draft; publish returns 400 if no draft exists.',
  // Trigger is async.
  'POST /templates/trigger is ASYNCHRONOUS. The 200 returns a BARE ARRAY [{ template, subject } | { template, errors }] — a subject means the job was queued (poll GET /documents/{key}), errors means it failed validation and no job ran. A template with no resolvable output.content_type (neither a trigger override nor a stored output.content_type) cannot be triggered.',
  // Response envelope.
  'Responses use a SINGLE `body` wrapper: { body: <payload>, metadata? } — status_code is the HTTP status, not in the JSON body. Lists are { body: { results: [...], results_total } }. Errors are top-level { error: "..." }. Read items carry extra event-sourcing fields (modified, sequence, subject, type) not in the spec schemas.',
  // Unset method asymmetry + missing-resource status (confirmed live).
  'Unset routes are asymmetric at the gateway: template unset is POST /templates/{key}/unset, but document unset is PATCH /documents/{key}/unset. A GET/PATCH on a missing OR deleted resource returns 500 with { error: "resource not found" } (not 404 — 404 is only a wrong route). PATCH on a template is create-or-overwrite, so a PATCH to a non-existent key silently CREATES a draft.',
  // Auth reality.
  'The engine only reads `Authorization: Bearer <jwt>` (request.ts derives the account/user, and thus the tenant, from the token). `X-Api-Key` is accepted because the gateway swaps it for a JWT (confirmed working for reads on staging).',
  // Subjects.
  'Response `subject`s: draft template `ms.document.draft.template.{key}`, published template `ms.document.template.{key}`, document `ms.document.document.{key}`. Keys are sanitised into subject tokens: `/` -> `.`, space -> `_`, other special chars -> `uXXXX` (utils/subject.ts).',
  // Expressions.
  'Template content and the expression-aware fields (output.name, signatories[].name/email) use single-brace angular syntax: {field}, {a.b.c}, {arr.0.x}, operators {qty * price}, conditionals {#x}...{/}, loops {#items}...{/items}, ternary {cond ? a : b}, and filters {d | formatdate:"yyyy-MM-dd":-5:en-US}. Missing payload fields render EMPTY, not error. Dates must be ISO 8601. Filter args are positional and ALL required. Validate a DOCX source with validate_docx before create/publish.',
  // Signatures.
  'E-signatures are HelloSign-backed. signatories[].name/email are expressions resolved from the trigger payload; a signatory whose rendered email is missing/invalid (or name empty) is silently skipped, and if none remain no request is sent (document.signatures stays null). get_document_signature_url only works for signatures created in embedded mode. The HelloSign webhook is platform-called and is intentionally not exposed as a tool.',
  // Coverage note.
  'The file-generator service also has AI-generation handlers (pptx, docx-generator, docx-editor, pdf-python, xlsx, html-pdf), but they are NOT in the gateway route registry (quiva-endpoints.json) and 404 at the REST gateway — not agent-callable via REST, so they are intentionally NOT exposed as tools (agents invoke them through other means when needed). The internal `approval-audit` handler and the HelloSign webhook are likewise not exposed.',
  // PDF fill: the field that is neither mapped nor tagged is the silent case.
  'A PDF form field with no entry in `pdf.fields` AND no `{tag}` already sitting in its own value/default-value/tooltip is left EXACTLY as the source PDF had it — not blanked, not filled, no warning at trigger time (fill.ts: an unmatched field only gets cleared if its stray text itself looks like a tag). A stale example value a designer left in the source PDF (e.g. sample text in a text field) ships into every generated document silently. `validate_docx` surfaces unmapped fields as warnings, but trigger_templates does not call it for you — check the field list yourself before publishing.',
  // PDF fill: loops are a hard rejection, not a silent no-op.
  'A PDF field value is ONE expression — a loop/section tag ({#items}...{/items}) is REJECTED outright at fill time ("a PDF field holds one value..."), which fails the whole trigger with an error. This is the one placeholder mistake that is NOT silent; the silent ones are a missing key (renders empty) and an unmapped/untagged field (left as-is).',
  // PDF fill: buttons.
  'Mapping a push-button field in `pdf.fields` has NO EFFECT — the fill code skips PDFButton fields entirely. validate_docx reports this as a warning, not an error, so it is easy to miss.',
  // PDF fill: choice fields are the one case that is NOT silent, with a caveat.
  'A dropdown/radio value that is not one of the field\'s real options is NOT silent at fill time — it throws and fails the whole trigger with an error entry, unlike the DOCX-placeholder case. But `validate_docx` can only catch this early when the mapped expression has no `{tag}` (a fixed value); a dynamic expression is checked against an EMPTY payload at validate time, so a mismatch only surfaces once you actually trigger.',
  // PDF publish-time gates (file-generator-service/src/handler/template-publish.ts).
  'Publish refuses a `pdf` config unless `source.content_type` is application/pdf, refuses a PDF source paired with a DOCX output, and refuses a template with signatories and a PDF source that has no `boxes[].kind: "signature"` entry — a PDF carries no text tag to place a signature, so the box is the only way in. Every sub-template must also be published with the SAME source content type as the parent (a PDF parent cannot merge a DOCX sub-template).',
  // Units caveat, carried over from the implementing commit (0cbc615a0).
  'PDF box coordinates are PDF points, origin bottom-left, absolute (MediaBox/CropBox offset included) and unrotated — the same convention pdf.js\'s `viewport.convertToPdfPoint` produces. Per the commit that shipped this (0cbc615a0), the signing-box-to-HelloSign coordinate conversion is "not yet confirmed against the live API" — verify placement on an actual signed document before relying on exact positioning.',
];

const DOCX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_CONTENT_TYPE = 'application/pdf';

// output.content_type accepts PDF or DOCX (DOCX sources can render to either;
// PDF sources can only output PDF).
const OUTPUT_CONTENT_TYPES = [PDF_CONTENT_TYPE, DOCX_CONTENT_TYPE];

// source.content_type MIME types the service understands.
const SOURCE_CONTENT_TYPES = [DOCX_CONTENT_TYPE, 'application/pdf'];

// validate_docx accepts these content types (TemplateValidateCodec). PDF is a
// distinct path: it returns the AcroForm field list + page geometry, and (with
// `pdf`/`signatory_count` also sent) checks a draft `pdf` config against them.
const VALIDATE_CONTENT_TYPES = [
  'application/msword',
  DOCX_CONTENT_TYPE,
  'application/xml',
  PDF_CONTENT_TYPE,
];

const SIGNATURE_STATUSES = ['DRAFT', 'SENT', 'SIGNED', 'EXPIRED', 'FAILED'];

const TEMPLATE_EXAMPLE = {
  key: 'invoice-template',
  label: 'Standard Invoice',
  source: {
    key: 'invoice.docx',
    content_type: DOCX_CONTENT_TYPE,
  },
  output: {
    name: 'invoice-{invoice_number}',
    content_type: PDF_CONTENT_TYPE,
    bucket: 'microstrate-documents',
    folder: 'invoices',
  },
  signatories: [
    {
      name: '{client_name}',
      email: '{client_email}',
      validity: { day: 7 },
      order: 0,
    },
  ],
  sub_templates: [
    {
      key: 'terms-eu',
      // rule-engine v2 expression. NOT { all: [ { fact, operator, value } ] } —
      // that shape has no `outcome`, so the sub-template is silently dropped.
      // Proven live 2026-07-29; see the sub-templates reference topic.
      conditions: { operator: '=', input: ['@fact:client_region.value', 'EU'] },
    },
  ],
};

const PDF_TEMPLATE_EXAMPLE = {
  key: 'onboarding-form',
  label: 'Onboarding Form (PDF)',
  source: { key: 'onboarding-form.pdf', content_type: PDF_CONTENT_TYPE },
  output: {
    content_type: PDF_CONTENT_TYPE,
    bucket: 'microstrate-documents',
    folder: 'onboarding',
  },
  signatories: [
    { name: '{employee_name}', email: '{employee_email}', validity: { week: 1 }, order: 0 },
  ],
  pdf: {
    fields: [
      { name: 'StartDate', expression: '{start_date | formatdate:"dd MMM yyyy":0:en-US}' },
      { name: 'RoleTitle', expression: '{role_title}' },
    ],
    boxes: [
      { id: 'sig-1', kind: 'signature', signatory: 0, page: 0, x: 380, y: 60, width: 160, height: 40 },
    ],
    flatten: true,
  },
};

const TRIGGER_EXAMPLE = {
  payload: {
    client_name: 'Acme Corp',
    client_email: 'billing@acme.com',
    invoice_number: 'INV-2026-014',
    line_items: [
      { description: 'Consulting', qty: 10, unit_price: 120 },
      { description: 'Support retainer', qty: 1, unit_price: 800 },
    ],
    subtotal: 2000,
    tax: 400,
  },
  list: [{ template: 'invoice-template', output: { folder: 'invoices.2026' } }],
};

const REFERENCE = {
  'expressions': {
    summary:
      'Single-brace angular-expression syntax used inside the DOCX source and in output.name / signatories[].name/email. Missing payload fields render as an empty string (never an error).',
    substitution: '{field_name}, nested {object.property}, array {array.0.field}',
    operators: 'math + - * /, comparison == != > < >= <=, logical && ||, ternary {cond ? a : b}. Precedence: parentheses > * / > + -.',
    control: 'Conditional {#condition}...{/} (or {/condition}); loop {#array}...{/array}. {/} is the preferred close. Every open tag must close.',
    critical_rules: [
      'All opening tags must close: {#...}{/}',
      'Missing payload fields render empty, not error',
      'Dates must be ISO 8601 (2024-01-15T10:00:00Z)',
      'Filter parameters are positional and all required',
    ],
    example: '{#line_items}{description} — {qty * unit_price | formatcurrency:USD:en-US:true}\n{/line_items}',
    reference: 'https://docxtemplater.com/docs/angular-parse/',
  },
  'filters': {
    summary: 'Built-in expression filters. All parameters are positional and required.',
    formatdate: {
      syntax: '{date | formatdate:"pattern":TIMEZONE:LOCALE}',
      example: '{invoice_date | formatdate:"yyyy-MM-dd":-5:en-US}',
      reference: 'https://date-fns.org/v4.4.0/docs/format',
    },
    formatcurrency: {
      syntax: '{amount | formatcurrency:CURRENCY:LOCALE:DECIMALS}',
      example: '{total | formatcurrency:USD:en-US:true}',
    },
  },
  'template': {
    summary:
      'A template is { key, label?, source?, output?, signatories?, sub_templates?, pdf? }. `key` is the only required field (read from the body). `source` references a DOCX/PDF in object storage; `output` controls where/how the rendered file is written. `pdf` (fields/boxes/flatten) fills a PDF source\'s own form fields — see the pdf-templates topic. Writes target the DRAFT; publish to make generation use it.',
    source_content_types: SOURCE_CONTENT_TYPES,
    example: TEMPLATE_EXAMPLE,
  },
  'output': {
    summary:
      'Where/how the rendered document is written. Final storage key is {bucket}/{folder}/{name}.{ext}, ext derived from content_type. `name` is an expression template (do NOT include the extension). `bucket` may be prefixed obj:// (default) or kv://. If neither the trigger override nor the stored output sets content_type, the template cannot be triggered.',
    content_types: OUTPUT_CONTENT_TYPES,
    example: TEMPLATE_EXAMPLE.output,
  },
  'signatories': {
    summary:
      'Signatories requested for e-signature after generation. Each requires name, email, validity. name/email are expressions resolved from the payload; entries with a missing/invalid rendered email are skipped. validity (day/week/month/year, summed) sets the expiry. Status lifecycle: ' + SIGNATURE_STATUSES.join(' -> ') + '.',
    statuses: SIGNATURE_STATUSES,
    example: TEMPLATE_EXAMPLE.signatories,
  },
  'sub-templates': {
    summary:
      'Additional published templates rendered with the same payload and merged after the main template in order. Entries with `conditions` are included only when the condition resolves true. Payload keys are exposed as facts named `<key>.value`, so reference them as "@fact:<key>.value".',
    conditions_engine:
      'RULE-ENGINE V2, not json-rules-engine. template-trigger.ts:274 evaluates it as ' +
      "resolveRulesV2({ rules: { trigger: conditions }, facts })?.['trigger']?.outcome === true, " +
      'so the value must be an expression object whose resolved outcome is true: ' +
      '{ "operator": "=", "input": ["@fact:client_region.value", "EU"] }. ' +
      'type/template.ts:64 types conditions as record(string, unknown) — an object, so prefer a single expression over an array of cells.',
    conditions_pitfall:
      'A json-rules-engine object ({ all: [ { fact, operator, value } ] }) has no `outcome`, so isRuleCellV2 rejects it, the whole object becomes the outcome, and outcome === true is false — the SUB-TEMPLATE IS SILENTLY DROPPED from the generated document. No error is raised anywhere. ' +
      'VERIFIED LIVE 2026-07-29: three documents generated from one template and compared byte-for-byte in object storage — v2 form with the condition met 46551 bytes (merged), v2 form with it unmet 44582 bytes (omitted), and the { all: [...] } form WITH THE CONDITION MET also 44582 bytes, byte-identical to the omitted case.',
    example: TEMPLATE_EXAMPLE.sub_templates,
    wrong_example_do_not_use: { key: 'terms-eu', conditions: { all: [{ fact: 'client_region.value', operator: 'equal', value: 'EU' }] } },
  },
  'pdf-templates': {
    summary:
      'A PDF-sourced template fills its OWN AcroForm fields instead of substituting DOCX placeholders. `template.pdf` = { fields?, boxes?, flatten? } — only valid when source.content_type is application/pdf, and the output must also be PDF (PDF -> DOCX is not supported). See the "gotchas" topic for what fails silently vs what does not.',
    fields:
      'Array of { name, expression }. `name` must match a real field name in the PDF\'s AcroForm — get the real list from validate_docx, never guess. `expression` is the SAME single-brace angular syntax as DOCX ({field}, {a.b.c}, filters) but with NO loop/section tags: a PDF field holds one value, so {#items}...{/items} is rejected at fill time ("index the list ({items[0].name}) or join it with a filter"). Index a list instead: {items[0].name}.',
    precedence:
      'Per field, the first of these that exists wins: (1) a mapping in pdf.fields, (2) a {tag} already sitting in the field\'s own /V (value), /DV (default value) or /TU (tooltip) inside the source PDF — so a form can be tagged once in Acrobat and never touched again in config. A field with neither is left EXACTLY as the source PDF had it.',
    boxes:
      'Array of drawn boxes layered onto the page: { id, kind, page, x, y, width, height }. `kind: "text"` additionally takes `expression` (+ optional font_size, align: left|center|right, multiline). `kind: "signature"|"initials"|"date_signed"` takes `signatory` — the index into template.signatories AFTER sorting by `order` — and becomes a HelloSign field rather than being filled directly; it is not itself an expression. Coordinates are PDF points, origin bottom-left, absolute (MediaBox/CropBox offset included) and unrotated — what pdf-lib\'s addToPage / a widget\'s /Rect take, and what pdf.js\'s viewport.convertToPdfPoint produces, so a pdf.js-based UI can pass coordinates through unconverted. Box ids must be unique within a template.',
    flatten:
      'Defaults to true: the filled form is baked into flat page content (no longer editable) after generation. Set false to ship an editable filled form instead.',
    publish_requirements: [
      '`pdf` is rejected at publish unless source.content_type is application/pdf (create/update accept it regardless — publish is where it is enforced)',
      'a PDF source must have output.content_type application/pdf',
      'if the template has signatories, at least one boxes[] entry must be kind "signature" — a PDF carries no text tag to place a signature',
      'every sub_template must be published with a source of the SAME content_type as the parent',
    ],
    validate_before_create:
      'validate_docx with content_type "application/pdf" returns the real field list and page geometry. Also pass `pdf` (and `signatory_count`, if signatories are already known) to run the same checks create/update trigger server-side: expressions compile, no loop tags, mapped names exist in the PDF, fixed choice values are real field options, box pages/signatory indexes are in range, and which real fields are left unmapped.',
    example: PDF_TEMPLATE_EXAMPLE,
  },
  'trigger': {
    summary:
      'POST /templates/trigger generates documents from PUBLISHED templates. `payload` is the shared expression data context (free-form). `list` names template keys with optional per-entry output overrides. Async: the 200 is a bare array of { template, subject } (queued) or { template, errors } (failed) — poll get_document.',
    example: TRIGGER_EXAMPLE,
  },
  'document': {
    summary:
      'A generated (or registered) document: { created_at, name, output, template, signatures, errors }. States: queued (output null, errors null) -> generated (output.key = obj://... or kv://... storage URI) or failed (errors populated). signatures fills once a HelloSign request is sent.',
    example: {
      created_at: '2026-03-15T10:30:00Z',
      name: 'invoice-INV-2026-014.pdf',
      output: { key: 'obj://microstrate-documents/invoices.2026.invoice-INV-2026-014.pdf' },
      template: { key: 'invoice-template' },
      signatures: null,
      errors: null,
    },
  },
  'endpoints': {
    summary: 'The file-generator REST surface (all under the /file-generator prefix) -> engine subject. Confirmed live for reads + create/validate/trigger; update/delete/publish/unset follow the same pattern. `assigned-files` and `brand-extract` are confirmed gateway-mapped on production (401 unauthenticated, 2026-09-27) despite being absent from the published OpenAPI spec.',
    account: [
      'GET  /file-generator/assigned-files              -> get.assigned-files (documents + workspace files assigned to the current user)',
      'POST /file-generator/brand-extract                -> post.brand-extract (bucket, key -> theme fonts/colors from an Office doc already in storage; requires the CALLER\'s own connection, so only buckets that user can already read work)',
    ],
    templates: [
      'GET    /file-generator/templates?draft=            -> get.templates',
      'GET    /file-generator/templates/{key}?draft=      -> get.template',
      'POST   /file-generator/templates                   -> post.template (402 if key exists)',
      'PATCH  /file-generator/templates/{key}             -> patch.template (merge upsert of draft)',
      'DELETE /file-generator/templates/{key}?draft=      -> delete.template (poison-pill)',
      'POST   /file-generator/templates/{key}/publish     -> post.template-publish (400 if no draft)',
      'POST   /file-generator/templates/validate          -> post.template-validate (base64 DOCX)',
      'POST   /file-generator/templates/{key}/unset       -> template-unset (gateway routes this as POST, not PATCH)',
      'POST   /file-generator/templates/trigger           -> post.template-trigger (async, bare array)',
    ],
    documents: [
      'GET    /file-generator/documents?query=            -> get.documents (query required; wildcard e.g. contracts.* / contracts.>)',
      'GET    /file-generator/documents/{key}             -> get.document',
      'PATCH  /file-generator/documents/{key}             -> patch.document (upsert)',
      'DELETE /file-generator/documents/{key}             -> delete.document (poison-pill)',
      'PATCH  /file-generator/documents/{key}/unset       -> patch.document-unset',
      'GET    /file-generator/documents/{key}/signature-url?signature_id= -> get.document-signature-url (embedded mode only)',
    ],
    not_exposed: [
      'AI generation (pptx, docx-generator, docx-editor, pdf-python, xlsx, html-pdf) — service handlers exist but are NOT in the gateway route registry (404 at the REST gateway); not agent-callable, so not exposed as tools.',
      'hellosign-callback (POST /file-generator/webhooks/hellosign/{account}) — platform webhook, not agent-callable.',
      'approval-audit — internal; overwrites the object in place. Intentionally not exposed.',
    ],
  },
  'gotchas': { summary: 'Spec-vs-engine truths (engine wins).', values: GOTCHAS },
};

export function listReferenceTopics() {
  return Object.keys(REFERENCE).map((topic) => ({ topic, summary: REFERENCE[topic].summary }));
}

export function getReference(topic) {
  const doc = REFERENCE[topic];
  if (!doc) {
    return { error: `Unknown topic "${topic}". Available: ${Object.keys(REFERENCE).join(', ')}` };
  }
  return { topic, ...doc };
}

export {
  OUTPUT_CONTENT_TYPES,
  SOURCE_CONTENT_TYPES,
  VALIDATE_CONTENT_TYPES,
  SIGNATURE_STATUSES,
  TEMPLATE_EXAMPLE,
  PDF_TEMPLATE_EXAMPLE,
  TRIGGER_EXAMPLE,
};
