#!/usr/bin/env node
// Quiva Records MCP server — create and manage record configs and records.
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { QuivaClient } from './client.js';
import { getExample, listExamples } from './examples.js';
import { GOTCHAS, listReferenceTopics, getReference } from './records-docs.js';
import { validate, queryFilterWarnings } from './validate.js';

export const instructions = `
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
7. create_record_config — define a new record type (id + name + schema[, views,
   index_fields]). Saved table views: ("table-views"); wizards: ("flow").
8. create_record / upsert_record / list_records / query_records / update_record —
   manage data. Bulk: csv_import, export_records, purge_records ("bulk-operations").

To BUILD A FORM: put the schema in "schema", then build views.forms[].layout
as a grid tree whose field nodes carry inputType, props, and (optionally)
rules — NOT on the schema. Read form-builder and form-rules first.

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
const viewsField = jsonValue.describe('Optional UI: { forms?: [{ id, title, description?, layout: <root grid node> }], form?: <deprecated legacy single form>, table?: <table node>, tables?: [<named saved view>], flow?: <wizard> }. See get_records_reference("table-views") and ("flow"). In a grid tree, a field leaf is { type: "field", field: "<dotted path>", inputType?, props?, rules? } — key is `field` (never `ref`) and inputType/props/rules live ON THE NODE, not on the schema. A leaf may also be { type: "array-field", field, props?, children } — a repeater bound to an array-of-object field, children `field` refs element-relative to items.properties. See get_records_reference("form-builder") and ("form-rules").');
const dataField = jsonValue.describe('Record data object; validated against the config schema.');

// Some API responses are primitives/arrays; spreading needs an object.
function wrap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
}

// The contract artefact's `opts` digit string is derived; never send it.
const indexFieldsField = jsonValue.describe(
  'Array of { field (or key), type?: keyword (default) | text | number | date, or the aliases text_sortable | numeric | datetime, sortable?: boolean }. Replaces the stored list wholesale. See get_records_reference("index-fields").'
);
const sourceField = jsonValue.describe(
  'Make the config a REFERENCE to a published catalogue definition: { publisher_account_id, config_id, version?: "<n>" | "latest" }. Only name and views.tables stay local. See get_records_reference("config-source").'
);
const hiddenFieldsField = z
  .array(z.string())
  .optional()
  .describe('Dotted refs a form rule hid; only their schema `required` is relaxed.');
const suppressEventsField = z
  .boolean()
  .optional()
  .describe('true: publish no record event for this write (stops a flow re-triggering itself on its own record).');

// Filtering on a field missing from index_fields returns 200 and an empty page, indistinguishable from no match.
const filterCondition = z
  .object({
    field: z.string().optional().describe('Leaf: payload field declared in index_fields, or a record field. Omit on a group.'),
    keyword: z.string().optional().describe('Exact match on a keyword field'),
    term: z.string().optional().describe('Token match on a text field'),
    prefix: z.string().optional().describe('Prefix match'),
    operator: z.string().optional().describe('"AND" (default) or "OR" for a nested group; there is no NOT'),
    exact: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    date_start: z.string().optional(),
    date_end: z.string().optional(),
    conditions: z.array(z.any()).optional().describe('Nested group; max depth 4'),
  })
  .passthrough();
const filterField = z
  .union([z.array(filterCondition), z.object({ conditions: z.array(filterCondition), sort_by: z.string().optional() }).passthrough()])
  .optional()
  .describe('Conditions over declared index_fields — an array, or { conditions, sort_by }. Max depth 4, 50 conditions');
const fieldsField = z
  .union([z.array(z.string()), z.string()])
  .optional()
  .describe('Projection: payload paths each row keeps (array or comma-separated, max 100). Any path, declared or not. Projected rows are partial — never write one back.');

// Query-string params shared by query_records and list_records.
function recordQuery({ folder, space_id, parent_folder, config_id, filter, sort_by, fields, limit, offset }) {
  const query = { folder, space_id, parent_folder, limit, offset, sort_by };
  if (config_id !== undefined) query.config_id = Array.isArray(config_id) ? config_id.join(',') : config_id;
  // A bare array is the service's shorthand for "just the conditions".
  if (filter !== undefined) query.filter = JSON.stringify(filter);
  if (fields !== undefined) query.fields = Array.isArray(fields) ? fields.join(',') : fields;
  return query;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
    'List records reference topics (schema, views, form-builder, form-rules, table-views, flow, index-fields, config-source, record, bulk-operations, endpoints, flow-triggers, …) plus the known spec-vs-engine gotchas. Start here. For building a form UI, read "form-builder" and "form-rules".',
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
    'Validate a record config locally (no API call): id, name, schema, form view nodes (including the `field` vs `ref` gotcha), table views and their filters, the flow wizard, index_fields, source and the unset_* flags. Run before create_record_config / update_record_config.',
    {
      config: jsonValue.describe('The record config: { id, name, description?, label?, schema, views?, index_fields?, source? } (updates may also carry unset_views / unset_source)'),
      require_id: z.boolean().default(true).describe('Set false to validate an update payload (id/name optional)'),
    },
    async ({ config, require_id }) => validate(config, { requireId: require_id })
  );

  // ---------------------------------------------------------------------------
  // Record configs
  // ---------------------------------------------------------------------------

  tool(
    'list_record_configs',
    'List record configurations. Optionally pass `ids` to batch-fetch specific configs. Without ids the list is paged by the storage layer: when the reply has `truncated: true`, call again with `cursor: next_cursor`. Call this first to discover available record types.',
    {
      ids: z.array(z.string()).optional().describe('Optional list of config ids to fetch (batch). Omit for all.'),
      limit: z.number().int().positive().optional().describe('Page size (unbatched listing only)'),
      cursor: z.string().optional().describe('next_cursor from a previous truncated reply'),
    },
    async ({ ids, limit, cursor }) =>
      client.get('/records/config', ids?.length ? { ids: ids.join(',') } : { limit, cursor })
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
      index_fields: indexFieldsField.optional(),
      source: sourceField.optional(),
      skip_local_validation: z.boolean().default(false).describe('Set true only to intentionally bypass the local validator'),
    },
    async ({ id, name, description, label, schema, views, index_fields, source, skip_local_validation }) => {
      const config = { id, name, description, label, schema, views, index_fields, source };
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
      if (index_fields !== undefined) body.index_fields = index_fields;
      if (source !== undefined) body.source = source;
      const created = await client.post('/records/config', body);
      return validation?.warnings?.length ? { ...wrap(created), warnings: validation.warnings } : created;
    }
  );

  tool(
    'update_record_config',
    'Update a record configuration (PUT, partial — only the fields you pass are changed; each view key you pass replaces the stored one). The id is immutable. Editing the schema does NOT re-validate existing records. On a REFERENCE config (one with `source`) only views.tables can change. Validated locally first.',
    {
      id: z.string().describe('Record config id to update'),
      name: z.string().optional(),
      description: z.string().optional(),
      label: z.string().optional(),
      schema: schemaField.optional(),
      views: viewsField.optional(),
      index_fields: indexFieldsField.optional(),
      source: sourceField.optional().describe('Repoint at a catalogue entry: REPLACES the stored document with a reference stub (views.tables survive).'),
      unset_views: z
        .array(z.enum(['form', 'table', 'forms', 'tables', 'flow']))
        .optional()
        .describe('View keys to clear outright — the only way to remove a view once set. Applied after `views` is merged.'),
      unset_source: z
        .boolean()
        .optional()
        .describe('Convert a reference back into an ordinary config. Must be sent with a `schema`.'),
      skip_local_validation: z.boolean().default(false),
    },
    async ({ id, name, description, label, schema, views, index_fields, source, unset_views, unset_source, skip_local_validation }) => {
      const body = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (label !== undefined) body.label = label;
      if (schema !== undefined) body.schema = schema;
      if (views !== undefined) body.views = views;
      if (index_fields !== undefined) body.index_fields = index_fields;
      if (source !== undefined) body.source = source;
      if (unset_views !== undefined) body.unset_views = unset_views;
      if (unset_source !== undefined) body.unset_source = unset_source;

      let validation = null;
      if (!skip_local_validation && Object.keys(body).some((k) => k !== 'description' && k !== 'label')) {
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
    'Delete a record configuration AND all of its records (the records storage bucket is purged). Irreversible, so it requires confirm: true: one call destroys every record of the type.',
    {
      id: z.string().describe('Record config id'),
      confirm: z.boolean().optional().describe('Must be true. Deletes the config and purges every one of its records.'),
    },
    async ({ id, confirm }) => {
      if (confirm !== true) {
        throw new Error('delete_record_config purges every record of the config irreversibly; pass confirm: true to proceed');
      }
      return client.delete(`/records/config/${encodeURIComponent(id)}`);
    }
  );

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------

  // get.records (the KV scan behind GET /records/{config_id}) was deleted, so this
  // runs on query-records, which needs a scope: without one it fans out over spaces.
  tool(
    'list_records',
    'List the records of one config (index-backed, via query-records). With space_id or folder it is one query. Without either it queries every space for this config and compares the hits with the config\'s stored key count. `complete: true` proves every record was found; `complete: false` means some records sit outside any space (reach them by folder) OR the count still includes deleted records, since it counts keys in the store and a delete leaves a marker. Page with limit/offset (offset needs space_id or folder). For filters, sorting, projection or cross-config queries use query_records.',
    {
      config_id: z.string().describe('Record config id'),
      space_id: z.string().optional().describe('Limit to one space'),
      folder: z.string().optional().describe('Limit to one folder'),
      limit: z.number().int().positive().max(1000).optional().describe('Max records returned (default 100; the index caps a page at 1000)'),
      offset: z.number().int().nonnegative().optional().describe('Requires space_id or folder'),
      fields: fieldsField,
    },
    async ({ config_id, space_id, folder, limit = 100, offset, fields }) => {
      if (space_id || folder) {
        return client.get('/records', recordQuery({ space_id, folder, config_id, limit, offset, fields }));
      }
      if (offset) throw new Error('offset needs space_id or folder: a fan-out across spaces has no single order to page through');

      const [counts, spaces] = await Promise.all([
        client.get('/records/count', { ids: config_id }),
        client.get('/workspaces/spaces'),
      ]);
      const spaceIds = (spaces?.results ?? []).map((s) => s.id).filter(Boolean);
      const pages = await mapLimit(spaceIds, 4, (id) =>
        client
          .get('/records', recordQuery({ space_id: id, config_id, limit, fields }))
          .then((r) => ({ id, r }), (err) => ({ id, err: err.message }))
      );
      const results = [];
      const hitsBySpace = {};
      const errorsBySpace = {};
      let totalHits = 0;
      for (const { id, r, err } of pages) {
        if (err) {
          errorsBySpace[id] = err;
          continue;
        }
        const hits = r?.total_hits ?? r?.results_total ?? 0;
        if (hits) hitsBySpace[id] = hits;
        totalHits += hits;
        for (const rec of r?.results ?? []) if (results.length < limit) results.push(rec);
      }
      const recordCount = counts?.[config_id] ?? 0;
      return {
        results,
        results_total: results.length,
        total_hits: totalHits,
        record_count: recordCount,
        complete: totalHits >= recordCount && !Object.keys(errorsBySpace).length,
        hits_by_space: hitsBySpace,
        ...(Object.keys(errorsBySpace).length && { errors_by_space: errorsBySpace }),
        ...(totalHits < recordCount && {
          note: `record_count ${recordCount} exceeds the ${totalHits} indexed hit(s). The count may include deleted keys; the rest are in no space or not indexed yet. Query by folder to find any real ones.`,
        }),
        ...(fields !== undefined && { fields }),
      };
    }
  );

  tool(
    'query_records',
    'Search records (index-backed, GET /records). Requires folder OR space_id. Narrow by config_id(s), parent_folder, and a payload `filter` over DECLARED index_fields; sort with sort_by (default created_at); keep only some payload paths with `fields`. Page with limit (default 25, max 1000) and offset: `total_hits` is the full match count, `results_total` only this page. A filter on an undeclared field returns an empty page, not an error.',
    {
      folder: z.string().optional().describe('Folder id (folder or space_id required)'),
      space_id: z.string().optional().describe('Space id (folder or space_id required)'),
      parent_folder: z.string().optional().describe('Only records hanging off this parent folder'),
      config_id: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('One config id → AND filter; multiple → OR group'),
      filter: filterField,
      sort_by: z.string().optional().describe('Record field or declared index field to sort by, "-field" to reverse'),
      fields: fieldsField,
      limit: z.number().int().positive().max(1000).optional(),
      offset: z.number().int().nonnegative().optional(),
    },
    async (args) => {
      if (!args.folder && !args.space_id) {
        throw new Error('folder or space_id is required for query_records');
      }
      const warnings = queryFilterWarnings(args.filter);
      const res = await client.get('/records', recordQuery(args));
      return warnings.length ? { ...res, warnings } : res;
    }
  );

  tool(
    'get_record',
    'Get a single record by config id and record id. The reply carries `revision`; pass it to update_record for a compare-and-swap write.',
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
      space_id: z.string().optional().describe('Space to associate the record with. A record with neither folder nor space_id is returned by no query.'),
      parent_folder: z.string().optional().describe('Folder of the record this one hangs off (an organisation, a household). Indexed.'),
      hidden_fields: hiddenFieldsField,
      suppress_events: suppressEventsField,
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
    async ({ config_id, data, folder, space_id, parent_folder, hidden_fields, suppress_events, validate: validateData, completed, test_flow }) => {
      const body = { data: data ?? {} };
      if (folder !== undefined) body.folder = folder;
      if (space_id !== undefined) body.space_id = space_id;
      if (parent_folder !== undefined) body.parent_folder = parent_folder;
      if (hidden_fields !== undefined) body.hidden_fields = hidden_fields;
      if (suppress_events !== undefined) body.suppress_events = suppress_events;
      if (validateData !== undefined) body.validate = validateData;
      if (completed !== undefined) body.completed = completed;
      if (test_flow !== undefined) body.test_flow = test_flow;
      const created = await client.post(`/records/${encodeURIComponent(config_id)}`, body);
      // The create response is the request struct: request-only flags echo back but are not stored.
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
    'Update a record (PUT). The `data` you pass is merged key-by-key into the existing record (replace=true swaps it whole); folder/space_id/parent_folder are overwritten only when supplied. The MERGED data is re-validated against the current config schema unless validate=false. Events: the transition to completed=true publishes "record-updated"; any other write that changed data publishes "record-patched" (only trigger nodes naming it receive it); suppress_events=true publishes nothing. Pass `revision` from get_record for a compare-and-swap write (409 if the record moved). Update has no test_flow.',
    {
      config_id: z.string().describe('Record config id'),
      id: z.string().describe('Record id'),
      data: dataField.optional(),
      folder: z.string().optional(),
      space_id: z.string().optional(),
      parent_folder: z.string().optional().describe('Set the parent folder; an empty string detaches the record from its parent'),
      replace: z.boolean().optional().describe('true: `data` replaces the stored data instead of merging — the only way to remove a key'),
      revision: z.number().int().nonnegative().optional().describe('Revision from a prior get_record; makes the write compare-and-swap'),
      hidden_fields: hiddenFieldsField,
      suppress_events: suppressEventsField,
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
    async ({ config_id, id, validate: validateData, ...rest }) => {
      const body = {};
      for (const key of ['data', 'folder', 'space_id', 'parent_folder', 'replace', 'revision', 'hidden_fields', 'suppress_events', 'completed']) {
        if (rest[key] !== undefined) body[key] = rest[key];
      }
      if (validateData !== undefined) body.validate = validateData;
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

  tool(
    'upsert_record',
    'Create or merge a record found by IDENTITY rather than id (POST /records/upsert-record). The folder is derived from the first identity field with a usable value ("<config_id>-<hash>"); a match is shallow-merged with `data`, otherwise a record is created there. Returns the stored record plus `created` and the derived `folder` — verify from THIS response: the lookup reads the search index, which lags writes, so an immediate re-read can miss it. Publishes NO record event. resolve_only=true returns the folder and writes nothing.',
    {
      config_id: z.string().describe('Record config id'),
      identity: z.record(z.string()).describe('Identity values, e.g. { "email": "a@example.com" }. Email is lower-cased; phone keeps digits only.'),
      identity_fields: z.array(z.string()).optional().describe('Order to try identity keys in; default is the identity keys sorted'),
      data: dataField.optional(),
      space_id: z.string().optional().describe('Set on create; never clears an existing space'),
      parent_folder: z.string().optional().describe('Set when given; omitted leaves an existing parent alone'),
      legacy_config_ids: z.array(z.string()).optional().describe('Other config ids this entity may already be stored under'),
      resolve_only: z.boolean().optional().describe('Answer with the derived folder (and any match) and write nothing'),
      validate: z.boolean().optional().describe('Default true: the MERGED data is validated against the schema'),
      hidden_fields: hiddenFieldsField,
    },
    async (args) => {
      const body = { ...args, data: args.data ?? {} };
      return client.post('/records/upsert-record', body);
    }
  );

  tool(
    'csv_import',
    'Turn an already-uploaded CSV into records, synchronously (POST /records/csv-import). The file must be in the `microstrate-agent-knowledge` object bucket (the webapp uploads it there); pass its location. Each row goes through the normal create path (validation, folder derivation, index, events). Needs space_id or folder, or the rows would be returned by no query. Up to 50,000 rows; returns { total, created, failed, errors } with errors capped at 20.',
    {
      config_id: z.string().describe('Record config id'),
      object_uri: z.string().optional().describe('obj://microstrate-agent-knowledge/<key>'),
      key: z.string().optional().describe('Object key in the knowledge bucket (alternative to object_uri)'),
      column_map: z.record(z.string()).optional().describe('CSV heading → record field. A heading left out is dropped; an empty map uses the sanitised headings.'),
      types: z
        .record(z.enum(['string', 'number', 'integer', 'boolean']))
        .optional()
        .describe('Record field → type to coerce to; unlisted fields are text'),
      space_id: z.string().optional(),
      folder: z.string().optional(),
      parent_folder: z.string().optional(),
      batch_size: z.number().int().positive().max(100).optional().describe('Records written concurrently (default 25, max 100)'),
      completed: z.boolean().optional().describe('Default false. true fires the record trigger for EVERY row.'),
      validate: z.boolean().optional().describe('Default true; false lets partial rows through'),
    },
    async (args) => {
      if (!args.object_uri && !args.key) throw new Error('object_uri or key is required');
      if (!args.space_id && !args.folder) {
        throw new Error('space_id or folder is required: records created with neither are returned by no query');
      }
      return client.post('/records/csv-import', args);
    }
  );

  tool(
    'export_records',
    'Email a record set as a CSV or JSON attachment (POST /records/export-records). The whole matching set (up to 50,000 rows) is mailed to `email`, which can be any address, so it requires an explicit `email` and confirm: true once the user has agreed to the recipient. Nothing but { message, records } comes back. Needs space_id or folder; `filter`/`sort_by` are the same as query_records.',
    {
      config_id: z.string().describe('Record config id'),
      space_id: z.string().optional(),
      folder: z.string().optional(),
      format: z.enum(['csv', 'json']).optional().describe('Default csv'),
      email: z.string().describe('Recipient address. Required: there is no default recipient.'),
      filter: filterField,
      sort_by: z.string().optional(),
      confirm: z.boolean().optional().describe('Must be true: the records leave the platform by email.'),
    },
    async ({ filter, confirm, ...rest }) => {
      if (!rest.space_id && !rest.folder) throw new Error('space_id or folder is required for export_records');
      if (!String(rest.email ?? '').trim()) throw new Error('email is required: export_records has no default recipient');
      if (confirm !== true) {
        throw new Error(`export_records mails the full record set to ${rest.email}; confirm the recipient with the user, then pass confirm: true`);
      }
      const warnings = queryFilterWarnings(filter);
      const body = { ...rest };
      if (filter !== undefined) body.filter = JSON.stringify(filter);
      const res = await client.post('/records/export-records', body);
      return warnings.length ? { ...res, warnings } : res;
    }
  );

  tool(
    'purge_records',
    'DELETE a config\'s records in bulk, keeping the config (DELETE /records/{config_id}/purge). Unscoped it removes EVERY record of the config; with space_id and/or folder (the record\'s own folder, not its parent) only those. Irreversible, publishes no events. Requires confirm: true. If the reply has truncated: true, records remain — run the same call again.',
    {
      config_id: z.string().describe('Record config id'),
      space_id: z.string().optional().describe('Only records in this space'),
      folder: z.string().optional().describe('Only records whose own folder is this'),
      confirm: z.boolean().describe('Must be true. A purge cannot be undone.'),
    },
    async ({ config_id, space_id, folder, confirm }) => {
      if (confirm !== true) {
        throw new Error('purge_records deletes records irreversibly; pass confirm: true to proceed');
      }
      return client.delete(`/records/${encodeURIComponent(config_id)}/purge`, { space_id, folder });
    }
  );
}

// ---------------------------------------------------------------------------

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(
      `[quiva-records-mcp] Node ${process.versions.node} is too old — requires Node >= 18 (global fetch). Launch via bin/run.sh or set QUIVA_NODE.`
    );
    process.exit(1);
  }
  const client = QuivaClient.fromEnv();
  if (!client.hasCredentials()) {
    console.error(
      '[quiva-records-mcp] Warning: no credentials configured (QUIVA_API_KEY, QUIVA_BEARER_TOKEN, or QUIVA_EMAIL/QUIVA_PASSWORD). API tools will fail until one is set.'
    );
  }
  const server = new McpServer({ name: 'quiva-records', version: '0.1.0' }, { instructions });
  registerTools(server, client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[quiva-records-mcp] ready — API: ${client.baseUrl}`);
}

// Importing this module must have no side effects (no connecting, no env
// reads) — only run the stdio bootstrap when this file is the entry point.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('[quiva-records-mcp] fatal:', err);
    process.exit(1);
  });
}
