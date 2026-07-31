#!/usr/bin/env node
// Quiva Workspaces MCP server — manage spaces, tasks, and comments (workspaces-service).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient } from './client.js';
import { GOTCHAS, listReferenceTopics, getReference } from './workspaces-docs.js';
import { validate } from './validate.js';
import { listExamples, getExample } from './examples.js';

const client = new QuivaClient();

const INSTRUCTIONS = `
Tools for managing Quiva workspaces (workspaces-service). A "space" is a
workspace holding tasks and configurable statuses; "tasks" are work items in a
space; "comments" (with emoji reactions) live on tasks.

Recipe:
1. list_reference_topics / get_workspaces_reference — learn the space/task/
   comment shapes, id rules, and filters (engine-truth; corrects the OpenAPI spec).
2. list_spaces / get_space — discover existing spaces and their statuses.
3. validate_payload — lint a create/update body locally before sending.
4. create_space -> create_task -> create_comment — build resources.
5. update_task / update_multi_task / react_to_comment — collaborate; delete_* to clean up.
6. set_task_action / delete_task_action — the per-task checklist (write-only; see below).

Top gotchas:
${GOTCHAS.map((g) => `- ${g}`).join('\n')}
`.trim();

const server = new McpServer(
  { name: 'quiva-workspaces', version: '0.1.0' },
  { instructions: INSTRUCTIONS }
);

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

function tool(name, description, inputSchema, handler) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return jsonResult(await handler(args ?? {}));
    } catch (err) {
      return errorResult(err);
    }
  });
}

// Free-form JSON value (payload objects, statuses, reaction maps). MCP clients
// pass untyped params as raw strings, so coerce JSON-looking strings back.
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

// Run the local validator, gate the call on errors, and surface warnings
// alongside a successful result.
async function withValidation(kind, payload, requireRequired, skip, run, key) {
  let validation = null;
  if (!skip) {
    validation = validate(kind, payload, { requireRequired });
    if (!validation.valid) {
      return { [key]: false, validation };
    }
  }
  const result = await run();
  return validation?.warnings?.length ? { ...wrap(result), warnings: validation.warnings } : result;
}

const spacePayload = jsonValue.describe('The space object: { id, name, description?, default_status?, statuses?[], record_config_ids?[], ... }. See get_workspaces_reference("spaces").');
const taskPayload = jsonValue.describe('The task object: { title, space_id?, description?, assignees?[], priority?, status?, due_date?, scheduled_at?, archived?, tags?[], time_tracking?, ... }. See get_workspaces_reference("tasks") and ("time-tracking").');
const commentPayload = jsonValue.describe('The comment object: { body, reply_id? }. See get_workspaces_reference("comments").');
const taskActionPayload = jsonValue.describe('The task action: { description, id?, done?, resources?[{ resource_id, resource_type, metadata? }] }. `description` is required on EVERY write, even one that only flips `done`. See get_workspaces_reference("task-actions").');

// ---------------------------------------------------------------------------
// Reference & validation (no API call)
// ---------------------------------------------------------------------------

tool(
  'list_reference_topics',
  'List workspaces reference topics (spaces, tasks, comments, reactions, identifiers, auth, endpoints, gotchas) plus the known spec-vs-engine gotchas. Start here.',
  {},
  async () => ({ topics: listReferenceTopics(), gotchas: GOTCHAS })
);

tool(
  'get_workspaces_reference',
  'Get the full reference for one topic: shapes, id rules, allowed values, filters, and correct examples.',
  { topic: z.string().describe('One of the topics from list_reference_topics') },
  async ({ topic }) => getReference(topic)
);

tool(
  'list_examples',
  'List bundled reference examples: real spaces/tasks/comments harvested off the platform, plus hand-written WRITE payloads. Read one before authoring — a harvested example proves a shape that works, and the authored one shows how a create body differs from a read.',
  {},
  async () => listExamples()
);

tool(
  'get_example',
  'Get one reference example in full, with what it teaches. Harvested examples are real platform data (READ responses — do not echo one back as a create body); authored ones are write payloads and say so.',
  { slug: z.string().describe('Example slug from list_examples') },
  async ({ slug }) => getExample(slug)
);

