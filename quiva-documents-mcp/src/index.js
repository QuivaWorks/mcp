#!/usr/bin/env node
// Quiva Documents MCP server — manage document templates, documents,
// e-signatures, and AI file generation (the file-generator service).
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient } from './client.js';
import {
  GOTCHAS,
  listReferenceTopics,
  getReference,
  VALIDATE_CONTENT_TYPES,
} from './documents-docs.js';
import { validate } from './validate.js';
import { listExamples, getExample } from './examples.js';

export const instructions = `
Tools for managing Quiva document templates, generated documents, and
e-signatures (the file-generator service). Templates follow a draft -> published
model; document generation only uses the PUBLISHED version.

Recipe:
1. list_reference_topics / get_documents_reference — learn expression syntax,
   filters, template/output/signatory shapes, and the spec-vs-engine gotchas.
2. list_templates / get_template — discover existing templates.
3. validate_template_config (local) and validate_docx (server, base64 DOCX) —
   lint before writing.
4. create_template -> publish_template — define and promote a template.
5. trigger_templates -> get_document — generate documents (async; poll).

Top gotchas:
${GOTCHAS.map((g) => `- ${g}`).join('\n')}
`.trim();

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err) {
  const detail = err?.body ? `\n${JSON.stringify(err.body, null, 2)}` : '';
  return {
    content: [{ type: 'text', text: `Error: ${err.message}${detail}` }],
    isError: true,
  };
}

// Free-form JSON value (source, output, signatories, payload, ...). MCP clients
// pass untyped params as raw strings, so coerce JSON-looking strings back to
// values — otherwise an object/array arrives as a string and is rejected.
const jsonValue = z.preprocess((v) => {
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (/^[[{"]/.test(trimmed) || /^(true|false|null|-?\d)/.test(trimmed)) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return v;
      }
    }
  }
  return v;
}, z.any());

// Some API responses are primitives/arrays; spreading needs an object.
function wrap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
}

const sourceField = jsonValue.describe('Source file ref: { key: "invoice.docx" | "obj://bucket/path.docx", content_type }. DOCX renders to PDF or DOCX; PDF only outputs PDF.');
const outputField = jsonValue.describe('Output config: { name?: "invoice-{invoice_number}" (expression, no extension), content_type?: pdf|docx, bucket?, folder? }.');
const signatoriesField = jsonValue.describe('Array of { name, email, validity: { day?, week?, month?, year? }, order? }. name/email are expressions resolved from the trigger payload.');
const subTemplatesField = jsonValue.describe(
  'Array of { key, conditions? }. Merged after the main template. `conditions` is a rule-engine V2 expression object — { "operator": "=", "input": ["@fact:region.value", "EU"] } — NOT { all: [ { fact, operator, value } ] }, which has no `outcome` and causes the sub-template to be SILENTLY DROPPED (verified live). Facts come from the trigger payload as `<key>.value`.'
);
const pdfField = jsonValue.describe(
  'PDF form-fill config, only valid when source.content_type is application/pdf: { fields?: [{ name, expression }], boxes?: [{ id, kind: text|signature|initials|date_signed, page, x, y, width, height, ...kind-specific }], flatten?: boolean }. See get_documents_reference("pdf-templates").'
);

