#!/usr/bin/env node
// Harvest real distribution READ responses into examples/harvested/ (read-only). Usage: node tools/harvest-examples.mjs
// Publisher: QUIVA_*; distributor (optional): QUIVA_DISTRIBUTOR_EMAIL/_PASSWORD/_ACCOUNT. Point QUIVA_API_URL at a test environment.
// Ids, emails, names, signing keys and product codes become stable placeholders everywhere, prose `detail` included.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuivaClient, refusalOf, unwrapEnvelope } from '../src/client.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'harvested');

// ---------------------------------------------------------------------------
// Redaction

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_NUMBER_RE = /\b\d{8,12}\b/g;

const literals = new Map(); // real value -> placeholder
const counters = {};

function placeholder(kind, value) {
  if (value === undefined || value === null || value === '') return value;
  const key = String(value);
  if (!literals.has(key)) {
    counters[kind] = (counters[kind] ?? 0) + 1;
    literals.set(key, `<<${kind}_${counters[kind]}>>`);
  }
  return literals.get(key);
}

// Structured fields whose values are identity. Their literals are also replaced in free text.
const FIELD_KINDS = {
  publisher_account_id: 'ACCOUNT',
  distributor_account_id: 'ACCOUNT',
  account_id: 'ACCOUNT',
  owner: 'ACCOUNT',
  owner_account_id: 'ACCOUNT',
  distributor_name: 'NAME',
  publisher_name: 'NAME',
  brokerage_name: 'NAME',
  space_id: 'SPACE',
  distributor_space_id: 'SPACE',
  publisher_space_id: 'SPACE',
  publisher_gateway_id: 'GATEWAY',
  distribution_id: 'DISTRIBUTION',
  invite_id: 'INVITE',
  product_id: 'PRODUCT',
  code: 'PRODUCT',
  product_name: 'PRODUCT_NAME',
  publisher_signing_public_key: 'SIGNING_KEY',
  distributor_signing_public_key: 'SIGNING_KEY',
};
const ALWAYS_REDACT = new Set(['granted_by', 'requested_by', 'redeemed_by_user_id', 'user_id', 'email', 'token', 'invite_url']);

// Platform config ids stay readable; an account's own config ids are its content.
const PLATFORM_CONFIGS = new Set(['quote_config', 'distribution_submission', 'distribution_decision', 'distribution_outcome',
  'distribution_quote_submission', 'distribution_mta_request', 'distribution_cancellation_request']);

function collect(value, key) {
  if (Array.isArray(value)) {
    if (key === 'record_config_ids') {
      value.forEach((v) => typeof v === 'string' && !PLATFORM_CONFIGS.has(v) && placeholder('CONFIG', v));
      return;
    }
    value.forEach((v) => collect(v, key === 'active_products' || key === 'withdraw_products' ? 'product_id' : undefined));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collect(v, k);
    return;
  }
  if (key && FIELD_KINDS[key] && typeof value === 'string') placeholder(FIELD_KINDS[key], value);
}

function scrubString(s) {
  // Longest literal first, so a name that contains an id is replaced whole.
  const ordered = [...literals.keys()].sort((a, b) => b.length - a.length);
  let out = s;
  for (const lit of ordered) {
    if (lit.length < 2) continue;
    const escaped = lit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'g'), literals.get(lit));
  }
  return out
    .replace(EMAIL_RE, '<<REDACTED:email>>')
    .replace(UUID_RE, '<<REDACTED:uuid>>')
    .replace(LONG_NUMBER_RE, (n) => placeholder('NUMBER', n));
}

function scrub(value, key) {
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = ALWAYS_REDACT.has(k) && v ? `<<REDACTED:${k}>>` : scrub(v, k);
    }
    return out;
  }
  return typeof value === 'string' ? scrubString(value) : value;
}

// ---------------------------------------------------------------------------
// Capture

async function capture(client, method, path, query) {
  const url = new URL(client.baseUrl + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: await client.authHeaders() });
  const text = await res.text();
  let body;
  try {
    body = unwrapEnvelope(JSON.parse(text));
  } catch {
    body = text;
  }
  return { request: { method, path, query: query ?? {} }, status: res.status, refused: Boolean(refusalOf(body)), body };
}

