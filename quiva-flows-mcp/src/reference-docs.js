// Queryable reference topics — the flows equivalent of the records MCP's
// `form-builder` / `form-rules` topics.
//
// Node-type docs cover "what fields does this node take". Topics cover the
// cross-cutting knowledge that has nowhere else to live: the rules DSL, the
// JSONPath/pipe/secret data plane, the flow-editor presentation contract, and
// the draft -> publish -> run lifecycle.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GOTCHAS, JSONPATH_GUIDE } from './node-docs.js';
import { RULES_SYNTAX } from './rules-docs.js';

const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

const GEOMETRY = `
FLOW-EDITOR PRESENTATION FIELDS
===============================

The hub API stores whatever node/edge JSON you send and never requires these,
but the flow editor (@xyflow/svelte) needs them to draw the graph. A config
created without them is valid and runnable yet renders as a pile of nodes at the
origin with no visible wiring — "the config is wrong" as far as anyone looking
at the UI is concerned.

Node (alongside "data"):
  position   { x, y }        required for layout; editor-authored flows step x by ~296
  type       "custom"        the renderer's node component
  measured   { width, height }  usually { 96, 96 }
  id         must equal data.id

Edge:
  id            conventionally "xy-edge__<source><source>-<target><target>"
  source/target node ids
  sourceHandle  = the source node id
  targetHandle  = the target node id
  type          "custom"
  edgeType      "custom"

create_workflow and update_workflow fill in anything missing (auto_layout=true
by default) and report what they added. Pass explicit values to control layout;
pass auto_layout=false to send the config through untouched.
`.trim();

const LIFECYCLE = `
WORKFLOW LIFECYCLE
==================

1. A collection holds workflows: ms.hub.config.collection.workflow.<id>
2. create_workflow / update_workflow always write a DRAFT:
     ms.hub.config.workflow.draft.<collection>.<flow>
3. publish_workflow promotes the draft. The published subject has NO "published"
   segment — it is ms.hub.config.workflow.<collection>.<flow>. Get it from
   list_workflows(version="published").
4. run_workflow executes it; await=true returns results synchronously.
5. Updating a published workflow creates a new draft — publish again to go live.

Notes
- update_workflow must send the DRAFT subject in the request body; path params
  alone silently no-op. The MCP client does this for you.
- A trigger node is editor metadata and is skipped at runtime. Runtime input
  comes from the run request's "trigger" field and is read as $.trigger.
- Resume a paused human-in-the-loop run with run_workflow(run_id, trigger).
- Nodes with no incoming edges all start immediately, in parallel.
- The graph must be acyclic; the server does not check, and nodes in a cycle
  simply never run. validate_flow_config does check.

Server validation
- Every create/update refuses empty or malformed node/edge ids (. * > @ or
  whitespace), an unknown node_type, and record/task trigger ids that do not
  address their config/space, even with server_validate=false
  (hub-service/handler/create-workflow.go ValidateGraphIDs).
- server_validate=true adds the node-id regex, payload-required and
  subject-exists checks, and refuses options.attempts on schedule nodes.
- publish runs the full validator (hub-service/validate/workflow.go) and refuses
  on any error: unknown task operation, disallowed quiva-endpoint subject,
  schedule attempts, dangling edges. Warnings never block it.
- hub-service has a workflow-validate handler, but it has no gateway mapping on
  api.quiva.ai, so validate_flow_config (local) is the pre-flight check.

Roles
- create/update/publish/delete workflow and create/delete collection need the
  root, admin or developer role: other roles get 403 "changing a flow needs the
  root, admin or developer role" (hub-service/handler/account_role.go).

Awaited runs on queued accounts (hub-service/handler/run_queue.go)
- 429 + Retry-After: the account's run limit is full. Wait and retry.
- 504: not finished before the gateway timeout. It may still complete; check
  search_run_logs before re-running.
- 409: the same run attempt is already queued.
- 503 + Retry-After: the queue could not take the run. Retry.
`.trim();

