// Agents reference data — derived from the hub-service engine source
// (hub-service/handler/agents.go, hub-service/model/agents.go,
// hub-service/service/service.go), NOT just the OpenAPI spec (quiva-agents.json).
// Where the spec and engine disagree, the engine wins and the discrepancy is
// captured in GOTCHAS.

// Gotchas: spec-vs-engine truths the validator lints and the tools encode.
export const GOTCHAS = [
  // Identifier semantics — three different "ids".
  'An agent has THREE distinct identifiers. (1) `subject` — the real identifier, SERVER-GENERATED as `ms.hub.config.agent.<uuid>`, where the uuid is an MD5 hash of the submitted config (CreateAgentHandler blanks any subject you send). (2) the `{id}` path param for GET/PUT/DELETE `/hub/agent/{id}` — this is just the uuid suffix of the subject (frontend does subject.split(".").pop()). (3) `config.id` — a human-facing label inside the config; it is NOT the identifier and is not used for routing. Because the subject is a hash of the config, creating the same config twice returns 409 "agent exists:<subject>".',
  // Auth reality — verified live on staging 2026-09-27.
  'Every agent endpoint (create/get/update/delete/invoke/list) derives the user/account from the Bearer JWT (transform.GetUserID / GetDecodedToken / GetUserPublicKey). An API key works fine here too: cerberus swaps X-Api-Key for a user JWT before hub-service ever sees the request (bellerophon-cerberus/http/middleware/ms_auth.go:143), minted through the same generateAuthToken path as password login (accounts-service/accounts/auth.go:66-114), so the JWT claims these handlers read are present either way. The one caveat is scope: a restricted (msr-) API key carries only its own permissions, so it must be granted `/hub/agent*` or it 401s at the gateway before reaching these handlers at all.',
  // Provider restriction.
  'invoke_agent accepts only llm_provider "claude" or "anthropic"; any other value returns 400 "unsupported provider" (hub-service/handler/agents.go). The spec\'s enum lists only "claude"; "anthropic" also works. The stored model jsonschema mentions workforce/gemini/openai but the invoke handler rejects them.',
  // Wrapper body shape.
  'Create and update send the agent definition WRAPPED: `{ "config": { ...name, llm_provider, model, behaviour, ... } }`. The agent fields live under `config` (engine model.AgentConfig = { config, subject, modified }). This MCP\'s create_agent/update_agent tools take the inner definition and build the wrapper for you.',
  // Update semantics.
  'Update is PUT `/hub/agent/{id}` (registered under the `put` route group — the spec\'s x-resource "microstrate.hub.patch.agent" is wrong). It REPLACES the config you send; only `owner` and `shared` are carried over from the prior version when omitted. It is not a per-field merge, so send a complete config. A top-level `subject` is optional — the `{id}` in the path is enough.',
  // Invoke request shape.
  'invoke_agent takes either `subject` (an existing agent\'s full subject) OR an inline `agent` definition — not both, and 400 if neither. The spec example field `agent_subject` is IGNORED (the engine field is `subject`). `prompt` (string or object) is expected but not strictly enforced by the engine. Useful extra fields the spec omits: `folder`, `llm_provider`/`model` (override), `no_invoke`, `session_id`, `parent_session_id`, `visibility` ("user"|"team", defaults to "user"), `turn` (per-turn routing override, see the "invoke" reference topic).',
  // response_subject must equal session_id (hub-service/handler/agents.go validateResponseSubject).
  '`response_subject`, when set, MUST equal `session_id` or invoke_agent returns 400 "response_subject must match session_id" (and 400 "response_subject requires a session_id" if session_id is empty). hub-service/handler/agents.go:1087 enforces this because response_subject becomes the live-output stream subject cerberus\'s websocket gate parses a session id back out of — a mismatch would let a caller point their run\'s output at a subject attributed to someone else\'s session. This tool validates the pair locally before sending so the 400 arrives with a clear reason.',
  // Dead cancel knobs.
  'Cancellation is done via cancel_agent (POST /hub/agent/cancel with { cancel_token }), which hub-service forwards to the agent-service subject microstrate.agent.api.cancel. The spec\'s invoke-time `x-cancel-id` query param and `cancel_token` body field are NOT read by hub-service (they are an agent-service/gateway concern) — do not rely on them to arm a cancel token here.',
  // List envelope, paging (hub-service/handler/agent-list.go).
  'list_agents is DESIGNED to be paged: `limit` (default and max 500), `offset` (max 10000, rejected past that rather than silently clamped), `search` (matches on name only, max 128 runes / 6 tokens), and `sort` (one of "modified" | "-modified" | "offset" | "-offset" | "name" | "-name"; empty defaults to "-offset", most recently modified first — an unlisted value is a 400, not a silent fallback). Each item is the full agent wrapper `{ subject, config, modified }`, not a summary, with per-user private-auth merged into config.auth. VERIFIED LIVE ON STAGING 2026-09-27: none of it is in effect there — `limit`, `offset`, `search` and `sort` were all sent (individually and combined) and every call still returned the full 194-agent list with only `{ results, results_total }`, no `metadata` block, `search` matching nothing narrowed the set. Staging is running a build that predates this feature (hub-service/handler/agent-list.go). Treat `metadata { total_hits, limit, offset, next_offset, has_more }` as the ENGINE-DESIGNED shape, not a confirmed-live one — re-verify against whichever environment you are pointed at before relying on paging actually limiting the reply. The create response is `{ subject, config, modified }` (there is no `type` field despite the spec); get returns `{ subject, config, modified }` (the spec\'s `confg` key is a typo for `config`).',
  // Delete + get-after-delete (verified live on staging).
  'delete_agent genuinely removes the agent (it disappears from list_agents and a second delete returns 404 "agent not found"), BUT get_agent on a deleted/missing subject does NOT 404 — it returns a HOLLOW config with all-empty fields (name/llm_provider/model/owner = ""). The KV delete appends an empty message that GetAgentBySubject reads back as an empty AgentConfig. This MCP\'s get_agent flags that shape with `_deleted: true`; to test existence, rely on list_agents or the empty-config signal, not on get erroring. (Likely a hub-service bug — GetAgentHandler should 404 on a tombstone.)',
  // Injected thinking budget vs max_tokens (hit live 2026-07-29).
  'llm_config.max_tokens at or below 8000 makes invoke_agent FAIL with 400 "EXECUTION_ERROR: thinking_tokens must be less than max_tokens (thinking=8000, max=N)" — even though the config stores and reads back perfectly. bellerophon-workforce/cmd/agent-service/service/process_invoke.go:1046-1058 (resolvePlanner) injects thinking_enabled=true and thinking_tokens=8000 for any field the caller left unset (unless llm_config.effort is set), and never reconciles that budget with max_tokens. Fix: raise max_tokens above 8000, set llm_config.thinking_tokens below max_tokens explicitly (injection only fills nil fields), or omit max_tokens. 8 of the 144 live configs with an llm_config are in this state and cannot be invoked.',
  // Result shape (verified live 2026-07-29, twice).
  'invoke_agent returns the answer as a STRING even when output_schema is set, and it is NOT raw JSON — it comes back MARKDOWN-FENCED (```json\\n{...}\\n```), so a bare JSON.parse THROWS. Extract the object before parsing: JSON.parse(String(result).match(/\\{[\\s\\S]*\\}/)[0]). In a flow, do that in an eval node between the agent node and any condition.',
  // Model names (bellerophon-workforce/model/internal/model/model_info.go).
  'Use current model aliases: `claude-opus-5-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-haiku-4-5`. Older dated ids are silently remapped rather than rejected — `claude-opus-4-8`/`-4-7`/`-4-6`/`-4-5` all resolve to `claude-opus-5-5`, and `claude-sonnet-4-6`/`-4-5` both resolve to `claude-sonnet-5` (ResolveModelReplacement, model_info.go:231-266). A stored config keeps the old string; only the resolved model is actually invoked, so get_agent/list_agents can show a name that no longer runs as written.',
  // agent_type coworker (hub-service/handler/agents.go).
  '`agent_type: "coworker"` (or a subject equal to the well-known Coworker agent subject, `ms.hub.config.agent.coworker`) routes an invoke through Abbie\'s own cognition pipeline instead of a standard LLM call — llm_provider/model are ignored in favour of her per-stage model pool. A generic create/update/delete naming that subject is refused with 400 ("Abbie\'s configuration is not a standard agent config; use PUT /hub/coworker/personality to change her voice") — this is a config-write guard, not a restriction on invoking her.',
  // MCP server registry/registration (hub-service/handler/mcp.go).
  '`list_mcp_servers` (GET /hub/mcp/registry) browses the OFFICIAL public MCP registry (registry.modelcontextprotocol.io) — it does not list servers already registered on this account. `register_mcp_server` (POST /hub/mcp/register) connects to a remote MCP server, runs initialize + tools/list, and writes the result into THIS ACCOUNT\'S OWN catalog only (never the shared platform catalog) — registering a server makes its tools immediately executable, and both its tool descriptions and results enter model context, so treat an unfamiliar server as a prompt-injection surface before registering it. This route is deliberately reachable only from the browser/API, not from the workforce: nothing in bellerophon-workforce (Abbie\'s runtime) requests this subject, so an assistant can propose an integration but cannot install one itself.',
  // list_mcp_servers response shape disagrees with its own OpenAPI spec (verified live on staging 2026-09-27).
  'The OpenAPI spec documents BrowseMCPRegistryResponse as `{ servers, cursor, received, skipped }`, but a live call returns `{ servers, next_cursor, received, total }` — the paging field is actually named `next_cursor`, not `cursor`, and an undocumented `total` field appears instead of (or alongside) `skipped`. Pass the response\'s `next_cursor` value back as the request\'s `cursor` param to continue paging — the request param name and the response field name genuinely differ.',
];