// Registers this server's tools on `server`, bound to `client`. `prefix` lets
// several servers be composed into one host without name collisions.
export function registerTools(server, client, { prefix = '' } = {}) {
  function tool(name, description, inputSchema, handler) {
    server.registerTool(`${prefix}${name}`, { description, inputSchema }, async (args) => {
      try {
        return jsonResult(await handler(args ?? {}));
      } catch (err) {
        return errorResult(err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Reference & validation (no API call)
  // ---------------------------------------------------------------------------

  tool(
    'list_reference_topics',
    'List documents reference topics (expressions, filters, template, output, signatories, sub-templates, pdf-templates, trigger, document, endpoints, gotchas) plus the known spec-vs-engine gotchas. Start here.',
    {},
    async () => ({ topics: listReferenceTopics(), gotchas: GOTCHAS })
  );

  tool(
    'get_documents_reference',
    'Get the full reference for one topic: shapes, allowed values, and a correct example.',
    { topic: z.string().describe('One of the topics from list_reference_topics') },
    async ({ topic }) => getReference(topic)
  );

  tool(
    'list_examples',
    'List bundled reference examples: real templates and generated-document records harvested off the platform, plus hand-written illustrations. Read one before authoring a template — a harvested example is proof of a shape that works.',
    {},
    async () => listExamples()
  );

  tool(
    'get_example',
    'Get one reference example in full (template config or document record, plus what it teaches). Harvested examples are real platform data; authored ones are illustrations and say so.',
    { slug: z.string().describe('Example slug from list_examples') },
    async ({ slug }) => getExample(slug)
  );

  tool(
    'validate_template_config',
    'Validate a template locally (no API call): key required, source/output shapes, output.content_type enum, PDF->DOCX guard, signatory shape, pdf fields/boxes shape (kind enum, numeric geometry, unique ids, loop-tag rejection in expressions, signature-box-required-with-signatories warning), and angular-expression tag balance in output.name / signatory fields. Run before create_template / update_template. (For the source file itself — DOCX or PDF — use validate_docx.)',
    {
      template: jsonValue.describe('The template: { key, label?, source?, output?, signatories?, sub_templates?, pdf? }'),
      require_key: z.boolean().default(true).describe('Set false to validate a partial update payload (key optional)'),
    },
    async ({ template, require_key }) => validate(template, { requireKey: require_key })
  );

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------

  tool(
    'list_templates',
    'List templates. Pass draft=true to list drafts instead of published. Returns { body: { results, results_total } }.',
    { draft: z.boolean().default(false).describe('List draft templates instead of published') },
    async ({ draft }) => client.get('/templates', draft ? { draft: true } : undefined)
  );

  tool(
    'get_template',
    'Get one template by key. Pass draft=true to fetch the draft version (defaults to published).',
    {
      key: z.string().describe('Template key'),
      draft: z.boolean().default(false).describe('Fetch the draft version'),
    },
    async ({ key, draft }) =>
      client.get(`/templates/${encodeURIComponent(key)}`, draft ? { draft: true } : undefined)
  );

  tool(
    'create_template',
    'Create a DRAFT template (POST). Validated locally first (errors block; warnings are reported alongside). Returns 402 if the key already exists (use update_template). Remember to publish_template to make it usable by trigger_templates.',
    {
      key: z.string().describe('Unique template key'),
      label: z.string().optional().describe('Human-readable display name'),
      source: sourceField.optional(),
      output: outputField.optional(),
      signatories: signatoriesField.optional(),
      sub_templates: subTemplatesField.optional(),
      pdf: pdfField.optional(),
      skip_local_validation: z.boolean().default(false).describe('Set true only to intentionally bypass the local validator'),
    },
    async ({ key, label, source, output, signatories, sub_templates, pdf, skip_local_validation }) => {
      const template = { key, label, source, output, signatories, sub_templates, pdf };
      let validation = null;
      if (!skip_local_validation) {
        validation = validate(template, { requireKey: true });
        if (!validation.valid) return { created: false, validation };
      }
      const body = { key };
      if (label !== undefined) body.label = label;
      if (source !== undefined) body.source = source;
      if (output !== undefined) body.output = output;
      if (signatories !== undefined) body.signatories = signatories;
      if (sub_templates !== undefined) body.sub_templates = sub_templates;
      if (pdf !== undefined) body.pdf = pdf;
      const created = await client.post('/templates', body);
      return validation?.warnings?.length ? { ...wrap(created), warnings: validation.warnings } : created;
    }
  );

  tool(
    'update_template',
    'Update a DRAFT template (PATCH, merge upsert — only the fields you pass are changed; untouched fields are preserved). Use unset_template_paths to REMOVE a field. Re-publish for changes to affect generation. Validated locally first.',
    {
      key: z.string().describe('Template key to update'),
      label: z.string().optional(),
      source: sourceField.optional(),
      output: outputField.optional(),
      signatories: signatoriesField.optional(),
      sub_templates: subTemplatesField.optional(),
      pdf: pdfField.optional(),
      skip_local_validation: z.boolean().default(false),
    },
    async ({ key, label, source, output, signatories, sub_templates, pdf, skip_local_validation }) => {
      const body = { key };
      if (label !== undefined) body.label = label;
      if (source !== undefined) body.source = source;
      if (output !== undefined) body.output = output;
      if (signatories !== undefined) body.signatories = signatories;
      if (sub_templates !== undefined) body.sub_templates = sub_templates;
      if (pdf !== undefined) body.pdf = pdf;

      let validation = null;
      if (!skip_local_validation) {
        validation = validate(body, { requireKey: false });
        if (!validation.valid) return { updated: false, validation };
      }
      const updated = await client.patch(`/templates/${encodeURIComponent(key)}`, body);
      return validation?.warnings?.length ? { ...wrap(updated), warnings: validation.warnings } : updated;
    }
  );

  tool(
    'publish_template',
    'Publish a draft template — promotes the current draft to the published version that trigger_templates uses. Returns 400 if no draft exists for the key.',
    { key: z.string().describe('Template key') },
    async ({ key }) => client.post(`/templates/${encodeURIComponent(key)}/publish`, { key })
  );

  tool(
    'validate_docx',
    'Server-side validation of a base64-encoded template file. For DOCX/DOC/XML: confirms the angular tags compile (unclosed loops, bad expressions), returning { body: { is_valid, errors } }. For application/pdf: inspects the AcroForm and returns { body: { is_valid, errors, warnings, fields, pages } } — pass `pdf` (and `signatory_count`, if known) to also check a draft pdf config against the real fields (expressions compile, no loop tags, mapped names exist, fixed choice values are real options, box pages/signatory indexes in range, and which real fields are left unmapped). Nothing is persisted either way. Run before storing a new/changed source.',
    {
      content_type: z.enum(VALIDATE_CONTENT_TYPES).describe('MIME type of the file being validated'),
      content: z.string().describe('Base64-encoded file content'),
      pdf: pdfField.optional().describe('PDF only: a draft pdf config to check against this file\'s real fields'),
      signatory_count: z.number().optional().describe('PDF only: how many signatories the template will have, to range-check boxes[].signatory'),
    },
    async ({ content_type, content, pdf, signatory_count }) => {
      const body = { content_type, content };
      if (pdf !== undefined) body.pdf = pdf;
      if (signatory_count !== undefined) body.signatory_count = signatory_count;
      return client.post('/templates/validate', body);
    }
  );

  tool(
    'unset_template_paths',
    'Remove specific fields from a DRAFT template by dot-notation path (e.g. ["output.folder", "signatories"]) — for clearing individual properties without resending the record. Re-publish afterwards. NOTE: this route is POST at the gateway (unlike unset_document_paths which is PATCH).',
    {
      key: z.string().describe('Template key'),
      paths: z.array(z.string()).describe('Dot-notation field paths to remove'),
    },
    async ({ key, paths }) => client.post(`/templates/${encodeURIComponent(key)}/unset`, { key, paths })
  );

  tool(
    'delete_template',
    'Delete a template. Pass draft=true to delete the draft version; omit to delete the published version (deleting one does not affect the other). Poison-pill delete.',
    {
      key: z.string().describe('Template key'),
      draft: z.boolean().default(false).describe('Target the draft version'),
    },
    async ({ key, draft }) =>
      client.delete(`/templates/${encodeURIComponent(key)}`, draft ? { draft: true } : undefined)
  );

  tool(
    'trigger_templates',
    'Generate documents from PUBLISHED templates (ASYNC). Each listed template produces a real stored document, and one with signatories sends a HelloSign signature request to every signer whose email resolves. `payload` is the shared expression data context; `list` names template keys with optional per-entry output overrides. The 200 is a bare array of { template, subject } (queued — poll get_document) or { template, errors } (failed). A template needs a resolvable output.content_type to trigger.',
    {
      payload: jsonValue.describe('Free-form data object; every key becomes an expression identifier available in the templates.'),
      list: jsonValue.describe('Array of { template: "<key>", output?: { name?, content_type?, bucket?, folder? } }.'),
    },
    async ({ payload, list }) => {
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error('list must be a non-empty array of { template, output? } entries');
      }
      return client.post('/templates/trigger', { payload: payload ?? {}, list });
    }
  );

  // ---------------------------------------------------------------------------
  // Documents
  // ---------------------------------------------------------------------------

  tool(
    'list_documents',
    'List documents matching a subject-stream query. `query` is a wildcard pattern appended to the document namespace: "contracts.*" (direct children), "contracts.>" (any depth), ">" (all). Folders are dot-separated tokens (contracts/x.pdf -> contracts.x.pdf).',
    { query: z.string().default('>').describe('Stream subject query, e.g. "invoices.2026.*" or ">" for all') },
    async ({ query }) => client.get('/documents', { query })
  );

  tool(
    'get_document',
    'Get one document by key (typically the output filepath, e.g. "invoices.2026.invoice-INV-2026-014.pdf"). Poll this after trigger_templates: output null = still generating, output.key set = done, errors set = failed.',
    { key: z.string().describe('Document key') },
    async ({ key }) => client.get(`/documents/${encodeURIComponent(key)}`)
  );

  tool(
    'update_document',
    'Create or update a document record directly (PATCH upsert) — e.g. to register an externally produced file or correct metadata. Merges supplied fields. Note: this updates the record, not the stored file.',
    {
      key: z.string().describe('Document key — derives the storage subject'),
      name: z.string().optional(),
      created_at: z.string().optional().describe('ISO 8601 datetime'),
      output: jsonValue.optional().describe('{ key: "obj://bucket/path.pdf" }'),
      template: jsonValue.optional().describe('{ key: "<template key>" }'),
      signatures: jsonValue.optional().describe('Array of signatory records'),
      errors: jsonValue.optional().describe('Array of error strings'),
    },
    async ({ key, name, created_at, output, template, signatures, errors }) => {
      const body = { key };
      if (name !== undefined) body.name = name;
      if (created_at !== undefined) body.created_at = created_at;
      if (output !== undefined) body.output = output;
      if (template !== undefined) body.template = template;
      if (signatures !== undefined) body.signatures = signatures;
      if (errors !== undefined) body.errors = errors;
      return client.patch(`/documents/${encodeURIComponent(key)}`, body);
    }
  );

  tool(
    'unset_document_paths',
    'Remove specific fields from a document record by dot-notation path. A common use is clearing ["errors", "output"] before re-triggering generation for the same key.',
    {
      key: z.string().describe('Document key'),
      paths: z.array(z.string()).describe('Dot-notation field paths to remove'),
    },
    async ({ key, paths }) => client.patch(`/documents/${encodeURIComponent(key)}/unset`, { key, paths })
  );

  tool(
    'delete_document',
    'Delete a document RECORD (poison-pill). The generated file referenced by output.key remains in storage and must be removed separately if required.',
    { key: z.string().describe('Document key') },
    async ({ key }) => client.delete(`/documents/${encodeURIComponent(key)}`)
  );

  tool(
    'get_document_signature_url',
    'Generate an embedded HelloSign signing URL for a specific signature on a document. Only works for signatures created in embedded mode; URLs are short-lived — generate immediately before presenting the signing UI.',
    {
      key: z.string().describe('Document key'),
      signature_id: z.string().describe('HelloSign per-signatory signature id (from the document signatory record)'),
    },
    async ({ key, signature_id }) =>
      client.get(`/documents/${encodeURIComponent(key)}/signature-url`, { signature_id })
  );

  // ---------------------------------------------------------------------------
  // Account (confirmed gateway-mapped on production 2026-09-27; absent from the
  // published OpenAPI spec — see get_documents_reference("endpoints").
  // ---------------------------------------------------------------------------

  tool(
    'list_assigned_files',
    'List documents and workspace files assigned to the current user (their whole assigned set, no query params). Returns { body: { data: [{ id, type: "document"|"workspace-file", data }], results_total } }.',
    {},
    async () => client.get('/assigned-files')
  );

  tool(
    'extract_brand',
    'Read the fonts and colour scheme out of an Office document (.docx/.pptx/.xlsx, up to 16 MiB) already in an object store, to seed the account\'s document theme. Reads with the CALLER\'s own connection, so only buckets that user can already access will work. Never throws for a file with no theme part — it returns an empty brand. Returns { body: { data: { heading_font?, body_font?, accent_color?, heading_color?, muted_color?, unsupported_fonts: [{ found, using }] } } }.',
    {
      bucket: z.string().describe('Object store bucket holding the source document'),
      key: z.string().describe('Object key of the source document'),
    },
    async ({ bucket, key }) => client.post('/brand-extract', { bucket, key })
  );

  // Note: the file-generator service also has AI-generation handlers (pptx,
  // docx-generator, docx-editor, pdf-python, xlsx, html-pdf), but they are NOT in
  // the gateway route registry (quiva-endpoints.json) — they are not REST-callable
  // and 404 at the gateway. They are intentionally not exposed as tools; agents
  // invoke them through other means when needed. See get_documents_reference("gotchas").
}

// ---------------------------------------------------------------------------

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(
      `[quiva-documents-mcp] Node ${process.versions.node} is too old — requires Node >= 18 (global fetch). Launch via bin/run.sh or set QUIVA_NODE.`
    );
    process.exit(1);
  }
  const client = QuivaClient.fromEnv();
  if (!client.hasCredentials()) {
    console.error(
      '[quiva-documents-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD). API tools will fail until one is set.'
    );
  }
  const server = new McpServer({ name: 'quiva-documents', version: '0.1.0' }, { instructions });
  registerTools(server, client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[quiva-documents-mcp] ready — API: ${client.baseUrl}${'/file-generator'}`);
}

// Importing this module must have no side effects (no connecting, no env
// reads) — only run the stdio bootstrap when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[quiva-documents-mcp] fatal:', err);
    process.exit(1);
  });
}