const TRIGGERS = `
TRIGGER TYPES — what actually starts a flow
============================================

A trigger node (node_type: "trigger") is editor/config metadata: it is never
executed as a run step. Whether it does anything depends entirely on
trigger_type, and that field spans THREE unrelated dispatch mechanisms plus a
purely presentational group. Get this wrong and a flow looks configured but
never fires — silently, with no error anywhere.

1. PURELY PRESENTATIONAL — no dispatch behind them at all
   manual, webhook, embed
   These exist for the editor's UI (a "Run manually" button, embed widget
   config) and never cause hub-service or anything else to start a run on
   their own.

2. INSTALLED AT PUBLISH TIME — schedule-service, not hub.trigger.*
   schedule
   publish-workflow.go:58-99 unschedules the previously published trigger and
   installs the draft's on every publish. Real, but the mechanism is a cron
   registration, not an event subscription.

3. LIVE IN HUB-SERVICE'S hub.trigger.* SUBSCRIBER — the "platform event" family
   record, object-store, email, task
   A publisher (records-service, workspaces-service, ...) sends to
   hub.trigger.<kind>.<scope>.<id>. hub-service globs
   ms.hub.config.workflow-node.*.*.<node-id> for matching trigger nodes and
   runs each match (hub-service/service/service.go dispatchTrigger,
   hub-service/data/const.go TriggerTypeRecord / TriggerTypeObjectStore /
   TriggerTypeEmail / TriggerTypeTask). These four are the ones that behave
   like "a real-world event started this flow."

   record  — get_node_type_reference("trigger").record_trigger. Node id MUST
     be "record:<record_config_id>" (COLON — a legacy dotted form still
     dispatches for a handful of pre-existing nodes, but create/update now
     reject a dot). record_create only republishes when the write sets
     completed:true (or test_flow); record_update republishes on ANY real
     change (record-patched), not only completed - the completed false->true
     transition alone publishes as record-updated. event_type omitted
     defaults to ["record-created","record-updated"], not every record event
     — "record-patched" must be named explicitly to catch a plain data change.
   task — get_node_type_reference("trigger").task_trigger. Node id MUST be
     "task:<space_id>" (COLON, same reasoning as record — a dotted id splits
     into two subject tokens and breaks workflow-history's node lookup).
     Implemented and live: hub-service/data/const.go defines TriggerTypeTask,
     dispatched in hub-service/service/service.go. Fires on task
     created/updated/status-changed/moved/deleted, action added/completed/
     deleted, and comment created/updated/deleted; a move is delivered to the
     destination space with every kind and to the space it left with only
     task-moved. Sourced from evari-olympus docs/task-event-trigger-plan.md §0.
   object-store, email — less commonly used; same dispatch shape as record.

   TASK LOOP CONTROLS — a flow that writes back to the task that started it can
   re-trigger itself. Guard with: self-trigger suppression (default ON; a run
   skips a write its own run produced — allow_self_trigger: true opts out),
   the write's own suppress_events: true (create/update task, add/update task
   action, create/update comment accept it in the body; deletes take it as
   ?suppress_events=true; a flow's task node can add it to create_task,
   update_task, set_task_status, assign_task, comment_task payloads — the
   editor form does not show it — but NOT to complete_task_action or any
   delete), a no-op write publishing nothing, and a 60/minute per-task burst
   limit as the backstop. Full detail: get_node_type_reference("trigger").task_trigger.loop_controls.

4. LIVE, BUT VIA A COMPLETELY DIFFERENT SERVICE — trigger-service
   gateway
   trigger-service (built for EXTERNAL ingress — a webhook door into the
   mesh) creates a gateway mapping and mapping version with
   Resource: <this flow's subject>, ResourceType: "flow"
   (trigger-service/handler/post-trigger-gateway.go), so an inbound HTTP call
   invokes the flow directly. This NEVER goes through hub.trigger.* or
   dispatchTrigger — it is dispatch #3's sibling system, not a member of it.
   Real and harvested in production: examples/client-folder-creation.json.

   trigger-service also registers "stream" and "obj" trigger types (a
   Bellerophon stream subject, an object-store event) with their own POST
   handlers — these are trigger-service concepts, not flow trigger_type
   values documented here, though a gateway/stream/obj trigger's endpoint is
   still what ultimately calls into a flow.

   "subject" is a trigger-service TriggerType constant (TRIGGER_TYPE_SUBJECT)
   with NO POST handler (only post-trigger-{email,gateway,obj,stream}.go
   exist) — it is dead. The frontend silently rewrites a chosen trigger_type
   of "subject" to "stream" before submitting
   (microstrate trigger.services.svelte.ts createTrigger). Never author
   trigger_type "subject".

THREE THINGS NAMED "TASK" — pick the right one
------------------------------------------------
- task TRIGGER (trigger_type: "task") — STARTS a flow on a workspaces task
  event (created, updated, status changed, ...). Ingress. Documented above
  and in get_node_type_reference("trigger").task_trigger.
- task NODE (node_type: "task") — PERFORMS one of 13 task operations
  (create, update, comment, complete an action, find, delete, schedule a task
  event, ...) as a step inside an already-running flow. Egress.
  get_node_type_reference("task"). Prefer its list_tasks operation over a
  quiva-endpoint node for a FILTERED task lookup — see
  get_node_type_reference("quiva-endpoint").header_lift.
- task_schedule_create / schedule_task_event (quiva-workspaces-mcp; the
  space/task "Automation" UI section) — a per-task CRON TIMER with
  action_type: "flow". Fires at a scheduled time regardless of any task
  write; never watches events. This is what a model reaches for by habit when
  it actually wants the task trigger above.

Check node_type vs trigger_type, not the English word, to tell the first two
apart in a config you are reading — they are different JSON fields that
happen to share a name.
`.trim();

