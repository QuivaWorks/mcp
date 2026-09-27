// Workspaces reference data — derived from the workspaces-service engine source
// (workspaces-service/handler/*.go, model/api.go, service/service.go,
// response/response.go) and recall-service, NOT just the OpenAPI spec
// (quiva-workspace.json). Where the spec and engine disagree, the engine wins
// and the discrepancy is captured in GOTCHAS.

// Gotchas: spec-vs-engine truths the validator lints and the tools encode.
export const GOTCHAS = [
  // Response envelope.
  'Every workspaces-service response is wrapped in `{ "status_code": N, "body": {...} }` (response/response.go). This MCP unwraps the envelope and returns the inner `body`. Errors carry the message under `body.error`.',
  // Delete shape.
  'Deletes do NOT return 204/no-body as the spec claims. delete_space / delete_task / delete_comment all return `{ "message": "success" }` with status_code 200. delete_comment is a SOFT delete (the comment is poison-pilled, not hard-removed).',
  // Space id semantics.
  'create_space requires `id` (the spec example omits it — that example would 400). The id must match `^\\w+$` (letters, numbers, underscore ONLY — no spaces or hyphens) and is UPPERCASED server-side: id "q2_mktg" is stored and referenced as "Q2_MKTG", and task ids/URLs use the uppercased form. Creating an id that already exists returns 409 "space exists".',
  // Task id + space linkage.
  'Task ids are SERVER-GENERATED — any `id` you send on create_task is ignored. `space_id` is trimmed and uppercased, the space MUST already exist (else 400 "space not found"), and the task id becomes `{SPACEID}-{n}` from a per-space counter (`t_<nanoid>` only if the counter fails). An omitted or blank `space_id` now resolves to the built-in ESCALATE space, not a "default" space (workspaces-service/handler/tasks.go resolveCreateSpaceID). Comment ids are `c_<nanoid>`.',
  // Update verb + merge semantics.
  'Updates are PATCH, not PUT (registered under the `patch` route group; the PUT routes are task-action, task-time-log and task-event-schedule). A space\'s `statuses`, `priorities` and `tags` REPLACE the stored list when sent, so a caller working from a partial read deletes by omission — use `upsert_statuses` / `remove_statuses` (and the priority/tag pairs) to edit by id instead. update_space and update_comment merge the fields you send over the stored record; update_task is a DeepMerge of the fields you send. Send only the fields you want to change — but ALWAYS construct minimal payloads from scratch: do NOT echo back nested objects (statuses, assignees) copied from a GET response.',
  // 202 async priority migration (masked by envelope unwrap).
  'update_space can return 202 (not 200) when you REMOVE a priority that tasks still reference: the space is updated immediately and a background job re-assigns those tasks onto the fallback priority (the default, or the first remaining). Verified live: the affected tasks are re-assigned a few seconds later. CAVEAT: this MCP unwraps the { status_code, body } envelope, so the tool result cannot distinguish 202 from 200 — confirm a migration by re-reading the affected tasks, not by the status code.',
  // updateMultiTask response shape.
  'update_multi_task (PATCH /workspaces/tasks) returns an OBJECT keyed by the task position in the request array — `{ "0": {task}, "1": {task} }` — NOT an array (the spec is wrong). If ANY task fails the whole call returns status 400 with per-index `{ "error": ... }` entries mixed in alongside the successes.',
  // Reaction response shape.
  'react_to_comment (POST .../reaction) returns only `{ "reactions": { "<emoji>": { count, users } } }` — NOT the full comment (the spec is wrong). The reaction map is `{ "<emoji>": true|false }` (true = add, false = remove). THE KEY MUST BE THE EMOJI CHARACTER ITSELF: it is stored verbatim and rendered as-is, and nothing converts a shortcode name into a glyph — `{ "eyes": true }` stores the literal string "eyes" and renders as a broken reaction, while `{ "\u{1F440}": true }` renders. Verified live 2026-07-30 (this MCP\'s own example shipped the shortcode form and had to be fixed on staging). Colons in a key are stripped server-side. An API KEY is sufficient and the reaction is attributed to the account the key resolves to — an earlier note here claiming a Bearer JWT was required, else the reaction is keyed to an empty user id, was wrong.',
  // Missing task fields.
  'The engine Task supports fields the spec omits: `archived`, `scheduled_at`, `order`, `tags`, `metadata`, `time_tracking.estimate`, `parent` (sub-tasks), and the pipeline fields `source`, `source_detail`, `value`, `currency`, `expected_close` (model/api.go Task). Setting `archived: true` unschedules the task; setting `scheduled_at` schedules a background job.',
  // Default status on create (#1281, then #1436).
  'create_task with no `status` takes the space\'s `default_status`; when the space has no default (or names one it does not contain) it takes the space\'s FIRST status (#1436, handler/tasks.go statusForCreate -> space_lists.go statusMigrationTarget). Only an empty status list still stores "". A status you DO send is written through unvalidated — nothing checks it against the space.',
  // Time logs moved to a subresource (#1292).
  'Time is logged through add_time_log (PUT /workspaces/task/{id}/time-log), one entry per call. The server mints the log id (`tl_<random>`), stamps the user from the JWT and sets created_at/updated_at. The task stores only `time_tracking.estimate`; `logs`, `spent`, `remaining` and `progress_percent` are hydrated server-side on every task read and write (handler/task_time_logs.go, tasks.go hydrateTimeTracking). Sending `time_tracking.logs` through update_task is stored and never read, and logs written inline before #1292 are invisible now — there was no migration.',
  // Task actions move the task status by role.
  'Writing or deleting a task action RECOMPUTES the task status from its actions, by status ROLE: none done -> the `todo` role (else default_status), some done -> `working`, all done -> `done` (else the first complete, non-outcome status). Chat actions do not count, and an id the space lacks is never written — no role means the status is left alone (handler/task_actions.go resolveTaskStatusFromActions). Give a space roles if you want checklists to drive its board. get_task returns `task_actions[]`; GET /workspaces/task/{id}/action now returns the list too on staging (verified 2026-09-27).',
  // Date formats.
  'due_date and scheduled_at are parsed as RFC3339 date-times on read (model/api.go Task.UnmarshalJSON), NOT plain "YYYY-MM-DD". A date-only value can fail to round-trip through GET — send a full RFC3339 timestamp like "2024-06-15T00:00:00Z".',
  // GetTask extra fields.
  'get_task returns the task PLUS top-level `watchers: []` and `muted: []` arrays (the user ids watching/muting the task). These are not part of the spec Task schema.',
  // Escalations space.
  'list_spaces always includes a built-in space `{ id: "ESCALATE", name: "Escalations" }` that is injected by the engine. It cannot be updated or deleted (both return 403). Do not try to manage it.',
  // Auth reality.
  'Core space/task/comment CRUD works with an API key alone, and REACTIONS are attributed correctly with a key too (verified live 2026-07-30: the reaction came back keyed to the account the API key resolves to, contradicting an earlier note here). Attribution fields on other resources (space `owner`, task `created_by`, comment `author`) still appear to need a Bearer JWT. Prefer bearer/email auth. (The my-tasks / watch / mute / export endpoints are Bearer-only 401, but they are not exposed by this MCP.)',
  // Files: dotted paths, and the marker rename that a source read gets wrong.
  'Space FILES are addressed by a DOTTED path — `spaces.<SPACE_ID>.<folder>.<subfolder>.<name>.<ext>`. `.` is the hierarchy separator, so no single name segment may contain one. A FOLDER is not a directory: it is a marker object at `<path>.<marker>.json` holding only `{created_at, created_by}`, and the marker filename was RENAMED from `metadata.json` to `__meta__.json` (evari-olympus 3a7ab968b "Files refactor signature approvals metadata" #1291, 2026-07-31; the frontend agrees — folder-metadata.utils.ts FOLDER_METADATA_FILENAME). Watched happen live: VERTICAL markers read as `metadata.json` early on 2026-07-31 and as `__meta__.json` an hour later, so existing markers were MIGRATED in place, not left behind. Write `__meta__.json`, but keep accepting `metadata.json` — accounts-service still skips both suffixes, and an unmigrated space may still hold the old name. A checkout predating the rename gives the WRONG answer straight from the handler source, which is why this was caught by writing a folder and looking, not by reading files.go.',
  // Files: an index entry's name can be blank. This one silently breaks polling.
  'A file-index entry\'s `name` is frequently EMPTY while its `subject` is correct, and this is NOT confined to migrated data — measured live 2026-07-31 across the VERTICAL space: 16 of 21 FOLDER MARKERS had a blank name, and 0 of 8 CONFIG FILES did. Three of eight markers created in a single fresh run came back blank, so it is a race in the folder-create indexing path, not a one-off migration artefact, and it is PERMANENT — re-listing minutes later does not fill it in. (An earlier note here claimed freshly created markers kept their name. That was wrong.) CONSEQUENCES, which differ by kind: for a FOLDER it is cosmetic but visible — accounts-service skips markers regardless so deployment is fine, but the UI file tree builds folder paths from `name`, so an EMPTY folder whose marker is unnamed DOES NOT APPEAR in the Files tab; it shows up as soon as it holds a real file, since files keep their names. For a CONFIG FILE it would be serious: deployVerticals matches on `file.Name`, so an unnamed config fails the prefix test and silently never deploys. THE SUBJECT IS THE AUTHORITATIVE KEY: it is `ms.workspace-files.` followed by one base64 RawStdEncoding segment per path segment, and the engine itself decodes it in exactly this situation (DeleteFolderHandler falls back to transform.ObjKeyUnsafe when Name is ""). Consequences: anything matching on `name` will not see those folders at all — a poll-until-indexed loop keyed on `name` waits forever for a key that is already present — and the `search` query param matches the stored name, so it cannot find them either. list_files therefore adds a resolved `key` to every entry; read `key`, not `name`. Deployment is NOT affected: an empty name fails both the marker-suffix and the vertical-prefix test in deployVerticals, so those entries are skipped, which is what should happen to a marker anyway.',
  // Files: the two sinks, and the async index. This is the operational trap.
  'A file write has TWO sinks: the object BUCKET and the file INDEX. `GET /workspaces/files` lists the INDEX, and so does the vertical deployer (accounts-service deployVerticals), so a file present in the bucket but missing from the index is readable by key and invisible to everything that matters. Writing an object DOES self-register — you do not need `/workspaces/files/file-record` (the UI never calls it; that route and `/sync-files` are repair paths). BUT INDEXING IS ASYNCHRONOUS: verified live twice, a config object was absent from the index at t+1s and present at t+16s, and a nested folder took minutes. create_folder also returns NO body at all (`response.Success(request)`). So "written" means "appears in the index" — poll for it; never write and immediately act on it.',
  // Files: deletes are deliberately not exposed.
  'DELETE of a file or folder is deliberately NOT exposed by this MCP, because it has never been exercised — and `delete_workflow` in the flows MCP silently orphaned every draft it "deleted" while returning success (docs/lessons.md). From the source only, therefore UNVERIFIED: params go in the QUERY STRING not the body (`?space_id=&folder=&subfolder=`), it is RECURSIVE over everything nested, it is a SOFT delete (each object is copied to a trash bucket, then removed, then unindexed), it hard-requires a Bearer JWT (`helper.GetAuthToken` failure is a 401, unlike create which tolerates its absence), and a partial failure returns 400 while KEEPING whatever it already deleted. Delete by hand if you must, then verify by re-listing rather than trusting the response.',
  // Contacts can enrol a person.
  'create_contact (POST /workspaces/client) can CREATE A PORTAL SIGN-IN: when the space\'s `base_record.create_login_on_create` is true and the contact has an email, the handler also creates a `client`-role user for that address (handler/contact_login.go). Check the space first, and use an obviously fake example.com address for any test. The response reports `login_created` / `login_skipped`.',
  // Foreign endpoint.
  'list_users hits /accounts/users/list — that is the ACCOUNTS service (microstrate.accounts.get.list-users-by-account), not workspaces. It is included only to resolve user ids for assignees/reporters. It returns `{ data: [ {id, email, first_name, last_name, role, ...} ] }`.',
  // Meetings index failure is a 200.
  'An empty list_meetings (or "no transcript entry" from get_meeting_transcript) means not indexed, or the meetings index did not answer: workspaces-service/handler/meetings.go:78-84 answers 200 with no results when the index query fails.',
];

