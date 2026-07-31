#!/usr/bin/env node
// Harvest real published workflows from the platform into examples/.
//
// The reference examples an agent learns from must be configs that DEMONSTRABLY
// RUN, not hand-written ones — a hand-written condition payload is exactly how
// the { if, then, else } mistake got shipped. These files also serve as the
// golden fixtures for `npm test`: the local validator must accept every config
// that is already live.
//
// Usage:  node tools/harvest-examples.mjs            (uses .env / process env)
//         node tools/harvest-examples.mjs --check    (verify redaction only)
//
// Secrets are stripped: anything that looks like a credential is replaced with
// a REDACTED marker. Never commit an example without running this.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuivaClient, subjectToTopics } from '../src/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(HERE, '..', 'examples');

// Published workflows worth learning from, with why each one is here.
const TARGETS = [
  {
    slug: 'client-folder-creation',
    subject: 'ms.hub.config.workflow.2163944795.4227511847',
    teaches: [
      'condition node: the payload IS the { condition, outcome } branch array',
      'gateway trigger node',
      'integration nodes with base_url + security_schemes',
      'pipe concatenation ("$.trigger.firstName| |$.trigger.lastName", "Bearer |$.env.auth_token")',
      'flow-level config.result',
      'flow-editor geometry (node position/type/measured, edge type/edgeType/handles)',
    ],
  },
  {
    slug: 'builders-risk-product-selection',
    subject: 'ms.hub.config.workflow.1508781670.1968763177',
    teaches: [
      'rules payload { facts, rules, context } run through a compute function node',
      'derived facts chaining via "@fact:<earlier rule key>"',
      'deeply nested expressions (and/or/=/</in/split/jPath/numberFormat/generate-array)',
      'a conditional chain with a catch-all final branch',
      'SECRET::NAME:: placeholders',
      'map node with JSONPath filters and pipe concatenation',
    ],
  },
];

// Keys whose values are credentials, and value patterns that look like one.
const SECRET_KEYS = /^(api_key|apikey|key|token|auth_token|password|secret|authorization)$/i;
const SECRET_VALUES = [
  /^ms[rk]?-[A-Z0-9]{20,}$/i, // platform api keys
  /^eyJ[A-Za-z0-9_-]{20,}\./, // JWTs
  /^Bearer\s+(?!\|)\S{20,}/i, // literal bearer tokens (not "Bearer |$.env...")
];

const REDACTED = '<<REDACTED — provide your own credential>>';

function redact(value, key = '') {
  if (typeof value === 'string') {
    // A value that resolves at run time (JSONPath / pipe-concat / a secret
    // placeholder) is not a credential — and those are exactly the forms the
    // examples exist to teach, so never scrub them.
    const isResolvedAtRuntime = value.includes('$.') || value.includes('SECRET::');
    if (!isResolvedAtRuntime && SECRET_KEYS.test(key) && value.length > 12) {
      return REDACTED;
    }
    if (isResolvedAtRuntime) return value;
    return SECRET_VALUES.some((re) => re.test(value)) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

function countRedactions(value, n = { count: 0 }) {
  if (typeof value === 'string') {
    if (value === REDACTED) n.count++;
  } else if (Array.isArray(value)) {
    value.forEach((v) => countRedactions(v, n));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => countRedactions(v, n));
  }
  return n.count;
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  mkdirSync(EXAMPLES_DIR, { recursive: true });
  console.error(`harvesting from ${client.baseUrl}`);

  for (const target of TARGETS) {
    const { collectionTopic, flowTopic } = subjectToTopics(target.subject);
    const flow = await client.get(`/hub/workflows/${collectionTopic}/${flowTopic}`, { draft: 'false' });

    const clean = redact(flow.config);
    const redactions = countRedactions(clean);

    const doc = {
      slug: target.slug,
      source: {
        environment: client.baseUrl,
        subject: target.subject,
        name: flow.name,
        harvested_from: 'published version',
      },
      teaches: target.teaches,
      redactions,
      description: flow.description ?? '',
      config: clean,
    };

    const path = join(EXAMPLES_DIR, `${target.slug}.json`);
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    const nodeCount = Array.isArray(clean?.nodes) ? clean.nodes.length : 0;
    console.error(`  ${target.slug}: ${nodeCount} nodes, ${redactions} value(s) redacted -> examples/${target.slug}.json`);
  }
}

main().catch((err) => {
  console.error('harvest failed:', err.message);
  process.exit(1);
});
