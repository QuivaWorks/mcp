// Workspaces reference data — derived from the workspaces-service engine source
// (workspaces-service/handler/{spaces,tasks,comments}.go, model/api.go,
// service/service.go, response/response.go), NOT just the OpenAPI spec
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
  'Task ids are SERVER-GENERATED — any `id` you send on create_task is ignored. If `space_id` is provided it is uppercased and the space MUST already exist (else 400 "space not found"), and the task id becomes `{SPACEID}-{n}` (n from a per-space counter). If `space_id` is omitted the task lands in the "default" space with a random id `t_<nanoid>`. Comment ids are `c_<nanoid>`.',
  // Update verb + merge semantics.
  'Updates are PATCH, not PUT (registered under the `patch` route group; the only PUT route is task-event-schedule, not exposed here). update_space and update_comment merge the fields you send over the stored record; update_task is a DeepMerge of the fields you send. Send only the fields you want to change — but ALWAYS construct minimal payloads from scratch: do NOT echo back nested objects (statuses, assignees) copied from a GET response.',
  // 202 async priority migration (masked by envelope unwrap).
  'update_space can return 202 (not 200) when you REMOVE a priority that tasks still reference: the space is updated immediately and a background job re-assigns those tasks onto the fallback priority (the default, or the first remaining). Verified live: the affected tasks are re-assigned a few seconds later. CAVEAT: this MCP unwraps the { status_code, body } envelope, so the tool result cannot distinguish 202 from 200 — confirm a migration by re-reading the affected tasks, not by the status code.',
  // updateMultiTask response shape.
  'update_multi_task (PATCH /workspaces/tasks) returns an OBJECT keyed by the task position in the request array — `{ "0": {task}, "1": {task} }` — NOT an array (the spec is wrong). If ANY task fails the whole call returns status 400 with per-index `{ "error": ... }` entries mixed in alongside the successes.',
  // Reaction response shape.
  'react_to_comment (POST .../reaction) returns only `{ "reactions": { "<emoji>": { count, users } } }` — NOT the full comment (the spec is wrong). The reaction map is `{ "<emoji>": true|false }` (true = add, false = remove). THE KEY MUST BE THE EMOJI CHARACTER ITSELF: it is stored verbatim and rendered as-is, and nothing converts a shortcode name into a glyph — `{ "eyes": true }` stores the literal string "eyes" and renders as a broken reaction, while `{ "\u{1F440}": true }` renders. Verified live 2026-07-30 (this MCP\'s own example shipped the shortcode form and had to be fixed on staging). Colons in a key are stripped server-side. An API KEY is sufficient and the reaction is attributed to the account the key resolves to — an earlier note here claiming a Bearer JWT was required, else the reaction is keyed to an empty user id, was wrong.',
  // Missing task fields.
  'The engine Task supports fields the spec omits: `archived` (bool), `scheduled_at` (RFC3339), `order` (number), `tags` (string[]), `metadata`, and `time_tracking`. update_task accepts archived / scheduled_at / order / tags / time_tracking. Setting `archived: true` unschedules the task; setting `scheduled_at` schedules a background job.',
  // Default status on create (behaviour CHANGE, workspaces-service #1281).
  'create_task with no `status` now inherits the space\'s `default_status` instead of storing "" (handler/tasks.go createTask fetches the space and fills it in). Verified live: posting {title, space_id:"MCP_VERIFICATION_RENEWALS"} came back with status "awaiting_info". This is a behaviour change — a task created without a status used to land outside every board column; it now appears in the default one. It only applies when `space_id` is set: a task with no space still gets "".',
  // Time tracking merge semantics (all four cases verified live).
  'Task `time_tracking` is `{ estimate?: { time_in_seconds }, logs: [TimeLog] }` and the frontend derives every total from it — nothing is stored pre-computed. Merge behaviour verified live 2026-07-29: omitting `time_tracking` leaves it untouched; sending `time_tracking` WITHOUT `logs` preserves the existing logs; `"logs": []` clears them all; and `"logs": [...]` REPLACES the array wholesale rather than appending. To add one entry you must read the task and send the complete set back. Every TimeLog field (id, created_at, user) is client-supplied — the backend defaults nothing inside the object.',
  // Task actions: write-only surface.
  'Task actions (the checklist hung off a task) are WRITE-ONLY through the API. PUT /workspaces/task/{task_id}/action creates or updates one and DELETE .../action/{id} removes it, but the GET on the same path is mapped to the WRITE resource `microstrate.workspaces.put.task-action`, so it runs the add handler and returns 400 "description is required" (verified live). ListTaskActionsHandler exists in the service (registered as get.task-actions) and no gateway route reaches it. The write response is your own request echoed back, not the stored aggregate — so a task action cannot be verified after writing. Nothing in the frontend reads them yet either.',
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
  'A file-index entry\'s `name` can be EMPTY while its `subject` is correct — observed live 2026-07-31 on ALL TWELVE folder markers in the VERTICAL space right after the #1291 rename migrated them, while markers created natively by the new code kept their name. THE SUBJECT IS THE AUTHORITATIVE KEY: it is `ms.workspace-files.` followed by one base64 RawStdEncoding segment per path segment, and the engine itself decodes it in exactly this situation (DeleteFolderHandler falls back to transform.ObjKeyUnsafe when Name is ""). Consequences: anything matching on `name` will not see those folders at all — a poll-until-indexed loop keyed on `name` waits forever for a key that is already present — and the `search` query param matches the stored name, so it cannot find them either. list_files therefore adds a resolved `key` to every entry; read `key`, not `name`. Deployment is NOT affected: an empty name fails both the marker-suffix and the vertical-prefix test in deployVerticals, so those entries are skipped, which is what should happen to a marker anyway.',
  // Files: the two sinks, and the async index. This is the operational trap.
  'A file write has TWO sinks: the object BUCKET and the file INDEX. `GET /workspaces/files` lists the INDEX, and so does the vertical deployer (accounts-service deployVerticals), so a file present in the bucket but missing from the index is readable by key and invisible to everything that matters. Writing an object DOES self-register — you do not need `/workspaces/files/file-record` (the UI never calls it; that route and `/sync-files` are repair paths). BUT INDEXING IS ASYNCHRONOUS: verified live twice, a config object was absent from the index at t+1s and present at t+16s, and a nested folder took minutes. create_folder also returns NO body at all (`response.Success(request)`). So "written" means "appears in the index" — poll for it; never write and immediately act on it.',
  // Files: deletes are deliberately not exposed.
  'DELETE of a file or folder is deliberately NOT exposed by this MCP, because it has never been exercised — and `delete_workflow` in the flows MCP silently orphaned every draft it "deleted" while returning success (docs/lessons.md). From the source only, therefore UNVERIFIED: params go in the QUERY STRING not the body (`?space_id=&folder=&subfolder=`), it is RECURSIVE over everything nested, it is a SOFT delete (each object is copied to a trash bucket, then removed, then unindexed), it hard-requires a Bearer JWT (`helper.GetAuthToken` failure is a 401, unlike create which tolerates its absence), and a partial failure returns 400 while KEEPING whatever it already deleted. Delete by hand if you must, then verify by re-listing rather than trusting the response.',
  // Foreign endpoint.
  'list_users hits /accounts/users/list — that is the ACCOUNTS service (microstrate.accounts.get.list-users-by-account), not workspaces. It is included only to resolve user ids for assignees/reporters. It returns `{ data: [ {id, email, first_name, last_name, role, ...} ] }`.',
];