// Task priority is free-form on the wire (no server-side enum); these are the
// conventional values used across the product UI.
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// Update payloads must be built from scratch (never copied from a GET). These
// are the fields UpdateSpaceRequest / UpdateTaskRequest read (model/api.go).
const SPACE_UPDATE_FIELDS = [
  'name', 'description', 'default_status', 'statuses',
  'record_configs', 'record_config_ids', 'default_record_config_id',
  'priorities', 'tags', 'logo', 'logo_bg_color', 'default_view',
  'records', 'tasks', 'files',
  'base_record', 'organisation_record',
  'modules', 'custom_tab', 'hidden_tabs', 'view',
  'upsert_statuses', 'remove_statuses',
  'upsert_priorities', 'remove_priorities',
  'upsert_tags', 'remove_tags',
];
const TASK_UPDATE_FIELDS = [
  'title', 'description', 'assignees', 'attachments', 'priority', 'folder',
  'reporter', 'status', 'space_id', 'due_date', 'scheduled_at', 'order',
  'archived', 'tags', 'time_tracking', 'parent', 'move_subtasks',
  'source', 'source_detail', 'value', 'currency', 'expected_close', 'suppress_events',
];

// Roles a status may carry (model/api.go StatusRole). Automation resolves a
// role, never a literal id; terminal roles must sit on a `complete` status.
const STATUS_ROLES = ['intake', 'acknowledged', 'working', 'won', 'lost', 'expired', 'todo', 'done'];
const TERMINAL_STATUS_ROLES = ['won', 'lost', 'expired', 'done'];

// Built-in tabs a space may hide (model/api.go spaceTabs). `overview` cannot be hidden.
const SPACE_TABS = ['tasks', 'chats', 'meetings', 'overview', 'records', 'schedule', 'files', 'entities', 'distribution', 'underwriting', 'custom'];
const SPACE_MODULES = ['files', 'tasks', 'records', 'chats', 'meetings'];

