#!/usr/bin/env node
// Harvest real document TEMPLATES (and the shape of generated DOCUMENTS) from
// the platform into examples/harvested/.
//
// Why: reference examples an agent learns from must be configs that demonstrably
// work. Hand-written examples are exactly the pattern that shipped a wrong
// condition syntax in the flows MCP (see docs/lessons.md) — and this MCP has the
// same latent defect in its `sub_templates[].conditions` docs. These harvested
// files also serve as the golden fixtures for `npm test`: the local validator
// must accept every template that is already live.
//
// PII: templates are configs and safe. Generated DOCUMENTS carry real signatory
// names and email addresses, so every document example is scrubbed — emails are
// replaced, signatory names are replaced, and any occurrence of a scrubbed name
// elsewhere in the record (storage paths embed them) is replaced too. Documents
// are harvested for their SHAPE only.
//
// Usage: node tools/harvest-examples.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuivaClient } from '../src/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'examples', 'harvested');

const REDACTED_EMAIL = '<<REDACTED:email>>';
const REDACTED_NAME = '<<REDACTED:name>>';
const REDACTED_ID = '<<REDACTED:id>>';
const REDACTED_SECRET = '<<REDACTED>>';

const SECRET_KEYS = /^(api_key|apikey|token|auth_token|password|secret|authorization)$/i;
const SECRET_VALUES = [/^ms[rk]?-[A-Z0-9]{20,}$/i, /^eyJ[A-Za-z0-9_-]{20,}\./];
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

// A template expression ({client_email}) is the thing these examples exist to
// teach — never scrub one, even though it sits in an email field.
function isExpression(value) {
  return typeof value === 'string' && value.includes('{') && value.includes('}');
}

function redactTemplate(value, key = '') {
  if (typeof value === 'string') {
    if (isExpression(value)) return value;
    if (SECRET_KEYS.test(key) && value.length > 12) return REDACTED_SECRET;
    return SECRET_VALUES.some((re) => re.test(value)) ? REDACTED_SECRET : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactTemplate(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactTemplate(v, k);
    return out;
  }
  return value;
}

// Documents: scrub emails everywhere, signatory names, then any residual
// occurrence of a scrubbed name (output.key embeds "spaces.FAHUB.First Last.").
function redactDocument(doc) {
  const names = new Set();
  let count = 0;

  const walk = (value, key = '', inSignature = false) => {
    if (typeof value === 'string') {
      if (isExpression(value)) return value;
      if (EMAIL_RE.test(value)) {
        count++;
        return value.replace(EMAIL_RE, REDACTED_EMAIL);
      }
      if (inSignature && key === 'name' && value !== '') {
        names.add(value);
        count++;
        return REDACTED_NAME;
      }
      // HelloSign request/signature ids identify a real signature request at a
      // third party. The shape is what teaches, so keep the keys, drop the ids.
      if (inSignature && (key === 'id' || key === 'signature_id')) {
        count++;
        return REDACTED_ID;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, key, inSignature));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = walk(v, k, inSignature || k === 'signatures');
      }
      return out;
    }
    return value;
  };

  const scrubbed = walk(doc);

  // Second pass: names also appear inside storage paths and subjects, and not
  // only the signatory's own — a document written into a workspace lands under
  // `spaces.<SPACE>.<Owner Name>.<file>`, so match that shape too. Subjects
  // sanitise a space to "_", hence the [ _] class.
  const PERSON_IN_PATH = /\b[A-Z][a-z]+[ _][A-Z][a-z]+\b/g;
  const sweep = (value) => {
    if (typeof value === 'string') {
      let out = value;
      for (const name of names) {
        if (out.includes(name)) {
          out = out.split(name).join(REDACTED_NAME);
          count++;
        }
      }
      if (PERSON_IN_PATH.test(out)) {
        out = out.replace(PERSON_IN_PATH, REDACTED_NAME);
        count++;
      }
      return out;
    }
    if (Array.isArray(value)) return value.map(sweep);
    if (value && typeof value === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(value)) o[k] = sweep(v);
      return o;
    }
    return value;
  };

  return { doc: sweep(scrubbed), redactions: count };
}

function countRedactions(value, n = { count: 0 }) {
  if (typeof value === 'string') {
    if (value.startsWith('<<REDACTED')) n.count++;
  } else if (Array.isArray(value)) {
    value.forEach((v) => countRedactions(v, n));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => countRedactions(v, n));
  }
  return n.count;
}