// Task priority is free-form on the wire (no server-side enum); these are the
// conventional values used across the product UI.
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

// Update payloads must be built from scratch (never copied from a GET). These
// are the fields the engine reads on each update; metadata/read-only fields on
// the parent object are ignored.
const SPACE_UPDATE_FIELDS = [
  'name', 'description', 'default_status', 'statuses',
  'record_config_ids', 'default_record_config_id',
  'priorities', 'tags', 'logo', 'default_view',
];
const TASK_UPDATE_FIELDS = [
  'title', 'description', 'assignees', 'attachments', 'priority', 'folder',
  'reporter', 'status', 'space_id', 'due_date', 'scheduled_at', 'order',
  'archived', 'tags', 'time_tracking',
];

// A complete time log as the frontend writes it. Every field here is
// client-supplied; the backend defaults nothing inside time_tracking.
const TIME_LOG_EXAMPLE = {
  id: 'time_log_7c1f0e2a-2b44-4a1e-9f0d-3d5a6b8c1120',
  time_spent: { time_in_seconds: 5400 },
  started_at: '2026-07-29T09:00:00Z',
  description: 'Re-rated the schedule and checked the sum insured',
  // Client-supplied snapshot. The backend never fills this in from the token, so
  // it must be a real uuid from list_users paired with that user's actual name.
  user: { id: '00000000-0000-0000-0000-000000000000', name: 'Example User' },
  created_at: '2026-07-29T10:32:00Z',
};