tool(
  'validate_payload',
  'Validate a workspaces payload locally (no API call). Encodes engine rules: space id ^\\w+$ + uppercasing, task title required + space_id existence/uppercasing, comment body-or-reply_id, reaction map shape, RFC3339 dates, time_tracking/TimeLog shape plus its replace-not-append warning, task-action requirements, and read-only-field lints. Run before create_*/update_*.',
  {
    kind: z.enum(['space', 'task', 'multi_task', 'comment', 'reaction', 'task_action']).describe('Which payload shape to validate'),
    payload: jsonValue.describe('The payload object to validate'),
    mode: z.enum(['create', 'update']).default('create').describe('create = required fields enforced; update = all optional'),
  },
  async ({ kind, payload, mode }) => validate(kind, payload, { requireRequired: mode === 'create' })
);

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

tool(
  'list_spaces',
  'List all spaces for the authenticated account. Returns { results: [Space], results_total }. The built-in ESCALATE space is always included.',
  {},
  async () => client.get('/workspaces/spaces')
);

tool(
  'create_space',
  'Create a space. Requires `id` (^\\w+$, UPPERCASED server-side) and `name`. Validated locally first (errors block, warnings reported). Creating an existing id returns 409 "space exists".',
  {
    space: spacePayload,
    skip_local_validation: z.boolean().default(false).describe('Set true only to intentionally bypass the local validator'),
  },
  async ({ space, skip_local_validation }) =>
    withValidation('space', space, true, skip_local_validation, () => client.post('/workspaces/space', space), 'created')
);

tool(
  'get_space',
  'Get one space by id. Returns the Space (statuses, priorities, record configs, url). The id is the uppercased space id.',
  { id: z.string().describe('Space id (uppercased form)') },
  async ({ id }) => client.get(`/workspaces/space/${encodeURIComponent(id)}`)
);

tool(
  'update_space',
  'Update a space (PATCH). Merges the fields you send over the stored space — send only changed fields, built from scratch (do NOT copy nested statuses from a GET). May return 202 when removing priorities triggers a background task re-assignment. Cannot update ESCALATE (403).',
  {
    id: z.string().describe('Space id (uppercased form)'),
    space: spacePayload,
    skip_local_validation: z.boolean().default(false),
  },
  async ({ id, space, skip_local_validation }) =>
    withValidation('space', space, false, skip_local_validation, () => client.patch(`/workspaces/space/${encodeURIComponent(id)}`, space), 'updated')
);

tool(
  'delete_space',
  'Delete a space by id (also purges its tasks, comments, and files). Returns { message: "success" }. Irreversible. Cannot delete ESCALATE (403).',
  { id: z.string().describe('Space id (uppercased form)') },
  async ({ id }) => client.delete(`/workspaces/space/${encodeURIComponent(id)}`)
);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

tool(
  'list_tasks',
  'List tasks in a space (path {space_id}) with optional filters. Returns { results: [Task], results_total }.',
  {
    space_id: z.string().describe('Space id to list tasks for (uppercased form)'),
    archived: z.boolean().optional(),
    scheduled: z.boolean().optional(),
    limit: z.number().int().optional().describe('Default 300'),
    offset: z.number().int().optional(),
    sort_by: z.string().optional().describe('Default created_at'),
    sort_order: z.enum(['asc', 'desc']).optional(),
    created_by: z.string().optional(),
    priority: z.string().optional().describe('Exact; comma-separated for multiple'),
    status: z.string().optional().describe('Exact; comma-separated for multiple'),
    title: z.string().optional().describe('Term search'),
    assignees: z.string().optional().describe('Comma-separated ids; at least one matches'),
    reporter: z.string().optional(),
    created_at: z.string().optional().describe('Date or {start},{end} range'),
    updated_at: z.string().optional().describe('Date or {start},{end} range'),
    scheduled_at: z.string().optional().describe('Date or {start},{end} range'),
  },
  async ({ space_id, ...query }) =>
    client.get(`/workspaces/space/${encodeURIComponent(space_id)}/tasks`, query)
);

tool(
  'create_task',
  'Create a task. Requires `title`. If `space_id` is set the space must already exist (and is uppercased); otherwise the task lands in the "default" space. The task `id` is server-generated — do not send one. due_date/scheduled_at are RFC3339. Omitting `status` inherits the space\'s default_status (only when space_id is set). Accepts `time_tracking` — see get_workspaces_reference("time-tracking").',
  {
    task: taskPayload,
    skip_local_validation: z.boolean().default(false),
  },
  async ({ task, skip_local_validation }) =>
    withValidation('task', task, true, skip_local_validation, () => client.post('/workspaces/task', task), 'created')
);

