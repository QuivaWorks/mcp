#!/usr/bin/env node
// Quiva Coworker MCP server: read and carefully change Abbie's settings (hub-service /hub/coworker/*).
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient } from './client.js';
import { GOTCHAS, listReferenceTopics, getReference } from './coworker-docs.js';
import { listExamples, getExample } from './examples.js';
import {
  SCOPES, TODO_STATUSES, ORG_PROFILE_FIELDS, PERSONAL_PROFILE_FIELDS,
  refusal, confirmGate, checkScope, todoResumesRun, validate,
  checkTodoUpdate, checkMemory, checkPersonalProfile, checkOrgProfile, checkCorrections, checkEnvVar,
  normaliseOrgProfile,
} from './validate.js';

export const instructions = `
Tools for reading and carefully changing the settings of Abbie, the Quiva AI
coworker (hub-service /hub/coworker/*). Abbie's behaviour comes from several
surfaces: the organisation profile, personality, personal profiles, memories,
corrections, skills, environment variables and the todo backlog.

Recipe:
1. list_reference_topics / get_coworker_reference("surfaces") to learn which
   surface holds what and who it affects; "roles-and-gates" for permissions.
2. Read before writing: get_org_profile, get_personal_profile, list_memories,
   list_corrections, list_env, list_todos, list_skills, get_model_catalog.
3. validate_payload lints a write locally.
4. Writes read the current value first, merge, send, and read back.

Writes that change Abbie for everyone in the account need confirm: true:
organisation memory, organisation profile, task space and organisation env.
Get the user's agreement before sending confirm. update_todo also needs confirm
to move an item out of awaiting_user, because that resumes Abbie's run.

Chatting with Abbie is not here: it spends tokens and answers on a stream. Use
the Assistants server (invoke_agent). See get_coworker_reference("not-exposed").

Top gotchas:
${GOTCHAS.map((g) => `- ${g}`).join('\n')}
`.trim();

function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err) {
  const detail = err?.body ? `\n${JSON.stringify(err.body, null, 2)}` : '';
  return { content: [{ type: 'text', text: `Error: ${err.message}${detail}` }], isError: true };
}