const TOPICS = {
  triggers: {
    summary:
      'What actually starts a flow: the four dispatch mechanisms behind trigger_type (presentational-only, schedule-service, hub-service\'s hub.trigger.* family, and trigger-service\'s gateway binding), plus how to tell the task TRIGGER apart from the task NODE and from task scheduling. Read this before wiring any trigger node.',
    body: () => TRIGGERS,
  },
  'rules-syntax': {
    summary:
      'The rule-engine v2 DSL used by condition / rules nodes: { condition, outcome } branches (NOT if/then/else), expressions, @fact refs, and the operator list. Read before building any branching flow.',
    body: () => RULES_SYNTAX,
  },
  jsonpath: {
    summary:
      'The data plane: $.trigger / $.static / $.context / $.env / $.<NODE_ID> references, pipe concatenation, SECRET:: placeholders, and where JSONPath is NOT resolved.',
    body: () => JSONPATH_GUIDE,
  },
  geometry: {
    summary:
      'Flow-editor presentation fields (node position/type/measured, edge type/edgeType/handles) — omit them and the graph renders stacked at the origin.',
    body: () => GEOMETRY,
  },
  lifecycle: {
    summary: 'Collections, draft vs published subjects, publish, run, resume, and the update-creates-a-draft rule.',
    body: () => LIFECYCLE,
  },
  gotchas: {
    summary: 'Every known spec-vs-engine trap, as a list.',
    body: () => GOTCHAS.map((g, i) => `${i + 1}. ${g}`).join('\n\n'),
  },
};

export function listReferenceTopics() {
  return {
    topics: Object.entries(TOPICS).map(([topic, { summary }]) => ({ topic, summary })),
    note: 'Fetch one with get_flows_reference(topic). Node-type shapes live in list_node_types / get_node_type_reference; real configs in list_examples / get_example.',
  };
}

export function getReference(topic) {
  const entry = TOPICS[topic];
  if (!entry) {
    throw new Error(`Unknown topic "${topic}". Available: ${Object.keys(TOPICS).join(', ')}`);
  }
  return { topic, summary: entry.summary, reference: entry.body() };
}

// --- Examples: real configs harvested from the platform --------------------

function readExamples() {
  let files;
  try {
    files = readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((file) => JSON.parse(readFileSync(join(EXAMPLES_DIR, file), 'utf8')));
}

export function listExamples() {
  const examples = readExamples();
  if (examples.length === 0) {
    return { examples: [], note: 'No examples bundled. Run tools/harvest-examples.mjs to fetch them from the platform.' };
  }
  return {
    examples: examples.map((e) => ({
      slug: e.slug,
      name: e.source?.name,
      description: e.description,
      teaches: e.teaches,
      nodes: Array.isArray(e.config?.nodes) ? e.config.nodes.length : 0,
    })),
    note: 'These are REAL published workflows harvested from the platform (credentials redacted) — they are known to run. Prefer copying their conventions over inventing a shape. Fetch one with get_example(slug).',
  };
}

export function getExample(slug) {
  const example = readExamples().find((e) => e.slug === slug);
  if (!example) {
    const available = readExamples().map((e) => e.slug).join(', ') || '(none — run tools/harvest-examples.mjs)';
    throw new Error(`Unknown example "${slug}". Available: ${available}`);
  }
  return example;
}

export { GEOMETRY, LIFECYCLE };