const TIME_TRACKING_EXAMPLE = {
  estimate: { time_in_seconds: 7200 },
  logs: [TIME_LOG_EXAMPLE],
};

const TASK_ACTION_EXAMPLE = {
  id: 'ta_confirm_sum_insured',
  description: 'Confirm the sum insured with the insured',
  done: false,
  resources: [
    {
      resource_id: 'risk_programme',
      resource_type: 'record-config',
      metadata: { note: 'capture the re-rate here' },
    },
  ],
};

const CREATE_SPACE_EXAMPLE = {
  id: 'Q2_MKTG',
  name: 'Q2 Marketing Campaign',
  description: 'All marketing activities for Q2 2024',
  default_status: 'to_do',
  statuses: [
    { id: 'to_do', name: 'To Do', color: '#cccccc', order: 1, is_visible: true },
    { id: 'in_progress', name: 'In Progress', color: '#0052cc', order: 2, is_visible: true },
    { id: 'done', name: 'Done', color: '#36b37e', order: 3, is_visible: true },
  ],
};

const CREATE_TASK_EXAMPLE = {
  title: 'Implement user authentication',
  description: 'Add OAuth2 authentication to the platform',
  space_id: 'Q2_MKTG',
  priority: 'high',
  status: 'to_do',
  assignees: ['user_123'],
  due_date: '2024-06-15T00:00:00Z',
};

