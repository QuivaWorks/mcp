// Reference for Abbie's settings API, read from hub-service source (evari-olympus main 6af2ba497).
// Where the app and the engine disagree, the engine wins.

export const GOTCHAS = [
  'Every hub-service response is `{ status_code, body }` (hub-service/response/response.go). This MCP unwraps it and treats an error status_code inside the envelope as a failure.',
  'Scope is silently widened. Memory and env resolve ANY scope other than "user" (case- and whitespace-insensitive) to organisation (hub-service/handler/org_memory.go resolveMemoryScope, hub-service/handler/coworker_env.go resolveCoworkerEnvScope); todos resolve anything other than "organisation" (same matching) to user (hub-service/handler/coworker_todo_store.go normalize). This MCP requires scope and refuses anything but "organisation" or "user".',
  'Organisation memory writes are NOT admin-gated on the server: any member can add, change or delete a memory every member\'s Abbie reads (hub-service/handler/org_memory.go PostCoworkerOrgMemoryHandler). This MCP requires confirm: true for them.',
  'Moving a todo out of "awaiting_user" to "pending" or "in_progress" RESUMES Abbie\'s run and spends tokens (hub-service/handler/coworker_todo_work.go coworkerTodoUnparks, publishCoworkerUnpark). update_todo refuses that change without confirm: true.',
  'The organisation profile and the personal profile are whole-document writes, and `{}` means "clear it" (hub-service/handler/coworker_profile.go PutCoworkerProfileHandler, hub-service/handler/coworker_personal_profile.go PutCoworkerPersonalProfileHandler). This MCP merges your fields over a fresh read, sends if_revision from that read, and refuses a write that would leave the profile empty.',
  'PUT on memory REPLACES topics: an omitted `topics` clears them (hub-service/handler/org_memory.go applyOrgMemoryUpdate). update_memory keeps the stored topics unless you send new ones.',
  'list_memories answers an empty list, not an error, when the store read fails (hub-service/handler/org_memory.go loadMemories). `total: 0` is not proof there are no memories.',
  'get_task_space answers the default "ESCALATE" when the stored setting cannot be read (hub-service/handler/coworker_task_space.go GetCoworkerTaskSpaceHandler); get_skill_exec answers enabled:false the same way (hub-service/handler/skill_exec.go). Neither distinguishes "unset" from "unreadable".',
  'promote_todo_to_task closes the todo (status done) and appends "[Promoted to workspace task <id>]" to its content. If the task is created but the todo update fails, the response is still 200 with `{ task, error }` (hub-service/handler/coworker_todo.go PostCoworkerTodoPromoteTaskHandler).',
  'Corrections are capped at 6 per person, and PUT replaces the whole list with no if_revision (hub-service/handler/coworker_corrections.go coworkerCorrectionsMaxEntries). update_corrections adds and removes by id over a fresh read, and refuses if the list moved before the PUT.',
  'An env value is either a literal or a SECRET::<name>:: reference. Literals are shown to Abbie\'s model; references are not (coworkerenv/coworkerenv.go CoworkerEnvVar.Secret). set_env refuses a literal for a key that looks like a credential.',
  'Admin gates read the `role` claim of the caller\'s token; only admin and root pass, and a failed role lookup answers 502, not 403 (hub-service/handler/coworker_authorisation.go coworkerAdminContext, hub-service/handler/account_role.go). An API-key token carries its user\'s role.',
];