// An add_time_log body. id, user, created_at and updated_at are server-owned.
const TIME_LOG_EXAMPLE = {
  time_spent: { time_in_seconds: 5400 },
  started_at: '2026-07-29T09:00:00Z',
  description: 'Drafted the checklist and circulated it for comments',
};

// What task.time_tracking carries on a WRITE: the estimate and nothing else.
const TIME_TRACKING_EXAMPLE = {
  estimate: { time_in_seconds: 7200 },
};

const TASK_ACTION_EXAMPLE = {
  id: 'ta_confirm_source_figures',
  description: 'Check the source before quoting any figure in the summary',
  done: false,
  resources: [
    {
      resource_id: 'project_brief',
      resource_type: 'record-config',
      metadata: { note: 'record the checked source here' },
    },
  ],
};

const CREATE_SPACE_EXAMPLE = {
  id: 'Q2_MKTG',
  name: 'Q2 Marketing Campaign',
  description: 'All marketing activities for Q2',
  default_status: 'to_do',
  statuses: [
    { id: 'to_do', name: 'To Do', color: '#cccccc', order: 1, is_visible: true, complete: false, role: 'todo' },
    { id: 'in_progress', name: 'In Progress', color: '#0052cc', order: 2, is_visible: true, complete: false, role: 'working' },
    { id: 'done', name: 'Done', color: '#36b37e', order: 3, is_visible: true, complete: true, role: 'done' },
  ],
};

const CREATE_TASK_EXAMPLE = {
  title: 'Draft the launch announcement',
  description: 'First draft for review by the operations manager',
  space_id: 'Q2_MKTG',
  priority: 'high',
  status: 'to_do',
  assignees: ['00000000-0000-0000-0000-000000000000'],
  due_date: '2026-10-15T00:00:00Z',
};

const UPDATE_TASK_EXAMPLE = {
  status: 'in_progress',
  priority: 'high',
  assignees: ['00000000-0000-0000-0000-000000000000'],
};

// A create_contact body for a space whose base_record keys on email.
const CREATE_CONTACT_EXAMPLE = {
  space_id: 'Q2_MKTG',
  first_name: 'Sam',
  last_name: 'Example',
  email: 'sam.example@example.com',
  phone: '+10000000000',
};

const TASK_TEMPLATE_EXAMPLE = {
  name: 'New supplier onboarding',
  description: 'Collect the supplier details and confirm the contract terms',
  priority: 'medium',
  tags: ['onboarding'],
  estimate: { time_in_seconds: 3600 },
  task_actions: [
    { kind: 'form', description: 'Complete the supplier details form', configs: [{ id: 'supplier_details' }] },
  ],
};

// --- Files, folders, and the vertical template space ------------------------

// The shared space holding per-vertical template configs.
// accounts-service/data/const.go VerticalSpaceID.
const VERTICAL_SPACE_ID = 'VERTICAL';

// A folder marker object. `__meta__.json` is current (evari-olympus 3a7ab968b,
// 2026-07-31); `metadata.json` is what folders created before that day carry.
// Both are live in the same space, and accounts-service skips BOTH suffixes when
// deploying (updateaccount.go), so neither is ever treated as a config.
const FOLDER_MARKERS = ['__meta__.json', 'metadata.json'];

// The ONLY six folder names accounts-service will deploy from, and the endpoint
// each is forwarded to. Transcribed from accounts-service/accounts/updateaccount.go
// (`configTypeToEndpointSubject`), so it is a WARNING not an error when a folder
// name is not on this list — the list can grow upstream without us noticing.
const VERTICAL_CONFIG_TYPES = {
  assistants: 'microstrate.hub.post.agent',
  flows: 'microstrate.hub.post.workflow',
  record_configs: 'microstrate.records.post.config',
  document_templates: 'microstrate.file-generator.post.template',
  meeting_templates: 'microstrate.recall.post.summarization-template',
  spaces: 'microstrate.workspaces.post.space',
};

// Folders we put in a vertical ON PURPOSE that accounts-service does not deploy.
// They reach the dispatch loop and fall out at the config-type lookup, which is
// the intended outcome — so they must NOT be reported as an accidental typo, and
// the golden gate must not treat them as an unknown category.
//
// `specs` holds the markdown brief a vertical was built from. It is documentation
// that travels with the vertical, not configuration.
const VERTICAL_NON_DEPLOYING_FOLDERS = ['specs'];

