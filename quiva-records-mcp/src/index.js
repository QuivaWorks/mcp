#!/usr/bin/env node
// Quiva Records MCP server — create and manage record configs and records.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient } from './client.js';
import { getExample, listExamples } from './examples.js';
import { GOTCHAS, listReferenceTopics, getReference } from './records-docs.js';
import { validate } from './validate.js';

const client = new QuivaClient();

const INSTRUCTIONS = `
Tools for creating and managing Quiva records. A "record config" defines a
schema (JSON Schema) plus optional form UI ("views") for a category of records;
"records" are data entries validated against a config's schema.

Recipe:
1. list_reference_topics / get_records_reference — learn the schema, view, and
   field shapes (engine-truth; corrects the OpenAPI spec).
2. get_records_reference("form-builder") — the COMPLETE spec for shaping a form
   UI from a schema (grid/field/array-field nodes; inputType/props/rules live on
   the NODE; input types + props per type; layout rules; worked examples).
3. get_records_reference("form-rules") — how to write conditional rules
   (json-logic-engine: visible/required/disabled/readonly/value).
4. list_examples / get_example — REAL record configs harvested from the platform.
   The "featured" ones have a working form UI; copy their conventions rather than
   inventing a layout. (Anything marked kind="authored" is a hand-written
   illustration, not evidence.)
5. list_record_configs / get_record_config — discover existing configs.
6. validate_record_config — lint a config locally before sending.
6. create_record_config — define a new record type (id + name + schema[, views]).
7. create_record / list_records / query_records / update_record — manage data.

To BUILD A FORM: put the schema in "schema", then build views.forms[].layout
as a grid tree whose field nodes carry inputType, props, and (optionally)
rules — NOT on the schema. Read form-builder and form-rules first.

Top gotchas:
${GOTCHAS.map((g) => `- ${g}`).join('\n')}
`.trim();

const server = new McpServer(
  { name: 'quiva-records', version: '0.1.0' },
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

// Free-form JSON value (schema, views, data). MCP clients pass untyped params
// as raw strings, so coerce JSON-looking strings back to values — otherwise a
// schema/data object arrives as a string and is rejected server-side.
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

const schemaField = jsonValue.describe('JSON Schema document: { type: "object", properties: {...}, required?: [...] }. Fields may embed `ui` and `display` hints.');
const viewsField = jsonValue.describe('Optional form UI layout: { forms?: [{ id, title, description?, layout: <root grid node> }], form?: <grid node, deprecated legacy single form>, table?: <table node> }. In a grid tree, a field leaf is { type: "field", field: "<dotted path>", inputType?, props?, rules? } — key is `field` (never `ref`) and inputType/props/rules live ON THE NODE, not on the schema. A leaf may also be { type: "array-field", field, props?, children } — a repeater bound to an array-of-object field, children `field` refs element-relative to items.properties. See get_records_reference("form-builder") and ("form-rules").');
const dataField = jsonValue.describe('Record data object; validated against the config schema.');

// Some API responses are primitives/arrays; spreading needs an object.
function wrap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
}

// ---------------------------------------------------------------------------
// Reference & validation (no API call)
// ---------------------------------------------------------------------------

tool(
  'list_reference_topics',
  'List records reference topics (schema, field-types, input-types, formatters, views, form-builder, form-rules, record, endpoints, gotchas) plus the known spec-vs-engine gotchas. Start here. For building a form UI, read "form-builder" and "form-rules".',
  {},
  async () => ({ topics: listReferenceTopics(), gotchas: GOTCHAS })
);

tool(
  'list_examples',
  'List bundled reference examples. "harvested" ones are REAL record configs pulled from the platform (known to work) — the featured ones have a working form UI. "authored" ones are hand-written illustrations only. Use these instead of inventing a schema or form layout.',
  {},
  async () => listExamples()
);

tool(
  'get_example',
  'Get one reference example in full: its schema, views (form layout with node-level inputType/props/rules), and what it demonstrates. Best starting point for building a form.',
  { slug: z.string().describe('Example slug from list_examples') },
  async ({ slug }) => getExample(slug)
);

tool(
  'get_records_reference',
  'Get the full reference for one topic: shapes, allowed values, and a correct example. Use "form-builder" for the complete form-UI-shaping spec and "form-rules" for conditional rule expressions.',
  { topic: z.string().describe('One of the topics from list_reference_topics (e.g. "form-builder", "form-rules", "views", "schema")') },
  async ({ topic }) => getReference(topic)
);

tool(
  'validate_record_config',
  'Validate a record config locally (no API call): id format, required name, schema sanity, view-node shapes (including the `field` vs `ref` gotcha), and dangling view references. Run before create_record_config / update_record_config.',
  {
    config: jsonValue.describe('The record config: { id, name, description?, label?, schema, views? }'),
    require_id: z.boolean().default(true).describe('Set false to validate an update payload (id/name optional)'),
  },
  async ({ config, require_id }) => validate(config, { requireId: require_id })
);

// ---------------------------------------------------------------------------
// Record configs
// ---------------------------------------------------------------------------

