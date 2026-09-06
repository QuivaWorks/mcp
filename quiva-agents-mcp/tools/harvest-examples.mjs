#!/usr/bin/env node
// Harvest real agent configs from the platform into examples/harvested/.
//
// Why: reference examples an agent learns from must be configs that demonstrably
// work. Hand-written examples are exactly the pattern that shipped a wrong
// condition syntax in the flows MCP (see docs/lessons.md). These harvested files
// also serve as the golden fixtures for `npm test`: the local validator must
// accept every config that is already live.
//
// The environment holds ~189 agents, far too many to bundle, so this picks a
// SPREAD rather than a prefix: one config per interesting trait (tools,
// knowledge, output_schema, llm_config, each llm_provider actually in use, each
// unusual agent_type). Selection is by trait, not by name, so re-running after
// the corpus changes keeps the coverage rather than the same files.
//
// For validator coverage over ALL of them use tools/sweep-validate.mjs — a
// handful of golden fixtures cannot tell you whether a rule is wrong, and that is
// exactly how the flows MCP shipped a validator that rejected reality.
//
// Secrets: api_key / auth are stripped. `behaviour` (the system prompt) is kept —
// it is the teaching content and holds no credentials.
//
// Usage: node tools/harvest-examples.mjs

import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QuivaClient } from '../src/client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'examples', 'harvested');

const REDACTED = '<<REDACTED — provide your own credential>>';
const SECRET_KEYS = /^(api_key|apikey|key|token|auth_token|password|secret|authorization|auth)$/i;
const SECRET_VALUES = [/^ms[rk]?-[A-Z0-9]{20,}$/i, /^eyJ[A-Za-z0-9_-]{20,}\./, /^sk-[A-Za-z0-9_-]{20,}$/];

// `api_key` CAN carry a literal LLM key — on invoke, hub-service forwards it as
// the X-LLM-API-Key header whenever api_key_source is not "system"
// (hub-service/agents/agents.go:175). But every value stored on staging is a NAME
// referencing an account secret (CLAUDE_API_KEY, GEMINI_API_KEY, OPEN_AI, ...),
// and that name is precisely what an example needs to teach. So keep name-shaped
// values and redact anything else — scrubbing them all would delete the lesson.
const SECRET_NAME_SHAPE = /^[A-Z][A-Z0-9_]{1,31}$/;

