// Local workflow-config validation.
//
// Mirrors the server-side checks in hub-service/handler/create-workflow.go
// (ValidateConfig, ValidateGraphIDs) and hub-service/validate/workflow.go (run
// on publish), and adds checks the server misses: cycle detection,
// per-node-type required payload props, and lints for known spec-vs-engine
// gotchas (wait -> delay, baseURL -> base_url, unresolvable $.X references).

import { NODE_TYPES } from './node-docs.js';
import { checkRule, isBranch } from './rules-docs.js';

const ID_REGEX = /^[a-zA-Z_][a-zA-Z0-9_:]*$/;
const RESERVED_IDS = new Set(['trigger', 'static', 'RESOLVE_ERROR', 'RESOLVE_SUCCESS']);

// Record and task trigger ids address their config or space with a colon —
// `record:<record_config_id>`, `task:<space_id>` — because hub dispatches by
// globbing the node id (hub-service/handler/create-workflow.go check*TriggerID).
const TASK_TRIGGER_ID_REGEX = /^task:\w+$/;
// The dotted record form hub still reads for legacy nodes but refuses on write.
const LEGACY_RECORD_TRIGGER_ID_REGEX = /^record\.[a-zA-Z0-9_-]+$/;

function isRecordTrigger(data) {
  return data?.node_type === 'trigger' && data?.trigger_type === 'record';
}
const RESERVED_CONDITION_TARGETS = new Set(['RESOLVE_ERROR', 'RESOLVE_SUCCESS']);
const BUILTIN_LOOKUPS = new Set(['trigger', 'static', 'env', 'context']);

const VALID_NODE_TYPES = new Set(Object.keys(NODE_TYPES));
// The server also accepts the editor's "chat" (a no-op) and agent_* sub-nodes (hub-service/model/request.go IsKnownNodeType).
const EDITOR_ONLY_NODE_TYPES = new Set(['chat']);
const AGENT_SUB_NODE_PREFIX = 'agent_';

const TASK_OPERATIONS = Object.keys(NODE_TYPES.task.operations);
const EMAIL_OPERATIONS = ['send_email'];

// Exact mirror of hub-service/handler/create-workflow.go graphIDBadChars (".*>@ \t\n"); refused on every write.
const GRAPH_ID_BAD_CHARS = /[.*>@ \t\n]/;

// Subjects that create or cancel a durable timer (hub-service/validate/schedule_attempts.go).
const SCHEDULE_SUBJECTS = new Set(['microstrate.hub.post.schedule-flow', 'microstrate.hub.delete.unschedule-flow']);

const DISTRIBUTION_ID_REGEX = /^[A-Za-z0-9_-]+$/;