function pickOnePer(items, field, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item[field])) continue;
    seen.add(item[field]);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

// Keeps the platform's results_total, so it can exceed results.length.
function trimList(response, items) {
  return { ...response, body: { ...response.body, data: { ...response.body.data, results: items } } };
}

const BOGUS_ACCOUNT = '0000000000';

async function main() {
  const publisher = QuivaClient.fromEnv();
  if (!publisher.hasCredentials()) throw new Error('Set QUIVA_* credentials for the publisher account.');
  const distributor = process.env.QUIVA_DISTRIBUTOR_EMAIL
    ? new QuivaClient({
        apiUrl: process.env.QUIVA_API_URL,
        email: process.env.QUIVA_DISTRIBUTOR_EMAIL,
        password: process.env.QUIVA_DISTRIBUTOR_PASSWORD,
        account: process.env.QUIVA_DISTRIBUTOR_ACCOUNT,
      })
    : null;

  const files = {};

  const register = await capture(publisher, 'GET', '/accounts/distributions');
  files['publisher-register'] = {
    teaches: 'list_distributions as the publisher: one grant per counterparty, one example per status. The list is trimmed, so results_total is the platform count.',
    response: trimList(register, pickOnePer(register.body?.data?.results ?? [], 'status', 3)),
  };

  const invites = await capture(publisher, 'GET', '/accounts/distribution-invites');
  files['publisher-invites'] = {
    teaches: 'list_distribution_invites: one invitation per state, newest first. Items carry no token. The list is trimmed, so results_total is the platform count.',
    response: trimList(invites, pickOnePer(invites.body?.data?.results ?? [], 'state', 4)),
  };

  files['product-definition-versions'] = {
    teaches: 'list_product_definition_versions: the catalogue versions of one published record-config schema.',
    response: await capture(publisher, 'GET', '/accounts/product-definitions', { config_id: 'quote_config' }),
  };

  files['refusals'] = {
    teaches: 'The three failure shapes: a named refusal (404 product_not_found), a plain 400 { error }, and a validation 400.',
    responses: [
      await capture(publisher, 'GET', '/accounts/distribution-product', { code: 'mcp-example-missing' }),
      await capture(publisher, 'GET', '/accounts/distribution', { distributor_account_id: BOGUS_ACCOUNT }),
      await capture(publisher, 'GET', '/accounts/distribution-invites', { state: 'unknown' }),
    ],
  };

  if (distributor) {
    const mine = await capture(distributor, 'GET', '/accounts/distributions', { side: 'distributor' });
    files['distributor-register'] = { teaches: 'list_distributions with side=distributor: the grants this account holds.', response: mine };
    const grant = mine.body?.data?.results?.[0];
    if (grant) {
      const notGranted = 'mcp-example-not-granted';
      files['distributor-get-distribution'] = {
        teaches: 'get_distribution with a product_id the grant does not carry: 200, empty refusal_code (the grant is live), product_refusal_code "product_not_granted".',
        response: await capture(distributor, 'GET', '/accounts/distribution', { publisher_account_id: grant.publisher_account_id, product_id: notGranted }),
      };
      files['distributor-status'] = {
        teaches: 'get_distribution_status from the distributor side: 200 with complete: false and one failed check named in missing[].',
        response: await capture(distributor, 'GET', '/accounts/distribution-status', { account_id: grant.publisher_account_id, side: 'distributor' }),
      };
      files['distributor-granted-products'] = {
        teaches: 'list_granted_products: a granted product with no published definition is dropped from products[] and named only in notices[].',
        response: await capture(distributor, 'GET', '/accounts/distribution-granted-products', { publisher_account_id: grant.publisher_account_id }),
      };
      files['refusals'].responses.push(
        await capture(distributor, 'GET', '/accounts/distribution-granted-products', { publisher_account_id: BOGUS_ACCOUNT })
      );
    }
  }

  collect(files);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const [slug, content] of Object.entries(files)) {
    const out = scrub({ slug, kind: 'harvested', source: { harvested_at: new Date().toISOString().slice(0, 10) }, ...content });
    writeFileSync(join(OUT_DIR, `${slug}.json`), JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${slug}.json`);
  }
  console.log(`${literals.size} distinct values replaced with placeholders.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