// PII hides in FREE TEXT, not only in identity fields. A `behaviour` prompt is a
// system prompt somebody wrote, and real ones route to real inboxes and real Slack
// channels: one harvested agent carried three colleague addresses and a personal
// channel name this way. Whole-value redaction would delete the lesson (that a
// prompt can instruct email/Slack delivery), so substitute in place instead.
// .invalid is reserved by RFC 2606 and can never resolve.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const INTERNAL_EMAIL = /@(evari\.tech|quiva\.ai|microstrate\.io)$/i;
// Only a #handle that the text itself calls a Slack channel. A blanket /#\w+/
// would mangle ordinary prose ("see #overview", "policy #123") and quietly
// corrupt the evidence these examples exist to be.
const SLACK_CHANNEL = /\bslack channel\s+(#[a-z0-9][a-z0-9_-]{2,})/gi;

let redactions = 0;

function scrubFreeText(text) {
  let out = text.replace(EMAIL, (address) => {
    if (!INTERNAL_EMAIL.test(address) || address.endsWith('example.invalid')) return address;
    redactions++;
    return 'someone@example.invalid';
  });
  out = out.replace(SLACK_CHANNEL, (whole, handle) => {
    redactions++;
    return whole.replace(handle, '#a-slack-channel');
  });
  return out;
}

function redact(value, key = '') {
  if (typeof value === 'string') {
    if (SECRET_KEYS.test(key) && !SECRET_NAME_SHAPE.test(value) && value.length > 8) {
      redactions++;
      return REDACTED;
    }
    if (SECRET_VALUES.some((re) => re.test(value))) {
      redactions++;
      return REDACTED;
    }
    return scrubFreeText(value);
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (value && typeof value === 'object') {
    // An `auth` object holds per-user credentials wholesale.
    if (SECRET_KEYS.test(key)) {
      redactions++;
      return REDACTED;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

// Traits worth having one example of each. Order matters: the first unclaimed
// trait a config satisfies is the slot it fills.
const TRAITS = [
  {
    slug: 'agent-with-tools-and-knowledge',
    test: (c) => c.tools?.length > 0 && c.knowledge?.length > 0,
    teaches: [
      'tools[] as mcp:// URIs alongside has_tools',
      'knowledge[] as obj:// URIs pointing at uploaded documents in the agent-knowledge bucket',
      'a real production agent combining both',
    ],
  },
  {
    slug: 'agent-with-output-schema',
    test: (c) => c.output_schema && Object.keys(c.output_schema).length > 0,
    teaches: [
      'output_schema is a { field: description } MAP, NOT JSON Schema',
      'the invoke result is still a JSON-encoded STRING — parse it before branching on fields',
    ],
  },
  {
    slug: 'agent-with-llm-config',
    test: (c) => c.llm_config && Object.keys(c.llm_config).length > 0,
    teaches: ['llm_config { temperature, max_tokens, max_turns } as actually stored'],
  },
  {
    slug: 'agent-with-context-management',
    test: (c) => c.ai_summary_threshold !== undefined && c.preserve_most_recent !== undefined,
    teaches: [
      'the context-window knobs: context_limit, message_history_limit, ai_summary_threshold, ai_summary_model, preserve_most_recent, ai_smart_context',
    ],
  },
  {
    slug: 'agent-provider-gemini',
    test: (c) => c.llm_provider === 'gemini',
    teaches: [
      'PROOF that a non-Claude llm_provider is STORED without complaint',
      'invoke_agent still rejects it with 400 "unsupported provider" — storing and invoking have different rules, and the MCP validator currently conflates them',
    ],
  },
  {
    slug: 'agent-provider-openai',
    test: (c) => c.llm_provider === 'openai',
    teaches: ['a second non-Claude provider stored live (openai + gpt-4)'],
  },
  {
    slug: 'agent-provider-anthropic',
    test: (c) => c.llm_provider === 'anthropic',
    teaches: ['llm_provider "anthropic" — accepted by invoke even though the spec enum lists only "claude"'],
  },
  {
    slug: 'agent-minimal-claude',
    test: (c) => c.llm_provider === 'claude' && c.behaviour && !c.tools?.length,
    teaches: ['the smallest shape that actually runs: name + llm_provider + model + behaviour'],
  },
  {
    slug: 'agent-unusual-agent-type',
    test: (c) => c.agent_type !== undefined && c.agent_type !== '' && c.agent_type !== 'deep-research',
    teaches: [
      'agent_type is NOT the closed enum the docs describe — this live value is outside { "", "deep-research" }',
    ],
  },
  {
    slug: 'agent-unknown-knowledge-scheme',
    test: (c) => (c.knowledge ?? []).some((k) => typeof k === 'string' && !/^(kv|obj|str|sid|dta):\/\//.test(k)),
    teaches: [
      'a knowledge URI scheme the MCP does not list — evidence the documented scheme set is incomplete',
    ],
  },
];

function describeConfig(config) {
  const facts = [];
  facts.push(`llm_provider "${config.llm_provider ?? ''}" / model "${config.model ?? ''}"`);
  if (config.shared !== undefined) facts.push(`shared: ${JSON.stringify(config.shared)}`);
  if (config.tools?.length) facts.push(`${config.tools.length} tool URI(s)`);
  if (config.knowledge?.length) facts.push(`${config.knowledge.length} knowledge URI(s)`);
  if (config.output_schema) facts.push('output_schema present');
  if (config.llm_config) facts.push(`llm_config: ${JSON.stringify(config.llm_config)}`);
  return facts;
}

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  // Trait selection is order-dependent, so stale files from a previous run would
  // silently mix two selections.
  for (const file of readdirSync(OUT_DIR).filter((f) => f.endsWith('.json'))) {
    unlinkSync(join(OUT_DIR, file));
  }

  const listed = await client.get('/hub/agent');
  const agents = listed?.results ?? listed?.body?.results ?? [];
  console.error(`harvesting from ${client.baseUrl}/hub/agent — ${agents.length} live agent(s)\n`);

  const claimed = new Set();
  let written = 0;

  for (const trait of TRAITS) {
    const match = agents.find((a) => {
      const config = a.config ?? {};
      return !claimed.has(a.subject) && trait.test(config);
    });
    if (!match) {
      console.error(`  ${trait.slug}: NO live config has this trait — skipped`);
      continue;
    }
    claimed.add(match.subject);
    const clean = redact(match.config ?? {});

    writeFileSync(
      join(OUT_DIR, `${trait.slug}.json`),
      `${JSON.stringify(
        {
          slug: trait.slug,
          source: {
            environment: client.baseUrl,
            subject: match.subject,
            // The {id} path param for GET/PUT/DELETE /hub/agent/{id} is the uuid
            // suffix of the subject, not the subject and not config.id.
            path_id: String(match.subject ?? '').split('.').pop(),
            name: match.config?.name,
            harvested_from: 'GET /hub/agent',
          },
          teaches: trait.teaches,
          facts: describeConfig(match.config ?? {}),
          config: clean,
        },
        null,
        2
      )}\n`
    );
    console.error(`  ${trait.slug}: ${match.config?.name ?? '(unnamed)'}`);
    written++;
  }

  console.error(`\n  ${written} example(s), ${redactions} value(s) redacted -> examples/harvested/`);
  console.error(
    '\n  These are a trait SPREAD, not a sample of the corpus. Run tools/sweep-validate.mjs\n' +
      '  to check the validator against all ' +
      agents.length +
      ' configs — a handful of fixtures cannot\n' +
      '  tell you a rule is wrong, and that is exactly how the flows MCP shipped one.'
  );
}

main().catch((err) => {
  console.error('harvest failed:', err.message);
  process.exit(1);
});