export function validateFlowConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['config must be an object with nodes/edges arrays'], warnings };
  }

  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  const edges = Array.isArray(config.edges) ? config.edges : [];

  if (nodes.length === 0) {
    errors.push('config.nodes is empty — a workflow needs at least one node');
  }

  const nodeIds = new Set();
  const runtimeNodeIds = new Set(); // excludes trigger nodes (skipped at runtime)

  for (const node of nodes) {
    const data = node?.data;
    const id = data?.id ?? node?.id;
    const label = id || '<missing id>';

    if (!data) {
      errors.push(`node ${label}: missing "data" object`);
      continue;
    }
    if (!id) {
      errors.push('node <missing id>: data.id is required');
      continue;
    }
    const legacyRecordId = isRecordTrigger(data) && LEGACY_RECORD_TRIGGER_ID_REGEX.test(id);
    if (typeof node.id === 'string' && GRAPH_ID_BAD_CHARS.test(node.id) && !legacyRecordId) {
      errors.push(`node ${label}: top-level id "${node.id}" cannot contain . * > @, a space, a tab or a newline — the server refuses it on every write, validate=true or not`);
    }
    if (node.id && node.id !== data.id) {
      warnings.push(`node ${label}: top-level id ("${node.id}") differs from data.id ("${data.id}") — they should match`);
    }
    if (!ID_REGEX.test(id)) {
      if (isRecordTrigger(data) && LEGACY_RECORD_TRIGGER_ID_REGEX.test(id)) {
        errors.push(
          `node ${label}: record trigger id "${id}" uses the legacy dot — hub-service refuses it on create and update (checkRecordTriggerID). Use "record:<record_config_id>".`
        );
      } else {
        errors.push(
          `node ${label}: invalid id — must start with a letter or underscore and contain only alphanumerics, underscores or colons (hub-service validate.ValidateID). NOTE: the flow editor does NOT run this check (the server only validates when validate=true), so UI-authored flows can contain ids like "QsY6OWA5xVhZn9aS3lF-Z" that you cannot re-send with validation on. To update such a flow, pass server_validate=false.`
        );
      }
    }
    const recordConfigId = isRecordTrigger(data) ? data.payload?.record_config_id : undefined;
    if (
      typeof recordConfigId === 'string' &&
      recordConfigId &&
      id !== `record:${recordConfigId}` &&
      !LEGACY_RECORD_TRIGGER_ID_REGEX.test(id)
    ) {
      errors.push(
        `node ${label}: a record trigger's id must be exactly "record:${recordConfigId}" — hub dispatches record events by globbing the node id and refuses a mismatch on create and update.`
      );
    }
    if (RESERVED_IDS.has(id)) {
      errors.push(`node ${label}: "${id}" is a reserved word and cannot be used as a node id`);
    }
    if (nodeIds.has(id)) {
      errors.push(`duplicate node id found: ${id}`);
    }
    nodeIds.add(id);

    const type = data.node_type;
    if (!type) {
      // The editor's unconfigured "New Node"; the server saves and publishes it (validate/workflow.go nodeTypeError).
      warnings.push(`node ${label}: no node_type, so the node does nothing at run time`);
      runtimeNodeIds.add(id);
      continue;
    }
    if (type === 'wait') {
      errors.push(
        `node ${label}: node_type "wait" does not exist in the engine — use "delay" (payload: { time_ms: <int ms> })`
      );
      continue;
    }
    if (type.startsWith(AGENT_SUB_NODE_PREFIX) || EDITOR_ONLY_NODE_TYPES.has(type)) {
      if (EDITOR_ONLY_NODE_TYPES.has(type)) {
        warnings.push(`node ${label}: node_type "${type}" is editor-only — the runner has no case for it, so it does nothing at run time`);
        runtimeNodeIds.add(id);
      }
      continue;
    }
    if (!VALID_NODE_TYPES.has(type)) {
      errors.push(
        `node ${label}: unknown node_type "${type}". Valid types: ${[...VALID_NODE_TYPES].join(', ')}`
      );
      continue;
    }

    if (type !== 'trigger') runtimeNodeIds.add(id);

    if (schedulesATimer(type, data) && Number(data.options?.attempts) > 1) {
      errors.push(
        `node ${label}: options.attempts is not allowed on a node that schedules or cancels a timer — a retry stamps a null topic and the timer becomes permanently uncancellable while the run reports success (hub-service/validate/schedule_attempts.go). Remove options.attempts.`
      );
    }

    if (data.payload === undefined || data.payload === null) {
      errors.push(`node ${label}: payload is required (server rejects nodes without one)`);
      continue;
    }

    validateNodePayload(type, data, label, errors, warnings);
  }

  // Edges: server requires source/target to reference existing nodes.
  const adjacency = new Map();
  for (const edge of edges) {
    const source = edge?.source;
    const target = edge?.target;
    const label = `${source || '?'} -> ${target || '?'}`;

    if (!source || !target) {
      errors.push(`edge ${label}: source and target are required`);
      continue;
    }
    if (!edge.id) {
      warnings.push(
        `edge ${label}: missing "id" — the server refuses an edge without one; create_workflow / update_workflow fill it when auto_layout is on`
      );
    } else if (typeof edge.id === 'string' && GRAPH_ID_BAD_CHARS.test(edge.id)) {
      errors.push(`edge ${label}: id "${edge.id}" cannot contain . * > @, a space, a tab or a newline — the server refuses it on every write`);
    }
    if (!nodeIds.has(source)) errors.push(`edge ${label}: source node not found: ${source}`);
    if (!nodeIds.has(target)) errors.push(`edge ${label}: target node not found: ${target}`);
    if (nodeIds.has(source) && nodeIds.has(target)) {
      if (!adjacency.has(source)) adjacency.set(source, []);
      adjacency.get(source).push(target);
    }
  }

  // Cycle check — the server does NOT do this; a cycle deadlocks the run.
  const cycle = findCycle(adjacency);
  if (cycle) {
    errors.push(
      `cycle detected: ${cycle.join(' -> ')} — workflows must be acyclic (nodes in a cycle never run)`
    );
  }

  // JSONPath reference check: $.X where X is not a node id or builtin.
  for (const node of nodes) {
    const data = node?.data;
    if (!data?.id || data.payload == null) continue;
    if (data.node_type === 'static') continue; // literals only, no resolution
    for (const ref of collectJsonPathRoots(data.payload)) {
      if (!BUILTIN_LOOKUPS.has(ref) && !runtimeNodeIds.has(ref)) {
        warnings.push(
          `node ${data.id}: payload references $.${ref} which is not a node id or builtin (trigger/static/env/context) — it will resolve to nothing at runtime`
        );
      }
    }
  }

  // config.result reference check
  if (typeof config.result === 'string' && config.result.trim() !== '') {
    for (const ref of collectJsonPathRoots(config.result)) {
      if (!BUILTIN_LOOKUPS.has(ref) && !runtimeNodeIds.has(ref)) {
        warnings.push(`config.result references $.${ref} which is not a node id or builtin`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateNodePayload(type, data, label, errors, warnings) {
  const payload = data.payload;
  const isObj = typeof payload === 'object' && !Array.isArray(payload) && payload !== null;

  const requireKeys = (keys) => {
    if (!isObj) {
      errors.push(`node ${label}: ${type} payload must be an object with ${keys.join(', ')}`);
      return false;
    }
    for (const key of keys) {
      if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
        errors.push(`node ${label}: ${type} payload requires "${key}"`);
      }
    }
    return true;
  };

  switch (type) {
    case 'agent': {
      if (!isObj) {
        errors.push(`node ${label}: agent payload must be an object`);
        break;
      }
      const inline = payload.agent;
      if (payload.subject || payload.node_subject) {
        // References a saved agent / agent node template — nothing more to check.
      } else if (inline && typeof inline === 'object' && !Array.isArray(inline)) {
        for (const key of ['name', 'llm_provider', 'model']) {
          if (!inline[key]) {
            errors.push(`node ${label}: agent payload.agent requires "${key}"`);
          }
        }
        if (inline.llm_provider && !['claude', 'anthropic'].includes(inline.llm_provider)) {
          errors.push(
            `node ${label}: llm_provider "${inline.llm_provider}" — the invoke handler only supports "claude" or "anthropic"`
          );
        }
      } else if (payload.llm_provider || payload.model || payload.api_key || payload.behaviour) {
        errors.push(
          `node ${label}: flat agent payload (api_key/llm_provider/model at top level) is silently DROPPED at runtime — nest the definition under payload.agent: { name, llm_provider, model, behaviour, output_schema, ... } with prompt/await at payload top level`
        );
      } else {
        errors.push(
          `node ${label}: agent payload requires one of "subject" (saved agent), "node_subject" (agent node template), or "agent" ({ name, llm_provider, model, ... })`
        );
      }
      if (payload.prompt === undefined) {
        warnings.push(
          `node ${label}: agent payload has no "prompt" — the engine will fall back to sending the raw trigger as the prompt`
        );
      }
      break;
    }

    case 'function':
      if (!data.subject) {
        errors.push(`node ${label}: a subject is required for function nodes (data.subject, format ms.compute.*)`);
      } else if (!String(data.subject).startsWith('ms.compute.')) {
        warnings.push(`node ${label}: function subject "${data.subject}" does not start with ms.compute. — double-check it`);
      }
      break;

    case 'flow':
      if (!data.subject) {
        errors.push(`node ${label}: a subject is required for flow nodes (data.subject, format ms.hub.config.workflow.*)`);
      } else if (!String(data.subject).startsWith('ms.hub.config.workflow.')) {
        warnings.push(`node ${label}: flow subject "${data.subject}" does not start with ms.hub.config.workflow. — double-check it`);
      }
      break;

    case 'quiva-endpoint':
      if (!data.subject) {
        errors.push(`node ${label}: a subject is required for quiva-endpoint nodes (data.subject)`);
      }
      break;

    case 'integration':
    case 'http':
      if (type === 'integration' && data.integration_id) {
        // The request definition lives on the integration (validate/workflow.go).
        if (isObj && payload.baseURL !== undefined) {
          errors.push(`node ${label}: payload key "baseURL" is silently ignored by the engine — rename it to "base_url"`);
        }
        break;
      }
      if (requireKeys(['url', 'method'])) {
        if (payload.baseURL !== undefined) {
          errors.push(
            `node ${label}: payload key "baseURL" is silently ignored by the engine — rename it to "base_url"`
          );
        }
      }
      break;

    case 'eval':
      requireKeys(['code', 'params']);
      if (isObj && payload.params !== undefined && (typeof payload.params !== 'object' || Array.isArray(payload.params))) {
        errors.push(`node ${label}: eval payload "params" must be an object of name -> value`);
      }
      break;

    case 'delay':
      requireKeys(['time_ms']);
      break;

    case 'schedule':
      requireKeys(['flow_subject', 'trigger']);
      if (isObj && !payload.trigger_in && !payload.trigger_on) {
        warnings.push(`node ${label}: schedule payload has neither trigger_in nor trigger_on — the run will not be deferred`);
      }
      if (isObj && payload.name !== undefined && typeof payload.name !== 'string') {
        errors.push(`node ${label}: schedule payload "name" must be a string, e.g. "reminder:|$.trigger.id"`);
      }
      break;

    case 'task':
      checkTaskNode(data, payload, isObj, label, errors);
      break;

    case 'email':
      checkEmailNode(data, payload, isObj, label, errors);
      break;

    case 'verify-signature':
      checkVerifySignatureNode(payload, isObj, label, errors);
      break;

    case 'sign-envelope':
      checkSignEnvelopeNode(payload, isObj, label, errors, warnings);
      break;

    case 'input':
    case 'human-in-the-loop':
      requireKeys(['message']);
      if (isObj && payload.notify !== undefined) {
        warnings.push(
          `node ${label}: payload "notify" is not read by the current engine — use title/description/priority/assignees (comma-separated user ids) instead`
        );
      }
      break;

    case 'error':
      requireKeys(['status_code']);
      break;

    case 'condition': {
      // The engine passes the WHOLE payload in as the rule (graph.go
      // handleConditionNode -> evaluateRules): it is the conditional chain
      // itself, not an object wrapping one.
      if (isObj && payload.rules !== undefined) {
        errors.push(
          `node ${label}: condition payload must BE the conditional chain, not { rules: ... } — the engine evaluates the whole payload as the rule. Move the array up to the payload root. (The { rules, facts, context } envelope belongs to "rules" nodes.)`
        );
        break;
      }
      if (!Array.isArray(payload) && !isBranch(payload)) {
        errors.push(
          `node ${label}: condition payload must be an ARRAY of { condition, outcome } branches (last one may omit "condition" as the catch-all). See get_flows_reference("rules-syntax").`
        );
        break;
      }
      checkRule(payload, 'payload', `node ${label}`, errors, warnings);
      break;
    }

    case 'rules':
      if (requireKeys(['rules'])) {
        const rules = payload.rules;
        if (Array.isArray(rules) || typeof rules !== 'object' || rules === null) {
          errors.push(
            `node ${label}: rules payload "rules" must be a MAP of rule name -> rule (e.g. { "priority.value": [ { condition, outcome } ] }), not ${
              Array.isArray(rules) ? 'an array' : typeof rules
            }`
          );
        } else {
          for (const [name, rule] of Object.entries(rules)) {
            checkRule(rule, `payload.rules["${name}"]`, `node ${label}`, errors, warnings);
          }
        }
        for (const key of ['facts', 'context']) {
          const value = payload[key];
          if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
            errors.push(`node ${label}: rules payload "${key}" must be an object`);
          }
        }
      }
      break;

    case 'jsonlogic':
      requireKeys(['rules']);
      if (isObj && payload.rules !== undefined && (typeof payload.rules !== 'object' || Array.isArray(payload.rules) || payload.rules === null)) {
        errors.push(`node ${label}: jsonlogic payload "rules" must be an object of rule id -> json-logic expression`);
      }
      break;

    case 'static':
      if (containsJsonPath(payload)) {
        warnings.push(
          `node ${label}: static payload contains "$." references — static nodes take LITERAL values only; JSONPath is not resolved`
        );
      }
      break;

    case 'trigger':
      if (data.trigger_type === 'task') {
        if (!isObj || !payload.space_id) {
          errors.push(`node ${label}: task trigger payload requires "space_id"`);
          break;
        }
        const expectedId = `task:${payload.space_id}`;
        if (data.id !== expectedId) {
          errors.push(
            `node ${label}: task trigger node id must be exactly "${expectedId}" (task:<space_id>, colon not dot) — hub-service dispatches task events by glob on the node subject, so any other id means the trigger silently never fires (task-event-trigger-plan.md §0/§3).`
          );
        } else if (!TASK_TRIGGER_ID_REGEX.test(data.id)) {
          // Catches a space_id with characters ^\w+$ does not allow, which
          // would otherwise pass the expectedId string-equality check above.
          errors.push(`node ${label}: task trigger id "${data.id}" — space_id must match ^\\w+$ (letters, digits, underscore only)`);
        }
        if (payload.event_type !== undefined && !Array.isArray(payload.event_type)) {
          errors.push(`node ${label}: task trigger payload "event_type" must be an array of event-kind strings, e.g. ["task-created","task-updated"]`);
        }
      }
      break;
    case 'map':
      break;
  }
}

function schedulesATimer(type, data) {
  return type === 'schedule' || (type === 'quiva-endpoint' && SCHEDULE_SUBJECTS.has(data.subject));
}

// Mirrors hub-service/validate/workflow.go checkTaskNode: all three are errors there too.
function checkTaskNode(data, payload, isObj, label, errors) {
  if (!data.operation) {
    if (isObj && payload.operation !== undefined) {
      errors.push(`node ${label}: a task node reads data.operation, not payload.operation — move "operation" up beside node_type`);
    } else {
      errors.push(`node ${label}: a task node needs data.operation, one of ${TASK_OPERATIONS.join(', ')}`);
    }
    return;
  }
  if (!TASK_OPERATIONS.includes(data.operation)) {
    errors.push(`node ${label}: unknown task operation "${data.operation}": expected one of ${TASK_OPERATIONS.join(', ')}`);
  }
}

const isLiteral = (value) => typeof value === 'string' && !value.includes('$.') && !value.includes('SECRET::');
const hasValue = (value) => value !== undefined && value !== null && value !== '';

// hub-service/runner/email_node.go validateEmailPayload refuses these at run time.
function checkEmailNode(data, payload, isObj, label, errors) {
  if (data.operation && !EMAIL_OPERATIONS.includes(data.operation)) {
    errors.push(`node ${label}: unknown email operation "${data.operation}": expected ${EMAIL_OPERATIONS.join(', ')}`);
  }
  if (!isObj) {
    errors.push(`node ${label}: email payload must be an object with to, subject and html or text`);
    return;
  }
  if (Array.isArray(payload.to)) {
    errors.push(`node ${label}: email "to" must be ONE address, not a list — consent is decided per person, so send one email per recipient`);
  } else if (!hasValue(payload.to)) {
    errors.push(`node ${label}: email payload requires "to"`);
  }
  if (!hasValue(payload.subject)) errors.push(`node ${label}: email payload requires "subject"`);
  if (!hasValue(payload.html) && !hasValue(payload.text)) {
    errors.push(`node ${label}: email payload has no body — give "html", "text" or both`);
  }
}

// hub-service/runner/verify_signature_node.go verifySignatureInput.
function checkVerifySignatureNode(payload, isObj, label, errors) {
  if (!isObj) {
    errors.push(`node ${label}: verify-signature payload must be an object`);
    return;
  }
  const kinds = payload.expected_kind;
  if (!hasValue(kinds) || (Array.isArray(kinds) && kinds.length === 0)) {
    errors.push(`node ${label}: verify-signature needs "expected_kind" — the kind or kinds this route carries, e.g. "order" or ["update","cancellation"]`);
  }
  if (!hasValue(payload.nonce_bucket)) {
    errors.push(`node ${label}: verify-signature needs "nonce_bucket" — the KV bucket nonces are claimed in`);
  }
  if (typeof payload.keyring === 'string' && payload.keyring.trim().startsWith('SECRET::')) {
    errors.push(`node ${label}: verify-signature "keyring" is a secret-name PREFIX, not a SECRET:: reference — the distribution id is appended to it`);
  }
  for (const key of ['headers', 'body']) {
    if (typeof payload[key] === 'string' && payload[key].trim().startsWith('|')) {
      errors.push(`node ${label}: verify-signature "${key}" starts with a pipe, which resolves the object to a STRING and fails every call — use "${payload[key].trim().slice(1)}"`);
    }
  }
}

// hub-service/runner/sign_envelope_node.go signEnvelopeInput / resolveSigningSeed.
function checkSignEnvelopeNode(payload, isObj, label, errors, warnings) {
  if (!isObj) {
    errors.push(`node ${label}: sign-envelope payload must be an object`);
    return;
  }
  for (const key of ['kind', 'sender_account_id', 'body']) {
    if (!hasValue(payload[key])) errors.push(`node ${label}: sign-envelope payload requires "${key}"`);
  }
  if (!hasValue(payload.seed) && !hasValue(payload.distribution_id)) {
    errors.push(`node ${label}: sign-envelope needs "seed" (a SECRET:: reference) or "distribution_id" (loads <seed_secret_prefix><distribution_id>)`);
  }
  if (isLiteral(payload.distribution_id) && payload.distribution_id && !DISTRIBUTION_ID_REGEX.test(payload.distribution_id.trim())) {
    errors.push(`node ${label}: sign-envelope "distribution_id" must match ^[A-Za-z0-9_-]+$`);
  }
  if (isLiteral(payload.seed) && payload.seed) {
    warnings.push(`node ${label}: sign-envelope "seed" is a literal — use a SECRET:: reference; a flow config is readable by anyone who can read the flow`);
  }
  if (typeof payload.body === 'string' && payload.body.trim().startsWith('|')) {
    warnings.push(`node ${label}: sign-envelope "body" starts with a pipe, so the body is signed and sent as a STRING — drop the pipe to send the object`);
  }
}

// A condition branch's "outcome" is the next step: a node id, or the reserved
// RESOLVE_SUCCESS / RESOLVE_ERROR (graph.go processConditionOutcome). Anything
// else fails the run with "next step not found". An outcome may also be an
// array of node ids to activate several branches at once.
export function checkConditionTargets(config) {
  const issues = [];
  const warnings = [];
  const nodes = Array.isArray(config?.nodes) ? config.nodes : [];
  const edges = Array.isArray(config?.edges) ? config.edges : [];
  const nodeIds = new Set(nodes.map((n) => n?.data?.id ?? n?.id).filter(Boolean));

  for (const node of nodes) {
    const data = node?.data;
    if (data?.node_type !== 'condition' || data.payload == null) continue;

    const outcomes = checkRule(data.payload, 'payload', `condition ${data.id}`, [], []);
    const edgeTargets = new Set(edges.filter((e) => e?.source === data.id).map((e) => e?.target));

    for (const { value, path } of outcomes) {
      const targets = Array.isArray(value) ? value : [value];
      for (const target of targets) {
        if (typeof target !== 'string') {
          issues.push(
            `condition ${data.id}: ${path}.outcome must be a node id string (or an array of them), or RESOLVE_SUCCESS / RESOLVE_ERROR — got ${
              value === null ? 'null' : typeof target
            }. The engine requires a string or array of strings and fails with "value has to be a string or an array of strings".`
          );
          continue;
        }
        if (RESERVED_CONDITION_TARGETS.has(target)) continue;
        if (!nodeIds.has(target)) {
          issues.push(
            `condition ${data.id}: ${path}.outcome "${target}" is not a node id or RESOLVE_SUCCESS/RESOLVE_ERROR — the flow will fail with "next step not found"`
          );
        } else if (!edgeTargets.has(target)) {
          warnings.push(
            `condition ${data.id}: branch target "${target}" has no edge ${data.id} -> ${target}. It will still run, but merge nodes downstream miscount when this branch is skipped — add the edge.`
          );
        }
      }
    }
  }
  return { issues, warnings };
}

function findCycle(adjacency) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  const parent = new Map();

  for (const start of adjacency.keys()) {
    if ((color.get(start) ?? WHITE) !== WHITE) continue;
    const stack = [[start, 0]];
    color.set(start, GRAY);

    while (stack.length > 0) {
      const [node, index] = stack[stack.length - 1];
      const children = adjacency.get(node) || [];
      if (index < children.length) {
        stack[stack.length - 1][1]++;
        const child = children[index];
        const childColor = color.get(child) ?? WHITE;
        if (childColor === GRAY) {
          // Reconstruct cycle path
          const cycle = [child];
          let current = node;
          while (current !== child && current !== undefined) {
            cycle.push(current);
            current = parent.get(current);
          }
          cycle.push(child);
          return cycle.reverse();
        }
        if (childColor === WHITE) {
          color.set(child, GRAY);
          parent.set(child, node);
          stack.push([child, 0]);
        }
      } else {
        color.set(node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

// Extract the root identifier of every "$.<root>..." reference in any string
// value inside a payload.
function collectJsonPathRoots(value, roots = new Set()) {
  if (typeof value === 'string') {
    const matches = value.matchAll(/\$\.([a-zA-Z_][a-zA-Z0-9_:]*)/g);
    for (const match of matches) roots.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const item of value) collectJsonPathRoots(item, roots);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectJsonPathRoots(item, roots);
  }
  return roots;
}

function containsJsonPath(value) {
  return collectJsonPathRoots(value).size > 0;
}

// Full validation: structural + condition targets.
export function validate(config) {
  const result = validateFlowConfig(config);
  const { issues, warnings } = checkConditionTargets(config);
  result.errors.push(...issues);
  result.warnings.push(...warnings);

  // Presentation fields are not required by the API but the flow editor needs
  // them; create_workflow / update_workflow fill them in automatically.
  const nodes = Array.isArray(config?.nodes) ? config.nodes : [];
  if (nodes.length > 0 && nodes.every((n) => !n?.position)) {
    result.warnings.push(
      'no node has a "position" — the flow editor would render every node stacked at the origin. create_workflow / update_workflow auto-layout this (auto_layout=true by default); set positions yourself to control the layout.'
    );
  }

  result.valid = result.errors.length === 0;
  return result;
}
