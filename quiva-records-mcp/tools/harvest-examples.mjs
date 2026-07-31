#!/usr/bin/env node
// Harvest real record CONFIGS from the platform into examples/harvested/.
//
// Why: reference examples an agent learns from must be configs that demonstrably
// work. The six files in examples/authored/ are hand-written fixtures — that is
// precisely the pattern that shipped a wrong condition syntax in the flows MCP
// (see docs/lessons.md). These harvested files also serve as the golden fixtures
// for `npm test`: the local validator must accept every config already live.
//
// CONFIGS ONLY — never record rows. Production records hold client PII.
//
// Usage: node tools/harvest-examples.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuivaClient } from '../src/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'examples', 'harvested');

const SECRET_KEYS = /^(api_key|apikey|key|token|auth_token|password|secret|authorization)$/i;
const SECRET_VALUES = [/^ms[rk]?-[A-Z0-9]{20,}$/i, /^eyJ[A-Za-z0-9_-]{20,}\./];
const REDACTED = '<<REDACTED>>';

function redact(value, key = '') {
  if (typeof value === 'string') {
    if (value.includes('$.') || value.includes('SECRET::')) return value;
    if (SECRET_KEYS.test(key) && value.length > 12) return REDACTED;
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

// Walk a form layout and report what it actually demonstrates, so the "teaches"
// list is derived from the config rather than asserted by hand.
function describeForms(config) {
  const traits = new Set();
  const inputTypes = new Set();
  const ruleProps = new Set();
  let nodes = 0;

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    nodes++;
    if (node.type === 'grid') traits.add('grid containers');
    if (node.type === 'array-field') traits.add('array-field repeater (arrays of objects)');
    if (node.type === 'field' && node.field) traits.add('field nodes bound by dotted path');
    if (node.inputType) inputTypes.add(node.inputType);
    if (Array.isArray(node.rules)) {
      for (const rule of node.rules) if (rule?.property) ruleProps.add(rule.property);
    }
    for (const child of node.children ?? []) walk(child);
  };

  for (const form of config?.views?.forms ?? []) walk(form.layout);

  const teaches = [...traits];
  if (inputTypes.size) teaches.push(`node-level inputType: ${[...inputTypes].sort().join(', ')}`);
  if (ruleProps.size) teaches.push(`json-logic form rules on properties: ${[...ruleProps].sort().join(', ')}`);
  if (config?.views?.tables?.length) teaches.push('views.tables');
  return { teaches, formNodeCount: nodes };
}

function describeSchema(config) {
  const traits = new Set();
  const types = new Set();
  const walk = (schema) => {
    if (!schema || typeof schema !== 'object') return;
    if (schema.type) types.add(Array.isArray(schema.type) ? schema.type.join('|') : schema.type);
    if (schema.enum) traits.add('enums');
    if (schema.format) traits.add(`format: ${schema.format}`);
    if (Array.isArray(schema.required) && schema.required.length) traits.add('required fields');
    for (const child of Object.values(schema.properties ?? {})) walk(child);
    if (schema.items) walk(schema.items);
  };
  walk(config?.schema);
  return [...traits, `schema types: ${[...types].sort().join(', ')}`];
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials configured.');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  console.error(`harvesting record configs from ${client.baseUrl}`);

  const response = await client.get('/records/config');
  const configs = response?.results ?? [];
  let withForms = 0;

  for (const raw of configs) {
    const config = redact(raw);
    const { teaches: formTeaches, formNodeCount } = describeForms(config);
    const hasForms = (config?.views?.forms ?? []).length > 0;
    if (hasForms) withForms++;

    const doc = {
      slug: config.id,
      source: {
        environment: client.baseUrl,
        config_id: config.id,
        harvested: 'live record config (configs only — no record data)',
      },
      featured: hasForms, // configs with a real form UI are the ones to learn from
      teaches: [...describeSchema(config), ...formTeaches],
      form_node_count: formNodeCount,
      config,
    };

    writeFileSync(join(OUT_DIR, `${config.id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }

  console.error(`  ${configs.length} configs written to examples/harvested/ (${withForms} with a form UI)`);
}

main().catch((err) => {
  console.error('harvest failed:', err.message);
  process.exit(1);
});