// llm_provider values the invoke handler actually accepts.
const PROVIDERS = ['claude', 'anthropic'];

// Current model aliases (bellerophon-workforce/model/internal/model/model_info.go).
// The model string is free-form on the wire (validated downstream), so treat
// this as guidance, not an enforced enum. Older dated ids (claude-sonnet-4-6,
// claude-opus-4-5, ...) still work but are silently remapped onto these — see
// the model-names gotcha.
const MODELS = [
  'claude-haiku-4-5', // default
  'claude-sonnet-5',
  'claude-opus-5-5',
  'claude-fable-5-1',
];

// agent_type built-in values (empty = standard LLM agent). "coworker" routes
// through Abbie's own pipeline (hub-service/handler/agents.go CoworkerAgentType)
// — see the agent_type-coworker gotcha before creating/updating with it.
const AGENT_TYPES = ['', 'deep-research', 'coworker'];

// shared / visibility enums.
const SHARED = ['private', 'team', 'public'];
const VISIBILITY = ['user', 'team'];

// URI scheme prefixes for tools and knowledge sources.
const TOOL_SCHEMES = ['mcp://', 'fun://', 'bit://'];
const KNOWLEDGE_SCHEMES = ['kv://', 'obj://', 'str://', 'sid://', 'dta://'];