// Derive what a template demonstrates from the template itself, so `teaches` is
// evidence rather than assertion.
function describeTemplate(t) {
  const traits = [];
  if (t.source?.content_type?.includes('wordprocessingml')) {
    traits.push('DOCX source rendered to a different output content_type');
  }
  if (t.output?.name) traits.push('output.name as an expression template (no extension)');
  if (t.output?.bucket || t.output?.folder) traits.push('output bucket/folder placement');
  const sigs = t.signatories ?? [];
  if (sigs.length === 1) traits.push('one e-signature signatory with expression name/email');
  if (sigs.length > 1) {
    traits.push(`${sigs.length} signatories with an explicit signing \`order\` (sequential signing)`);
  }
  if (sigs.some((s) => s.validity)) {
    traits.push(`signatory validity window (${sigs.map((s) => JSON.stringify(s.validity)).join(', ')})`);
  }
  if (Array.isArray(t.sub_templates) && t.sub_templates.length > 0) {
    traits.push('sub_templates merged after the main template');
    if (t.sub_templates.some((s) => s.conditions)) {
      traits.push('sub_template `conditions` AS ACTUALLY USED IN PRODUCTION — compare against the docs');
    }
  } else {
    traits.push('sub_templates: [] — no live template on this environment uses conditions');
  }
  return traits;
}

function describeDocument(d) {
  const traits = ['the generated-document record shape (what get_document returns)'];
  const statuses = [...new Set((d.signatures ?? []).map((s) => s.status))];
  if (statuses.length) traits.push(`signature status(es) present: ${statuses.join(', ')}`);
  if ((d.signatures ?? []).some((s) => 'request' in s)) {
    traits.push('a SENT/EXPIRED signature carries extra fields (request, error, signed_at) that a DRAFT one does not');
  }
  if (d.output?.key) traits.push('output.key is a storage URI (obj://bucket/dot.separated.path)');
  if (d.errors === null) traits.push('errors: null on a successful generation');
  return traits;
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.error(`harvesting from ${client.baseUrl}/file-generator`);

  // --- templates (published) ---
  const listed = await client.get('/templates');
  const templates = listed?.body?.results ?? [];
  if (templates.length === 0) console.error('  warning: no published templates on this environment');

  let conditionUsers = 0;
  for (const summary of templates) {
    const fetched = await client.get(`/templates/${encodeURIComponent(summary.key)}`);
    const template = fetched?.body ?? summary;
    const clean = redactTemplate(template);
    if (Array.isArray(template.sub_templates) && template.sub_templates.some((s) => s.conditions)) {
      conditionUsers++;
    }

    const slug = `template-${slugify(template.key)}`;
    write(slug, {
      slug,
      kind: 'template',
      source: {
        environment: client.baseUrl,
        subject: template.subject,
        key: template.key,
        harvested_from: 'published version',
      },
      teaches: describeTemplate(template),
      redactions: countRedactions(clean),
      label: template.label ?? '',
      config: clean,
    });
  }

  // --- documents (shape only, PII scrubbed) ---
  // One example per distinct signature-status shape is enough; the records are
  // otherwise repetitive and every one costs a scrub.
  const docsResponse = await client.get('/documents', { query: '>' });
  const documents = docsResponse?.body?.results ?? [];
  const seenShapes = new Set();
  let written = 0;
  for (const doc of documents) {
    const shape = [...new Set((doc.signatures ?? []).map((s) => s.status))].sort().join('+') || 'no-signatures';
    if (seenShapes.has(shape)) continue;
    seenShapes.add(shape);

    const { doc: clean, redactions } = redactDocument(doc);
    const slug = `document-${shape.toLowerCase().replace(/\+/g, '-')}`;
    write(slug, {
      slug,
      kind: 'document',
      source: {
        environment: client.baseUrl,
        // The SCRUBBED subject — the raw one embeds the owner's name.
        subject: clean.subject,
        key: clean.name,
        harvested_from: 'generated document (PII scrubbed — shape only)',
      },
      teaches: describeDocument(doc),
      redactions,
      config: clean,
    });
    written++;
  }

  console.error(
    `\n  ${templates.length} template(s), ${written} document shape(s) -> examples/harvested/`
  );
  console.error(
    `  templates using sub_templates[].conditions: ${conditionUsers}` +
      (conditionUsers === 0
        ? ' — the documented {all:[...]} form is UNPROVEN on this environment (see docs/quiva-mcp-handoff.md §4)'
        : ' — INSPECT THESE: if they use {all:[...]} their sub-templates are being silently dropped')
  );
}

function slugify(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function write(slug, doc) {
  const path = join(OUT_DIR, `${slug}.json`);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  console.error(`  ${slug}: ${doc.redactions} value(s) redacted -> examples/harvested/${slug}.json`);
}

main().catch((err) => {
  console.error('harvest failed:', err.message);
  process.exit(1);
});
