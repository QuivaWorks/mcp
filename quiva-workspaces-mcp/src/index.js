#!/usr/bin/env node
// Quiva Workspaces MCP server — manage spaces, tasks, and comments (workspaces-service).
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient, WORKSPACES_BUCKET, RECALL_BUCKET, fileKeyOf, digestMatches, expectedDigestString } from './client.js';
import { GOTCHAS, listReferenceTopics, getReference } from './workspaces-docs.js';
import { validate, verticalRouting, externalIdProblem } from './validate.js';
import { listExamples, getExample } from './examples.js';

export const instructions = `
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
6. set_task_action / delete_task_action — the per-task checklist, read back via
   get_task (task_actions[]). A write moves the task status by status ROLE
   (todo / working / done), so give the space's statuses roles.
7. add_time_log / list_time_logs — log time one entry at a time; the server owns
   the id, user and timestamps and hydrates the totals onto the task.
8. create_contact — a contact keyed on the space's base_record. It can CREATE A
   PORTAL SIGN-IN when the space enrols contacts; it refuses unless allow_sign_in.
9. list_task_templates / create_task_template ... — templates that pre-fill tasks.
10. list_meetings / get_meeting_transcript — meeting files a notetaker filed.
10a. upsert_task_by_external_id / list_space_changes / if_match on update_task and
   delete_task — keep an external system in step; see get_workspaces_reference("task-sync").

Spaces also hold FILES, and the space "VERTICAL" is a template library whose
folders are deployed into an account when a vertical is added to it:
11. get_workspaces_reference("files") / ("verticals") — the dotted-path scheme, how
   a folder is really stored, and the deployment contract.
12. list_files -> create_folder -> write_file — build a vertical's folder tree and
   drop configs into it. Both writes confirm against the FILE INDEX, because
   indexing is asynchronous and the index is what deployment reads.
   Deleting a file or folder is deliberately NOT exposed — see the gotcha.

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

const spacePayload = jsonValue.describe('The space object: { id, name, description?, default_status?, statuses?[{ id, name, color, order, complete, is_visible, role? }], priorities?[], tags?[], record_configs?[], base_record?, organisation_record?, modules?, custom_tab?, hidden_tabs?[], view?, upsert_/remove_{statuses,priorities,tags}? (update only), editing_disabled? (create only, irreversible), staging? (root/admin only) }. See get_workspaces_reference("spaces").');
const taskPayload = jsonValue.describe('The task object: { title, space_id, description?, assignees?[], priority?, status?, due_date?, scheduled_at?, archived?, tags?[], parent?, source?, value?, currency?, expected_close?, time_tracking?: { estimate } , identity? (create only), external_id?, move_subtasks? (update only), suppress_events? }. See get_workspaces_reference("tasks").');
const ifMatch = z.union([z.number().int(), z.string()]).optional().describe('Task `version` you last read, sent as the If-Match header. A stale value fails with 409 version_conflict and the current task; omit for last-writer-wins. See get_workspaces_reference("task-sync").');

// Only send the header when a value was given.
function ifMatchHeader(value) {
  return value === undefined || value === null || value === '' ? undefined : { 'If-Match': String(value) };
}

const commentPayload = jsonValue.describe('The comment object: { body, reply_id? }. See get_workspaces_reference("comments").');
const taskActionPayload = jsonValue.describe('The task action: { description, id?, done?, resources?[{ resource_id, resource_type, metadata? }] }. `description` is required on EVERY write, even one that only flips `done`. See get_workspaces_reference("task-actions").');

// The space id is the second segment of every key: spaces.<SPACE_ID>....
function spaceIdOfKey(key) {
  return String(key).split('.')[1] ?? '';
}

function indexNote(verification, key, { isMarker = false } = {}) {
  if (!verification.indexed) {
    return (
      `NOT YET in the file index after ${verification.waited_ms}ms. The bytes are stored (the write returned a digest), but indexing is asynchronous and can take minutes. ` +
      `Until "${key}" appears in list_files it is invisible to vertical deployment — re-run list_files before deploying, and do NOT treat this as written.`
    );
  }
  if (verification.name_indexed) {
    return `Confirmed in the file index after ${verification.waited_ms}ms, with a populated \`name\` — so it is visible to vertical deployment and to the UI file tree.`;
  }
  // Present but unnamed. Harmless for a marker, serious for a config.
  const shared =
    `Present in the index after ${verification.waited_ms}ms but with an EMPTY \`name\` (the key was recovered from its subject). ` +
    'This is a platform indexing defect, and it is permanent — the name does not fill in later. ';
  return isMarker
    ? shared +
        'For a FOLDER this is cosmetic but visible: accounts-service skips markers anyway, so deployment is unaffected, but the UI file tree derives folder paths from `name` and will NOT show this folder while it is empty. It appears as soon as it contains a real file, because files do keep their names.'
    : shared +
        'For a CONFIG FILE this is SERIOUS: accounts-service deployVerticals matches on `file.Name`, so an unnamed entry fails the prefix test and the config WILL NOT DEPLOY — silently. Re-write the file and re-check before deploying.';
}

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
  // Files & folders (object store + file index)
  //
  // A write lands in TWO places: the object bucket and the file index. The INDEX is
  // what list_files reads and what the vertical deployer iterates, and indexing is
  // ASYNCHRONOUS — so every write here can wait for the key to actually appear
  // rather than trusting a 200. That is the whole reason these tools exist as more
  // than a fetch wrapper.
  // ---------------------------------------------------------------------------

  // Poll the file index until `key` shows up.
  //
  // Two levels of "indexed", and conflating them produced a FALSE GREEN once
  // already, so they are reported separately:
  //
  //   indexed      — the key is in the index, found via `name` OR by decoding the
  //                  subject. Matching on `name` alone would hang forever on an
  //                  entry whose name is blank, which is common.
  //   name_indexed — the entry also carries a populated `name`. This is the
  //                  stricter bar, and it is the one that matters to CONSUMERS:
  //                  accounts-service deployVerticals matches on `file.Name`, and
  //                  the UI's file tree derives folder paths from it. An entry with
  //                  a blank name is invisible to both.
  //
  // Returns { indexed, name_indexed, waited_ms, entries }.
  async function waitForIndex(spaceId, key, timeoutMs = 60_000) {
    const started = Date.now();
    let entries = 0;
    let indexed = false;
    for (;;) {
      const listed = await client.get('/workspaces/files', { space_id: spaceId });
      const results = listed?.results ?? [];
      entries = results.length;
      const match = results.find((f) => fileKeyOf(f) === key);
      if (match) {
        indexed = true;
        const name_indexed = Boolean(match.name);
        // Keep polling briefly if the key is present but unnamed — the name may
        // still be filling in. Observed permanent for markers, so this is bounded.
        if (name_indexed || Date.now() - started >= timeoutMs) {
          return { indexed, name_indexed, waited_ms: Date.now() - started, entries };
        }
      } else if (Date.now() - started >= timeoutMs) {
        return { indexed, name_indexed: false, waited_ms: Date.now() - started, entries };
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  // ---------------------------------------------------------------------------
  // Reference & validation (no API call)
  // ---------------------------------------------------------------------------

  tool(
    'list_reference_topics',
    'List workspaces reference topics (spaces, tasks, time-tracking, task-actions, contacts, task-templates, meetings, comments, reactions, identifiers, auth, endpoints, files, verticals, gotchas) plus the known spec-vs-engine gotchas. Start here.',
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
    'Validate a workspaces payload locally (no API call). Encodes engine rules: space id ^\\w+$ + uppercasing, status roles, base/organisation records, custom_tab and hidden_tabs, list edits, task title + space, sub-task parent, pipeline fields, identity, comment body-or-reply_id, reaction map shape, RFC3339 dates, time logs, task actions, contacts, task templates, and read-only-field lints. Run before create_*/update_*.',
    {
      kind: z.enum(['space', 'task', 'multi_task', 'comment', 'reaction', 'task_action', 'time_log', 'contact', 'task_template', 'folder', 'file']).describe('Which payload shape to validate. "time_log" = an add_time_log body; "contact" = a create_contact body; "folder" = a create_folder body; "file" = { key, content } for write_file.'),
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
    'Create a space. Requires `id` (^\\w+$, UPPERCASED server-side) and `name`. Give statuses a `role` (todo/working/done, ...) so task actions and flows can move tasks. `editing_disabled: true` locks the space for good. Validated locally first (errors block, warnings reported). Creating an existing id returns 409 "space exists".',
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
    'Update a space (PATCH). Merges the fields you send over the stored space — send only changed fields, built from scratch. A sent statuses/priorities/tags list REPLACES the stored one; use upsert_statuses / remove_statuses (and the priority/tag pairs) to change entries by id. Also takes base_record, organisation_record, modules, custom_tab, hidden_tabs, view. May return 202 when removing a status or priority triggers a background re-assignment. A space with editing disabled answers 403.',
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
    'Delete a space by id (also purges its tasks, comments, and files). Returns { message: "success" }. Irreversible, so it requires confirm: true: one call removes everything the space holds. Cannot delete ESCALATE (403).',
    {
      id: z.string().describe('Space id (uppercased form)'),
      confirm: z.boolean().optional().describe('Must be true. Purges every task, comment and file in the space.'),
    },
    async ({ id, confirm }) => {
      if (confirm !== true) {
        throw new Error(`delete_space purges every task, comment and file in ${id} irreversibly; pass confirm: true to proceed`);
      }
      return client.delete(`/workspaces/space/${encodeURIComponent(id)}`);
    }
  );

  // ---------------------------------------------------------------------------
  // Tasks
  // ---------------------------------------------------------------------------

  tool(
    'list_tasks',
    'List tasks in a space (path {space_id}) with optional filters. Returns { results: [Task], results_total }; each task carries subtasks[] and task_actions[]. There is no is_subtask filter — use exclude_subtasks or parent.',
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
      parent: z.string().optional().describe('Exact: only the sub-tasks of this task id'),
      exclude_subtasks: z.boolean().optional().describe('Drop sub-tasks from the top level (they still appear nested in each parent\'s subtasks[])'),
      folder: z.string().optional().describe('Exact: every task for one contact folder'),
      source: z.string().optional().describe('Exact'),
      currency: z.string().optional().describe('Exact'),
      value: z.string().optional().describe('"min,max", either side optional (e.g. ",5000")'),
      expected_close: z.string().optional().describe('Date or {start},{end} range'),
      external_id: z.string().optional().describe('Exact match on the task\'s external_id'),
    },
    async ({ space_id, ...query }) =>
      client.get(`/workspaces/space/${encodeURIComponent(space_id)}/tasks`, query)
  );

  tool(
    'create_task',
    'Create a task. Requires `title`; `space_id` must name an existing space (omitted -> the ESCALATE space). The `id` is server-generated. due_date/scheduled_at are RFC3339. Omitting `status` takes the space\'s default_status, else its first status. `parent` makes it a sub-task (one level). `identity` (e.g. { email }) links it to the space\'s base record — the task is created even if that fails, and the response then carries `base_record_skipped` with the reason. Only time_tracking.estimate is writable; log time with add_time_log.',
    {
      task: taskPayload,
      skip_local_validation: z.boolean().default(false),
    },
    async ({ task, skip_local_validation }) =>
      withValidation('task', task, true, skip_local_validation, () => client.post('/workspaces/task', task), 'created')
  );

  tool(
    'get_task',
    'Get one task by id. Returns the task plus top-level `watchers[]`, `muted[]` and `task_actions[]`, with time_tracking hydrated (logs, spent, remaining, progress_percent).',
    { id: z.string().describe('Task id') },
    async ({ id }) => client.get(`/workspaces/task/${encodeURIComponent(id)}`)
  );

  tool(
    'update_task',
    'Update one task (PATCH merge). Send only changed fields, built from scratch. Accepts title/description/assignees/priority/status/due_date/scheduled_at/archived/tags/parent/pipeline fields/time_tracking.estimate. `parent: ""` detaches a sub-task; `move_subtasks: true` carries sub-tasks along when space_id or folder changes. Setting archived:true unschedules the task. Do not send time_tracking.logs — it is stored and never read; use add_time_log. Optional if_match (the task `version`) makes the write conditional: a stale value returns 409 version_conflict with the current task.',
    {
      id: z.string().describe('Task id'),
      task: taskPayload,
      if_match: ifMatch,
      skip_local_validation: z.boolean().default(false),
    },
    async ({ id, task, if_match, skip_local_validation }) =>
      withValidation('task', task, false, skip_local_validation, () => client.patch(`/workspaces/task/${encodeURIComponent(id)}`, task, undefined, ifMatchHeader(if_match)), 'updated')
  );

  tool(
    'upsert_task_by_external_id',
    'Create or update a task keyed by YOUR id (PUT /workspaces/space/{space_id}/tasks/external/{external_id}). Body is the same as create_task / update_task; the route owns space_id and external_id, so a body value for either is ignored. Returns 201 with the task when created, 200 when updated. external_id: at most 256 bytes, no "/". Optional if_match (task `version`) guards an update (409 version_conflict). 409 external_id_pending: retry. 410 task_deleted: the id is permanently retired, so use a new one. Needs tasks:write on the space. See get_workspaces_reference("task-sync").',
    {
      space_id: z.string().describe('Space id (uppercased form)'),
      external_id: z.string().describe('Your id for the task; no "/", at most 256 bytes of UTF-8'),
      task: taskPayload,
      if_match: ifMatch,
      skip_local_validation: z.boolean().default(false),
    },
    async ({ space_id, external_id, task, if_match, skip_local_validation }) => {
      const problem = externalIdProblem(external_id);
      if (problem) throw new Error(problem);
      const path = `/workspaces/space/${encodeURIComponent(space_id)}/tasks/external/${encodeURIComponent(external_id)}`;
      return withValidation('task', task, false, skip_local_validation, () => client.put(path, task, undefined, ifMatchHeader(if_match)), 'upserted');
    }
  );

  tool(
    'list_space_changes',
    'Read a space\'s change feed (GET /workspaces/space/{space_id}/changes). Read-only. Returns { events[], next_cursor, has_more, retention_days }; each event carries event_type, origin, changed_fields and the whole task after-state. Page with cursor = the last next_cursor and store it even when events is empty; has_more true means call again. since (RFC 3339) is used only without a cursor. limit 1 to 500, default 100. 410 cursor_expired after 30 days: reconcile with list_tasks. The feed includes your own writes. Needs tasks:read on the space.',
    {
      space_id: z.string().describe('Space id (uppercased form)'),
      cursor: z.string().optional().describe('next_cursor from a previous page; wins over since'),
      since: z.string().optional().describe('RFC 3339 start time; used only when there is no cursor'),
      limit: z.number().int().min(1).max(500).optional().describe('1 to 500, default 100'),
    },
    async ({ space_id, cursor, since, limit }) =>
      client.get(`/workspaces/space/${encodeURIComponent(space_id)}/changes`, { cursor, since, limit })
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
    'Delete a task by id (also purges its comments and reactions). With delete_subtasks: true every sub-task goes too; without it they are left behind. Returns { message: "success" }. Irreversible. Optional if_match (the task `version`) refuses a stale delete with 409 version_conflict.',
    {
      id: z.string().describe('Task id'),
      delete_subtasks: z.boolean().optional().describe('Also delete every sub-task, archived ones included'),
      if_match: ifMatch,
    },
    async ({ id, delete_subtasks, if_match }) =>
      client.delete(`/workspaces/task/${encodeURIComponent(id)}`, delete_subtasks ? { delete_subtasks: 'true' } : undefined, ifMatchHeader(if_match))
  );

  // ---------------------------------------------------------------------------
  // Time logs (handler/task_time_logs.go). The server owns id, user and timestamps.
  // ---------------------------------------------------------------------------

  tool(
    'add_time_log',
    'Log one time entry against a task (PUT /workspaces/task/{task_id}/time-log). Body: { time_spent: { time_in_seconds > 0 }, started_at (RFC3339), description? }. The server mints the id (tl_<random>), stamps the user from the credential and sets created_at — anything you send for those is ignored. Returns the task\'s whole hydrated time_tracking: { estimate?, logs[], spent, remaining?, progress_percent? }. There is no edit or delete for a log.',
    {
      task_id: z.string().describe('Task id'),
      log: jsonValue.describe('{ time_spent: { time_in_seconds }, started_at, description? }'),
      skip_local_validation: z.boolean().default(false),
    },
    async ({ task_id, log, skip_local_validation }) =>
      withValidation('time_log', log, true, skip_local_validation, () => client.put(`/workspaces/task/${encodeURIComponent(task_id)}/time-log`, log), 'logged')
  );

  tool(
    'list_time_logs',
    'List a task\'s time logs (GET /workspaces/task/{task_id}/time-log). Returns { results: [{ id, time_spent, started_at, description?, user: { id, name }, created_at }], results_total }. get_task carries the same logs plus the derived totals.',
    { task_id: z.string().describe('Task id') },
    async ({ task_id }) => client.get(`/workspaces/task/${encodeURIComponent(task_id)}/time-log`)
  );

  // ---------------------------------------------------------------------------
  // Task actions (the per-task checklist). Read back through get_task.
  // ---------------------------------------------------------------------------

  tool(
    'set_task_action',
    'Create or update a checklist action on a task (PUT /workspaces/task/{task_id}/action). Omit `id` to create one (server assigns ta_<random>); pass an existing `id` to address that action. `description` is required on EVERY write, even one that only flips `done`. 404 "task not found" if the task does not exist. THE WRITE MOVES THE TASK STATUS BY ROLE: none done -> the space\'s `todo` status (else default_status), some done -> `working`, all done -> `done` (else the first complete, non-outcome status). Chat actions do not count, an id the space lacks is never written, and with no matching role the status is left alone. The response echoes your request — verify with get_task (`task_actions[]`).',
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
    'Delete a checklist action from a task (DELETE /workspaces/task/{task_id}/action/{id}). Returns { message: "success" }; an unknown id returns 404 "resource not found". Take the id from get_task\'s task_actions[]. The task status is recomputed by role afterwards, as for set_task_action.',
    {
      task_id: z.string().describe('Task id'),
      id: z.string().describe('Action id (ta_<random> unless you supplied one)'),
    },
    async ({ task_id, id }) =>
      client.delete(`/workspaces/task/${encodeURIComponent(task_id)}/action/${encodeURIComponent(id)}`)
  );

  // ---------------------------------------------------------------------------
  // Contacts (handler/client.go). Can enrol the contact as a portal user.
  // ---------------------------------------------------------------------------

  // Which record a profile writes, and whether that write creates a sign-in —
  // mirrors contactWriteRecord + contactLogin.
  function contactPlan(space, profile) {
    const base = space?.base_record?.config_id ? space.base_record : null;
    const organisation = space?.organisation_record?.config_id
      ? space.organisation_record
      : base?.parent_config_id ? { config_id: base.parent_config_id } : null;
    const wanted = String(profile.config_id ?? '').trim();
    if (!base) return { record: 'legacy', config_id: 'Client', sign_in: false };
    const isOrganisation = Boolean(wanted && wanted !== base.config_id && organisation && wanted === organisation.config_id);
    const email = String(profile.email ?? '').trim();
    return {
      record: isOrganisation ? 'organisation_record' : 'base_record',
      config_id: isOrganisation ? organisation.config_id : base.config_id,
      identity_fields: (isOrganisation ? organisation.identity_fields : base.identity_fields) ?? [],
      sign_in: !isOrganisation && base.create_login_on_create === true && email !== '',
    };
  }

  tool(
    'create_contact',
    'Create a contact in a space (POST /workspaces/client): a record keyed on the space\'s base_record identity fields (an upsert — the same person lands on one folder; an existing folder is 409) plus a contact folder. Set config_id to the space\'s organisation_record config to write the FIRM instead. A space with no base_record needs first_name + last_name + email and writes the legacy `Client` config. WARNING — THIS CAN CREATE A PORTAL SIGN-IN: when the space\'s base_record has create_login_on_create: true and the contact has an email, the platform also creates a client-role user for that email. This tool reads the space first and REFUSES that case unless allow_sign_in is true. The response carries login_created / login_skipped.',
    {
      contact: jsonValue.describe('{ space_id, first_name?, last_name?, name?, email?, phone?, address?, dob?, extra_data?, config_id?, parent_folder?, entity_type?, parent_entity? }'),
      allow_sign_in: z.boolean().default(false).describe('Required true when the space enrols contacts (base_record.create_login_on_create) — the write will create a portal login for the email'),
      skip_local_validation: z.boolean().default(false),
    },
    async ({ contact, allow_sign_in, skip_local_validation }) =>
      withValidation('contact', contact, true, skip_local_validation, async () => {
        const space = await client.get(`/workspaces/space/${encodeURIComponent(String(contact.space_id).toUpperCase())}`);
        const plan = contactPlan(space, contact);
        if (plan.sign_in && !allow_sign_in) {
          return {
            created: false,
            plan,
            refused: `Space ${space?.id} has base_record.create_login_on_create: true, so this write would ALSO create a client-role portal sign-in for ${contact.email}. Re-run with allow_sign_in: true if that is intended.`,
          };
        }
        const record = await client.post('/workspaces/client', contact);
        return { ...wrap(record), plan };
      }, 'created')
  );

  // ---------------------------------------------------------------------------
  // Task templates (handler/task_templates.go). task-from-template has no gateway route.
  // ---------------------------------------------------------------------------

  const templatePayload = jsonValue.describe('{ name, description?, vertical?, priority?, tags?[], folder?, reporter?, assignees?[], estimate?: { time_in_seconds }, task_actions?[{ kind: form|document|chat, description, ... }] }. See get_workspaces_reference("task-templates").');

  tool(
    'list_task_templates',
    'List the account\'s task templates (GET /workspaces/task-templates). Returns { results: [TaskTemplate], results_total }.',
    { vertical: z.string().optional().describe('Only templates for this vertical') },
    async ({ vertical }) => client.get('/workspaces/task-templates', { vertical })
  );

  tool(
    'get_task_template',
    'Get one task template by id (tt_<random>).',
    { id: z.string().describe('Template id') },
    async ({ id }) => client.get(`/workspaces/task-template/${encodeURIComponent(id)}`)
  );

  tool(
    'create_task_template',
    'Create a task template (POST /workspaces/task-template). `name` is required and becomes the new task\'s title. Seeds priority, tags, folder, reporter, assignees, estimate and task_actions onto a task made from it — never status or due date. Note: creating a task FROM a template is not reachable through the API gateway; the web app and assistants do it.',
    { template: templatePayload, skip_local_validation: z.boolean().default(false) },
    async ({ template, skip_local_validation }) =>
      withValidation('task_template', template, true, skip_local_validation, () => client.post('/workspaces/task-template', template), 'created')
  );

  tool(
    'update_task_template',
    'Update a task template (PATCH). tags, assignees and task_actions REPLACE the stored value whole. Any `id` inside `template` is dropped: the server lets a body id override the path id.',
    { id: z.string().describe('Template id'), template: templatePayload, skip_local_validation: z.boolean().default(false) },
    async ({ id, template, skip_local_validation }) => {
      const isObj = template && typeof template === 'object' && !Array.isArray(template);
      const body = isObj ? Object.fromEntries(Object.entries(template).filter(([k]) => k !== 'id')) : template;
      return withValidation('task_template', body, false, skip_local_validation, () => client.patch(`/workspaces/task-template/${encodeURIComponent(id)}`, body), 'updated');
    }
  );

  tool(
    'delete_task_template',
    'Delete a task template. Tasks already created from it are unaffected.',
    { id: z.string().describe('Template id') },
    async ({ id }) => client.delete(`/workspaces/task-template/${encodeURIComponent(id)}`)
  );

  // ---------------------------------------------------------------------------
  // Meetings (workspaces-service/handler/meetings.go, recall-service transcript).
  // ---------------------------------------------------------------------------

  tool(
    'list_meetings',
    'List meeting files a notetaker filed into a space (GET /workspaces/meetings). One entry per FILE — video, audio, transcript, summary — each { space_id, folder, file_type, recording_id, bot_id, title, created_at, created_by, file: { name, size, mtime } }. An empty list is not proof there are none: the server answers 200 with no results when the meetings index fails.',
    {
      space_id: z.string().describe('Space id'),
      folder: z.string().optional().describe('Exact folder'),
      file_type: z.enum(['video', 'audio', 'transcript', 'summary']).optional(),
      recording_id: z.string().optional(),
      bot_id: z.string().optional(),
      created_by: z.string().optional().describe('User id'),
      title: z.string().optional().describe('Term search'),
      created_at: z.string().optional().describe('Date or {start},{end} range'),
      limit: z.number().int().optional(),
      offset: z.number().int().optional(),
      sort_by: z.string().optional(),
      sort_order: z.enum(['asc', 'desc']).optional(),
    },
    async (query) => client.get('/workspaces/meetings', query)
  );

  tool(
    'get_meeting_transcript',
    'Read one meeting\'s transcript as text ("[mm:ss – mm:ss] Speaker: words" per turn). Finds the recording\'s transcript entry in the space and reads that file. Falls back to GET /recall/recording/{id}/transcript, which only answers the user who recorded the meeting.',
    {
      space_id: z.string().describe('Space id the meeting was filed into'),
      recording_id: z.string().describe('recording_id from list_meetings'),
    },
    async ({ space_id, recording_id }) => {
      const listed = await client.get('/workspaces/meetings', { space_id, recording_id, file_type: 'transcript' });
      const entry = (listed?.results ?? []).find((m) => m?.file?.name);
      let fileError = entry ? null : 'no transcript entry for this recording in the space: not indexed, or the meetings index did not answer';
      if (entry) {
        try {
          const file = await client.readObject(RECALL_BUCKET, entry.file.name);
          return { recording_id, title: entry.title, source: `${RECALL_BUCKET}/${entry.file.name}`, transcript: file.content };
        } catch (err) {
          fileError = err.message;
        }
      }
      try {
        const structured = await client.get(`/recall/recording/${encodeURIComponent(recording_id)}/transcript`);
        return { recording_id, title: entry?.title, source: 'recall get.transcript', transcript: structured };
      } catch (err) {
        err.message = `${err.message} (file read: ${fileError}; the recall route answers only the user who recorded the meeting)`;
        throw err;
      }
    }
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

  tool(
    'list_files',
    'List a space\'s files and folders from the FILE INDEX — the same source vertical deployment iterates, so this is the authoritative "what is actually there". Keys are dotted (spaces.<SPACE_ID>.<folder>...<name>.<ext>). Folder markers (__meta__.json) appear as entries; that is how folders are stored. IMPORTANT: an entry\'s `name` can be EMPTY while its `subject` is correct, so this tool adds a resolved `key` to every entry (decoded from the subject, the same fallback the engine\'s own delete path uses) — read `key`, not `name`. Indexing lags writes, so a file written seconds ago may not be here yet.',
    {
      space_id: z.string().describe('Space id, e.g. "VERTICAL" (uppercased server-side)'),
      subfolder: z.string().optional().describe('Restrict to a dotted subfolder path, e.g. "financial_advisor.flows"'),
      search: z.string().optional().describe('Case-insensitive substring match on the file name. NOTE the engine matches on the stored `name`, so an entry with an empty name cannot be found this way — omit `search` and filter on the resolved `key` instead.'),
      exact: z.boolean().optional().describe('Treat `search` as an exact match rather than a substring'),
    },
    async ({ space_id, subfolder, search, exact }) => {
      const listed = await client.get('/workspaces/files', { space_id, subfolder, search, exact });
      const results = (listed?.results ?? []).map((entry) => ({
        ...entry,
        key: fileKeyOf(entry),
        ...(entry?.name ? {} : { name_missing: true }),
      }));
      const nameless = results.filter((r) => r.name_missing).length;
      return {
        ...listed,
        results,
        ...(nameless
          ? {
              note: `${nameless} of ${results.length} entries have an EMPTY name; their \`key\` was decoded from the subject. Use \`key\`. This is a known state the engine handles the same way (transform.ObjKeyUnsafe), and it is why \`search\` cannot find these entries.`,
            }
          : {}),
      };
    }
  );

  tool(
    'create_folder',
    'Create a folder in a space. A folder is not a directory: this writes a single marker object at <path>.__meta__.json, and the UI derives the tree from the keys — so a new folder correctly renders EMPTY. Send space_id + folder (+ subfolder for a parent path), OR full_path. NOTE `subfolder` is the PARENT prefix, not a child: {space_id:"VERTICAL", subfolder:"my_vertical", folder:"flows"} creates spaces.VERTICAL.my_vertical.flows. The engine returns no body, so this reads the index back to confirm. Re-runnable: an existing folder returns 409 server-side and is reported here as `already_existed: true` rather than an error, so building a tree twice is safe.',
    {
      space_id: z.string().optional().describe('Space id, e.g. "VERTICAL". Required unless full_path is given.'),
      folder: z.string().optional().describe('The folder name — a single dot-free segment. Required unless full_path is given.'),
      subfolder: z.string().optional().describe('PARENT path under the space, dotted for depth, e.g. "my_vertical" or "my_vertical.sub"'),
      full_path: z.string().optional().describe('Complete dotted path instead of space_id+folder, e.g. "spaces.VERTICAL.my_vertical.flows". Do not combine with space_id/folder.'),
      metadata: jsonValue.optional().describe('Extra folder metadata. Values must all be STRINGS (engine field is map[string]string). created_at/created_by are set by the engine.'),
      wait_for_index: z.boolean().optional().describe('Poll the file index until the marker appears (default true). Indexing is async; false returns as soon as the write succeeds.'),
      skip_local_validation: z.boolean().optional().describe('Skip the local validator'),
    },
    async ({ space_id, folder, subfolder, full_path, metadata, wait_for_index = true, skip_local_validation }) => {
      const payload = {};
      if (space_id !== undefined) payload.space_id = space_id;
      if (folder !== undefined) payload.folder = folder;
      if (subfolder !== undefined) payload.subfolder = subfolder;
      if (full_path !== undefined) payload.full_path = full_path;
      if (metadata !== undefined) payload.metadata = metadata;

      return withValidation('folder', payload, true, skip_local_validation, async () => {
        // Rebuild the key the engine will have written, so we can look for it.
        const base = full_path && full_path !== ''
          ? full_path
          : `spaces.${String(space_id).toUpperCase()}${subfolder ? '.' + subfolder : ''}.${folder}`;
        const markerKey = `${base}.__meta__.json`;
        const spaceId = spaceIdOfKey(base);

        // 409 "folder exists" is treated as SUCCESS, not an error: building a
        // vertical's tree is inherently re-runnable, and a push that dies on the
        // second attempt is useless. The post-condition — the folder is there — is
        // satisfied either way, and it is still confirmed against the index below.
        let response;
        let already_existed = false;
        try {
          response = await client.post('/workspaces/files/folder', payload);
        } catch (err) {
          if (err?.status !== 409) throw err;
          already_existed = true;
          response = { message: 'folder exists (409) — treated as success; nothing was changed' };
        }

        if (!wait_for_index) {
          return { response, already_existed, folder_path: base, marker_key: markerKey, verified: false, note: 'wait_for_index was false — nothing has been confirmed. The engine returns no body, so this is the write response only.' };
        }
        const verification = await waitForIndex(spaceId, markerKey);
        return {
          response,
          already_existed,
          folder_path: base,
          marker_key: markerKey,
          verified: verification.indexed,
          visible_in_ui: verification.name_indexed,
          verification,
          note: indexNote(verification, markerKey, { isMarker: true }),
        };
      }, 'created');
    }
  );

  tool(
    'read_file',
    'Read one file\'s CONTENT by its dotted key. Text for .json/.md/.txt/.yaml/.csv/.html/.svg keys, base64 otherwise (a vertical document_templates folder holds .docx). This hits the object store, which is a different URL root from /workspaces/* and is absent from the gateway route registry. Reading back is how you verify a write — never trust the write response alone.',
    {
      key: z.string().describe('Full dotted object key, e.g. "spaces.VERTICAL.financial_advisor.spaces.fahub.json"'),
      bucket: z.string().optional().describe('Object bucket (default microstrate-workspaces — the space files bucket; meeting files live in microstrate-recall-files)'),
    },
    async ({ key, bucket }) => client.readObject(bucket || WORKSPACES_BUCKET, key)
  );

  tool(
    'write_file',
    'Write a config file into a space folder. Uploads the bytes, verifies the returned SHA-256 digest against the content locally, and then polls the FILE INDEX until the key appears — because a file present in the bucket but absent from the index is invisible to vertical deployment. Creating the containing folder first is not required for the write, but is needed for the tree to render. For a vertical config the validator also checks the category folder routes, that an assistants config is { config: {...} }-wrapped, and that record_configs/record_config_ids agree.',
    {
      key: z.string().describe('Full dotted object key, e.g. "spaces.VERTICAL.my_vertical.spaces.myhub.json". No dots inside a name segment.'),
      content: z.string().describe('File content as a string. Stringify JSON before sending.'),
      bucket: z.string().optional().describe('Object bucket (default microstrate-workspaces)'),
      wait_for_index: z.boolean().optional().describe('Poll the file index until the key appears (default true). Indexing is async.'),
      skip_local_validation: z.boolean().optional().describe('Skip the local validator'),
    },
    async ({ key, content, bucket, wait_for_index = true, skip_local_validation }) =>
      withValidation('file', { key, content }, true, skip_local_validation, async () => {
        const entry = await client.writeObject(bucket || WORKSPACES_BUCKET, key, content);

        // The store returns a digest over the bytes it stored. digestMatches
        // normalises both sides (base64url alphabet, padding stripped) — comparing
        // raw strings passed for the wrong reason on the first file tested.
        const digest_ok = digestMatches(content, entry?.digest);
        const expected = expectedDigestString(content);

        const result = {
          entry,
          digest_verified: digest_ok,
          ...(digest_ok
            ? {}
            : { digest_mismatch: { expected, returned: entry?.digest ?? null }, warning: 'The stored digest does not match a SHA-256 of what was sent — the bytes on the platform are NOT what you wrote. Read the file back before doing anything else.' }),
        };

        if (!wait_for_index) {
          return { ...result, verified: false, note: 'wait_for_index was false — the bytes are stored but nothing confirms the file is in the index yet.' };
        }
        const verification = await waitForIndex(spaceIdOfKey(key), key);
        const routing = verticalRouting(key);
        return {
          ...result,
          // A config whose index entry has no `name` is skipped by deployVerticals,
          // so "indexed" alone is not good enough to call a write verified.
          verified: verification.name_indexed && digest_ok,
          // will_deploy has to answer BOTH questions deployVerticals asks: is the
          // index entry named, AND is the category one of the six routing keys. It
          // used to report only the first, so a file in a MISSPELLED category folder
          // (`flow/`, `record_config/`) came back will_deploy=true and then deployed
          // nothing, silently — the exact failure this field exists to catch. It also
          // claimed true for specs/, which never deploys by design.
          will_deploy: verification.name_indexed && routing.deploys,
          ...(routing.reason ? { will_deploy_reason: routing.reason } : {}),
          verification,
          note: indexNote(verification, key),
        };
      }, 'written')
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
}

// ---------------------------------------------------------------------------

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(
      `[quiva-workspaces-mcp] Node ${process.versions.node} is too old — requires Node >= 18 (global fetch). Launch via bin/run.sh or set QUIVA_NODE.`
    );
    process.exit(1);
  }
  const client = QuivaClient.fromEnv();
  if (!client.hasCredentials()) {
    console.error(
      '[quiva-workspaces-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD). API tools will fail until one is set.'
    );
  }
  const server = new McpServer({ name: 'quiva-workspaces', version: '0.1.0' }, { instructions });
  registerTools(server, client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[quiva-workspaces-mcp] ready — API: ${client.baseUrl}`);
}

// Importing this module must have no side effects (no connecting, no env
// reads) — only run the stdio bootstrap when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[quiva-workspaces-mcp] fatal:', err);
    process.exit(1);
  });
}
