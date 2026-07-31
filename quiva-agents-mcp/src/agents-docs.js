// Agents reference data — derived from the hub-service engine source
// (hub-service/handler/agents.go, hub-service/model/agents.go,
// hub-service/service/service.go), NOT just the OpenAPI spec (quiva-agents.json).
// Where the spec and engine disagree, the engine wins and the discrepancy is
// captured in GOTCHAS.

// Gotchas: spec-vs-engine truths the validator lints and the tools encode.
export const GOTCHAS = [
  // Identifier semantics — three different "ids".
  'An agent has THREE distinct identifiers. (1) `subject` — the real identifier, SERVER-GENERATED as `ms.hub.config.agent.<uuid>`, where the uuid is an MD5 hash of the submitted config (CreateAgentHandler blanks any subject you send). (2) the `{id}` path param for GET/PUT/DELETE `/hub/agent/{id}` — this is just the uuid suffix of the subject (frontend does subject.split(".").pop()). (3) `config.id` — a human-facing label inside the config; it is NOT the identifier and is not used for routing. Because the subject is a hash of the config, creating the same config twice returns 409 "agent exists:<subject>".',
  // Auth reality — broader than records.
  'Every agent endpoint (create/get/update/delete/invoke/list) derives the user/account from the Bearer JWT (transform.GetUserID / GetDecodedToken / GetUserPublicKey) and returns 401 without one. The API gateway resolves X-Api-Key, but these handlers need the JWT claims — so an API key alone is insufficient. Use a bearer token or email/password auth.',
  // Provider restriction.
  'invoke_agent accepts only llm_provider "claude" or "anthropic"; any other value returns 400 "unsupported provider" (hub-service/handler/agents.go). The spec\'s enum lists only "claude"; "anthropic" also works. The stored model jsonschema mentions workforce/gemini/openai but the invoke handler rejects them.',
  // Wrapper body shape.
  'Create and update send the agent definition WRAPPED: `{ "config": { ...name, llm_provider, model, behaviour, ... } }`. The agent fields live under `config` (engine model.AgentConfig = { config, subject, modified }). This MCP\'s create_agent/update_agent tools take the inner definition and build the wrapper for you.',
  // Update semantics.
  'Update is PUT `/hub/agent/{id}` (registered under the `put` route group — the spec\'s x-resource "microstrate.hub.patch.agent" is wrong). It REPLACES the config you send; only `owner` and `shared` are carried over from the prior version when omitted. It is not a per-field merge, so send a complete config. A top-level `subject` is optional — the `{id}` in the path is enough.',
  // Invoke request shape.
  'invoke_agent takes either `subject` (an existing agent\'s full subject) OR an inline `agent` definition — not both, and 400 if neither. The spec example field `agent_subject` is IGNORED (the engine field is `subject`). `prompt` (string or object) is expected but not strictly enforced by the engine. Useful extra fields the spec omits: `folder`, `llm_provider`/`model` (override), `no_invoke`, `session_id`, `parent_session_id`, `visibility` ("user"|"team", defaults to "user").',
  // Dead cancel knobs.
  'Cancellation is done via cancel_agent (POST /hub/agent/cancel with { cancel_token }), which hub-service forwards to the agent-service subject microstrate.agent.api.cancel. The spec\'s invoke-time `x-cancel-id` query param and `cancel_token` body field are NOT read by hub-service (they are an agent-service/gateway concern) — do not rely on them to arm a cancel token here.',
  // List envelope.
  'list_agents returns `{ results: [ { subject, config, modified } ], results_total, page?, page_size? }` — each item is the full agent wrapper, not a summary, with per-user private-auth merged into config.auth. The create response is `{ subject, config, modified }` (there is no `type` field despite the spec); get returns `{ subject, config, modified }` (the spec\'s `confg` key is a typo for `config`).',
  // Delete + get-after-delete (verified live on staging).
  'delete_agent genuinely removes the agent (it disappears from list_agents and a second delete returns 404 "agent not found"), BUT get_agent on a deleted/missing subject does NOT 404 — it returns a HOLLOW config with all-empty fields (name/llm_provider/model/owner = ""). The KV delete appends an empty message that GetAgentBySubject reads back as an empty AgentConfig. This MCP\'s get_agent flags that shape with `_deleted: true`; to test existence, rely on list_agents or the empty-config signal, not on get erroring. (Likely a hub-service bug — GetAgentHandler should 404 on a tombstone.)',
  // Injected thinking budget vs max_tokens (hit live 2026-07-29).
  'llm_config.max_tokens at or below 8000 makes invoke_agent FAIL with 400 "EXECUTION_ERROR: thinking_tokens must be less than max_tokens (thinking=8000, max=N)" — even though the config stores and reads back perfectly. bellerophon-workforce/cmd/agent-service/service/process_invoke.go:893-902 injects thinking_enabled=true and thinking_tokens=8000 for any field the caller left unset, and never reconciles that budget with max_tokens. Fix: raise max_tokens above 8000, set llm_config.thinking_tokens below max_tokens explicitly (injection only fills nil fields), or omit max_tokens. 8 of the 144 live configs with an llm_config are in this state and cannot be invoked.',
  // Result shape (verified live 2026-07-29, twice).
  'invoke_agent returns the answer as a STRING even when output_schema is set, and it is NOT raw JSON — it comes back MARKDOWN-FENCED (```json\\n{...}\\n```), so a bare JSON.parse THROWS. Extract the object before parsing: JSON.parse(String(result).match(/\\{[\\s\\S]*\\}/)[0]). In a flow, do that in an eval node between the agent node and any condition.',
];