const ENDPOINTS = [
  ['GET', '/hub/coworker/skills', 'member', 'list_skills'],
  ['POST', '/hub/coworker/skill/test', 'member', 'test_skill_activation'],
  ['GET', '/hub/coworker/skill-drafts', 'member', 'list_skill_drafts'],
  ['GET', '/hub/coworker/skill-exec', 'member', 'get_skill_exec'],
  ['GET', '/hub/coworker/todos', 'member (own + organisation)', 'list_todos'],
  ['PUT', '/hub/coworker/todo', 'member', 'update_todo'],
  ['POST', '/hub/coworker/todo/promote/task', 'member', 'promote_todo_to_task'],
  ['GET', '/hub/coworker/org-memories', 'member', 'list_memories'],
  ['POST', '/hub/coworker/org-memory', 'member (org scope: confirm)', 'create_memory'],
  ['PUT', '/hub/coworker/org-memory/{id}', 'member (org scope: confirm)', 'update_memory'],
  ['DELETE', '/hub/coworker/org-memory/{id}', 'member (org scope: confirm)', 'delete_memory'],
  ['GET', '/hub/coworker/profile', 'member', 'get_org_profile'],
  ['PUT', '/hub/coworker/profile', 'admin + confirm', 'update_org_profile'],
  ['GET', '/hub/coworker/personal-profile', 'caller only', 'get_personal_profile'],
  ['PUT', '/hub/coworker/personal-profile', 'caller only', 'update_personal_profile'],
  ['GET', '/hub/coworker/personality', 'member', 'get_personality'],
  ['GET', '/hub/coworker/corrections', 'caller only', 'list_corrections'],
  ['GET', '/hub/coworker/org-corrections', 'member', 'list_corrections'],
  ['GET', '/hub/coworker/correction-drafts', 'caller only', 'list_corrections'],
  ['PUT', '/hub/coworker/corrections', 'caller only', 'update_corrections'],
  ['GET', '/hub/coworker/task-space', 'member', 'get_task_space'],
  ['PUT', '/hub/coworker/task-space', 'admin + confirm', 'set_task_space'],
  ['GET', '/hub/coworker/env', 'member', 'list_env'],
  ['POST/PUT', '/hub/coworker/env', 'org scope: admin + confirm; user scope: caller', 'set_env'],
  ['DELETE', '/hub/coworker/env', 'org scope: admin + confirm; user scope: caller', 'delete_env'],
  ['GET', '/hub/coworker/model-catalog', 'member', 'get_model_catalog'],
  ['GET', '/hub/agent/model-pool', 'member', 'get_model_pool'],
  ['GET', '/hub/coworker/memory-consolidation', 'member', 'get_memory_settings'],
].map(([method, path, gate, tool]) => ({ method, path, gate, tool }));

