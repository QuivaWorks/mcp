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
`.trim();

const TOPICS = {
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