// llm_provider values the invoke handler actually accepts.
const PROVIDERS = ['claude', 'anthropic'];

// Model identifiers documented in the spec's AgentConfig.model description.
// The model string is free-form on the wire (validated downstream), so treat
// this as guidance, not an enforced enum.
const MODELS = [
  'claude-haiku-4-5', // default
  'claude-sonnet-4',
  'claude-sonnet-4-5',
  'claude-opus-4-5',
  'claude-opus-4-1',
];

// agent_type built-in values (empty = standard LLM agent).
const AGENT_TYPES = ['', 'deep-research'];

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
  visibility: 'user',
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
      'POST /hub/agent/invoke runs an agent. Provide EITHER `subject` (existing agent) OR an inline `agent` definition — 400 if neither. `prompt` may be a string or an object. Optional: session_id (continue a conversation), parent_session_id, visibility ("user"|"team", default "user"), knowledge[], folder, llm_provider + model (override), no_invoke (save the message without running), await, response_subject (async). Note: invoking spends real LLM tokens/cost.',
    fields: {
      subject: 'Full subject of an existing agent (ms.hub.config.agent.<uuid>).',
      agent: 'Inline agent definition (same shape as agent-config), used instead of subject.',
      prompt: 'string | object — the input for the agent to process.',
      session_id: 'Continue an existing conversation; omit for one-shot/new.',
      visibility: VISIBILITY,
      knowledge: 'Additional knowledge sources for this invocation (URI schemes).',
      folder: 'Organise the resulting session under a folder/space path.',
      no_invoke: 'true = persist the message but do not run the agent.',
    },
    example_inline: INVOKE_INLINE_EXAMPLE,
    example_subject: INVOKE_SUBJECT_EXAMPLE,
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
      'All agent endpoints need a Bearer JWT (the handlers read user/account claims from it). An API key alone is resolved by the gateway but lacks those claims and will 401 on most tools. Configure QUIVA_BEARER_TOKEN or QUIVA_EMAIL/QUIVA_PASSWORD.',
  },
  'endpoints': {
    summary: 'The hub-service agent surface exposed by this MCP (REST path → engine route key).',
    agents: [
      'POST   /hub/agent          → post.agent        (create; body { config }; 409 if the config hash already exists)',
      'GET    /hub/agent          → get.list-agents   (list; { results, results_total, page?, page_size? })',
      'GET    /hub/agent/{id}     → get.agent         (id = uuid suffix of the subject)',
      'PUT    /hub/agent/{id}     → put.agent         (replace config; owner/shared preserved)',
      'DELETE /hub/agent/{id}     → delete.agent',
      'POST   /hub/agent/invoke   → post.invoke-agent (run an agent; subject OR inline agent)',
      'POST   /hub/agent/cancel   → post.cancel-agents (forward { cancel_token } to agent-service)',
    ],
    not_exposed: [
      'hub-service also exposes favorites, user-context, history, sessions, agent-query, marketplace, and mcp-server management routes. This MCP is scoped to the 7 spec\'d agent operations above (matching how quiva-records-mcp / quiva-flows-mcp were scoped).',
    ],
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