// MCP clients may pass structured params as JSON strings.
const jsonValue = z.preprocess((v) => {
  if (typeof v === 'string' && /^[[{"]/.test(v.trim())) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}, z.any());

const scopeArg = z.enum(SCOPES).describe('"organisation" (every member) or "user" (the caller only). Required: the server silently widens anything else.');
const confirmArg = z.boolean().optional().describe('Required (true) for writes that change Abbie for the whole account. Ask the user first.');

const trimmed = (v) => (typeof v === 'string' ? v.trim() : v);
const stripMeta = ({ is_default, revision, ...rest } = {}) => rest;
const same = (a, b) => JSON.stringify(normalise(a)) === JSON.stringify(normalise(b));
function normalise(v) {
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalise(v[k])]));
  return trimmed(v ?? '');
}

function refuseInvalid(check) {
  return check.valid ? null : refusal(check.errors.join('; '), { errors: check.errors });
}

// Which of `fields` the read-back does not match; empty means verified.
function mismatches(sent, readBack, fields) {
  return fields.filter((f) => sent[f] !== undefined && !same(sent[f], readBack?.[f]));
}

async function findMemory(client, scope, id) {
  for (let offset = 0; offset < 10000; offset += 200) {
    const page = await client.get('/hub/coworker/org-memories', { scope, limit: 200, offset });
    const hit = (page?.memories ?? []).find((m) => m.id === id);
    if (hit) return hit;
    if ((page?.memories ?? []).length < 200) return null;
  }
  return null;
}

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

  // Reference and validation (no API call)

  tool(
    'list_reference_topics',
    'List reference topics for Abbie\'s settings (surfaces, roles-and-gates, todos, skills, memory, profiles, corrections, env-and-secrets, models, not-exposed, endpoints, gotchas) plus the gotchas. Start here.',
    {},
    async () => ({ topics: listReferenceTopics(), gotchas: GOTCHAS })
  );

  tool(
    'get_coworker_reference',
    'Get one reference topic in full: shapes, limits, gates and the traps each route carries.',
    { topic: z.string().describe('A topic from list_reference_topics') },
    async ({ topic }) => getReference(topic)
  );

  tool('list_examples', 'List authored example write payloads.', {}, async () => listExamples());

  tool(
    'get_example',
    'Get one authored example payload and what it teaches.',
    { slug: z.string().describe('Slug from list_examples') },
    async ({ slug }) => getExample(slug)
  );

  tool(
    'validate_payload',
    'Lint a write locally (no API call), with the same limits and refusals the write tools apply.',
    {
      kind: z.enum(['todo_update', 'memory', 'personal_profile', 'org_profile', 'corrections', 'env_var']),
      payload: jsonValue.describe('The body to check. For corrections, the full list or { corrections: [...] }.'),
    },
    async ({ kind, payload }) => validate(kind, payload)
  );

  // Skills (read only)

  tool(
    'list_skills',
    'List Abbie\'s skills: builtins, the account\'s disabled builtins and its own skills. GET /hub/coworker/skills.',
    {},
    async () => client.get('/hub/coworker/skills')
  );

  tool(
    'test_skill_activation',
    'Dry-run which skills a message would activate (`activated`) or make available on request (`discoverable`). Keyword and pattern matching only; no model call, no tokens. POST /hub/coworker/skill/test.',
    { message: z.string().describe('A message a user might send Abbie') },
    async ({ message }) => client.post('/hub/coworker/skill/test', { message })
  );

  tool(
    'list_skill_drafts',
    'List skills Abbie has proposed, with status pending|approved|rejected|expired. Approval happens in the app. GET /hub/coworker/skill-drafts.',
    {},
    async () => client.get('/hub/coworker/skill-drafts')
  );

  tool(
    'get_skill_exec',
    'Whether the account lets skills run scripts: { enabled, enabled_by, enabled_at }. A failed read also reports enabled:false. GET /hub/coworker/skill-exec.',
    {},
    async () => client.get('/hub/coworker/skill-exec')
  );

  // Todos

  tool(
    'list_todos',
    'List Abbie\'s backlog: the caller\'s own items and the organisation\'s, each tagged with `scope`. GET /hub/coworker/todos.',
    {
      status: z.enum(TODO_STATUSES).optional(),
      kind: z.enum(['task', 'reminder']).optional(),
      open_only: z.boolean().optional().describe('Only items not done or cancelled'),
      scheduled: z.boolean().optional().describe('Only items with a schedule'),
      session_id: z.string().optional().describe('Only items from one chat session'),
    },
    async ({ status, kind, open_only, scheduled, session_id }) =>
      client.get('/hub/coworker/todos', {
        status, kind, session_id,
        open_only: open_only ? 'true' : undefined,
        scheduled: scheduled ? 'true' : undefined,
      })
  );

  tool(
    'update_todo',
    'Update one backlog item: status, content, details, follow_up_at (only with status awaiting_user) or acknowledge a delivered reminder. Moving an item from awaiting_user to pending or in_progress RESUMES Abbie\'s run and spends tokens, so it needs confirm: true. Cancel with status "cancelled". PUT /hub/coworker/todo.',
    {
      scope: scopeArg,
      id: z.string(),
      status: z.enum(TODO_STATUSES).optional(),
      content: z.string().optional(),
      details: z.string().optional(),
      follow_up_at: z.string().optional().describe('RFC3339 time to chase the person; requires status awaiting_user'),
      acknowledge: z.boolean().optional().describe('Confirm a reminder that was already delivered'),
      confirm: confirmArg,
    },
    async (args) => {
      const bad = refuseInvalid(checkTodoUpdate(args));
      if (bad) return bad;
      const { scope, id, status, content, details, follow_up_at, acknowledge, confirm } = args;
      let before = null;
      if ((status === 'pending' || status === 'in_progress') && confirm !== true) {
        try {
          const list = await client.get('/hub/coworker/todos');
          before = (list?.items ?? []).find((i) => i.id === id && i.scope === scope) ?? null;
        } catch (err) {
          return refusal(`Could not read the item to check whether this resumes Abbie's run (${err.message}). Re-send with confirm: true to proceed anyway.`, { needs_confirm: true });
        }
        if (before && todoResumesRun(before.status, status)) {
          return refusal(
            `Item ${id} is awaiting_user. Moving it to ${status} resumes Abbie's run immediately and spends tokens. Re-send with confirm: true once the user has agreed.`,
            { needs_confirm: true, current_status: before.status }
          );
        }
      }
      const updated = await client.put('/hub/coworker/todo', { scope, id, status, content, details, follow_up_at, acknowledge });
      return { updated, status_verified: status === undefined || updated?.status === status };
    }
  );

  tool(
    'promote_todo_to_task',
    'Turn a backlog item into a workspace task and close the item (status done; its content gains "[Promoted to workspace task <id>]"). The task goes to space_id, else the account\'s task space, else ESCALATE. POST /hub/coworker/todo/promote/task.',
    {
      scope: scopeArg,
      id: z.string(),
      space_id: z.string().optional().describe('Workspace space for the task; defaults to the account setting'),
    },
    async ({ scope, id, space_id }) => {
      const res = await client.post('/hub/coworker/todo/promote/task', { scope, id, space_id });
      if (res?.error) {
        return { ...res, warning: 'The task was created but the todo item was not closed. Close it with update_todo.' };
      }
      return res;
    }
  );

  // Memories

  tool(
    'list_memories',
    'List Abbie\'s memories in one scope: { memories, total }. q is a substring match; total counts matches before paging. An unreadable store lists as empty. GET /hub/coworker/org-memories.',
    {
      scope: scopeArg,
      q: z.string().optional(),
      topic: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50, max 200'),
      offset: z.number().int().min(0).optional(),
    },
    async ({ scope, q, topic, limit, offset }) => client.get('/hub/coworker/org-memories', { scope, q, topic, limit, offset })
  );

  tool(
    'create_memory',
    'Add a memory. Organisation memories are read by every member\'s Abbie. The server does NOT restrict organisation memory writes to admins, so this tool requires confirm: true for them. POST /hub/coworker/org-memory.',
    {
      scope: scopeArg,
      memory: z.string().describe('The fact, 2048 bytes max'),
      topics: z.array(z.string()).optional().describe('Up to 10 topics, 64 bytes each'),
      confirm: confirmArg,
    },
    async (args) => {
      const bad = refuseInvalid(checkMemory(args));
      if (bad) return bad;
      if (args.scope === 'organisation') {
        const gate = confirmGate({ confirm: args.confirm, what: 'An organisation memory' });
        if (gate) return gate;
      }
      const created = await client.post('/hub/coworker/org-memory', { memory: args.memory, topics: args.topics ?? [] }, { scope: args.scope });
      const readBack = created?.id ? await findMemory(client, args.scope, created.id) : null;
      return { created, verified: Boolean(readBack && same(readBack.memory, args.memory)) };
    }
  );

  tool(
    'update_memory',
    'Change a memory\'s text, and its topics if given (stored topics are kept otherwise). Organisation scope requires confirm: true; the server itself does not gate it. PUT /hub/coworker/org-memory/{id}.',
    {
      scope: scopeArg,
      id: z.string(),
      memory: z.string(),
      topics: z.array(z.string()).optional(),
      confirm: confirmArg,
    },
    async (args) => {
      const bad = refuseInvalid(checkMemory(args));
      if (bad) return bad;
      if (args.scope === 'organisation') {
        const gate = confirmGate({ confirm: args.confirm, what: 'Changing an organisation memory' });
        if (gate) return gate;
      }
      let topics = args.topics;
      if (topics === undefined) {
        const existing = await findMemory(client, args.scope, args.id);
        if (!existing) return refusal(`No ${args.scope} memory with id ${args.id}.`);
        topics = existing.topics ?? [];
      }
      const updated = await client.put(`/hub/coworker/org-memory/${encodeURIComponent(args.id)}`, { memory: args.memory, topics }, { scope: args.scope });
      const readBack = await findMemory(client, args.scope, args.id);
      return { updated, verified: Boolean(readBack && same(readBack.memory, args.memory) && same(readBack.topics, topics)) };
    }
  );

  tool(
    'delete_memory',
    'Delete a memory. The text is kept as a hidden tombstone so Abbie does not re-learn it; purge: true drops the text too. Organisation scope requires confirm: true. DELETE /hub/coworker/org-memory/{id}.',
    { scope: scopeArg, id: z.string(), purge: z.boolean().optional(), confirm: confirmArg },
    async ({ scope, id, purge, confirm }) => {
      const scopeErr = checkScope(scope);
      if (scopeErr) return refusal(scopeErr);
      if (scope === 'organisation') {
        const gate = confirmGate({ confirm, what: 'Deleting an organisation memory' });
        if (gate) return gate;
      }
      await client.delete(`/hub/coworker/org-memory/${encodeURIComponent(id)}`, { scope, purge: purge ? 'true' : undefined });
      const readBack = await findMemory(client, scope, id);
      return { deleted: id, purged: Boolean(purge), verified: readBack === null };
    }
  );

  // Profiles

  tool(
    'get_org_profile',
    'Read the organisation profile Abbie uses for every member: flat fields plus is_default and revision. GET /hub/coworker/profile.',
    {},
    async () => client.get('/hub/coworker/profile')
  );

  const orgProfileArgs = Object.fromEntries(
    ORG_PROFILE_FIELDS.map((f) => [f, jsonValue.optional().describe(f)])
  );

  tool(
    'update_org_profile',
    'Change fields of the organisation profile. Admin-only on the server; lands in every member\'s prompts, so this tool also requires confirm: true. Only the fields you pass change: the tool reads the profile, merges, sends if_revision, and reads back. Refuses a result that would be empty. Field limits: get_coworker_reference("profiles"). PUT /hub/coworker/profile.',
    { ...orgProfileArgs, confirm: confirmArg },
    async ({ confirm, ...fields }) => {
      const gate = confirmGate({ confirm, what: 'The organisation profile' });
      if (gate) return gate;
      const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length === 0) return refusal('Pass at least one profile field to change.');
      const current = await client.get('/hub/coworker/profile');
      const merged = { ...stripMeta(current), ...patch };
      const bad = refuseInvalid(checkOrgProfile(merged));
      if (bad) return bad;
      const saved = await client.put('/hub/coworker/profile', { ...normaliseOrgProfile(merged), if_revision: current?.revision });
      const readBack = await client.get('/hub/coworker/profile');
      const off = mismatches(normaliseOrgProfile(patch), readBack, Object.keys(patch));
      return { saved: readBack, verified: off.length === 0, ...(off.length ? { not_matching: off } : {}), revision: saved?.revision };
    }
  );

  tool(
    'get_personal_profile',
    'Read the caller\'s own personal profile: about_me, how_i_work, constraints, is_default, revision. GET /hub/coworker/personal-profile.',
    {},
    async () => client.get('/hub/coworker/personal-profile')
  );

  tool(
    'update_personal_profile',
    'Change the caller\'s own personal profile. Only the fields you pass change; the tool merges over a fresh read, sends if_revision, and reads back. Refuses a result that would be empty. 1000 characters per field, 3000 in total. PUT /hub/coworker/personal-profile.',
    {
      about_me: z.string().optional(),
      how_i_work: z.string().optional(),
      constraints: z.string().optional(),
    },
    async (fields) => {
      const patch = Object.fromEntries(PERSONAL_PROFILE_FIELDS.filter((f) => fields[f] !== undefined).map((f) => [f, fields[f]]));
      if (Object.keys(patch).length === 0) return refusal('Pass at least one of about_me, how_i_work, constraints.');
      const current = await client.get('/hub/coworker/personal-profile');
      const merged = Object.fromEntries(PERSONAL_PROFILE_FIELDS.map((f) => [f, patch[f] ?? current?.[f] ?? '']));
      const bad = refuseInvalid(checkPersonalProfile(merged));
      if (bad) return bad;
      await client.put('/hub/coworker/personal-profile', { ...merged, if_revision: current?.revision });
      const readBack = await client.get('/hub/coworker/personal-profile');
      const off = mismatches(patch, readBack, Object.keys(patch));
      return { saved: readBack, previous: stripMeta(current), verified: off.length === 0, ...(off.length ? { not_matching: off } : {}) };
    }
  );

  tool(
    'get_personality',
    'Read Abbie\'s voice for the account: { voice, is_default, revision }. Changing it is an admin action in the app. GET /hub/coworker/personality.',
    {},
    async () => client.get('/hub/coworker/personality')
  );

  // Corrections

  tool(
    'list_corrections',
    'Read corrections: the caller\'s own (max 6), the organisation\'s, and drafts Abbie proposed for the caller. Each part reports its own error if it fails.',
    {},
    async () => {
      const parts = {
        corrections: '/hub/coworker/corrections',
        org_corrections: '/hub/coworker/org-corrections',
        drafts: '/hub/coworker/correction-drafts',
      };
      const entries = await Promise.all(
        Object.entries(parts).map(async ([k, path]) => {
          try {
            return [k, await client.get(path)];
          } catch (err) {
            return [k, { error: err.message }];
          }
        })
      );
      return Object.fromEntries(entries);
    }
  );

  tool(
    'update_corrections',
    'Add or remove the caller\'s own corrections ("in this situation, do this instead"). Reads the list, applies remove then add, re-reads just before writing and refuses if the list changed in between, then writes the whole list. The server\'s own 409 covers only its internal load-to-save window, not the gap since your read. At most 6; situation 150 and instead 200 characters. PUT /hub/coworker/corrections.',
    {
      add: jsonValue.optional().describe('[{ situation, instead }]'),
      remove: z.array(z.string()).optional().describe('Correction ids to remove'),
    },
    async ({ add = [], remove = [] }) => {
      if (!Array.isArray(add)) return refusal('add must be an array of { situation, instead }');
      if (add.length === 0 && remove.length === 0) return refusal('Pass add, remove, or both.');
      const current = (await client.get('/hub/coworker/corrections'))?.corrections ?? [];
      const missing = remove.filter((id) => !current.some((c) => c.id === id));
      if (missing.length) return refusal(`No correction with id ${missing.join(', ')}.`);
      const next = [
        ...current.filter((c) => !remove.includes(c.id)),
        ...add.map((c) => ({ situation: c?.situation, instead: c?.instead, source: 'manual' })),
      ];
      const bad = refuseInvalid(checkCorrections(next));
      if (bad) return bad;
      // PUT carries no revision, so a change since the first read would be overwritten.
      const latest = (await client.get('/hub/coworker/corrections'))?.corrections ?? [];
      if (!same(latest, current)) {
        return refusal('The corrections changed since they were read (another save landed in between). Nothing was written; run update_corrections again.', { current: latest });
      }
      await client.put('/hub/coworker/corrections', { corrections: next });
      const readBack = (await client.get('/hub/coworker/corrections'))?.corrections ?? [];
      const addedOk = add.every((a) => readBack.some((c) => same(c.situation, a.situation) && same(c.instead, a.instead)));
      const removedOk = remove.every((id) => !readBack.some((c) => c.id === id));
      return { corrections: readBack, previous: current, verified: addedOk && removedOk };
    }
  );

  // Task space

  tool(
    'get_task_space',
    'The workspace space tasks Abbie creates land in: { space_id, updated }. "ESCALATE" is the default, and is also what an unreadable setting reports. GET /hub/coworker/task-space.',
    {},
    async () => client.get('/hub/coworker/task-space')
  );

  tool(
    'set_task_space',
    'Change where every task Abbie creates for the account lands. Admin-only; requires confirm: true. The space must exist. PUT /hub/coworker/task-space.',
    { space_id: z.string(), confirm: confirmArg },
    async ({ space_id, confirm }) => {
      const gate = confirmGate({ confirm, what: 'The task space' });
      if (gate) return gate;
      if (!trimmed(space_id)) return refusal('space_id is required');
      const saved = await client.put('/hub/coworker/task-space', { space_id });
      const readBack = await client.get('/hub/coworker/task-space');
      return { saved, verified: String(readBack?.space_id ?? '').toUpperCase() === String(space_id).trim().toUpperCase() };
    }
  );

  // Environment variables

  tool(
    'list_env',
    'List Abbie\'s environment variables in one scope: { scope, vars, updated_at }. Values come back as stored: literals and SECRET:: references, never resolved secrets. GET /hub/coworker/env.',
    { scope: scopeArg },
    async ({ scope }) => client.get('/hub/coworker/env', { scope })
  );

  tool(
    'set_env',
    'Create or change one variable. secret is required: true takes only a SECRET::<name>:: reference to a stored secret; false takes a literal, which Abbie\'s model can see, and is refused for credential-looking keys. That check only matches whole words of the key name (KEY, TOKEN, SECRET, PASSWORD, PASS, AUTH, BEARER, DSN, ACCESS, SIGNING, PRIVATE ...); it cannot see a credential stored under an innocent name or inside the value, so never pass a real credential as a literal. Organisation scope is admin-only and requires confirm: true. POST or PUT /hub/coworker/env.',
    {
      scope: scopeArg,
      key: z.string().describe('^[A-Z_][A-Z0-9_]*$, 64 max'),
      value: z.string(),
      secret: z.boolean(),
      description: z.string().optional().describe('What Abbie is told about the key (always model-visible)'),
      server: z.string().optional().describe('Catalog server id this belongs to'),
      consumers: z.array(z.string()).optional(),
      confirm: confirmArg,
    },
    async (args) => {
      const bad = refuseInvalid(checkEnvVar(args));
      if (bad) return bad;
      if (args.scope === 'organisation') {
        const gate = confirmGate({ confirm: args.confirm, what: 'An organisation environment variable' });
        if (gate) return gate;
      }
      const list = await client.get('/hub/coworker/env', { scope: args.scope });
      const existing = (list?.vars ?? []).find((v) => v.key === args.key);
      const body = {
        key: args.key,
        value: args.value.trim(),
        description: args.description ?? existing?.description,
        server: args.server ?? existing?.server,
        consumers: args.consumers ?? existing?.consumers,
      };
      const saved = existing
        ? await client.put('/hub/coworker/env', body, { scope: args.scope })
        : await client.post('/hub/coworker/env', body, { scope: args.scope });
      const readBack = ((await client.get('/hub/coworker/env', { scope: args.scope }))?.vars ?? []).find((v) => v.key === args.key);
      return {
        action: existing ? 'updated' : 'created',
        saved,
        verified: Boolean(readBack && readBack.value === body.value && readBack.secret === args.secret),
      };
    }
  );

  tool(
    'delete_env',
    'Delete one variable. Organisation scope is admin-only and requires confirm: true. DELETE /hub/coworker/env?key=.',
    { scope: scopeArg, key: z.string(), confirm: confirmArg },
    async ({ scope, key, confirm }) => {
      const scopeErr = checkScope(scope);
      if (scopeErr) return refusal(scopeErr);
      if (!trimmed(key)) return refusal('key is required');
      if (scope === 'organisation') {
        const gate = confirmGate({ confirm, what: 'Deleting an organisation environment variable' });
        if (gate) return gate;
      }
      const res = await client.delete('/hub/coworker/env', { scope, key });
      const readBack = ((await client.get('/hub/coworker/env', { scope }))?.vars ?? []).find((v) => v.key === key);
      return { ...res, verified: !readBack };
    }
  );

  // Models and settings

  tool(
    'get_model_catalog',
    'The models Abbie can use: { providers, partial }. partial: true means only the account\'s custom providers could be listed. GET /hub/coworker/model-catalog.',
    {},
    async () => client.get('/hub/coworker/model-catalog')
  );

  tool(
    'get_model_pool',
    'The account\'s model routing settings, provider keys redacted. {} can mean unset or a failed redaction. GET /hub/agent/model-pool.',
    {},
    async () => client.get('/hub/agent/model-pool')
  );

  tool(
    'get_memory_settings',
    'Whether Abbie consolidates memories for the account: { enabled, enabled_by, enabled_at }. GET /hub/coworker/memory-consolidation.',
    {},
    async () => client.get('/hub/coworker/memory-consolidation')
  );
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`[quiva-coworker-mcp] Node ${process.versions.node} is too old; requires Node >= 18. Launch via bin/run.sh or set QUIVA_NODE.`);
    process.exit(1);
  }
  const client = QuivaClient.fromEnv();
  if (!client.hasCredentials()) {
    console.error('[quiva-coworker-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD).');
  }
  const server = new McpServer({ name: 'quiva-coworker', version: '0.1.0' }, { instructions });
  registerTools(server, client);
  await server.connect(new StdioServerTransport());
  console.error(`[quiva-coworker-mcp] ready. API: ${client.baseUrl}`);
}

// Importing must have no side effects; only run when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[quiva-coworker-mcp] fatal:', err);
    process.exit(1);
  });
}