const UPDATE_TASK_EXAMPLE = {
  status: 'in_progress',
  priority: 'high',
  assignees: ['user_123'],
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

const REFERENCE = {
  'spaces': {
    summary:
      'A space (workspace) holds tasks and configurable statuses. create_space requires `id` (^\\w+$, uppercased server-side) and `name`. Optional: description, default_status, statuses[], record_config_ids[], default_record_config_id[], priorities[], tags[]. update_space is a PATCH merge — send only changed fields, constructed from scratch (do NOT copy nested statuses from a GET).',
    create_required: ['id', 'name'],
    id_rule: 'id must match ^\\w+$ (letters, numbers, underscore only) and is UPPERCASED server-side.',
    update_fields: SPACE_UPDATE_FIELDS,
    status_shape: '{ id, name, color?, order?, is_visible?, complete? }',
    example_create: CREATE_SPACE_EXAMPLE,
    example_update: { name: 'Updated Space Name', default_status: 'in_progress' },
  },
  'tasks': {
    summary:
      'A task is a work item in a space. create_task requires only `title`; if `space_id` is set the space must exist (and is uppercased). The task `id` is server-generated (`{SPACEID}-{n}` or `t_<nanoid>`). list_tasks is per-space (path {space_id}) with rich query filters. update_task / update_multi_task are PATCH merges. due_date/scheduled_at are RFC3339.',
    create_required: ['title'],
    server_generated: ['id', 'created_by', 'created_at', 'updated_at', 'url'],
    update_fields: TASK_UPDATE_FIELDS,
    priorities: PRIORITIES,
    list_filters: [
      'archived (bool)', 'scheduled (bool)', 'limit (default 300)', 'offset',
      'sort_by (default created_at)', 'sort_order (asc|desc)', 'created_by', 'priority',
      'status (comma-separated)', 'title (term search)', 'assignees (comma-separated)',
      'reporter', 'created_at', 'updated_at', 'scheduled_at',
    ],
    default_status_note:
      'Omitting `status` on create now inherits the space\'s `default_status` (workspaces-service #1281) instead of storing "". Verified live: {title, space_id:"MCP_VERIFICATION_RENEWALS"} came back status "awaiting_info". Only applies when space_id is set — a task with no space still gets "".',
    time_tracking_note:
      'Tasks carry `time_tracking` ({ estimate?, logs[] }). See get_workspaces_reference("time-tracking") — logs[] REPLACES rather than appends, so adding an entry is read-modify-write.',
    task_actions_note:
      'Checklist items live on a separate subject, not on the task. See get_workspaces_reference("task-actions") — they are write-only today because the GET route is misrouted.',
    example_create: CREATE_TASK_EXAMPLE,
    example_update: UPDATE_TASK_EXAMPLE,
    multi_update_note:
      'update_multi_task returns an OBJECT keyed by request index, not an array; a single failure fails the whole call with per-index errors.',
  },
  'time-tracking': {
    summary:
      'Task `time_tracking` records an effort estimate plus every logged entry: { estimate?: { time_in_seconds }, logs: [TimeLog] }. It is set through create_task / update_task like any other task field. Nothing is pre-computed — total spent, remaining, and progress are all derived on the frontend, so never send them.',
    shape: {
      estimate: '{ time_in_seconds: N } — the original effort estimate. Optional.',
      logs: '[TimeLog] — every logged entry. Required by the Go struct (no omitempty), but see merge_semantics: omitting it is safe.',
    },
    time_log_shape: {
      id: 'REQUIRED, client-supplied. The backend never generates one; the UI mints `time_log_<uuid>`.',
      time_spent: '{ time_in_seconds: N } — REQUIRED. Always SECONDS.',
      started_at: 'RFC3339 — when the tracked work started. REQUIRED.',
      description: 'Optional free text.',
      user: '{ id, name } — a snapshot of who logged it, client-supplied (the backend does NOT fill it from the token). Deliberately excludes avatar info.',
      created_at: 'RFC3339 — client-supplied.',
      updated_at: 'RFC3339 — optional.',
    },
    merge_semantics: [
      'time_tracking omitted from the PATCH        -> untouched',
      'time_tracking present but WITHOUT `logs`    -> existing logs PRESERVED (verified live 2026-07-29)',
      '"logs": []                                  -> every log CLEARED',
      '"logs": [ ... ]                             -> the array is REPLACED wholesale, NOT appended',
    ],
    adding_one_log:
      'Because logs[] replaces rather than appends, adding an entry is read-modify-write: get_task, take time_tracking.logs, append your new log, and send the whole array back. Sending just the new log silently discards the rest.',
    units:
      'Everything is seconds. The UI parses a Jira-style "2w 4d 6h 45m" string into seconds before sending, using 1w = 5d and 1d = 8h (task-time-tracking.utils.ts). Those working-time conventions live entirely in the frontend — the API only ever sees the number.',
    derived_on_frontend: ['total spent', 'remaining', 'progress percent', 'progress colour'],
    example: TIME_TRACKING_EXAMPLE,
  },
  'task-actions': {
    summary:
      'A task action is a checklist item hung off a task, optionally linking platform resources. It lives on its own subject (`ms.workspaces.task-action.{taskID}.{actionID}`), NOT as a field on the task — so it never shows up in get_task. WRITE-ONLY: there is no working read route (see read_is_broken).',
    write_route: 'PUT /workspaces/task/{task_id}/action — create when `id` is omitted (server assigns ta_<random>), address an existing action by passing its `id`.',
    delete_route: 'DELETE /workspaces/task/{task_id}/action/{id} — returns { message: "success" }; 404 "resource not found" for an unknown id.',
    create_required: ['description'],
    read_is_broken:
      'GET /workspaces/task/{task_id}/action is mapped to the WRITE resource `microstrate.workspaces.put.task-action`, so it invokes AddTaskActionHandler and returns 400 "description is required" (verified live 2026-07-29). ListTaskActionsHandler exists at workspaces-service/handler/task_actions.go:94 and is registered as `get.task-actions` in service/service.go, but no gateway mapping points at it. Fix: repoint the GET mapping at microstrate.workspaces.get.task-actions.',
    unverifiable:
      'The write handler responds with your own request body echoed back (response.SuccessWithBody(request, body)), not the stored aggregate. With no read route, NOTHING about a task action can be confirmed after writing — including whether a partial write merges or replaces. Treat every write as unverified until the GET is fixed.',
    resource_shape: '{ resource_id, resource_type, metadata? } — both ids are free-form strings; the service does not validate that the resource exists.',
    frontend_support: 'None yet — no component in microstrate/src reads or writes task actions, so an action you create is invisible in the UI.',
    validation_quirk:
      '`description` is required on EVERY write, not just creates: the handler checks it before touching the store, so a call that only means to flip `done` still has to resend the description.',
    example: TASK_ACTION_EXAMPLE,
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
    task_id: 'Server-generated: `{SPACEID}-{n}` when the task has an existing space, else `t_<nanoid>`. Any id you send on create is ignored.',
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
      'GET    /workspaces/space/{space_id}/tasks → get.tasks  (per-space list + filters)',
      'POST   /workspaces/task                   → post.task  (title required; id server-generated)',
      'PATCH  /workspaces/tasks                  → patch.tasks (batch; returns index-keyed object)',
      'GET    /workspaces/task/{id}              → get.task   (task + watchers[] + muted[])',
      'PATCH  /workspaces/task/{id}              → patch.task (merge; accepts time_tracking)',
      'DELETE /workspaces/task/{id}              → delete.task ({message:success})',
    ],
    task_actions: [
      'PUT    /workspaces/task/{task_id}/action        → put.task-action    (create/update; description always required)',
      'DELETE /workspaces/task/{task_id}/action/{id}   → delete.task-action ({message:success})',
      'GET    /workspaces/task/{task_id}/action        → put.task-action    ** MISROUTED ** — points at the WRITE resource, so it runs the add handler and 400s. The list handler (get.task-actions) has no route. Not exposed as a tool because it cannot work.',
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
    not_exposed: [
      'workspaces-service also exposes my-tasks, task watch/mute, meetings, task-event-schedules, change-log, tasks-export, and reindex. This MCP is scoped to the spec\'d space/task/comment operations (matching how quiva-records-mcp / quiva-agents-mcp were scoped).',
      'Three newer route groups are live on the gateway but deliberately NOT exposed here, because each is a subsystem of its own rather than a task/space operation. All three were probed live 2026-07-29 and the notes below are what the probe actually returned:',
      '  FILES & FOLDERS — GET/DELETE /workspaces/files, POST/DELETE /workspaces/files/folder, PATCH /workspaces/file/{name}/metadata, GET /workspaces/files/trash, POST /workspaces/files/restore. `GET /workspaces/files` and `GET /workspaces/files/trash` both answer 200 with { results, results_total }; files are addressed by a dotted path (spaces.<SPACE_ID>.<folder>...), and "." is the folder separator so it cannot appear inside a name segment.',
      '  FILE APPROVALS — GET/POST /workspaces/approvals, GET/DELETE /workspaces/approvals/{id}, PATCH .../approve, PATCH .../reject, GET/POST .../events. The list REQUIRES a `file_subject` query param (without it: 400 "file subject is required"; `subject` and `file` are not accepted). approve/reject are the only PUBLIC routes in workspaces-service — they are reachable unauthenticated so an emailed approval link works. This overlaps the file-generator approvals surface that quiva-documents-mcp covers.',
      '  CLIENT FOLDERS — POST /workspaces/client. One call does three things: creates a folder object `spaces.{space_id}.{First Last - email}` in the microstrate-workspaces bucket, registers it in the file hierarchy index, and creates a record in the `Client` record config via the records service. Requires space_id + first_name + last_name + email; 409 "folder exists" if it is already there. Dots in the folder name (from the email) are rewritten to "·" because "." is the path separator. Not probed live — it writes into a real space AND a real record config, so exercising it needs a throwaway space.',
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
        'A migrated marker\'s index entry has an EMPTY `name` while its `subject` is correct. The subject is `ms.workspace-files.` + one base64 RawStdEncoding segment per path segment, and the engine decodes it in this exact case (transform.ObjKeyUnsafe). list_files adds a resolved `key` to every entry — use it. Matching on `name` makes empty folders invisible and makes a poll-until-indexed loop hang forever.',
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
    how_deployment_is_triggered:
      'Updating an account with a `verticals` array. accounts-service updateaccount.go then runs `go deployVerticals(...)` — a goroutine, so it is fire-and-forget and the account-update response tells you nothing about whether it worked.',
    rules_that_bite: [
      'THE CATEGORY FOLDER NAME IS THE ROUTING KEY. It is the first path segment after `spaces.VERTICAL.<vertical>.`, and an unrecognised name is silently skipped (`if !ok { continue }`) — no error, no log line. A folder named `record_config` instead of `record_configs` deploys nothing and says nothing.',
      'DEPLOYMENT IS DELTA-ONLY. Only verticals NOT already on the account are deployed. Re-adding a vertical that is already listed deploys NOTHING — to redeploy you must remove it, save, and re-add.',
      'THERE IS NO DEPENDENCY ORDER. Files deploy in index-listing order, so a space referencing the `Client` record config can be created before `Client` exists. Deploy SHARED first and confirm it landed.',
      'MARKER FILES NEVER DEPLOY — both `.metadata.json` and `.__meta__.json` suffixes are skipped.',
      'FLOWS get a collection created for them (name = the vertical id split on `_` and title-cased, e.g. insurance_broker -> "Insurance Broker") and have `collection` + `auto_publish: true` injected into the payload.',
      'ASSISTANTS must be wrapped as `{ "config": { ... } }` and have `config.shared` FORCED to "team", whatever you wrote.',
      'The only observability is a stream: microstrate.accounts.<account_id>.deploy-verticals, one message per file with { name, vertical, config_type, subject, status, error }.',
    ],
    space_configs_and_record_configs:
      'A space config under `spaces/` may attach record configs. `record_configs: [{ id, form_id? }]` is the CURRENT shape and WINS on read; `record_config_ids: [string]` is LEGACY and is only read when `record_configs` is absent (microstrate/src/components/spaces/records/space-record-configs.utils.ts:12). Persisting from the UI writes `record_configs` and DELETES `record_config_ids`. So adding a config to `record_config_ids` alone, while `record_configs` is present, is silently ignored — write BOTH and keep them identical, and treat `record_configs` as authoritative.',
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
  VERTICAL_SPACE_ID,
  VERTICAL_CONFIG_TYPES,
  FOLDER_MARKERS,
};