tool(
  'list_record_configs',
  'List record configurations. Optionally pass `ids` to batch-fetch specific configs. Call this first to discover available record types.',
  {
    ids: z.array(z.string()).optional().describe('Optional list of config ids to fetch (batch). Omit for all.'),
  },
  async ({ ids }) => client.get('/records/config', ids?.length ? { ids: ids.join(',') } : undefined)
);

tool(
  'get_record_config',
  'Get one record configuration (its schema and views) by id.',
  { id: z.string().describe('Record config id') },
  async ({ id }) => client.get(`/records/config/${encodeURIComponent(id)}`)
);

tool(
  'create_record_config',
  'Create a record configuration. Validated locally first (errors block the call; warnings are reported alongside the result). Requires id (^[a-zA-Z0-9_-]+$) and name; schema must be a valid JSON Schema; views optional. To include a form UI, build `views.forms[].layout` per get_records_reference("form-builder") (inputType/props/rules on the field nodes) and get_records_reference("form-rules"). Returns 409 if the id already exists.',
  {
    id: z.string().describe('Unique config id, immutable. Allowed: letters, numbers, underscore, hyphen.'),
    name: z.string().describe('Human-readable name'),
    description: z.string().optional(),
    label: z.string().optional(),
    schema: schemaField,
    views: viewsField.optional(),
    skip_local_validation: z.boolean().default(false).describe('Set true only to intentionally bypass the local validator'),
  },
  async ({ id, name, description, label, schema, views, skip_local_validation }) => {
    const config = { id, name, description, label, schema, views };
    let validation = null;
    if (!skip_local_validation) {
      validation = validate(config, { requireId: true });
      if (!validation.valid) {
        return { created: false, validation };
      }
    }
    const body = { id, name, schema };
    if (description !== undefined) body.description = description;
    if (label !== undefined) body.label = label;
    if (views !== undefined) body.views = views;
    const created = await client.post('/records/config', body);
    return validation?.warnings?.length ? { ...wrap(created), warnings: validation.warnings } : created;
  }
);

tool(
  'update_record_config',
  'Update a record configuration (PUT, partial — only the fields you pass are changed). The id is immutable. Editing the schema does NOT re-validate existing records. Validated locally first.',
  {
    id: z.string().describe('Record config id to update'),
    name: z.string().optional(),
    description: z.string().optional(),
    label: z.string().optional(),
    schema: schemaField.optional(),
    views: viewsField.optional(),
    skip_local_validation: z.boolean().default(false),
  },
  async ({ id, name, description, label, schema, views, skip_local_validation }) => {
    const body = {};
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;
    if (label !== undefined) body.label = label;
    if (schema !== undefined) body.schema = schema;
    if (views !== undefined) body.views = views;

    let validation = null;
    if (!skip_local_validation && (schema !== undefined || views !== undefined || name !== undefined)) {
      validation = validate({ id, ...body }, { requireId: false });
      if (!validation.valid) {
        return { updated: false, validation };
      }
    }
    const updated = await client.put(`/records/config/${encodeURIComponent(id)}`, body);
    return validation?.warnings?.length ? { ...wrap(updated), warnings: validation.warnings } : updated;
  }
);

tool(
  'delete_record_config',
  'Delete a record configuration AND all of its records (the records storage bucket is purged). Irreversible.',
  { id: z.string().describe('Record config id') },
  async ({ id }) => client.delete(`/records/config/${encodeURIComponent(id)}`)
);

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

tool(
  'list_records',
  'List every record belonging to one config (KV scan by config id). For filtered or cross-config queries use query_records.',
  { config_id: z.string().describe('Record config id') },
  async ({ config_id }) => client.get(`/records/${encodeURIComponent(config_id)}`)
);

tool(
  'query_records',
  'Search records by folder and/or space (index-backed). Requires folder OR space_id, and a Bearer-JWT credential (used to derive the tenant) — an API key alone is rejected here. Optionally narrow by config_id(s) and page with limit/offset. Sorted by created_at.',
  {
    folder: z.string().optional().describe('Folder id (folder or space_id required)'),
    space_id: z.string().optional().describe('Space id (folder or space_id required)'),
    config_id: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe('One config id → AND filter; multiple → OR group'),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
  },
  async ({ folder, space_id, config_id, limit, offset }) => {
    if (!folder && !space_id) {
      throw new Error('folder or space_id is required for query_records');
    }
    const query = { folder, space_id, limit, offset };
    if (config_id !== undefined) {
      query.config_id = Array.isArray(config_id) ? config_id.join(',') : config_id;
    }
    return client.get('/records', query);
  }
);

tool(
  'get_record',
  'Get a single record by config id and record id.',
  {
    config_id: z.string().describe('Record config id'),
    id: z.string().describe('Record id'),
  },
  async ({ config_id, id }) =>
    client.get(`/records/${encodeURIComponent(config_id)}/${encodeURIComponent(id)}`)
);