const CONFIG_EXAMPLE = {
  id: 'EMAIL_DRAFT',
  name: 'Email Draft',
  description: 'Drafts a reply to an email',
  behaviour: 'You are an expert assistant. Draft a concise, friendly reply to the email provided.',
  llm_provider: 'claude',
  model: 'claude-haiku-4-5',
  has_tools: false,
  knowledge: [],
  tools: [],
  timeout: 60000,
  context_limit: 200000,
  message_history_limit: 200,
  shared: 'private',
};

const INVOKE_INLINE_EXAMPLE = {
  agent: {
    name: 'data-analyzer',
    description: 'Analyzes data patterns',
    behaviour: 'You are a data analysis expert.',
    llm_provider: 'claude',
    model: 'claude-haiku-4-5',
    has_tools: false,
  },
  prompt: 'Analyze these sales trends: ...',
  visibility: 'team',
};

const INVOKE_SUBJECT_EXAMPLE = {
  subject: 'ms.hub.config.agent.8f5568aa-c88c-32d7-adfb-8565d367fb24',
  prompt: 'Summarize the attached document.',
  session_id: 'session_abc123',
  response_subject: 'session_abc123', // must equal session_id, or invoke_agent 400s
  visibility: 'user',
};

const TURN_EXAMPLE = {
  subject: 'ms.hub.config.agent.coworker',
  prompt: 'Draft the release notes for this week.',
  session_id: 'session_abc123',
  turn: { mode: 'thorough', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' },
};

const REFERENCE = {
  'agent-config': {
    summary:
      'The agent definition (the object that goes under `config`). Required for create: `name`, `llm_provider`, `model`. `behaviour` (system prompt) is strongly recommended. Optional: description, id (a label, not the identifier), has_tools, tools[], knowledge[], output_schema, timeout, context_limit, message_history_limit, agent_type, shared, appearance, agent_settings, llm_config, auth, allowed_agents, and the ai_* smart-context knobs.',
    required_for_create: ['name', 'llm_provider', 'model'],
    providers: PROVIDERS,
    models: MODELS,
    agent_types: AGENT_TYPES,
    shared: SHARED,
    tool_schemes: TOOL_SCHEMES,
    knowledge_schemes: KNOWLEDGE_SCHEMES,
    example: CONFIG_EXAMPLE,
  },
  'providers': {
    summary:
      'invoke_agent accepts only these llm_provider values; anything else is 400 "unsupported provider". `model` is a free-form string (not enforced as an enum on the wire); the values below are the ones documented in the spec.',
    values: PROVIDERS,
    models: MODELS,
    default_model: 'claude-haiku-4-5',
  },
  'invoke': {
    summary:
      'POST /hub/agent/invoke runs an agent. Provide EITHER `subject` (existing agent) OR an inline `agent` definition — 400 if neither. `prompt` may be a string or an object. Optional: session_id (continue a conversation), parent_session_id, visibility ("user"|"team", default "user"), knowledge[], folder, llm_provider + model (override), no_invoke (save the message without running), await, response_subject (must equal session_id — see gotchas), turn (per-turn routing override). Note: invoking spends real LLM tokens/cost.',
    fields: {
      subject: 'Full subject of an existing agent (ms.hub.config.agent.<uuid>).',
      agent: 'Inline agent definition (same shape as agent-config), used instead of subject.',
      prompt: 'string | object — the input for the agent to process.',
      session_id: 'Continue an existing conversation; omit for one-shot/new.',
      response_subject: 'Bellerophon subject the run streams its live output onto. Must equal session_id when set (hub-service/handler/agents.go validateResponseSubject) — this tool checks that before sending. Leave unset for synchronous-only, no stream.',
      visibility: VISIBILITY,
      knowledge: 'Additional knowledge sources for this invocation (URI schemes).',
      folder: 'Organise the resulting session under a folder/space path.',
      no_invoke: 'true = persist the message but do not run the agent.',
      turn: 'Per-turn routing override: { mode, routing_mode, provider, model, effort }. Never stored — relayed for this call only. `mode` is "" (auto) | "fast" | "thorough"; `routing_mode` is "performance" | "accuracy". Meaningful mainly for agent_type "coworker" (Abbie\'s pipeline) — a standard agent has no classifier/judge stages for it to steer. Model still requires provider; standard agents still accept only "claude"/"anthropic" (see PROVIDERS gotcha).',
    },
    example_inline: INVOKE_INLINE_EXAMPLE,
    example_subject: INVOKE_SUBJECT_EXAMPLE,
    example_turn: TURN_EXAMPLE,
  },
  'cancel': {
    summary:
      'POST /hub/agent/cancel with `{ cancel_token }`. hub-service forwards it to the agent-service (subject microstrate.agent.api.cancel) and relays `{ success, message, cancelled_count }`. The invoke-time x-cancel-id/cancel_token knobs in the spec are not consumed by hub-service.',
    example: { cancel_token: 'my-session-token-123' },
  },
  'identifiers': {
    summary:
      'subject vs {id} vs config.id — the single most common source of confusion. See the first gotcha.',
    subject: 'The real identifier: ms.hub.config.agent.<uuid>, server-generated as an MD5 hash of the config. Returned by create/get/list.',
    path_id: 'The `{id}` in /hub/agent/{id} for get/update/delete — just the uuid suffix of the subject. This MCP accepts either a full subject or a bare uuid and extracts the suffix.',
    config_id: 'config.id — a human-facing label inside the config. NOT the identifier, not used for routing.',
    collision: 'Same config bytes => same uuid => 409 "agent exists:<subject>" on create.',
  },
  'auth': {
    summary:
      'Any of the three auth options works on every agent endpoint. A Bearer JWT (email/password or a passed-in token) carries the claims directly. An X-Api-Key ALSO works: verified live on staging 2026-09-27, cerberus swaps it for a user JWT before hub-service sees the request, minted through the same path as password login. The only failure mode is scope — a restricted (msr-) key must be granted `/hub/agent*`, or the gateway 401s it before these handlers run at all. Configure QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD.',
  },
  'endpoints': {
    summary: 'The hub-service agent surface exposed by this MCP (REST path → engine route key).',
    agents: [
      'POST   /hub/agent          → post.agent        (create; body { config }; 409 if the config hash already exists)',
      'GET    /hub/agent          → get.list-agents   (list; paged — see list_agents gotcha; { results, results_total, metadata? })',
      'GET    /hub/agent/{id}     → get.agent         (id = uuid suffix of the subject)',
      'PUT    /hub/agent/{id}     → put.agent         (replace config; owner/shared preserved)',
      'DELETE /hub/agent/{id}     → delete.agent',
      'POST   /hub/agent/invoke   → post.invoke-agent (run an agent; subject OR inline agent)',
      'POST   /hub/agent/cancel   → post.cancel-agents (forward { cancel_token } to agent-service)',
      'GET    /hub/mcp/registry   → get.mcp-registry         (browse the OFFICIAL public MCP registry, not this account\'s own servers)',
      'POST   /hub/mcp/register   → post.register-mcp-server (register a remote MCP server into THIS ACCOUNT\'S catalog)',
    ],
    not_exposed: [
      'hub-service also exposes favorites, user-context, history, sessions, agent-query, marketplace, mcp-server-oauth, and single-server get/delete/list-mine routes. This MCP covers the 7 spec\'d agent operations plus the two MCP-registry operations above (matching how quiva-records-mcp / quiva-flows-mcp were scoped) — everything else awaits a workstream that needs it.',
    ],
  },
  'mcp-servers': {
    summary:
      'Two distinct operations, easy to conflate because both are called "MCP servers". list_mcp_servers browses the public MCP registry (an external catalog anyone can publish to) — it has nothing to do with what this account has registered. register_mcp_server connects to one specific remote server (by URL or a registry_name from that browse) and writes the result into this account\'s OWN catalog, making its tools immediately callable.',
    list_mcp_servers: {
      endpoint: 'GET /hub/mcp/registry',
      params: 'search, limit (default 30, max 100), cursor (pass back the previous response\'s `next_cursor` for the next page), updated_since (RFC3339), latest_only.',
      response: 'VERIFIED LIVE 2026-09-27, and it disagrees with the OpenAPI spec: `{ servers: [...], next_cursor?, received, total }` — the spec calls the paging field `cursor` and also documents `skipped`; the actual field is `next_cursor` and `total` is what came back instead. An empty servers[] means the registry genuinely had nothing for the query; a schema the parser cannot read is a 502, not an empty page.',
    },
    register_mcp_server: {
      endpoint: 'POST /hub/mcp/register',
      required: 'One of endpoint (a remote MCP server URL) or registry_name (e.g. "io.github.owner/repo", selects a registry entry instead).',
      optional: 'transport ("streamable-http" default | "sse" — stdio is deliberately unsupported), server_id, name, description, headers (non-secret, replayed on every call — never put credentials here), auth_token (used only for this registration\'s handshake, never persisted), oauth_integration_id (from a prior POST /hub/mcp/server-oauth), auth_required, tags, metadata, replace (allow overwriting an existing id), env (declared env vars).',
      response: '{ server_id, name, tools: [...] } — tools are whatever tools/list returned; env echoes back declared variables as a connection form would need them.',
      caution: 'Registering a server makes its tools immediately executable and puts both its tool descriptions and its results into model context — treat an unfamiliar endpoint as a prompt-injection surface, the same way you would an unreviewed npm package. This is a browser/API-only surface by design: bellerophon-workforce (Abbie\'s own runtime) never requests this subject, so she can propose an integration but cannot register one herself.',
    },
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
  PROVIDERS,
  MODELS,
  AGENT_TYPES,
  SHARED,
  VISIBILITY,
  TOOL_SCHEMES,
  KNOWLEDGE_SCHEMES,
  CONFIG_EXAMPLE,
};