const REFERENCE = {
  'spaces': {
    summary:
      'A space (workspace) holds tasks and configurable statuses. create_space requires `id` (^\\w+$, uppercased server-side) and `name`. update_space is a PATCH merge — send only changed fields, constructed from scratch. A sent `statuses`/`priorities`/`tags` list REPLACES the stored one; the `upsert_*`/`remove_*` fields edit by id instead.',
    create_required: ['id', 'name'],
    id_rule: 'id must match ^\\w+$ (letters, numbers, underscore only) and is UPPERCASED server-side.',
    update_fields: SPACE_UPDATE_FIELDS,
    status_shape: '{ id, name, color?, order?, complete, is_visible?, role? }',
    status_roles: {
      values: STATUS_ROLES,
      meaning:
        'A role is the machine-addressable meaning of a status; automation (task actions, flows) resolves the role, never a literal id, so the id/name/colour stay free to change. `todo` and `done` are the two ends of a plain workflow; `working` is in progress; `intake`/`acknowledged` are pipeline entry stages; `won`/`lost`/`expired` are OUTCOMES a person or the clock decides.',
      rules: [
        'Keep each role unique within a space — a duplicate resolves to the first status in order.',
        'A terminal role (won, lost, expired, done) belongs on a status with `complete: true`.',
        'On update, an omitted `role` KEEPS the stored one (carryStatus); send `"role": ""` to clear it.',
        'Nothing validates roles server-side, so these are validator warnings.',
      ],
      source: 'workspaces-service/model/api.go StatusRole / SpaceStatus; handler/space_lists.go carryStatus',
    },
    list_edits: {
      fields: ['upsert_statuses', 'remove_statuses', 'upsert_priorities', 'remove_priorities', 'upsert_tags', 'remove_tags'],
      semantics:
        'Applied after any full list you send: replace, then upsert by id (adds or updates, never removes), then remove by id. Fields an upserted entry omits (name, colour, icon, role) are carried from the stored entry. Update-only — model.Space has no such fields, so create_space ignores them. Removing a status or priority tasks still use can return 202 while a background job re-assigns them.',
      source: 'workspaces-service/handler/spaces.go UpdateSpaceHandler; handler/space_lists.go applyListEdits',
    },
    base_record: {
      what:
        'The entity a space\'s tasks and contacts are tracked against — the PERSON (client). `organisation_record` is the FIRM they hang off. Each keys on its own identity fields, so two people at one firm stay two records and one firm stays one.',
      shape:
        '{ config_id, identity_fields[], display_fields?[], label?, create_login_on_create (client only), enable_distribution (organisation only), config_icon?, parent_config_id?, parent_label?, parent_config_icon? }',
      identity_fields: 'Tried in order; the first with a value keys the record, and records-service derives the contact folder from config_id + that value.',
      display_fields: 'Fields that together NAME a record, joined by a space. Safe to change; they key nothing.',
      create_login_on_create:
        'CLIENT record only. When true, create_contact also creates a `client`-role portal sign-in for the contact\'s email. Off unless you ask for it.',
      enable_distribution: 'ORGANISATION record only. When true, creating a firm also grants it distribution.',
      no_omitempty: 'Both flags are sent even when false, so turning one off sticks — an absent key would keep the stored value.',
      legacy_parent: '`parent_config_id` / `parent_label` on base_record is the older way to name the organisation. A space with no organisation_record reads it as one. Prefer organisation_record.',
      legacy_config_ids: 'Read-compat ids, carried server-side on update. Do not send them.',
      source: 'workspaces-service/model/api.go BaseRecord; handler/client.go; handler/contact_login.go',
    },
    modules: '{ files?, tasks?, records?, chats?, meetings? } — booleans switching each module on or off.',
    custom_tab: {
      what: 'The space\'s own tab of card buttons: `{ name?, cards: [{ config_id, action: "create"|"list", label?, icon?, order?, view?, product_id?, detail?: "form"|"lifecycle", actions?[], on_submit?[] }] }`.',
      refused_server_side: [
        'a card with no config_id or no action, or an action other than create/list',
        'detail other than form/lifecycle',
        'view, detail or actions on a create card',
        'two cards with the same product_id + config_id + action + view',
      ],
      clearing: '`{ "cards": [] }` clears the tab (cards has no omitempty).',
      source: 'workspaces-service/model/api.go CustomTab / ValidateDisplay',
    },
    hidden_tabs: {
      values: SPACE_TABS,
      rule: 'Built-in tabs this space does not offer. `overview` can never be hidden, and an unknown key is refused (400). Sending the list replaces it whole; `[]` offers every tab again.',
      source: 'workspaces-service/model/api.go ValidateHiddenTabs',
    },
    view: 'Board card layout: `{ tasks: { board: { card: { fields: { title, task_id, priority, assignees, tags, subtasks_progress, actions_progress } } } } }`, each `{ visible, display? }`. priority.display.type is "icon" or "icon_and_text".',
    editing_disabled:
      'CREATE-ONLY and irreversible: a space created with `editing_disabled: true` refuses every update and delete (403), and there is no unlock. It is absent from UpdateSpaceRequest, so sending it on update does nothing.',
    example_create: CREATE_SPACE_EXAMPLE,
    example_update: { name: 'Updated Space Name', upsert_statuses: [{ id: 'blocked', name: 'Blocked', color: '#DC2626', order: 25, complete: false }] },
  },
  'tasks': {
    summary:
      'A task is a work item in a space. create_task requires only `title`; `space_id` must name an existing space (omitted -> ESCALATE). The task `id` is server-generated (`{SPACEID}-{n}`). list_tasks is per-space with rich query filters. update_task / update_multi_task are PATCH merges. due_date/scheduled_at are RFC3339.',
    create_required: ['title'],
    server_generated: ['id', 'created_by', 'created_at', 'updated_at', 'url'],
    update_fields: TASK_UPDATE_FIELDS,
    priorities: PRIORITIES,
    list_filters: [
      'archived (bool)', 'scheduled (bool)', 'limit (default 300)', 'offset',
      'sort_by (default created_at)', 'sort_order (asc|desc)', 'created_by', 'priority',
      'status (comma-separated)', 'title (term search)', 'assignees (comma-separated)',
      'reporter', 'created_at', 'updated_at', 'scheduled_at',
      'parent (exact — the sub-tasks of one task)', 'exclude_subtasks (bool — drop sub-tasks from the top level)',
      'folder (exact — every task for one contact)', 'source (exact)', 'currency (exact)',
      'value ("min,max", either side optional)', 'expected_close (date or "start,end")',
    ],
    list_filter_notes: [
      'Every result carries a `subtasks[]` array of its sub-tasks from the same page, plus `task_actions[]`.',
      '`is_subtask` is indexed but ListTasksHandler never reads it as a query param — use `exclude_subtasks=true` or `parent=<id>`.',
      'Currencies are never converted, so a `value` range over mixed currencies compares raw numbers.',
      'Source: workspaces-service/handler/tasks.go ListTasksHandler; indexer/index-task.go.',
    ],
    subtasks: {
      parent: 'Set `parent` to another task\'s id (create or update). One level deep: a sub-task\'s parent cannot itself have a parent, a task cannot be its own parent, and the parent must exist (400 otherwise). Send `"parent": ""` to detach.',
      move_subtasks: 'Request-only flag on update_task. With `move_subtasks: true`, a change of `space_id` or `folder` also moves every sub-task. Without a space/folder change it does nothing.',
      delete_subtasks: 'delete_task with `delete_subtasks: true` (`?delete_subtasks=true`) also deletes every sub-task, archived ones included. Without it, sub-tasks are left pointing at a deleted parent.',
      source: 'workspaces-service/handler/tasks.go validateParent / moveSubtasks / DeleteTaskHandler',
    },
    pipeline_fields: {
      fields: { source: 'string, indexed', source_detail: 'free text, not indexed', value: 'number, indexed', currency: 'string, indexed, not validated', expected_close: 'ISO date, indexed' },
      note: 'Nothing validates currency and no total is converted between currencies.',
      source: 'workspaces-service/model/api.go Task',
    },
    identity_on_create: {
      what: '`identity` (e.g. `{ "email": "sam@example.com" }`) links a new task to the space\'s base record: records-service upserts the contact keyed on the space\'s identity_fields, the contact folder is created if missing, and the task\'s `folder` is set to `spaces.<SPACE>.<contact folder>`. Request-only — never stored. It creates no sign-in.',
      base_record_skipped:
        'The task is created EVEN IF the link fails. The create response then carries `base_record_skipped` with the reason (the space declares no base record, the upsert failed, or the space could not be read). Always check it when you sent `identity`.',
      deployment:
        'NOT honoured on staging when probed 2026-09-27: a task created with `identity` in a space with a base_record came back with no `folder` and no `base_record_skipped` — the field was silently ignored. Read the task back and check `folder` before relying on the link.',
      source: 'workspaces-service/handler/tasks.go createTask; handler/task_base_record.go linkBaseRecord',
    },
    suppress_events: 'Request-only `suppress_events: true` on create/update stops the write publishing a task event, so a flow can write without re-triggering itself.',
    default_status_note:
      'Omitting `status` on create takes the space\'s `default_status`; a space with no default (or a default it does not contain) gives its FIRST status (#1436). Only a space with no statuses stores "". A status you send is written through unvalidated. #1436 merged 2026-09-27 and was not on staging that day: a task in a space with no default_status came back with no status. Source: workspaces-service/handler/tasks.go statusForCreate, handler/space_lists.go statusMigrationTarget.',
    time_tracking_note:
      'Only `time_tracking.estimate` is writable on the task. Log time with add_time_log; read it back hydrated on the task or with list_time_logs. See get_workspaces_reference("time-tracking").',
    task_actions_note:
      'Checklist items are stored on their own subjects and returned by get_task / list_tasks in `task_actions[]`. Writing one recomputes the task status by role — see get_workspaces_reference("task-actions").',
    templates_note: 'Task templates pre-fill new tasks; see get_workspaces_reference("task-templates").',
    flows_note:
      'Task writes can start a Quiva flow. A "task" TRIGGER (quiva-flows-mcp node_type: "trigger", trigger_type: "task") starts a flow on a task event — created/updated/status-changed/moved/deleted, action added/completed/deleted, comment created/updated/deleted — bound to one space (node id `task:<space_id>`). This is DIFFERENT from the per-task cron timer described in the "Automation" UI section (`action_type: "flow"`, PUT task-event-schedule route above): the trigger reacts to an event with no timer, the schedule fires at a time with no event. See quiva-flows-mcp get_flows_reference("triggers") for the full picture, including a third thing that shares the word "task": the flows "task" NODE TYPE, which is a flow performing a task operation (the egress direction of this same feature).',
    example_create: CREATE_TASK_EXAMPLE,
    example_update: UPDATE_TASK_EXAMPLE,
    multi_update_note:
      'update_multi_task returns an OBJECT keyed by request index, not an array; a single failure fails the whole call with per-index errors.',
  },
  'time-tracking': {
    summary:
      'Time is logged one entry at a time with add_time_log (PUT /workspaces/task/{task_id}/time-log). The server owns each log\'s id, user and timestamps, and hydrates logs[] plus spent/remaining/progress_percent onto every task response. The task itself stores only the estimate.',
    add_time_log: {
      route: 'PUT /workspaces/task/{task_id}/time-log  -> microstrate.workspaces.put.task-time-log',
      body: {
        time_spent: '{ time_in_seconds: N } — REQUIRED, must be > 0 (else 400). Always SECONDS.',
        started_at: 'RFC3339 — REQUIRED (else 400). When the work started.',
        description: 'Optional free text.',
      },
      server_owned: {
        id: '`tl_<random>` — any id you send is ignored.',
        user: '{ id, name } from the caller\'s JWT and the account user list. An API key is exchanged for a JWT at the gateway, so it attributes too.',
        created_at: 'Set to now. updated_at likewise.',
      },
      response: 'The task\'s whole hydrated TimeTracking view — `{ estimate?, logs[], spent, remaining?, progress_percent? }` — not the one log.',
      errors: '404 "task not found"; 400 for a non-positive time_in_seconds or a missing started_at.',
    },
    list_time_logs: 'GET /workspaces/task/{task_id}/time-log -> `{ results: [TimeLog], results_total }`. The same logs are hydrated onto get_task.',
    time_log_shape: '{ id, time_spent: { time_in_seconds }, started_at, description?, user: { id, name }, created_at, updated_at? }',
    estimate: 'The only persisted part of time_tracking. Set it with create_task / update_task: `{ "time_tracking": { "estimate": { "time_in_seconds": 7200 } } }`. Task templates can seed it.',
    hydrated_fields: {
      logs: 'every time-log record for the task',
      spent: 'sum of logs, in seconds',
      remaining: 'estimate - spent, floored at 0 (only with an estimate)',
      progress_percent: 'spent / estimate * 100, capped at 100 (only with an estimate)',
    },
    never_send: [
      '`time_tracking.logs` on create_task / update_task — it is stored on the task and never read.',
      '`spent`, `remaining`, `progress_percent` — response-only.',
    ],
    no_edit_or_delete: 'There is no route to edit or delete a single log (service.go registers put.task-time-log and get.task-time-logs only). Log a correcting entry if you must.',
    legacy_inline_logs:
      'Before #1292 logs were a client-minted array inline on the task, replaced wholesale on every PATCH. There was no migration: hydrateTimeTracking reads only time-log records, so logs written the old way (still visible in some harvested tasks) no longer show anywhere.',
    units:
      'Everything is seconds. The UI parses a Jira-style "2w 4d 6h 45m" string into seconds before sending, using 1w = 5d and 1d = 8h (task-time-tracking.utils.ts).',
    source: 'workspaces-service/handler/task_time_logs.go; model/api.go TimeTracking / AddTimeLogRequest; handler/tasks.go hydrateTimeTracking',
    example_add_time_log: TIME_LOG_EXAMPLE,
    example_task_time_tracking: TIME_TRACKING_EXAMPLE,
  },
  'task-actions': {
    summary:
      'A task action is a checklist item hung off a task, optionally linking platform resources. It is stored on its own subject (`ms.workspaces.task-action.{taskID}.{actionID}`) and returned by get_task / list_tasks in `task_actions[]`. Writing or deleting one recomputes the task status by status role.',
    write_route: 'PUT /workspaces/task/{task_id}/action — create when `id` is omitted (server assigns ta_<random>), address an existing action by passing its `id`.',
    delete_route: 'DELETE /workspaces/task/{task_id}/action/{id} — returns { message: "success" }; 404 "resource not found" for an unknown id.',
    create_required: ['description'],
    read_via_get_task:
      'GetTaskHandler returns `task_actions[]` alongside `watchers[]`/`muted[]` (workspaces-service/handler/tasks.go). This is the read to rely on.',
    dedicated_read_route:
      'GET /workspaces/task/{task_id}/action used to be mapped at the WRITE resource and 400 "description is required". Re-probed 2026-09-27: on staging it now returns `{ results: [TaskAction], results_total }`. Production is mapped (401 unauthenticated) but its target is unverified, so prefer get_task.',
    status_by_role: {
      rule:
        'After every action write or delete the task status is recomputed from its countable actions: none done -> the space\'s `todo` role (else default_status); some done -> the `working` role; all done -> the `done` role (else the first `complete` status whose role is not an outcome). Chat actions do not count.',
      never_invents_an_id: 'The result is checked against the space\'s statuses; an id the space lacks is never written, and with no matching role the status is left alone.',
      consequence: 'A space whose statuses carry roles gets a board that follows its checklists. A space with none only ever moves to default_status (no actions done) or its inferred done status (all done).',
      history: 'Replaces the 2026-08-04 finding that a write reset the task to `backlog` (aa7c27b75, fa234c0b1).',
      source: 'workspaces-service/handler/task_actions.go resolveTaskStatusFromActions / updateTaskStatusFromActions; model/api.go Space.StatusIDForRole',
    },
    unverifiable_write_response:
      'The write handler responds with your own request body echoed back, not the stored aggregate. Confirm through get_task.',
    resource_shape: '{ resource_id, resource_type, metadata? } — both ids are free-form strings; the service does not validate that the resource exists.',
    validation_quirk:
      '`description` is required on EVERY write, not just creates: the handler checks it before touching the store, so a call that only flips `done` still has to resend the description.',
    suppress_events: 'Request-only `suppress_events: true` stops the write publishing a task event.',
    flows_note:
      'Adding or completing an action fires `task-action-added` / `task-action-completed` on the same task-event trigger described in get_workspaces_reference("tasks").flows_note. WATCH FOR LOOPS: completing an action can itself move the task\'s status (status_by_role above), which can re-fire the trigger on the resulting status change — a flow that ticks its own action needs the trigger\'s self-trigger suppression (default on). See quiva-flows-mcp get_flows_reference("triggers").',
    example: TASK_ACTION_EXAMPLE,
  },
  'contacts': {
    summary:
      'create_contact (POST /workspaces/client) writes a contact — a person, or with `config_id` the organisation — into a space: a record keyed on the space\'s base record, plus a contact folder. It can ALSO create a portal sign-in.',
    body: {
      space_id: 'REQUIRED. 404 if the space does not exist.',
      'first_name / last_name / name / email / phone / address / dob': 'Profile fields. email must look like an address (400 otherwise).',
      extra_data: 'Any other fields, stored on the record. A declared identity or display field can be supplied here.',
      config_id: 'Omit for the space\'s base_record (the person). Set to the organisation_record\'s config_id to write the firm. Anything else is 400.',
      parent_folder: 'Folder of the organisation this contact belongs to — a single segment, no dots.',
      'entity_type / parent_entity': 'Optional labels stored on the record and the folder metadata.',
    },
    identity:
      'With a base record the write is an UPSERT keyed on the chosen record\'s identity_fields (from email, phone or extra_data), so the same person arriving twice lands on one folder; re-creating one whose folder exists is 409. One identity value is required, and something (name, email or phone) must label the contact. A space with NO base record falls back to the legacy shape: first_name, last_name and email all required, written to the `Client` config under a random folder.',
    sign_in:
      'When the CLIENT record has `create_login_on_create: true` and the contact has an email, the handler also creates a `client`-role user for that email, scoped to the contact folder. Never for an organisation write. The contact is kept even if the sign-in fails; the response says `login_created` and, when none was made, `login_skipped` with the reason.',
    response: '{ id, folder, space_id, data, parent_folder?, login_created, login_skipped? } — `folder` is relative to the space.',
    source: 'workspaces-service/handler/client.go CreateClientFolder / createContact; handler/contact_login.go; model/api.go ClientProfile',
    example: CREATE_CONTACT_EXAMPLE,
  },
  'task-templates': {
    summary:
      'A task template quick-fills a new task: name/description become the title/description, and priority, tags, folder, reporter, assignees, estimate and task_actions are seeded. Nothing is binding. Account-scoped; `vertical` groups them.',
    routes: [
      'GET    /workspaces/task-templates?vertical=   -> list',
      'POST   /workspaces/task-template              -> create (name required; id tt_<random> server-set)',
      'GET    /workspaces/task-template/{id}',
      'PATCH  /workspaces/task-template/{id}         -> update; tags/assignees/task_actions replace whole',
      'DELETE /workspaces/task-template/{id}',
    ],
    task_action_kinds: {
      form: 'config_id (legacy) or configs[{ id, view?, flow? }] required',
      document: 'document_source "generate" (default; document_template_id required) or "knowledge" (knowledge_key required); requires_signature?',
      chat: 'agent_subject or flow_config_id required',
      all: 'description required; id tta_<random> if absent',
    },
    task_from_template:
      'POST task-from-template (CreateTaskFromTemplateHandler) exists on the mesh but is NOT gateway-mapped on production or staging (404, probed 2026-09-27), so this MCP has no tool for it. Assistants and flows reach it over the mesh; the web app seeds templates client-side.',
    source: 'workspaces-service/handler/task_templates.go; model/api.go TaskTemplate / UpdateTaskTemplateRequest',
    example: TASK_TEMPLATE_EXAMPLE,
  },
  'meetings': {
    summary:
      'Meeting recordings a notetaker bot filed into a space: list_meetings reads the meetings index, get_meeting_transcript reads one transcript. Recording itself is not exposed.',
    list_meetings:
      'GET /workspaces/meetings?space_id= with optional folder, file_type (video|audio|transcript|summary), recording_id, bot_id, created_by, title (term), created_at, limit, offset, sort_by, sort_order. One entry per FILE: `{ space_id, folder, file_type, recording_id, bot_id, title, created_at, created_by, file: { name, size, mtime } }`. If the meetings index fails the server still answers 200 with an empty list (workspaces-service/handler/meetings.go:78-84), so "none" can mean not indexed, or the meetings index did not answer.',
    get_meeting_transcript:
      'Finds the recording\'s transcript entry in the space and reads `file.name` from the `microstrate-recall-files` bucket — plain text, one "[mm:ss – mm:ss] Speaker: words" line per turn. GET /recall/recording/{id}/transcript returns the structured entries but is keyed to the user who recorded it (config.TranscriptKey(userID, recordingID)), so anyone else gets 400 "key not found" — this tool uses it only as a fallback.',
    source: 'workspaces-service/handler/meetings.go; recall-service/handler/transcript.go; recall-service/config/service.go',
  },
  'comments': {
    summary:
      'Comments live under a task (path {task_id}). create_comment requires `body`. update_comment requires `body` or `reply_id`. get/list return the comment(s) with an aggregated `reactions` map. delete_comment is a soft delete. Author/created_at/updated_at/url are server-set.',
    create_required: ['body'],
    update_required_one_of: ['body', 'reply_id'],
    server_generated: ['id', 'author', 'created_at', 'updated_at', 'url'],
    example_create: { body: 'This looks good, ready for review', reply_id: null },
    example_update: { body: 'Updated comment text with corrections' },
  },
  'reactions': {
    summary:
      'react_to_comment toggles an emoji reaction on a comment. The body is `{ reaction: { "<emoji>": true|false } }` (true = add, false = remove). Response is `{ reactions: { "<emoji>": { count, users } } }`, NOT the comment. THE KEY MUST BE THE EMOJI CHARACTER — it is stored verbatim and rendered as-is, so a shortcode name like "eyes" renders as a broken reaction. An API key is sufficient; the reaction is attributed to the account the key resolves to.',
    key_rule:
      'The map key is the EMOJI CHARACTER, not a shortcode name. It is stored verbatim and the UI renders it as-is — nothing translates "eyes" into \u{1F440}. Verified live 2026-07-30: { "eyes": true } stored the literal string and showed as an invalid reaction; { "\u{1F440}": true } rendered. validate_payload errors on a non-emoji key.',
    example_add: { reaction: { '👍': true } },
    example_remove: { reaction: { '👍': false } },
  },
  'identifiers': {
    summary: 'How space/task/comment ids are formed — the common source of confusion.',
    space_id: 'Client-supplied on create, must match ^\\w+$, UPPERCASED server-side. Used verbatim as the GET/PATCH/DELETE path param and as the task-id prefix.',
    task_id: 'Server-generated: `{SPACEID}-{n}` from the space counter (an omitted space_id means ESCALATE); `t_<nanoid>` only if the counter fails. Any id you send on create is ignored.',
    time_log_id: 'Server-generated: `tl_<random>`.',
    task_template_id: 'Server-generated: `tt_<random>`; template action ids `tta_<random>`.',
    comment_id: 'Server-generated: `c_<nanoid>`. The comment path is /workspaces/task/{task_id}/comment/{id}.',
  },
  'auth': {
    summary:
      'An API key alone drives the core CRUD, but attribution (owner/created_by/author) and reactions need a Bearer JWT. Configure QUIVA_API_KEY, or (preferred) QUIVA_BEARER_TOKEN or QUIVA_EMAIL/QUIVA_PASSWORD.',
  },
  'endpoints': {
    summary: 'The workspaces-service surface exposed by this MCP (REST path → engine route key).',
    spaces: [
      'GET    /workspaces/spaces               → get.spaces  (list; always includes the ESCALATE space)',
      'POST   /workspaces/space                → post.space  (create; id required, uppercased; 409 if exists)',
      'GET    /workspaces/space/{id}           → get.space',
      'PATCH  /workspaces/space/{id}           → patch.space (merge; may return 202 on async priority migration)',
      'DELETE /workspaces/space/{id}           → delete.space ({message:success}; 403 for ESCALATE)',
    ],
    tasks: [
      'GET    /workspaces/space/{space_id}/tasks → get.tasks  (per-space list + filters; each result carries subtasks[] and task_actions[])',
      'POST   /workspaces/task                   → post.task  (title required; id server-generated; optional identity -> base_record_skipped)',
      'PATCH  /workspaces/tasks                  → patch.tasks (batch; returns index-keyed object)',
      'GET    /workspaces/task/{id}              → get.task   (task + watchers[] + muted[] + task_actions[] + hydrated time_tracking)',
      'PATCH  /workspaces/task/{id}              → patch.task (merge; parent, move_subtasks, pipeline fields)',
      'DELETE /workspaces/task/{id}              → delete.task ({message:success}; ?delete_subtasks=true)',
    ],
    time_logs: [
      'PUT    /workspaces/task/{task_id}/time-log → put.task-time-log   (one entry; server owns id/user/timestamps; returns hydrated time_tracking)',
      'GET    /workspaces/task/{task_id}/time-log → get.task-time-logs  ({ results, results_total })',
    ],
    task_actions: [
      'PUT    /workspaces/task/{task_id}/action        → put.task-action    (create/update; description always required; recomputes the task status by role)',
      'DELETE /workspaces/task/{task_id}/action/{id}   → delete.task-action ({message:success})',
      'GET    /workspaces/task/{task_id}/action        → returns the list on staging (2026-09-27); prod target unverified — read through get_task.',
    ],
    task_templates: [
      'GET    /workspaces/task-templates        → get.task-templates (?vertical=)',
      'POST   /workspaces/task-template         → post.task-template',
      'GET    /workspaces/task-template/{id}    → get.task-template',
      'PATCH  /workspaces/task-template/{id}    → patch.task-template',
      'DELETE /workspaces/task-template/{id}    → delete.task-template',
      '(post.task-from-template has NO gateway mapping — 404 on prod and staging, 2026-09-27)',
    ],
    contacts: [
      'POST   /workspaces/client                → post.client-folder (create_contact; may create a portal sign-in)',
    ],
    meetings: [
      'GET    /workspaces/meetings              → get.meetings (list_meetings)',
      'GET    {base}/api/default-storage/object/microstrate-recall-files/{file.name} (get_meeting_transcript)',
      'GET    /recall/recording/{recording_id}/transcript → recall get.transcript (fallback; recorder only)',
    ],
    comments: [
      'POST   /workspaces/task/{task_id}/comment           → post.comment',
      'GET    /workspaces/task/{task_id}/comments          → get.comments',
      'GET    /workspaces/task/{task_id}/comment/{id}      → get.comment',
      'PATCH  /workspaces/task/{task_id}/comment/{id}      → patch.comment',
      'DELETE /workspaces/task/{task_id}/comment/{id}      → delete.comment (soft delete)',
      'POST   /workspaces/task/{task_id}/comment/{id}/reaction → post.comment-reaction',
    ],
    users: [
      'GET    /accounts/users/list             → accounts.get.list-users-by-account (FOREIGN: accounts-service)',
    ],
    probed: 'Every route above answered 401 unauthenticated on production and staging on 2026-09-27 (mapped). See docs/endpoint-probe-2026-09-27/workspaces.md.',
    not_exposed: [
      'my-tasks, client-task-list, task watch/mute, task-event-schedules, change-log, tasks-export, bulk delete by folder, reindex/backfill, file trash/restore, and file approvals.',
      'FILE APPROVALS — GET/POST /workspaces/approvals, GET/DELETE /workspaces/approvals/{id}, PATCH .../approve, PATCH .../reject, GET/POST .../events. The list REQUIRES a `file_subject` query param (400 "file subject is required" without it). approve/reject are PUBLIC so an emailed approval link works. Overlaps the file-generator approvals surface quiva-documents-mcp covers.',
      'File/folder DELETE — see get_workspaces_reference("files").deleting.',
    ],
  },
  'files': {
    summary:
      'Space files and folders: the dotted path scheme, how a folder is really stored, the two sinks a write lands in, and why you must poll after writing.',
    path_scheme: {
      shape: 'spaces.<SPACE_ID>.<folder>[.<subfolder>...].<name>.<ext>',
      separator:
        '`.` is the hierarchy separator, so NO single name segment may contain a dot. A vertical id, a category folder and a config name must all be dot-free; only the file extension adds one.',
      space_id: 'Uppercased, like every space id (^\\w+$).',
      note: 'Live keys DO contain spaces — `spaces.FAHUB.<Owner Name>.<file>.pdf` — so keys must be percent-encoded in a URL. This client does that.',
    },
    a_folder_is_a_marker_object: {
      what:
        'There are no directories. `create_folder` writes a single small object at `<path>.<marker>.json` containing only `{ created_at, created_by }`, and the UI derives the tree from the set of keys.',
      current_marker: '__meta__.json',
      legacy_marker: 'metadata.json',
      why_both:
        'Renamed in evari-olympus 3a7ab968b (#1291, 2026-07-31), and existing markers were MIGRATED in place — watched live, VERTICAL read as metadata.json and an hour later as __meta__.json. Write the new name; keep accepting the old one, since accounts-service skips both suffixes and an unmigrated space may still hold it.',
      consequence:
        'A newly created folder renders as EMPTY in the UI Files tab — correct, not a failure. The marker is filtered out of the tree.',
      name_can_be_blank:
        'A marker\'s index entry very often has an EMPTY `name` while its `subject` is correct — 16 of 21 markers live on 2026-07-31, including 3 of 8 created in one fresh run, and it never fills in. The subject is `ms.workspace-files.` + one base64 RawStdEncoding segment per path segment, and the engine decodes it in this exact case (transform.ObjKeyUnsafe). list_files adds a resolved `key` to every entry — use it, because matching on `name` makes a poll-until-indexed loop hang forever.',
      why_an_empty_folder_may_not_show_in_the_UI:
        'The UI builds its folder tree from `name`. A folder whose marker has a blank name and which contains NO files therefore has nothing to derive a path from, and does not render in the Files tab — even though it exists, is in the index, and behaves correctly for deployment. Put a real file in it and it appears, because config files keep their names. So "I cannot see the folder I just created" is usually this, not a failed create: check `visible_in_ui` on the create_folder result.',
    },
    writing_a_file: {
      route: 'POST {base}/api/default-storage/object/{bucket}/{key} with the raw bytes as the body',
      bucket: 'microstrate-workspaces (workspaces-service/data/const.go WorkspacesObjectStoreBucketName)',
      not_in_the_registry:
        'This root is absent from specs/openapi/quiva-endpoints.json — it was found by reading what the UI calls (storage.api.ts uploadObjFileBinary). Read and write share the root and differ only by method.',
      response:
        '{ name, bucket, buid, size, mtime, chunks, digest }. `digest` is "SHA-256=<base64>" over the exact bytes sent — verified by recomputing locally — so integrity is checkable without a second read.',
      auth: 'An API key is sufficient for both read and write (verified live 2026-07-31).',
      self_registers:
        'YES. You do NOT need to call /workspaces/files/file-record afterwards; the UI never does. That route and /workspaces/files/sync-files are repair paths for an index that has drifted.',
    },
    the_two_sinks: {
      bucket: 'Holds the bytes. Readable by exact key.',
      index:
        'microstrate-workspace-files. This is what `GET /workspaces/files?space_id=…` lists AND what accounts-service deployVerticals iterates.',
      rule:
        'A file in the bucket but not the index is invisible to everything that matters. "Written" means "appears in the index".',
      asynchronous:
        'CRITICAL: indexing lags the write. Verified live twice — a config object was absent at t+1s and present at t+16s; a nested folder took minutes. POLL for the key; never write and immediately act. This is the difference between a vertical that deploys completely and one that silently deploys a subset.',
    },
    deleting: {
      exposed: false,
      why:
        'Never exercised, and destructive. delete_workflow silently orphaned every draft it "deleted" while returning success (docs/lessons.md), so an unverified destructive tool is not shipped here.',
      source_derived_UNVERIFIED: [
        'Params go in the QUERY STRING, not the body: DELETE /workspaces/files/folder?space_id=&folder=&subfolder=',
        'Recursive — it lists everything nested plus the target marker.',
        'SOFT delete: each object is copied to a trash bucket, then removed, then unindexed. GET /workspaces/files/trash lists them; POST /workspaces/files/restore restores.',
        'Hard-requires a Bearer JWT (401 without), unlike create which tolerates its absence and just records an empty created_by.',
        'Partial failure returns 400 but KEEPS whatever it already deleted.',
      ],
      if_you_must: 'Do it by hand, then verify by re-listing — not by the response body.',
    },
  },

  'verticals': {
    summary:
      'The VERTICAL space is a template library. Adding a vertical to an account copies its configs into that account. This is the contract that folder layout has to satisfy.',
    the_space: VERTICAL_SPACE_ID,
    layout: 'spaces.VERTICAL.<vertical_id>.<category>.<config_name>.json',
    shared_folder:
      'spaces.VERTICAL.SHARED.* is ALWAYS deployed alongside whichever vertical was requested (deployVerticals appends "SHARED" to the list). That is how every account with any vertical ends up with the `Client` record config.',
    config_types: VERTICAL_CONFIG_TYPES,
    non_deploying_folders: {
      folders: VERTICAL_NON_DEPLOYING_FOLDERS,
      why:
        'Folders we place in a vertical on purpose that are NOT deployed. `specs` holds the markdown brief the vertical was built from — documentation that travels with the vertical, not configuration. It reaches the dispatch loop and falls out at the config-type lookup, which is the intended outcome. Note this is ONE layer of protection rather than two: a folder at the VERTICAL root never matches the vertical prefix at all, whereas one inside a vertical does and is stopped only by the config-type table. If a `specs` config type were ever added upstream, these files would start being POSTed at an endpoint.',
    },
    how_deployment_is_triggered:
      'Two paths. Account activation deploys every listed vertical (accounts-service/accounts/createaccount.go activateAccountResources). Updating an account with a `verticals` array runs `go deployVerticals(...)` for the newly added ones (accounts-service/accounts/updateaccount.go) — a goroutine, so it is fire-and-forget and the account-update response tells you nothing about whether it worked.',
    rules_that_bite: [
      'THE CATEGORY FOLDER NAME IS THE ROUTING KEY. It is the first path segment after `spaces.VERTICAL.<vertical>.`, and an unrecognised name is silently skipped (`if !ok { continue }`) — no error, no log line. A folder named `record_config` instead of `record_configs` deploys nothing and says nothing.',
      'DEPLOYMENT IS DELTA-ONLY. Only verticals NOT already on the account are deployed. Re-adding a vertical that is already listed deploys NOTHING — to redeploy you must remove it, save, and re-add.',
      'THERE IS NO DEPENDENCY ORDER. Files deploy in index-listing order, so a space referencing the `Client` record config can be created before `Client` exists. Deploy SHARED first and confirm it landed.',
      'MARKER FILES NEVER DEPLOY — both `.metadata.json` and `.__meta__.json` suffixes are skipped.',
      'FLOWS get a collection created for them (name = the vertical id split on `_` and title-cased, e.g. financial_advisor -> "Financial Advisor") and have `collection` + `auto_publish: true` injected into the payload.',
      'ASSISTANTS must be wrapped as `{ "config": { ... } }` and have `config.shared` FORCED to "team", whatever you wrote.',
      'The only observability is a stream: microstrate-accounts.<account_id>.deploy-verticals, one message per file with { name, vertical, config_type, subject, status (SUCCESS|UPDATED|UNCHANGED|FAILED), error, changed_fields }. A create that collides with an existing resource is compared and updated in place (accounts-service/accounts/verticalresources.go reconcileVerticalResource), not reported as a failure.',
    ],
    space_configs_and_record_configs:
      'A space config under `spaces/` may attach record configs. `record_configs: [{ id, form_id? }]` is the CURRENT shape and WINS on read; `record_config_ids: [string]` is LEGACY and is only read when `record_configs` is absent (microstrate/src/components/spaces/records/space-record-configs.utils.ts:13-14). Persisting from the UI writes `record_configs` and DELETES `record_config_ids`. So adding a config to `record_config_ids` alone, while `record_configs` is present, is silently ignored — write BOTH and keep them identical, and treat `record_configs` as authoritative.',
  },

  'gotchas': { summary: 'Spec-vs-engine truths.', values: GOTCHAS },
};

export function listReferenceTopics() {
  return Object.keys(REFERENCE).map((topic) => ({ topic, summary: REFERENCE[topic].summary }));
}

export function getReference(topic) {
  const doc = REFERENCE[topic];
  if (!doc) {
    return { error: `Unknown topic "${topic}". Available: ${Object.keys(REFERENCE).join(', ')}` };
  }
  return { topic, ...doc };
}

export {
  PRIORITIES,
  SPACE_UPDATE_FIELDS,
  TASK_UPDATE_FIELDS,
  CREATE_SPACE_EXAMPLE,
  CREATE_TASK_EXAMPLE,
  TIME_LOG_EXAMPLE,
  TIME_TRACKING_EXAMPLE,
  TASK_ACTION_EXAMPLE,
  CREATE_CONTACT_EXAMPLE,
  TASK_TEMPLATE_EXAMPLE,
  STATUS_ROLES,
  TERMINAL_STATUS_ROLES,
  SPACE_TABS,
  SPACE_MODULES,
  VERTICAL_SPACE_ID,
  VERTICAL_CONFIG_TYPES,
  FOLDER_MARKERS,
  VERTICAL_NON_DEPLOYING_FOLDERS,
};