tool(
  'create_record',
  'Create a record under a config. The record id is server-generated (any id you pass is ignored). `data` is validated against the config schema unless validate=false. Set completed=true to let the record event fire any flow whose record trigger watches this config, or pass test_flow to run ONE named flow and suppress every configured trigger. See get_records_reference("flow-triggers").',
  {
    config_id: z.string().describe('Record config id'),
    data: dataField,
    folder: z.string().optional().describe('Optional folder to organize the record into'),
    space_id: z.string().optional().describe('Optional space to associate the record with'),
    validate: z
      .boolean()
      .optional()
      .describe(
        'Default true. Set false to SKIP schema validation entirely — the record is stored exactly as sent, including fields the schema does not define and required fields left out. Verified live: {"not_in_schema":123} 400s by default and 200s with validate:false. Use only for imports/backfills; a record written this way can break any form or flow that assumes the schema holds.'
      ),
    completed: z
      .boolean()
      .optional()
      .describe(
        'Set true to publish the record event to hub.trigger.record.<config_id>.<record_id>, which runs every published flow whose trigger node is trigger_type "record" on this config. Nothing fires without it — a plain create is silent.'
      ),
    test_flow: jsonValue
      .optional()
      .describe(
        'Run exactly ONE flow and suppress all configured triggers: { subject: "ms.hub.config.workflow[.draft].<collection>.<flow>", run_id: "<your id>" }. Both fields are required or hub-service ignores it and falls back to the normal trigger lookup. Unlike `completed`, this works with a DRAFT subject — the normal record trigger only matches published flows.'
      ),
  },
  async ({ config_id, data, folder, space_id, validate: validateData, completed, test_flow }) => {
    const body = { data: data ?? {} };
    if (folder !== undefined) body.folder = folder;
    if (space_id !== undefined) body.space_id = space_id;
    if (validateData !== undefined) body.validate = validateData;
    if (completed !== undefined) body.completed = completed;
    if (test_flow !== undefined) body.test_flow = test_flow;
    const created = await client.post(`/records/${encodeURIComponent(config_id)}`, body);
    // The create response is the REQUEST struct, not the stored Record: it echoes
    // `validate` and always includes `test_flow` (the Go field has no omitempty,
    // so it serialises as null). Neither is stored on the record — a later GET
    // shows neither. Flagged so the shape difference is not mistaken for state.
    if (validateData === false) {
      return {
        ...created,
        warning:
          'created with validate:false — the schema was NOT applied, so this record may not satisfy the config it belongs to. Forms and flows reading it can break on missing or unexpected fields.',
      };
    }
    return created;
  }
);

tool(
  'update_record',
  'Update a record (PUT). The `data` you pass is merged key-by-key into the existing record; folder/space_id are overwritten only when supplied. The MERGED data is re-validated against the current config schema unless validate=false. Set completed=true to fire record triggers on the update (event type "record-updated"). NOTE: update has no test_flow — that is create-only.',
  {
    config_id: z.string().describe('Record config id'),
    id: z.string().describe('Record id'),
    data: dataField.optional(),
    folder: z.string().optional(),
    space_id: z.string().optional(),
    validate: z
      .boolean()
      .optional()
      .describe(
        'Default true. Set false to skip schema validation of the merged result. Useful when the config schema has moved on and the stored record no longer satisfies it — validation runs against whatever the config defines NOW, so an unrelated field edit can otherwise be blocked by a pre-existing mismatch.'
      ),
    completed: z
      .boolean()
      .optional()
      .describe(
        'Persisted on the record. When true it also publishes hub.trigger.record.<config_id>.<record_id> with event type "record-updated", running matching published record-trigger flows. Unlike create, `completed` is STORED here (existing.Completed is assigned), so it shows up on later reads.'
      ),
  },
  async ({ config_id, id, data, folder, space_id, validate: validateData, completed }) => {
    const body = {};
    if (data !== undefined) body.data = data;
    if (folder !== undefined) body.folder = folder;
    if (space_id !== undefined) body.space_id = space_id;
    if (validateData !== undefined) body.validate = validateData;
    if (completed !== undefined) body.completed = completed;
    return client.put(`/records/${encodeURIComponent(config_id)}/${encodeURIComponent(id)}`, body);
  }
);

tool(
  'delete_record',
  'Permanently delete a single record by config id and record id. Irreversible.',
  {
    config_id: z.string().describe('Record config id'),
    id: z.string().describe('Record id'),
  },
  async ({ config_id, id }) =>
    client.delete(`/records/${encodeURIComponent(config_id)}/${encodeURIComponent(id)}`)
);

// ---------------------------------------------------------------------------

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(
      `[quiva-records-mcp] Node ${process.versions.node} is too old — requires Node >= 18 (global fetch). Launch via bin/run.sh or set QUIVA_NODE.`
    );
    process.exit(1);
  }
  if (!client.hasCredentials()) {
    console.error(
      '[quiva-records-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD). API tools will fail until one is set.'
    );
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[quiva-records-mcp] ready — API: ${client.baseUrl}`);
}

main().catch((err) => {
  console.error('[quiva-records-mcp] fatal:', err);
  process.exit(1);
});