tool(
  'get_task',
  'Get one task by id. Returns the task plus top-level `watchers[]` and `muted[]` arrays.',
  { id: z.string().describe('Task id') },
  async ({ id }) => client.get(`/workspaces/task/${encodeURIComponent(id)}`)
);

tool(
  'update_task',
  'Update one task (PATCH merge). Send only changed fields, built from scratch. Accepts title/description/assignees/priority/status/due_date/scheduled_at/archived/tags/time_tracking/etc. Setting archived:true unschedules the task. WARNING on time_tracking: `logs[]` REPLACES the stored array rather than appending, so adding one entry means get_task -> append -> send the whole array.',
  {
    id: z.string().describe('Task id'),
    task: taskPayload,
    skip_local_validation: z.boolean().default(false),
  },
  async ({ id, task, skip_local_validation }) =>
    withValidation('task', task, false, skip_local_validation, () => client.patch(`/workspaces/task/${encodeURIComponent(id)}`, task), 'updated')
);

tool(
  'update_multi_task',
  'Batch-update tasks (PATCH /workspaces/tasks). Body is { tasks: [{ id, ...fields }] }. Returns an OBJECT keyed by request index (not an array); any single failure fails the whole call with per-index errors.',
  {
    tasks: jsonValue.describe('Array of task updates, each with an `id`: [{ id, status?, priority?, ... }]'),
    skip_local_validation: z.boolean().default(false),
  },
  async ({ tasks, skip_local_validation }) => {
    const payload = { tasks };
    return withValidation('multi_task', payload, true, skip_local_validation, () => client.patch('/workspaces/tasks', payload), 'updated');
  }
);

tool(
  'delete_task',
  'Delete a task by id (also purges its comments and reactions). Returns { message: "success" }. Irreversible.',
  { id: z.string().describe('Task id') },
  async ({ id }) => client.delete(`/workspaces/task/${encodeURIComponent(id)}`)
);

// ---------------------------------------------------------------------------
// Task actions (the per-task checklist)
//
// WRITE-ONLY by accident, not by design. The gateway maps
// GET /workspaces/task/{task_id}/action at the WRITE resource
// `microstrate.workspaces.put.task-action`, so the GET runs AddTaskActionHandler
// and answers 400 "description is required" (verified live 2026-07-29).
// ListTaskActionsHandler exists (workspaces-service/handler/task_actions.go:94,
// registered as get.task-actions) but nothing routes to it — so there is no
// list_task_actions tool here. Exposing one would only ever return that 400.
// ---------------------------------------------------------------------------

tool(
  'set_task_action',
  'Create or update a checklist action on a task (PUT /workspaces/task/{task_id}/action). Omit `id` to create one (server assigns ta_<random>); pass an existing `id` to address that action. `description` is required on EVERY write, even one that only flips `done`. 404 "task not found" if the task does not exist. IMPORTANT: the response is your own request echoed back, not the stored record, and there is NO working read route for task actions — so this write cannot be verified afterwards. Nothing in the UI displays task actions yet either.',
  {
    task_id: z.string().describe('Task id the action hangs off'),
    action: taskActionPayload,
    skip_local_validation: z.boolean().default(false),
  },
  async ({ task_id, action, skip_local_validation }) =>
    withValidation(
      'task_action',
      action,
      true,
      skip_local_validation,
      () => client.put(`/workspaces/task/${encodeURIComponent(task_id)}/action`, action),
      'written'
    )
);

tool(
  'delete_task_action',
  'Delete a checklist action from a task (DELETE /workspaces/task/{task_id}/action/{id}). Returns { message: "success" }; an unknown id returns 404 "resource not found". Because there is no working list route, the id has to come from whatever created the action.',
  {
    task_id: z.string().describe('Task id'),
    id: z.string().describe('Action id (ta_<random> unless you supplied one)'),
  },
  async ({ task_id, id }) =>
    client.delete(`/workspaces/task/${encodeURIComponent(task_id)}/action/${encodeURIComponent(id)}`)
);

