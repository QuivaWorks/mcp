#!/usr/bin/env node
// Quiva Flows MCP server — build, publish, run and debug Quiva workflows.
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient, subjectToTopics } from './client.js';
import { applyGeometry } from './geometry.js';
import { GOTCHAS, JSONPATH_GUIDE, getNodeTypeReference, listNodeTypes } from './node-docs.js';
import {
  getExample,
  getReference,
  listExamples,
  listReferenceTopics,
} from './reference-docs.js';
import { validate } from './validate.js';

export const instructions = `
Tools for building and running Quiva workflows (DAGs of nodes connected by edges).

Recipe for building a flow:
1. list_node_types / get_node_type_reference — learn the node shapes (engine-truth, corrects the OpenAPI spec).
2. list_reference_topics / get_flows_reference — the cross-cutting contracts. Read "rules-syntax" BEFORE building any
   condition / rules node: those use the rule-engine v2 DSL ({ condition, outcome } branches, NOT { if, then, else }).
3. list_examples / get_example — REAL published workflows harvested from the platform. Copy their conventions rather
   than inventing a payload shape; get_example("client-folder-creation") is the canonical condition-node reference.
4. list_collections (create_collection if needed) — flows live in a workflow collection.
5. list_functions / list_quiva_endpoints — discover valid "subject" values for function / quiva-endpoint nodes.
6. validate_flow_config — lint the config locally before sending.
7. create_workflow — creates a draft (auto-fills flow-editor geometry so the graph renders).
8. publish_workflow — makes it runnable.
9. run_workflow (await: true) — execute and inspect the result.
10. Debug with search_run_logs / list_errored_workflows / list_paused_workflows; iterate with update_workflow (re-publish after updating).

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

// Free-form JSON value (payloads, configs, triggers). MCP clients pass
// untyped params as raw strings, so coerce JSON-looking strings back to
// values — otherwise a trigger object arrives at the flow as a string.
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

const configSchema = z
  .object({
    nodes: z.array(jsonValue).describe('Array of node definitions: { id, data: { id, node_type, payload, ... }, position? }'),
    edges: z.array(jsonValue).default([]).describe('Array of edges: { id, source, target }'),
    static: z.record(jsonValue).optional().describe('Static variables available via $.static'),
    result: z
      .union([z.string(), z.record(jsonValue)])
      .optional()
      .describe('Run return value: a JSONPath string (e.g. "$.FINAL_NODE.result") or an object template whose values are JSONPath-resolved'),
    options: jsonValue.optional().describe('Run options: { run_type: normal|debounced|ordered, order_on, debounce_on, debounce_time, debounce_max }'),
  })
  .passthrough();

// Some API responses are primitives/arrays; spreading needs an object.
function wrap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
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
  // Reference & validation
  // ---------------------------------------------------------------------------

  tool(
    'list_node_types',
    'List all workflow node types with one-line summaries, plus the JSONPath data-reference guide and known gotchas. Start here.',
    {},
    async () => ({ node_types: listNodeTypes(), jsonpath_guide: JSONPATH_GUIDE, gotchas: GOTCHAS })
  );

  tool(
    'get_node_type_reference',
    'Get the full reference for one node type: required/optional payload props, node-level props, and a correct minimal example.',
    { node_type: z.string().describe('One of the types returned by list_node_types') },
    async ({ node_type }) => getNodeTypeReference(node_type)
  );

  tool(
    'list_reference_topics',
    'List the queryable reference topics (rules-syntax, jsonpath, geometry, lifecycle, gotchas). Read "rules-syntax" before building any condition or rules node.',
    {},
    async () => listReferenceTopics()
  );

  tool(
    'get_flows_reference',
    'Get a full reference topic. "rules-syntax" is the rule-engine v2 DSL for condition/rules nodes (engine-truth; the flow editor labels branches IF/ELSE IF/ELSE but the wire format is { condition, outcome }).',
    { topic: z.string().describe('One of the topics from list_reference_topics') },
    async ({ topic }) => getReference(topic)
  );

  tool(
    'list_examples',
    'List real published workflows bundled as reference examples (harvested from the platform, credentials redacted). These configs are known to run — prefer their conventions over inventing a payload shape.',
    {},
    async () => listExamples()
  );

  tool(
    'get_example',
    'Get a bundled reference example: the full config of a real published workflow, plus what it teaches. "client-folder-creation" is the canonical condition-node example; "product-selection-rules" covers a rules payload with chained facts.',
    { slug: z.string().describe('Example slug from list_examples') },
    async ({ slug }) => getExample(slug)
  );

  tool(
    'validate_flow_config',
    'Validate a workflow config locally (no API call): server rules (ids, reserved words, node types, task operations, schedule attempts, payloads, subjects, edges), cycle detection, per-node-type required props, and spec-vs-engine gotcha lints. Run this before create_workflow / update_workflow. There is no public server-side validate endpoint on api.quiva.ai; publish_workflow is where the server validator runs.',
    { config: configSchema.describe('The workflow config: { nodes, edges, static?, result?, options? }') },
    async ({ config }) => validate(config)
  );

  // ---------------------------------------------------------------------------
  // Collections
  // ---------------------------------------------------------------------------

  tool(
    'list_collections',
    'List workflow (or node) collections. Workflows must be created inside a collection; the collection "subject" is needed for create_workflow.',
    {
      collection_type: z.enum(['workflow', 'node']).default('workflow'),
    },
    async ({ collection_type }) => client.get('/hub/collections', { collection_type })
  );

  tool(
    'create_collection',
    'Create a new workflow collection. Needs the root, admin or developer role (403 otherwise).',
    {
      name: z.string().describe('Collection name'),
      description: z.string().optional(),
      collection_type: z.enum(['workflow', 'node']).default('workflow'),
    },
    async ({ name, description, collection_type }) =>
      client.post('/hub/collections', { name, description, collection_type })
  );

  // ---------------------------------------------------------------------------
  // Workflows CRUD
  // ---------------------------------------------------------------------------

  tool(
    'list_workflows',
    'List workflows, optionally filtered by collection topic (last segment of the collection subject) and draft/published version.',
    {
      collection_topic: z.string().optional().describe('Last segment of the collection subject, e.g. "2408930879"'),
      version: z.enum(['draft', 'published']).optional().describe('Omit for all versions'),
    },
    async ({ collection_topic, version }) =>
      client.get('/hub/workflows', { collection_topic, version })
  );

  tool(
    'get_workflow',
    'Fetch a workflow (its config, nodes and edges) by subject.',
    {
      subject: z.string().describe('Workflow subject, e.g. ms.hub.config.workflow.draft.{collection}.{flow}'),
      draft: z.boolean().default(true).describe('true = draft version, false = published version'),
    },
    async ({ subject, draft }) => {
      const { collectionTopic, flowTopic } = subjectToTopics(subject);
      return client.get(`/hub/workflows/${collectionTopic}/${flowTopic}`, { draft: String(draft) });
    }
  );

  tool(
    'create_workflow',
    'Create a new workflow (draft) in a collection. The config is validated locally first (errors block the call; warnings are reported alongside the result) and then server-side. Publish it afterwards to make it runnable. Needs the root, admin or developer role (403 otherwise).',
    {
      name: z.string().describe('Unique workflow name within the collection'),
      collection: z
        .string()
        .describe('Collection subject: ms.hub.config.collection.workflow.{collection_id} (from list_collections)'),
      description: z.string().optional(),
      config: configSchema.describe('Workflow config: { nodes, edges, static?, result?, options? }'),
      secrets: z.array(z.string()).optional().describe('Secret identifiers used by the workflow'),
      skip_local_validation: z.boolean().default(false).describe('Set true only to intentionally bypass the local validator'),
      auto_layout: z
        .boolean()
        .default(true)
        .describe('Fill in missing flow-editor presentation fields (node position/type/measured, edge type/edgeType/handles) so the graph renders. Set false to send the config untouched.'),
      server_validate: z
        .boolean()
        .default(true)
        .describe('Send validate=true so the server also applies the node-id regex, the payload-required check and the function/flow subject-exists checks. Set false only to save a UI-authored flow whose nanoid ids (with hyphens) fail that regex. false does NOT skip the checks every write runs: empty or malformed node/edge ids (. * > @ whitespace), unknown node_type, record/task trigger ids. publish_workflow then runs the full server validator whatever this was.'),
    },
    async ({ name, collection, description, config, secrets, skip_local_validation, auto_layout, server_validate }) => {
      let validation = null;
      if (!skip_local_validation) {
        validation = validate(config);
        if (!validation.valid) {
          return { created: false, validation };
        }
      }
      const { config: finalConfig, added } = auto_layout ? applyGeometry(config) : { config, added: [] };
      const created = await client.post(
        '/hub/workflows',
        { name, description, collection, config: finalConfig, secrets },
        { validate: String(server_validate) }
      );
      const extras = {};
      if (validation?.warnings?.length) extras.warnings = validation.warnings;
      if (added.length) extras.geometry_added = added;
      return Object.keys(extras).length ? { ...wrap(created), ...extras } : created;
    }
  );

  tool(
    'update_workflow',
    'Update a workflow (partial: name, description, config, archived, secrets). Updating a published workflow creates a new draft — publish again to go live. Config passes local validation first. Needs the root, admin or developer role (403 otherwise).',
    {
      subject: z.string().describe('Workflow subject (draft or published)'),
      name: z.string().optional(),
      description: z.string().optional(),
      archived: z.boolean().optional().describe('true archives the workflow (cannot be executed)'),
      config: configSchema.optional(),
      secrets: z.array(z.string()).optional(),
      skip_local_validation: z.boolean().default(false),
      auto_layout: z
        .boolean()
        .default(true)
        .describe('Fill in missing flow-editor presentation fields so the graph renders. Set false to send the config untouched.'),
      server_validate: z
        .boolean()
        .default(true)
        .describe('Send validate=true so the server also applies the node-id regex, the payload-required check and the function/flow subject-exists checks. Set false only to save a UI-authored flow whose nanoid ids (with hyphens) fail that regex. false does NOT skip the checks every write runs: empty or malformed node/edge ids (. * > @ whitespace), unknown node_type, record/task trigger ids. publish_workflow then runs the full server validator whatever this was.'),
    },
    async ({ subject, name, description, archived, config, secrets, skip_local_validation, auto_layout, server_validate }) => {
      let validation = null;
      let geometryAdded = [];
      if (config && !skip_local_validation) {
        validation = validate(config);
        if (!validation.valid) {
          return { updated: false, validation };
        }
      }
      if (config && auto_layout) {
        const laid = applyGeometry(config);
        config = laid.config;
        geometryAdded = laid.added;
      }
      const { collectionTopic, flowTopic } = subjectToTopics(subject);
      // The handler requires the draft subject in the body (path params alone
      // are not reliably mapped) and only drafts can be updated.
      const body = { subject: `ms.hub.config.workflow.draft.${collectionTopic}.${flowTopic}` };
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (archived !== undefined) body.archived = archived;
      if (config !== undefined) body.config = config;
      if (secrets !== undefined) body.secrets = secrets;

      const updated = await client.patch(`/hub/workflows/${collectionTopic}/${flowTopic}`, body, {
        validate: String(server_validate),
      });
      const extras = {};
      if (validation?.warnings?.length) extras.warnings = validation.warnings;
      if (geometryAdded.length) extras.geometry_added = geometryAdded;
      return Object.keys(extras).length ? { ...wrap(updated), ...extras } : updated;
    }
  );

  tool(
    'publish_workflow',
    'Publish a draft workflow, making it executable via run_workflow. Also wires up any schedule triggers. The server runs its full validator here and refuses on any error (unknown node_type, bad task operation, disallowed quiva-endpoint subject, options.attempts on a schedule node, dangling edge). Needs the root, admin or developer role (403 otherwise).',
    {
      subject: z.string().describe('Draft workflow subject: ms.hub.config.workflow.draft.{collection}.{flow}'),
      commit: z.string().optional().describe('Commit message describing the change'),
    },
    async ({ subject, commit }) => client.post('/hub/workflows/publish', { subject, commit })
  );

  tool(
    'delete_workflow',
    'Delete a workflow — both the draft and the published version by default. Set keep_draft=true to remove only the published version and leave the draft in place. Irreversible (no undo, no recycle bin), so it requires confirm: true. Needs the root, admin or developer role (403 otherwise).',
    {
      subject: z.string().describe('Workflow subject (draft or published)'),
      keep_draft: z.boolean().default(false).describe('true = delete only the published version, keeping the draft'),
      confirm: z.boolean().optional().describe('Must be true. The deletion cannot be undone.'),
    },
    async ({ subject, keep_draft, confirm }) => {
      if (confirm !== true) {
        throw new Error('delete_workflow removes the flow irreversibly; pass confirm: true to proceed');
      }
      const { collectionTopic, flowTopic } = subjectToTopics(subject);
      // No keep_draft in the engine: ?draft=true resolves a ".draft." subject, which deletes both versions.
      const response = await client.delete(`/hub/workflows/${collectionTopic}/${flowTopic}`, {
        draft: String(!keep_draft),
      });
      return {
        ...wrap(response),
        deleted: keep_draft ? 'published version only (draft kept)' : 'draft and published',
      };
    }
  );

  tool(
    'get_workflow_history',
    'Get the version history of a workflow.',
    {
      subject: z.string().describe('Workflow subject'),
      draft: z.boolean().default(true),
    },
    async ({ subject, draft }) => {
      const { collectionTopic, flowTopic } = subjectToTopics(subject);
      return client.get(`/hub/workflows/${collectionTopic}/${flowTopic}/history`, {
        draft: String(draft),
      });
    }
  );

  // ---------------------------------------------------------------------------
  // Execution & debugging
  // ---------------------------------------------------------------------------

  tool(
    'run_workflow',
    'Execute a published (or draft) workflow. Every node runs for real: HTTP calls, emails and record writes happen, and agent nodes spend LLM tokens. Use await=true to get results synchronously. Resume a paused (human-in-the-loop) run by passing run_id plus the human response as trigger. On accounts routed through the run queue, an awaited run can return 429 + Retry-After (run limit full: wait and retry), 504 (not finished before the gateway timeout; it may still complete, so check search_run_logs before re-running), 409 (this attempt is already queued) or 503 + Retry-After.',
    {
      subject: z.string().describe('Workflow subject (published, or draft for test runs)'),
      trigger: jsonValue.optional().describe('Input object, referenced in nodes via $.trigger'),
      triggers: z.array(jsonValue).optional().describe('Batch execution: array of trigger objects (use instead of trigger)'),
      await: z.boolean().default(true).describe('Wait for completion and return results'),
      enable_log: z.boolean().default(true).describe('Store detailed run logs (searchable via search_run_logs)'),
      knowledge: z.array(z.string()).optional().describe('Knowledge URIs for agents: kv://, obj://, str://, sid://, dta://'),
      session_id: z.string().optional().describe('Session id for agent conversation continuity'),
      run_id: z.string().optional().describe('Existing run/tracking id to resume a paused run'),
      retry: z.boolean().optional().describe('Retry a failed run'),
    },
    async ({ subject, trigger, triggers, await: shouldAwait, enable_log, knowledge, session_id, run_id, retry }) => {
      const body = { subject, await: shouldAwait, enable_log };
      if (trigger !== undefined) body.trigger = trigger;
      if (triggers !== undefined) body.triggers = triggers;
      if (knowledge !== undefined) body.knowledge = knowledge;
      if (session_id !== undefined) body.session_id = session_id;
      if (run_id !== undefined) body.run_id = run_id;
      if (retry !== undefined) body.retry = retry;
      return client.post('/hub/workflows/run', body);
    }
  );

  tool(
    'list_paused_workflows',
    'List workflow runs paused for human input (input / human-in-the-loop nodes). Resume with run_workflow (run_id + trigger).',
    { flow_subject: z.string().optional().describe('Filter by workflow subject') },
    async ({ flow_subject }) => client.get('/hub/workflows/paused', { flow_subject })
  );

  tool(
    'list_errored_workflows',
    'List workflow runs that ended in an error, including the failing node and lookup state.',
    { flow_subject: z.string().optional().describe('Filter by workflow subject') },
    async ({ flow_subject }) => client.get('/hub/workflows/errored', { flow_subject })
  );

  tool(
    'search_run_logs',
    'Search workflow run logs by indexed fields (run_id, flow_topic, collection_topic, status, session_id, error, draft).',
    {
      conditions: z
        .array(
          z.object({
            field: z.string().describe('Indexed field, e.g. "flow_topic", "status", "run_id"'),
            keyword: z.string().describe('Value to match'),
          }).passthrough()
        )
        .describe('Search conditions (ANDed)'),
      limit: z.number().int().positive().optional(),
    },
    async ({ conditions, limit }) => {
      const body = { conditions };
      if (limit !== undefined) body.limit = limit;
      return client.post('/hub/run-logs/search', body);
    }
  );

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  tool(
    'list_functions',
    'List available compute (Hydra) functions — their subjects are what function nodes reference in data.subject.',
    {},
    async () => client.get('/compute/functions')
  );

  tool(
    'list_quiva_endpoints',
    'List available Quiva endpoints — their subjects are what quiva-endpoint nodes reference in data.subject.',
    {},
    async () => client.get('/hub/quiva-endpoints')
  );

  // ---------------------------------------------------------------------------
  // Payload helpers
  // ---------------------------------------------------------------------------

  tool(
    'test_jsonpath',
    'Test a JSONPath expression against sample data using the real engine resolver. Use to verify node payload references before building a flow.',
    {
      data: jsonValue.describe('Sample lookup data, e.g. { "trigger": {...}, "MY_NODE": {...} }'),
      path: jsonValue.describe('JSONPath expression or template object to resolve, e.g. "$.trigger.email"'),
    },
    async ({ data, path }) => client.post('/hub/test-jpath', { data, path })
  );

  tool(
    'test_eval',
    'Test an eval-node payload (JavaScript code + params) using the real engine evaluator.',
    {
      code: z.string().describe('JavaScript expression, as used in an eval node payload'),
      params: z.record(jsonValue).describe('Params object; plain values (JSONPath already resolved)'),
    },
    async ({ code, params }) => client.post('/hub/test-eval', { code, params })
  );

  tool(
    'test_http',
    'Test an http/integration-node request through the engine (supports a lookup object for JSONPath resolution).',
    {
      method: z.string().describe('HTTP method'),
      url: z.string().describe('Full URL or path (combine with base_url semantics resolved before calling)'),
      headers: z.record(z.string()).optional(),
      params: z.record(jsonValue).optional(),
      data: jsonValue.optional().describe('Request body'),
      lookup: z.record(jsonValue).optional().describe('Lookup data for resolving $.X references in the request'),
    },
    async ({ method, url, headers, params, data, lookup }) =>
      client.post('/hub/test-http', { method, url, headers, params, data, lookup })
  );
}

// ---------------------------------------------------------------------------

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(
      `[quiva-flows-mcp] Node ${process.versions.node} is too old — requires Node >= 18 (global fetch). Launch via bin/run.sh or set QUIVA_NODE.`
    );
    process.exit(1);
  }
  const client = QuivaClient.fromEnv();
  if (!client.hasCredentials()) {
    console.error(
      '[quiva-flows-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD). API tools will fail until one is set.'
    );
  }
  const server = new McpServer({ name: 'quiva-flows', version: '0.1.0' }, { instructions });
  registerTools(server, client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[quiva-flows-mcp] ready — API: ${client.baseUrl}`);
}

// Importing this module must have no side effects (no connecting, no env
// reads) — only run the stdio bootstrap when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[quiva-flows-mcp] fatal:', err);
    process.exit(1);
  });
}
