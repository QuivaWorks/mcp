#!/usr/bin/env node
// Validate EVERY agent config on the environment with the local validator.
//
// This is the check that the flows MCP lacked: a two-config golden gate passes a
// validator that is confidently wrong. Only running the validator over the whole
// corpus of configs that already exist tells you whether its rules match reality
// (docs/lessons.md). Every error reported here is a config the platform accepted
// and the validator rejects — i.e. a validator bug, unless it is a config that is
// genuinely broken and known to be.
//
// Usage: node tools/sweep-validate.mjs [--verbose]

import { QuivaClient } from '../src/client.js';
import { validate } from '../src/validate.js';

const VERBOSE = process.argv.includes('--verbose');

// Collapse a message to a signature so counts group by RULE, not by value.
function signature(message) {
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .trim();
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }

  const listed = await client.get('/hub/agent');
  const agents = listed?.results ?? listed?.body?.results ?? [];
  console.error(`swept ${agents.length} live agent config(s) on ${client.baseUrl}\n`);

  const errors = new Map();
  const warnings = new Map();
  let clean = 0;
  let withErrors = 0;

  for (const agent of agents) {
    const config = agent.config ?? agent;
    // Live configs are validated in create mode on purpose: that is the mode an
    // agent authoring a new config runs, so it is the mode whose false positives
    // matter.
    const result = validate(config, { requireRequired: true });
    if (result.errors.length === 0 && result.warnings.length === 0) clean++;
    if (result.errors.length > 0) withErrors++;

    for (const message of result.errors) {
      const key = signature(message);
      if (!errors.has(key)) errors.set(key, { count: 0, examples: [] });
      const entry = errors.get(key);
      entry.count++;
      if (entry.examples.length < 3) entry.examples.push(`${config.name || '(unnamed)'} <${agent.subject}>`);
    }
    for (const message of result.warnings) {
      const key = signature(message);
      if (!warnings.has(key)) warnings.set(key, { count: 0, examples: [] });
      const entry = warnings.get(key);
      entry.count++;
      if (entry.examples.length < 3) entry.examples.push(`${config.name || '(unnamed)'} <${agent.subject}>`);
    }
  }

  const report = (label, map) => {
    console.error(`--- ${label} (${map.size} distinct rule(s)) ---`);
    const sorted = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [key, { count, examples }] of sorted) {
      console.error(`  ${String(count).padStart(4)}x  ${key}`);
      if (VERBOSE) for (const example of examples) console.error(`          e.g. ${example}`);
    }
    if (map.size === 0) console.error('  (none)');
    console.error('');
  };

  report('ERRORS against live configs — each one is a validator bug until proven otherwise', errors);
  report('WARNINGS against live configs', warnings);

  console.error(
    `${clean}/${agents.length} configs are completely clean; ${withErrors}/${agents.length} produce at least one ERROR.`
  );
  if (withErrors > 0) {
    console.error(
      '\nAn ERROR means the local validator would BLOCK a config the platform is\n' +
        'already storing and serving. Decide per rule: tighten the rule to match the\n' +
        'engine, or downgrade it to a warning. Do not "fix" the corpus.'
    );
  }
  // Exit non-zero so this can gate CI once the errors are triaged to zero.
  process.exit(withErrors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('sweep failed:', err.message);
  process.exit(2);
});
