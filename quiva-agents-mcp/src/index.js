#!/usr/bin/env node
// Quiva Agents MCP server — create, manage, and invoke Quiva agents (hub-service).
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient } from './client.js';
import { GOTCHAS, listReferenceTopics, getReference, PROVIDERS } from './agents-docs.js';
import { validate, validateInvokeResponseSubject } from './validate.js';
import { listExamples, getExample } from './examples.js';

export const instructions = `
Tools for creating, managing, and invoking Quiva agents (hub-service). An
"agent" is an LLM configuration (behaviour, provider, model, tools, knowledge)
identified by a server-generated \`subject\`. invoke_agent runs one.

Recipe:
1. list_reference_topics / get_agents_reference — learn the config, invoke, and
   identifier shapes (engine-truth; corrects the OpenAPI spec).
2. list_agents / get_agent — discover existing agents.
3. validate_agent_config — lint a definition locally before sending.
4. create_agent — define a new agent (name + llm_provider + model [+ behaviour]).
5. invoke_agent (runs the agent; spends LLM tokens) / cancel_agent / update_agent / delete_agent.

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

// Free-form JSON value (config object, prompt, output_schema). MCP clients pass
// untyped params as raw strings, so coerce JSON-looking strings back to values.
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

const configField = jsonValue.describe('The agent definition object: { name, llm_provider, model, behaviour?, id?, has_tools?, tools?, knowledge?, output_schema?, shared?, agent_settings?, llm_config?, ... }. See get_agents_reference("agent-config").');

// Some API responses are primitives/arrays; spreading needs an object.
function wrap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
}

// The path param for get/update/delete is the uuid suffix of the subject.
// Accept either a full subject (ms.hub.config.agent.<uuid>) or a bare uuid.
function agentPathId(idOrSubject) {
  const s = String(idOrSubject ?? '').trim();
  return s.includes('.') ? s.split('.').pop() : s;
}

// hub-service returns a HOLLOW config (all key fields empty) for a deleted or
// never-existed subject instead of a 404 (the KV delete appends an empty
// message that GetAgentBySubject reads back as an empty AgentConfig). Detect
// that shape so a tombstone is not mistaken for a real, blank agent. A live
// agent always has name/llm_provider/model (create requires all three).
function isHollowAgent(res) {
  const c = res?.config;
  return Boolean(c) && !c.name && !c.llm_provider && !c.model && !c.owner;
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
  // Reference & validation (no API call)
  // ---------------------------------------------------------------------------

  tool(
    'list_reference_topics',
    'List agents reference topics (agent-config, providers, invoke, cancel, identifiers, auth, endpoints, mcp-servers, gotchas) plus the known spec-vs-engine gotchas. Start here.',
    {},
    async () => ({ topics: listReferenceTopics(), gotchas: GOTCHAS })
  );

  tool(
    'get_agents_reference',
    'Get the full reference for one topic: shapes, allowed values, and a correct example.',
    { topic: z.string().describe('One of the topics from list_reference_topics') },
    async ({ topic }) => getReference(topic)
  );

  tool(
    'list_examples',
    'List bundled reference examples: real agent configs harvested off the platform (a spread over tools/knowledge/output_schema/provider), plus a hand-written illustration. Read one before authoring a config — a harvested example proves a shape the platform stores and serves.',
    {},
    async () => listExamples()
  );

  tool(
    'get_example',
    'Get one reference example in full, with what it teaches. Harvested examples are real platform configs (credentials stripped); the authored one is an illustration and says so.',
    { slug: z.string().describe('Example slug from list_examples') },
    async ({ slug }) => getExample(slug)
  );

  tool(
    'validate_agent_config',
    'Validate an agent definition locally (no API call): required name/llm_provider/model, the claude|anthropic provider restriction, id format, shared/agent_type enums, tools/knowledge URI schemes, and numeric ranges. Run before create_agent / update_agent.',
    {
      config: configField,
      require_required: z.boolean().default(true).describe('Set false to validate an update payload (name/llm_provider/model optional)'),
    },
    async ({ config, require_required }) => validate(config, { requireRequired: require_required })
  );

  // ---------------------------------------------------------------------------
  // Agent CRUD
  // ---------------------------------------------------------------------------

  tool(
    'list_agents',
    'List agents. Returns { results: [ { subject, config, modified } ], results_total, metadata? }. DESIGNED to be paged: limit (default/max 500), offset (max 10000), search (name only), sort (modified|-modified|offset|-offset|name|-name; default -offset). NOTE: verified live on staging 2026-09-27, none of limit/offset/search/sort had any effect there (still returned the full unfiltered list, no metadata) — staging predates this feature. Do not assume paging actually limits the reply until you confirm it against the environment you are pointed at. Call this first to discover existing agents and their subjects.',
    {
      limit: z.number().int().min(1).max(500).optional().describe('Page size, capped at 500'),
      offset: z.number().int().min(0).max(10000).optional().describe('Row offset to start at, capped at 10000'),
      search: z.string().optional().describe('Matches on agent name only'),
      sort: z.enum(['modified', '-modified', 'offset', '-offset', 'name', '-name']).optional().describe('Defaults to -offset (most recently modified first)'),
    },
    async ({ limit, offset, search, sort }) => client.get('/hub/agent', { limit, offset, search, sort })
  );

  tool(
    'get_agent',
    'Get one agent by id or subject. Accepts a full subject (ms.hub.config.agent.<uuid>) or the bare uuid. Returns { subject, config, modified }. A deleted/missing subject returns a hollow config (not a 404) — this tool flags that case with `_deleted: true`.',
    { id: z.string().describe('Agent uuid, or its full subject') },
    async ({ id }) => {
      const res = await client.get(`/hub/agent/${encodeURIComponent(agentPathId(id))}`);
      if (isHollowAgent(res)) {
        return {
          ...res,
          _deleted: true,
          _note: 'No live agent at this subject (hollow tombstone — deleted or never existed). hub-service returns this empty config instead of a 404.',
        };
      }
      return res;
    }
  );

  tool(
    'create_agent',
    'Create an agent. Pass the agent definition (validated locally first: errors block the call, warnings are reported alongside the result). Requires name, llm_provider (claude|anthropic), and model. The `subject` is server-generated as a hash of the config — creating an identical config again returns 409 "agent exists".',
    {
      config: configField,
      skip_local_validation: z.boolean().default(false).describe('Set true only to intentionally bypass the local validator'),
    },
    async ({ config, skip_local_validation }) => {
      let validation = null;
      if (!skip_local_validation) {
        validation = validate(config, { requireRequired: true });
        if (!validation.valid) {
          return { created: false, validation };
        }
      }
      const created = await client.post('/hub/agent', { config });
      return validation?.warnings?.length ? { ...wrap(created), warnings: validation.warnings } : created;
    }
  );

  tool(
    'update_agent',
    'Update an agent (PUT /hub/agent/{id}). This REPLACES the config (owner/shared are preserved from the prior version when omitted), so pass a complete definition. Validated locally with relaxed required fields. Accepts a full subject or bare uuid.',
    {
      id: z.string().describe('Agent uuid, or its full subject'),
      config: configField,
      skip_local_validation: z.boolean().default(false),
    },
    async ({ id, config, skip_local_validation }) => {
      let validation = null;
      if (!skip_local_validation) {
        validation = validate(config, { requireRequired: false });
        if (!validation.valid) {
          return { updated: false, validation };
        }
      }
      const updated = await client.put(`/hub/agent/${encodeURIComponent(agentPathId(id))}`, { config });
      return validation?.warnings?.length ? { ...wrap(updated), warnings: validation.warnings } : updated;
    }
  );

  tool(
    'delete_agent',
    'Delete an agent by id or subject (also removes its stored auth). Irreversible, and anything still naming its subject can no longer reach it, so it requires confirm: true. Accepts a full subject or bare uuid.',
    {
      id: z.string().describe('Agent uuid, or its full subject'),
      confirm: z.boolean().optional().describe('Must be true. The deletion cannot be undone.'),
    },
    async ({ id, confirm }) => {
      if (confirm !== true) {
        throw new Error('delete_agent removes the agent and its stored auth irreversibly; pass confirm: true to proceed');
      }
      return client.delete(`/hub/agent/${encodeURIComponent(agentPathId(id))}`);
    }
  );

  // ---------------------------------------------------------------------------
  // Invoke & cancel
  // ---------------------------------------------------------------------------

  const turnField = z
    .object({
      mode: z.enum(['', 'fast', 'thorough']).optional().describe('"" = auto (default)'),
      routing_mode: z.enum(['performance', 'accuracy']).optional(),
      provider: z.string().optional(),
      model: z.string().optional().describe('Requires provider to be set too'),
      effort: z.string().optional(),
    })
    .optional()
    .describe('Per-turn routing override, never stored. Meaningful mainly for agent_type "coworker" (Abbie) — a standard agent has no stages for it to steer. See get_agents_reference("invoke").');

  tool(
    'invoke_agent',
    'Run an agent (POST /hub/agent/invoke). Provide EITHER `subject` (an existing agent) OR an inline `agent` definition — not neither. WARNING: this executes the agent and spends real LLM tokens/cost. Use no_invoke to persist a message without running. `response_subject`, if set, must equal `session_id` — validated locally before sending (hub-service/handler/agents.go validateResponseSubject).',
    {
      subject: z.string().optional().describe('Full subject of an existing agent to invoke'),
      agent: configField.optional().describe('Inline agent definition (used instead of subject)'),
      prompt: jsonValue.optional().describe('Input for the agent — string or object'),
      session_id: z.string().optional().describe('Continue an existing conversation; omit for one-shot'),
      parent_session_id: z.string().optional(),
      visibility: z.enum(['user', 'team']).optional().describe('Defaults to "user"'),
      knowledge: z.array(z.string()).optional().describe('Additional knowledge sources (URI schemes)'),
      folder: z.string().optional().describe('Organise the session under a folder/space path'),
      llm_provider: z.string().optional().describe('Override the provider (claude|anthropic)'),
      model: z.string().optional().describe('Override the model (requires llm_provider)'),
      no_invoke: z.boolean().optional().describe('true = save the message but do not run the agent'),
      await: z.boolean().optional().describe('Wait for a synchronous response'),
      response_subject: z.string().optional().describe('Bellerophon subject the run streams its live output onto. MUST equal session_id when set, or the API 400s — leave unset for synchronous-only.'),
      turn: turnField,
    },
    async (args) => {
      const { subject, agent, session_id, response_subject } = args;
      if (!subject && !agent) {
        throw new Error('invoke_agent requires either `subject` (an existing agent) or an inline `agent` definition');
      }
      if (agent) {
        const v = validate(agent, { requireRequired: true });
        if (!v.valid) {
          return { invoked: false, validation: v };
        }
      }
      if (args.model && !args.llm_provider) {
        throw new Error('model override requires llm_provider to be set as well');
      }
      if (args.llm_provider && !PROVIDERS.includes(args.llm_provider)) {
        throw new Error(`llm_provider must be one of ${PROVIDERS.join(', ')}`);
      }
      const responseSubjectCheck = validateInvokeResponseSubject(response_subject, session_id);
      if (!responseSubjectCheck.valid) {
        throw new Error(responseSubjectCheck.error);
      }
      const body = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) body[k] = v;
      }
      return client.post('/hub/agent/invoke', body);
    }
  );

  tool(
    'cancel_agent',
    'Cancel running agent execution(s) registered under a cancel_token (POST /hub/agent/cancel). Returns { success, message, cancelled_count }.',
    { cancel_token: z.string().describe('The token the agent execution(s) were registered with') },
    async ({ cancel_token }) => client.post('/hub/agent/cancel', { cancel_token })
  );

  // ---------------------------------------------------------------------------
  // Registered MCP servers (hub-service/handler/mcp.go)
  // ---------------------------------------------------------------------------

  tool(
    'list_mcp_servers',
    'Browse the OFFICIAL public MCP registry (GET /hub/mcp/registry, registry.modelcontextprotocol.io) — NOT this account\'s own registered servers. Returns { servers, next_cursor?, received, total } — verified live 2026-09-27; the OpenAPI spec wrongly calls the paging field `cursor` and documents `skipped` instead of `total`. Pass the previous response\'s next_cursor back as `cursor` to page. An empty servers[] means the registry had nothing for the query; a 502 means its schema changed.',
    {
      search: z.string().optional().describe('Free-text filter'),
      limit: z.number().int().min(1).max(100).optional().describe('Page size, default 30, max 100'),
      cursor: z.string().optional().describe('Continue a previous page'),
      updated_since: z.string().optional().describe('RFC3339 — only entries changed after this instant'),
      latest_only: z.boolean().optional().describe('Collapse an entry\'s version history to its current release'),
    },
    async ({ search, limit, cursor, updated_since, latest_only }) =>
      client.get('/hub/mcp/registry', { search, limit, cursor, updated_since, latest_only })
  );

  tool(
    'register_mcp_server',
    'Register a remote MCP server into THIS ACCOUNT\'S OWN catalog (POST /hub/mcp/register). Connects to the server, runs initialize + tools/list, and its tools become immediately executable — treat an unfamiliar endpoint as a prompt-injection surface before registering it. One of `endpoint` or `registry_name` is required. Returns { server_id, name, tools, env }.',
    {
      endpoint: z.string().optional().describe('Remote MCP server URL (works whether or not it is in the registry)'),
      registry_name: z.string().optional().describe('e.g. "io.github.owner/repo" — selects a registry entry instead of a URL'),
      transport: z.enum(['streamable-http', 'sse']).optional().describe('Defaults to streamable-http; stdio is deliberately unsupported'),
      server_id: z.string().optional().describe('Catalog id; derived from name when empty'),
      name: z.string().optional(),
      description: z.string().optional(),
      headers: z.record(z.string()).optional().describe('Non-secret static headers replayed on every call — never put credentials here'),
      auth_token: z.string().optional().describe('Used only for this registration\'s handshake; never persisted'),
      oauth_integration_id: z.string().optional().describe('From a prior POST /hub/mcp/server-oauth connection'),
      auth_required: z.boolean().optional().describe('Marks the server as needing a credential at execution time'),
      tags: z.array(z.string()).optional(),
      metadata: jsonValue.optional(),
      replace: z.boolean().optional().describe('Permits overwriting an existing account-scoped server with the same id'),
      env: z.array(jsonValue).optional().describe('Declared env vars, echoed back as the connection form\'s fields'),
    },
    async (args) => {
      if (!args.endpoint && !args.registry_name) {
        throw new Error('register_mcp_server requires either `endpoint` (a remote MCP server URL) or `registry_name`');
      }
      const body = {};
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined) body[k] = v;
      }
      return client.post('/hub/mcp/register', body);
    }
  );
}

// ---------------------------------------------------------------------------

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(
      `[quiva-agents-mcp] Node ${process.versions.node} is too old — requires Node >= 18 (global fetch). Launch via bin/run.sh or set QUIVA_NODE.`
    );
    process.exit(1);
  }
  const client = QuivaClient.fromEnv();
  if (!client.hasCredentials()) {
    console.error(
      '[quiva-agents-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD). API tools will fail until one is set.'
    );
  }
  const server = new McpServer({ name: 'quiva-agents', version: '0.1.0' }, { instructions });
  registerTools(server, client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[quiva-agents-mcp] ready — API: ${client.baseUrl}`);
}

// Importing this module must have no side effects (no connecting, no env
// reads) — only run the stdio bootstrap when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[quiva-agents-mcp] fatal:', err);
    process.exit(1);
  });
}