const REFERENCE = {
  surfaces: {
    summary: 'The places Abbie\'s behaviour comes from, and who each one affects.',
    surfaces: [
      { name: 'organisation profile', scope: 'account', holds: 'facts about the organisation: what it does, systems of record, glossary, house style, always/never rules', tool: 'get_org_profile / update_org_profile' },
      { name: 'personality (voice)', scope: 'account', holds: 'free-text tone guidance, up to 4000 characters', tool: 'get_personality (read only here)' },
      { name: 'personal profile', scope: 'one person', holds: 'about_me, how_i_work, constraints', tool: 'get_personal_profile / update_personal_profile' },
      { name: 'memories', scope: 'organisation or user', holds: 'short standing facts Abbie remembers, with topics', tool: 'list_memories / create_memory / update_memory / delete_memory' },
      { name: 'corrections', scope: 'one person (admins can promote to the account)', holds: '"in this situation, do this instead" rules, max 6', tool: 'list_corrections / update_corrections' },
      { name: 'skills', scope: 'account', holds: 'instruction packs that activate on keywords or patterns', tool: 'list_skills / test_skill_activation (writes not exposed)' },
      { name: 'environment variables', scope: 'organisation or user', holds: 'config literals and SECRET:: references Abbie\'s tools can use', tool: 'list_env / set_env / delete_env' },
      { name: 'todos (backlog)', scope: 'organisation or user', holds: 'work Abbie is tracking, including items parked on a person', tool: 'list_todos / update_todo / promote_todo_to_task' },
    ],
  },

  'roles-and-gates': {
    summary: 'Which calls need an admin, and what this MCP adds on top.',
    rules: [
      'Member: any authenticated user of the account. The account comes from the token, so a caller only ever reaches their own account.',
      'Admin: token role admin or root (hub-service/handler/account_role.go callerIsAccountAdmin, hub-service/handler/coworker_todo.go isCoworkerTodoAdminRole). A non-admin gets 403; a role lookup failure gets 502.',
      'Caller only: the subject is keyed on the caller\'s own user id, so there is no way to read or write someone else\'s (personal profile, corrections, correction drafts).',
      'confirm: true is this MCP\'s gate, not the server\'s. It is required for every write that changes Abbie for the whole account: organisation memory, organisation profile, task space and organisation env.',
      'The gateway denies the `client` role on these routes by default (bellerophon-cerberus installs a deny-client authorizer when a mapping has none).',
      'A restricted (msr-) API key must allow /hub/coworker* and /hub/agent/model-pool.',
    ],
  },

  todos: {
    summary: 'Abbie\'s backlog: statuses, scopes, resuming, reminders, promotion.',
    statuses: ['pending', 'in_progress', 'done', 'awaiting_user', 'cancelled'],
    kinds: ['task', 'reminder'],
    list_filters: { status: 'one status', kind: 'task | reminder', open_only: 'true', scheduled: 'true', session_id: 'one chat session' },
    item_fields: ['id', 'content', 'status', 'owner_user_id', 'session_id', 'blocked_on', 'follow_up_at', 'details', 'kind', 'scope'],
    rules: [
      'list_todos returns the caller\'s own items and the organisation\'s, each tagged with `scope` (hub-service/handler/coworker_todo.go GetCoworkerTodosHandler).',
      'scope "user" always means the caller\'s own backlog; there is no way to address another person\'s.',
      'awaiting_user -> pending or in_progress resumes the run immediately (hub-service/handler/coworker_todo_work.go coworkerTodoUnparks). Other transitions do not.',
      'follow_up_at is only accepted together with status awaiting_user.',
      'acknowledge: true confirms a reminder that was already delivered; it is refused on anything not delivered.',
      'Cancel an item with status "cancelled". There is no delete.',
      'promote_todo_to_task creates a workspace task in space_id, else the account\'s task space, else ESCALATE (hub-service/handler/coworker_task_space.go resolveCoworkerTaskSpace), and closes the todo.',
    ],
  },

  skills: {
    summary: 'Skill shape, activation and drafts. Reads only in this MCP.',
    list_shape: '{ builtins: [...], disabled_builtins: [ids], skills: [user skills] } (hub-service/handler/skills.go GetCoworkerSkillsHandler)',
    skill_fields: ['id', 'name', 'title', 'description', 'keywords', 'patterns', 'negative_patterns', 'instruction', 'tool_ids', 'always_on', 'resources', 'disabled', 'source', 'exec_approved'],
    rules: [
      'test_skill_activation is a local keyword/pattern dry run on the server: no model call. `activated` would load now; `discoverable` could be loaded by Abbie on request.',
      'A skill with no keywords and no patterns is discovery-only: it never activates on its own.',
      'Drafts are skills Abbie proposed (status pending|approved|rejected|expired, origin explicit|proactive|refinement) (hub-service/handler/skill_drafts.go SkillDraft).',
      'get_skill_exec reports whether the account allows skills to run scripts. Enabling it is admin-only and not exposed here.',
      'Skill writes are not exposed: see not-exposed.',
    ],
  },

  memory: {
    summary: 'Memory scopes, limits, and delete vs purge.',
    shape: '{ id, memory, topics[], scope, created_at, updated_at, deleted }',
    list: 'list_memories(scope, q?, topic?, limit? (default 50, max 200), offset?) -> { memories, total }. `q` is a case-insensitive substring match; `total` counts matches before paging.',
    limits: 'memory: 2048 bytes; topics: at most 10, each 64 bytes (hub-service/handler/org_memory.go validateOrgMemoryInput).',
    rules: [
      'Organisation memories are read by every member\'s Abbie. User memories are the caller\'s own.',
      'delete keeps the text as a tombstone, which stops Abbie re-learning it; purge: true drops the text too (hub-service/handler/org_memory.go purgeMemoryEntry).',
      'An unreadable store lists as empty.',
    ],
  },

  profiles: {
    summary: 'Organisation profile, personal profile and personality.',
    org_profile_fields: {
      legal_name: 'string, 500', trading_names: 'string[], 10 x 200', what_we_do: 'string, 1000', industry: 'string, 200',
      regulator: 'string, 500', size: 'string, 200', locations: 'string, 500', financial_year_end: 'string, 100',
      systems_of_record: '[{ system (200), authoritative_for (300) }], 20', glossary: '[{ term (100), meaning (300) }], 40',
      working_hours: 'string, 300', timezone: 'string, 100', house_style: 'string, 1000',
      always: 'string[], 20 x 300', never: 'string[], 20 x 300', data_handling: 'string, 1000',
      whole_document: '8000 characters',
    },
    personal_profile_fields: { about_me: 1000, how_i_work: 1000, constraints: 1000, whole_document: 3000 },
    read_shape: 'Profile fields flat, plus is_default and revision.',
    rules: [
      'Limits are in characters (runes) (hub-service/handler/coworker_profile.go, hub-service/handler/coworker_personal_profile.go).',
      'update_* reads the current profile, merges the fields you pass, and sends if_revision. A 409 means someone saved in between: read again and retry.',
      'The organisation profile is admin-only and lands in every member\'s prompts.',
      'Personality (voice) is read-only here; changing it is an admin action in the app.',
    ],
  },

  corrections: {
    summary: 'Failure-derived rules: "in this situation, do this instead".',
    shape: '{ id, situation (150), instead (200), source: analyser|vote|manual, created_at }',
    rules: [
      'Each person keeps at most 6 (hub-service/handler/coworker_corrections.go).',
      'Drafts are proposals from Abbie\'s own analysis of a conversation; they never apply until the person approves them in the app.',
      'Organisation corrections apply to everyone. Promoting one is admin-only, REMOVES the person\'s own copy, and is not exposed here (hub-service/handler/coworker_org_corrections.go PostCoworkerCorrectionsPromoteHandler).',
      'update_corrections takes add[] and remove[] and writes the result as a whole list. PUT takes no if_revision: its 409 covers only the server\'s own load-to-save window (hub-service/handler/coworker_corrections.go PutCoworkerCorrectionsHandler), so a save between your read and the PUT would be overwritten. update_corrections re-reads just before the PUT and refuses if the list changed.',
    ],
  },

  'env-and-secrets': {
    summary: 'Environment variables for Abbie\'s tools, and how secrets stay out of the model.',
    shape: '{ key, value, secret, description?, server?, consumers?[], updated_by, updated_at }',
    rules: [
      'key matches ^[A-Z_][A-Z0-9_]*$, at most 64 characters.',
      'value is a literal or SECRET::<name>:: (no colons in the name). `secret` is derived by the server from the value, never taken from the client.',
      'Literals are visible to Abbie\'s model. References are resolved only at tool time against the caller\'s own secrets.',
      'set_env requires secret: true|false. secret: true accepts only a well-formed reference; a credential-looking key (KEY, TOKEN, SECRET, PASSWORD, AUTH, BEARER, DSN ...) with a literal is refused. That check matches whole _-separated words of the key only: it cannot see a credential under an innocent name (DB_URL holding a password) or inside the value, so it is a backstop, not a guarantee.',
      'list_env returns values exactly as stored: literals and references, never resolved secrets (hub-service/handler/coworker_env.go GetCoworkerEnvHandler).',
      'POST answers 409 if the key exists and PUT answers 404 if it does not; set_env reads first and picks the right one.',
      'Organisation scope writes are admin-only; user scope is the caller\'s own.',
    ],
  },

  models: {
    summary: 'Model catalog and the account\'s model pool.',
    rules: [
      'get_model_catalog -> { providers, partial }. partial: true means agent-service did not answer and only the account\'s custom providers are listed (hub-service/handler/model_catalog.go).',
      'get_model_pool returns the account\'s routing settings with provider keys redacted. If redaction fails it returns {} rather than an error (hub-service/handler/model_pool.go GetModelPoolHandler).',
      'Changing the model pool is not exposed: see not-exposed.',
    ],
  },

  'not-exposed': {
    summary: 'Routes deliberately left out, and why.',
    withheld: [
      { route: 'GET /hub/coworker/todos-admin', why: 'Returns every member\'s email alongside their backlog. Withheld for privacy.' },
      { route: 'PUT /hub/agent/model-pool', why: 'Has no admin gate on the server (hub-service/handler/model_pool.go PutModelPoolHandler) and carries provider keys. Any member could reroute the whole account.' },
      { route: 'PUT /hub/coworker/skill, PUT /hub/coworker/skill/settings, POST /hub/coworker/skill-draft/approve, DELETE /hub/coworker/skill/{id}', why: 'Member-gated but change skills for the whole account. A PUT that omits exec_approved resets it (hub-service/handler/skills.go).' },
      { route: 'PUT /hub/coworker/personality', why: 'Account-wide voice; left to the app.' },
      { route: 'PUT /hub/coworker/org-corrections, POST /hub/coworker/corrections/promote', why: 'Account-wide; promote removes the person\'s own copy.' },
      { route: 'correction and profile draft approve/dismiss', why: 'Approval is a person\'s decision in the app; dismissal is permanent.' },
      { route: 'skill-exec, native-provider-tools, memory-consolidation, rapport-analysis PUTs', why: 'Admin switches for the whole account; left to the app.' },
      { route: '/hub/coworker/authorisation*, /denial, /server-credential*', why: 'Integration consent and credentials.' },
      { route: 'POST /hub/agent/invoke (chat with Abbie)', why: 'Spends tokens across a multi-stage run and answers on a session stream. Use the Assistants server (quiva-agents invoke_agent).' },
    ],
    unmapped_on_production: [
      { route: 'GET /hub/coworker/skill-discover', note: 'Registered in hub-service and called by the app\'s skill Discover tab, but the gateway has no mapping (404).' },
      { route: 'POST /hub/coworker/todo/schedule', note: 'Registered in hub-service; no gateway mapping (404).' },
      { route: 'GET /hub/coworker/auto-approvals, POST /hub/coworker/session-read', note: 'Registered; no gateway mapping (404).' },
      { route: 'GET /hub/coworker/authorisation-status', note: 'Internal by design; must stay unmapped.' },
    ],
  },

  endpoints: { summary: 'Every route this MCP calls, with its gate.', values: ENDPOINTS },
  gotchas: { summary: 'Engine truths the tools encode.', values: GOTCHAS },
};

export function listReferenceTopics() {
  return Object.keys(REFERENCE).map((topic) => ({ topic, summary: REFERENCE[topic].summary }));
}

export function getReference(topic) {
  const doc = REFERENCE[topic];
  if (!doc) return { error: `Unknown topic "${topic}". Available: ${Object.keys(REFERENCE).join(', ')}` };
  return { topic, ...doc };
}

export { ENDPOINTS };
