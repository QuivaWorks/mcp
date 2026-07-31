#!/usr/bin/env node
// Push the authored agent example onto the platform, then READ IT BACK and check
// it, so the artefact can be inspected in the UI.
//
// A write response is not proof: quiva-flows-mcp's delete_workflow returned
// {"message":"success"} while orphaning every draft (docs/quiva-mcp-handoff.md).
// Everything here is verified by re-reading.
//
// Usage:
//   node tools/push-example.mjs             create + verify, LEAVE it on staging
//   node tools/push-example.mjs --invoke    also invoke it once (SPENDS LLM TOKENS)
//   node tools/push-example.mjs --cleanup   delete afterwards + verify it is gone

import { QuivaClient } from '../src/client.js';
import { getExample } from '../src/examples.js';
import { validate } from '../src/validate.js';

const INVOKE = process.argv.includes('--invoke');
const CLEANUP = process.argv.includes('--cleanup');
// /en/hub/agents has a +page.ts but NO +page.svelte in the repo, so do not send
// anyone there. The route that definitely renders is agents/edit/[subject], where
// the subject is URL-encoded by replacing every "." with "+" (encodeUrlString in
// microstrate/src/utils/transform.utils.ts — dotString = '+'). Agents are
// labelled "Assistants" in the UI.
const agentEditUrl = (subject) =>
  `https://app.microstrate.io/en/hub/agents/edit/${String(subject).split('.').join('+')}`;

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`ok   - ${name}`);
  } else {
    failures++;
    console.error(`FAIL - ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

// The {id} path param for get/update/delete is the uuid SUFFIX of the subject —
// not the subject, and not config.id (the frontend does subject.split('.').pop()).
const pathId = (subject) => String(subject ?? '').split('.').pop();

async function main() {
  const client = new QuivaClient();
  if (!client.hasCredentials()) {
    console.error('No credentials — set QUIVA_API_KEY / QUIVA_BEARER_TOKEN / QUIVA_EMAIL+QUIVA_PASSWORD.');
    process.exit(1);
  }
  const example = getExample('submission-triage-agent');
  console.log(`pushing "${example.slug}" to ${client.baseUrl}\n`);

  const validation = validate(example.config, { requireRequired: true });
  check('local validate', validation.valid, validation.errors.join('; '));
  if (!validation.valid) process.exit(1);

  // --- create (the subject is an md5 of the config, so a re-run 409s) ---
  let subject;
  try {
    const created = await client.post('/hub/agent', { config: example.config });
    subject = created?.subject ?? created?.body?.subject;
    console.log(`ok   - created agent ${subject}`);
  } catch (err) {
    const existing = /agent exists:(\S+)/.exec(err.body?.error ?? err.message ?? '');
    if (err.status === 409 && existing) {
      subject = existing[1];
      console.log(`ok   - agent already exists (409, subject is an md5 of the config), reusing ${subject}`);
    } else {
      throw err;
    }
  }
  check('subject is server-generated in the documented shape', /^ms\.hub\.config\.agent\.[0-9a-f-]{36}$/.test(subject ?? ''), `got ${subject}`);

  // --- 409 on an identical config (documented, previously untested) ---
  let got409 = false;
  let conflictSubject = null;
  try {
    await client.post('/hub/agent', { config: example.config });
  } catch (err) {
    got409 = err.status === 409;
    conflictSubject = (/agent exists:(\S+)/.exec(err.body?.error ?? err.message ?? '') ?? [])[1] ?? null;
  }
  check('creating the identical config returns 409 with the existing subject', got409 && conflictSubject === subject, `409=${got409} subject=${conflictSubject}`);

  // --- read back ---
  const fetched = await client.get(`/hub/agent/${pathId(subject)}`);
  const stored = fetched?.config ?? fetched?.body?.config;
  check('agent read back by the uuid suffix of the subject', Boolean(stored), JSON.stringify(fetched).slice(0, 200));
  check('name round-tripped', stored?.name === example.config.name, `got ${JSON.stringify(stored?.name)}`);
  check('behaviour round-tripped', stored?.behaviour === example.config.behaviour);
  check('llm_provider/model round-tripped', stored?.llm_provider === example.config.llm_provider && stored?.model === example.config.model, `got ${stored?.llm_provider}/${stored?.model}`);
  check(
    'output_schema round-tripped as a { field: description } map',
    stored?.output_schema &&
      Object.keys(stored.output_schema).length === Object.keys(example.config.output_schema).length &&
      Object.values(stored.output_schema).every((v) => typeof v === 'string'),
    JSON.stringify(stored?.output_schema)
  );
  check('llm_config round-tripped', JSON.stringify(stored?.llm_config) === JSON.stringify(example.config.llm_config), JSON.stringify(stored?.llm_config));
  check(
    'api_key stayed a secret NAME, not a resolved credential',
    stored?.api_key === example.config.api_key,
    `got ${JSON.stringify(stored?.api_key)}`
  );

  const listed = await client.get('/hub/agent');
  check('agent appears in list_agents', (listed?.results ?? []).some((a) => a.subject === subject));

  // --- optional invoke (costs tokens) ---
  if (INVOKE) {
    console.log('\ninvoking (this spends LLM tokens)');
    const invoked = await client.post('/hub/agent/invoke', {
      subject,
      prompt: example.invoke.prompt,
    });
    const raw = invoked?.result ?? invoked?.body?.result ?? invoked;
    console.log(`     raw result type: ${typeof raw}`);
    console.log(`     raw result: ${typeof raw === 'string' ? raw.slice(0, 400) : JSON.stringify(raw).slice(0, 400)}`);
    check('invoke returned something', raw !== undefined && raw !== null);
    if (typeof raw === 'string') {
      check('the result is a STRING even with output_schema set', true);

      // Observed live 2026-07-29: the string is not raw JSON, it is MARKDOWN-FENCED
      // JSON (```json\n{...}\n```). A bare JSON.parse throws on it, so the standing
      // advice to "JSON.parse the result in an eval node" fails as written.
      const bareParseThrew = (() => {
        try {
          JSON.parse(raw);
          return false;
        } catch {
          return true;
        }
      })();
      const fenced = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(raw);
      check(
        'a bare JSON.parse on the result throws — it is markdown-fenced, not raw JSON',
        bareParseThrew && fenced !== null,
        `bareParseThrew=${bareParseThrew} fenced=${fenced !== null}. If the fence is gone, the platform changed — update the docs.`
      );

      let parsed = null;
      try {
        parsed = JSON.parse(fenced ? fenced[1] : raw);
      } catch {
        /* still not JSON */
      }
      check('stripping the fence first makes it parse', parsed !== null, `raw: ${raw.slice(0, 200)}`);
      if (parsed) {
        check(
          'the parsed object carries the output_schema fields',
          Object.keys(example.config.output_schema).every((f) => f in parsed),
          JSON.stringify(parsed).slice(0, 200)
        );
      }
    } else {
      console.log('     NOTE: the result was NOT a string — that contradicts the documented gotcha, worth recording.');
    }
  } else {
    console.log('\n(skipped invoke — pass --invoke to run one claude-haiku-4-5 call)');
  }

  console.log(`\nCheck it in the UI (agents are labelled "Assistants"):`);
  console.log(`  Editor  : ${agentEditUrl(subject)}`);
  console.log(`            (subject with every "." replaced by "+")`);
  console.log(`  Subject : ${subject}`);
  console.log(`  Path id : ${pathId(subject)}   <- the {id} for get/update/delete`);

  if (CLEANUP) {
    console.log('\ncleaning up (deletes are verified, not trusted)');
    await client.delete(`/hub/agent/${pathId(subject)}`);
    const after = (await client.get('/hub/agent'))?.results ?? [];
    check('agent really deleted (gone from list_agents)', !after.some((a) => a.subject === subject));
    // Documented quirk: get on a deleted subject returns a HOLLOW empty config
    // rather than 404, because the KV delete appends an empty message.
    const ghost = await client.get(`/hub/agent/${pathId(subject)}`).catch(() => null);
    const ghostConfig = ghost?.config ?? ghost?.body?.config;
    check(
      'get_agent on the deleted subject returns a hollow config rather than 404 (documented hub-service quirk)',
      ghost === null || !ghostConfig?.name,
      `got ${JSON.stringify(ghostConfig).slice(0, 160)}`
    );
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
  console.error('push failed:', err.message, err.body ? JSON.stringify(err.body).slice(0, 300) : '');
  process.exit(1);
});