// ---------------------------------------------------------------------------
// Comments & reactions
// ---------------------------------------------------------------------------

tool(
  'create_comment',
  'Add a comment to a task (path {task_id}). Requires `body`. The comment `id` (c_<nanoid>), author, and timestamps are server-set. The author auto-watches the task.',
  {
    task_id: z.string().describe('Task id to comment on'),
    comment: commentPayload,
    skip_local_validation: z.boolean().default(false),
  },
  async ({ task_id, comment, skip_local_validation }) =>
    withValidation('comment', comment, true, skip_local_validation, () => client.post(`/workspaces/task/${encodeURIComponent(task_id)}/comment`, comment), 'created')
);

tool(
  'list_comments',
  'List comments on a task (path {task_id}). Returns { results: [Comment], results_total }, each with an aggregated `reactions` map.',
  { task_id: z.string().describe('Task id') },
  async ({ task_id }) => client.get(`/workspaces/task/${encodeURIComponent(task_id)}/comments`)
);

tool(
  'get_comment',
  'Get one comment on a task. Returns the comment with its aggregated `reactions` map.',
  {
    task_id: z.string().describe('Task id'),
    id: z.string().describe('Comment id (c_<nanoid>)'),
  },
  async ({ task_id, id }) => client.get(`/workspaces/task/${encodeURIComponent(task_id)}/comment/${encodeURIComponent(id)}`)
);

tool(
  'update_comment',
  'Update a comment (PATCH). Requires at least one of `body` or `reply_id`. Returns the updated comment.',
  {
    task_id: z.string().describe('Task id'),
    id: z.string().describe('Comment id'),
    comment: commentPayload,
    skip_local_validation: z.boolean().default(false),
  },
  async ({ task_id, id, comment, skip_local_validation }) =>
    withValidation('comment', comment, false, skip_local_validation, () => client.patch(`/workspaces/task/${encodeURIComponent(task_id)}/comment/${encodeURIComponent(id)}`, comment), 'updated')
);

tool(
  'delete_comment',
  'Delete a comment (soft delete — poison-pilled). Returns { message: "success" }.',
  {
    task_id: z.string().describe('Task id'),
    id: z.string().describe('Comment id'),
  },
  async ({ task_id, id }) => client.delete(`/workspaces/task/${encodeURIComponent(task_id)}/comment/${encodeURIComponent(id)}`)
);

tool(
  'react_to_comment',
  'Add or remove an emoji reaction on a comment. Body is { reaction: { "<emoji>": true|false } } (true = add, false = remove). Returns { reactions: { "<emoji>": { count, users } } } — NOT the comment. Needs a Bearer JWT to key the reacting user.',
  {
    task_id: z.string().describe('Task id'),
    id: z.string().describe('Comment id'),
    reaction: jsonValue.describe('Map of emoji to boolean: { "👍": true } to add, { "👍": false } to remove'),
    skip_local_validation: z.boolean().default(false),
  },
  async ({ task_id, id, reaction, skip_local_validation }) => {
    const payload = { reaction };
    return withValidation('reaction', payload, true, skip_local_validation, () => client.post(`/workspaces/task/${encodeURIComponent(task_id)}/comment/${encodeURIComponent(id)}/reaction`, payload), 'reacted');
  }
);

// ---------------------------------------------------------------------------
// Users (accounts-service — for resolving assignee/reporter ids)
// ---------------------------------------------------------------------------

tool(
  'list_users',
  'List active users in the current account (accounts-service, not workspaces). Use to resolve user ids for assignees/reporters. Returns { data: [ { id, email, first_name, last_name, role, ... } ] }.',
  {},
  async () => client.get('/accounts/users/list')
);

// ---------------------------------------------------------------------------

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(
      `[quiva-workspaces-mcp] Node ${process.versions.node} is too old — requires Node >= 18 (global fetch). Launch via bin/run.sh or set QUIVA_NODE.`
    );
    process.exit(1);
  }
  if (!client.hasCredentials()) {
    console.error(
      '[quiva-workspaces-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD). API tools will fail until one is set.'
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[quiva-workspaces-mcp] ready — API: ${client.baseUrl}`);
}

main().catch((err) => {
  console.error('[quiva-workspaces-mcp] fatal:', err);
  process.exit(1);
});
