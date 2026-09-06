// Canonical node type reference for Quiva workflows.
//
// Derived from the flow engine source (hub-service/runner/graph.go,
// hub-service/model/request.go), NOT just the OpenAPI spec — the spec has a
// few shapes the engine does not actually accept. Engine-truth wins here.

export const JSONPATH_GUIDE = `
Data references (JSONPath) usable inside node payloads:
  $.trigger              - the trigger input passed to the run
  $.trigger.<field>      - a field of the trigger object
  $.static               - workflow static variables (config.static + static nodes)
  $.context              - context variables passed at run time
  $.env.auth_token       - the run's auth token
  $.env.run_id           - the tracking/run id
  $.env.headers          - request headers map
  $.<NODE_ID>            - the full output of an upstream node
  $.<NODE_ID>.result     - the text/object result of an agent node (agent output is an object; .result holds the answer)

Concatenation inside a payload string — the resolver splits on "|" and joins the
parts, so a pipe lets you mix literals with JSONPath in one value:
  "$.trigger.firstName| |$.trigger.lastName"   -> "Ada Lovelace"  (the " " between pipes is a literal space)
  "Bearer |$.env.auth_token"                   -> "Bearer eyJ..."
  "Summarise: |$.trigger.text"                 -> literal prefix + resolved value

Secrets: "SECRET::MY_SECRET_NAME::" anywhere in a payload is replaced with the
account secret of that name at run time (resolved by GetWorkflowConfig). Create
the secret in the account first; the placeholder is safe to commit.

JSONPath is resolved in every node payload EXCEPT:
  - static nodes (literal values only)
  - eval nodes (only the values inside payload.params are resolved; payload.code is plain JavaScript)

Workflow-level config fields:
  config.result  - JSONPath string selecting the run's return value, e.g. "$.FINAL_NODE.result".
                   Without it the run returns the full step-by-step log array.
  config.static  - object of static variables available via $.static
  config.options - { run_type: "normal"|"debounced"|"ordered", order_on, debounce_on, debounce_time, debounce_max }
`.trim();

export const GOTCHAS = [
  'Agent nodes: nest the inline definition under payload.agent ({name, llm_provider, model, ...}); flat payloads (api_key/llm_provider/model at payload top level) are silently dropped and the node fails with "a subject, node_subject or agent property is required". Only llm_provider "claude"/"anthropic" is supported. Use platform model aliases (claude-sonnet-4-6, claude-haiku-4-5).',
  'Agent results ($.<ID>.result) are STRINGS even with output_schema — and NOT raw JSON: verified live 2026-07-29, the string comes back MARKDOWN-FENCED (```json\\n{...}\\n```), so a bare JSON.parse THROWS. In an eval node, extract the object first: JSON.parse(String(r).match(/\\{[\\s\\S]*\\}/)[0]).',
  'Published workflow subjects have NO "published" segment: ms.hub.config.workflow.{collection}.{flow}. Only drafts carry ".draft.". Get the published subject from list_workflows version=published.',
  'Update records with PUT (the records service registers put.record; PATCH returns 500 despite the records openapi saying PATCH).',
  'Use node_type "delay", NOT "wait". The OpenAPI spec says "wait" but the engine has no such handler — a "wait" node silently does nothing.',
  'HTTP/integration payloads use "base_url" (snake_case), NOT "baseURL". A "baseURL" key is silently ignored and the request goes to just "url". Safest: put the full URL in "url".',
  'Node IDs must match ^[a-zA-Z_][a-zA-Z0-9_:]*$ and must not be: trigger, static, RESOLVE_ERROR, RESOLVE_SUCCESS. BUT the server only enforces this when the request carries validate=true, and the flow editor does not send it — so UI-authored flows contain nanoid ids with hyphens (e.g. "QsY6OWA5xVhZn9aS3lF-Z") that cannot be re-sent with validation on. Use server_validate=false to update such a flow.',
  'Every node requires a payload (server rejects nodes without one).',
  'function nodes require an existing "subject" (ms.compute.*); flow nodes require an existing "subject" (ms.hub.config.workflow.*). The server verifies these exist.',
  'The graph must be acyclic. The server does NOT check for cycles — a cycle means those nodes simply never run.',
  'Nodes with no incoming edges all start immediately in parallel. A graph with no edges runs every node simultaneously.',
  'trigger nodes are skipped at runtime — they are editor/config metadata. You do not need one for the flow to run.',
  'Condition branch targets are activated directly by the condition node, but you should still add edges condition -> target so merge-node bookkeeping works when a branch is skipped.',
  'condition / rules nodes use the rule-engine v2 DSL: branches are { condition: { operator, input }, outcome }, NOT { if, then, else }. The editor labels them IF / ELSE IF / ELSE, which is why the wrong shape looks plausible. A condition payload IS the branch array (no "rules" wrapper); a rules payload is { rules: { name: <rule> }, facts, context }. Call get_flows_reference("rules-syntax").',
  'An operator the rules engine does not implement does NOT error — it resolves to undefined, the branch is skipped, and the run fails with the misleading "failed to determine next steps". The validator errors on unknown operator names; get the list from get_flows_reference("rules-syntax").',
  'A conditional chain whose last branch still has a "condition" has no catch-all: a run where nothing matches fails with "failed to determine next steps". End with { "outcome": ... } and no condition.',
  'Nodes and edges need flow-editor presentation fields (node: position/type/measured; edge: type/edgeType/sourceHandle/targetHandle) or the graph renders stacked at the origin. create_workflow / update_workflow auto-layout anything missing.',
  'Pipe concatenation: "$.trigger.first| |$.trigger.last" joins values with a literal middle segment; "Bearer |$.env.auth_token" prefixes a literal. Secrets use the SECRET::NAME:: placeholder.',
  'verify-challenge nodes: a FAILED challenge is a successful node returning { success: false }, not an error. The run continues downstream regardless, so you MUST branch on $.<ID>.success — otherwise every bot submission proceeds exactly as a person\'s would. Check $.<ID>.hostname too: one widget can allow several domains and a token solved on any of them verifies on all of them.',
  'task nodes: "operation" is a NODE-LEVEL property (data.operation), not a payload field. Omitting space_id is not neutral — it falls back to the ESCALATE space. An empty assignees list CLEARS assignees (only an absent field is no-change), and a mapped value resolving to nothing sends exactly that. status/priority/tags are free strings server-side, so a value the space does not define is stored and then matches no filter, and the task vanishes from every board.',
  'input / human-in-the-loop payload is {title, description, message, priority, assignees} (assignees = comma-separated user ids). The spec\'s "notify" email/slack block is not read by the current engine.',
];

export const NODE_TYPES = {
  trigger: {
    summary:
      'Entry-point metadata for the visual editor. No trigger node is executed as a step. But FOUR kinds are read elsewhere and genuinely start runs: "record", "object-store" and "email" by hub-service\'s subscriber, and "schedule" at PUBLISH time — publish-workflow.go:58-99 unschedules the previously published one and installs the draft\'s. Only "manual", "webhook" and "embed" are purely presentational.',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {},
      optional: {
        api_key: 'API key config for embed triggers',
        embed_type: '"chat" | "form" for embed triggers',
        theme: '"light" | "dark"',
        element_props: '{ title, description, initialMessage, height }',
        record_config_id: 'RECORD triggers only: the record config whose events start this flow. Must match the config id exactly.',
        event_type:
          'RECORD triggers only: array of event names to accept, e.g. ["record-created", "record-updated"]. Omit (or leave empty) to accept every record event — hub-service only filters when the array is non-empty.',
      },
    },
    nodeLevelProps: {
      trigger_type:
        '"manual" | "schedule" | "webhook" | "embed" | "record" | "object-store" | "email". "manual", "webhook" and "embed" are editor metadata; "schedule" is installed at publish time (publish-workflow.go:58-99); the last three are live in hub-service (data.TriggerTypeRecord / TriggerTypeObjectStore / TriggerTypeEmail) and drive real dispatch.',
      topic: 'topic identifier for scheduled triggers',
    },
    example: {
      id: 'TRIGGER',
      data: {
        id: 'TRIGGER',
        name: 'Manual Trigger',
        node_type: 'trigger',
        trigger_type: 'manual',
        payload: {},
      },
    },
    record_trigger_example: {
      // The id is NOT free-form here — see record_trigger below.
      id: 'record.risk_programme',
      position: { x: 0, y: 0 },
      type: 'custom',
      data: {
        id: 'record.risk_programme',
        name: 'On risk programme record',
        node_type: 'trigger',
        trigger_type: 'record',
        payload: {
          record_config_id: 'risk_programme',
          event_type: ['record-created', 'record-updated'],
        },
      },
    },
    record_trigger: {
      what:
        'Starts the flow when a record is created or updated in a given record config. records-service publishes `hub.trigger.record.<configID>.<recordID>` (RepublishRecord) and hub-service\'s subscriber fans it out to matching trigger nodes.',
      the_id_rule:
        'The node id MUST be exactly `record.<record_config_id>`. hub-service finds trigger nodes by GLOB on the node subject — `ms.hub.config.workflow-node.*.*.record.<configID>` (service/service.go recordTriggerNodeSubject) — and a node subject is the flow subject with ".workflow." replaced by ".workflow-node." plus "." + node.id. Any other id and the trigger silently never fires. The editor does the same thing (trigger-record.component.svelte:113).',
      validator_consequence:
        'That id contains a dot, which hub-service validate.ValidateID rejects. So a record-trigger flow CANNOT be sent with server-side validation on: pass server_validate=false. validate_flow_config downgrades the id error to a warning when node_type is "trigger" and trigger_type is "record".',
      published_only:
        'The glob has exactly two wildcards for collection and flow, so it matches PUBLISHED node subjects only. A draft node subject carries an extra ".draft." token and never matches — a record trigger on an unpublished flow does nothing. Publish the flow before expecting record events.',
      event_filter:
        'payload.event_type is matched against the `x-event-type` header (record-created / record-updated). hub-service skips the filter when the array is absent or empty, so an omitted event_type accepts every record event.',
      records_side:
        'The publish is OPT-IN on the records side: records-service only republishes when the create/update body sets `completed: true` (or passes `test_flow`). A plain create fires nothing. See quiva-records-mcp get_records_reference("flow-triggers").',
      test_flow:
        'create_record accepts `test_flow: { subject, run_id }`, which runs ONLY that flow and suppresses every configured trigger — the way to exercise a flow without a record config wired up. hub-service turns run_id into `ms.hub.run.<run_id>.<subject>` when it is not already a run subject.',
    },
    notes:
      'Runtime input arrives via the run request "trigger" field and is referenced as $.trigger — not through this node. For a record trigger, $.trigger is the full record ({ id, data, folder, space_id, completed, created_at, updated_at }).',
  },

  agent: {
    summary: 'Invoke an LLM agent. The inline agent definition MUST be nested under payload.agent — flat payloads are silently dropped at runtime.',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        agent:
          'inline agent definition: { name (required), llm_provider (required: "claude" or "anthropic" — the invoke handler rejects others), model (required — use platform catalog aliases like "claude-sonnet-4-6", "claude-haiku-4-5"), behaviour, output_schema (flat map field -> short description), has_tools, tools (bit://web_search, mcp://, fun://), timeout (seconds), knowledge }. ALTERNATIVE: pass "subject" (a saved agent subject) or "node_subject" (agent node template) instead of "agent".',
      },
      optional: {
        prompt:
          'string or object at payload TOP LEVEL (not inside agent); supports JSONPath, e.g. "Summarise |$.trigger.text". Empty prompt falls back to the raw trigger.',
        await: 'boolean at payload top level — wait for completion',
        knowledge: 'array of knowledge URIs: kv://bucket/doc, obj://bucket/doc, str://stream/start/end, sid://session_id, dta://data',
        session_id: 'conversation continuity (usually injected by the run)',
      },
    },
    example: {
      id: 'SUMMARISER',
      data: {
        id: 'SUMMARISER',
        name: 'Summariser',
        node_type: 'agent',
        payload: {
          agent: {
            name: 'summariser',
            llm_provider: 'claude',
            model: 'claude-haiku-4-5',
            behaviour: 'You summarise text in one paragraph.',
            output_schema: { summary: 'the one-paragraph summary' },
            timeout: 60,
          },
          prompt: 'Summarise: |$.trigger.text',
          await: true,
        },
      },
    },
    notes:
      'IMPORTANT: the agent result at $.<ID>.result is a JSON-ENCODED STRING even when output_schema is set — add an eval node after the agent to JSON.parse it before referencing fields (e.g. code: "JSON.parse(String(r).match(/\\\\{[\\\\s\\\\S]*\\\\}/)[0])", params: {r: "$.<ID>.result"}). No api_key field is needed — the platform supplies provider credentials.',
  },

  function: {
    summary: 'Invoke a compute (Hydra) function by subject.',
    required: ['id', 'node_type', 'subject', 'payload'],
    nodeLevelProps: {
      subject: 'REQUIRED — function subject, format ms.compute.<...>.function.<id>; must exist (use list_functions)',
      response_map: 'optional JSONPath mapping applied to the function output',
      options: '{ flat_map, backoff_ms, timeout (ms), attempts (1-10), ignore_response_codes }',
    },
    payload: {
      required: {
        payload:
          'any JSON (object/string/array/number/bool) passed as function input; JSONPath supported throughout, e.g. "$.PREV_NODE"',
      },
      optional: {},
    },
    example: {
      id: 'BASE64_ENCODE',
      data: {
        id: 'BASE64_ENCODE',
        name: 'Base64 Encode',
        node_type: 'function',
        subject: 'ms.compute.1753641292.function.230114167',
        payload: '$.CLEAN_UP.result',
      },
    },
  },

  integration: {
    summary:
      'HTTP request to a third-party API, optionally through an OAuth connection (slack, github, ...). Same runtime handler as "http".',
    required: ['id', 'node_type', 'payload'],
    nodeLevelProps: {
      integration_id: 'integration identifier, e.g. "slack"',
      request_type_id: 'request type, e.g. "post_chat_postMessage"',
      oauth: 'OAuth connection identifier, e.g. "slack.maria"',
      options: '{ flat_map, backoff_ms, timeout (ms), attempts, ignore_response_codes }',
    },
    payload: {
      required: {
        url: 'endpoint path or full URL',
        method: 'HTTP method (GET/POST/... case-insensitive)',
      },
      optional: {
        base_url: 'base URL joined with url — MUST be snake_case "base_url" (NOT baseURL)',
        data: 'request body object',
        params: 'path/query params object',
        query: 'query params object',
        headers: 'headers map',
        timeout: 'ms',
      },
    },
    example: {
      id: 'SLACK_POST',
      data: {
        id: 'SLACK_POST',
        name: 'Post to Slack',
        node_type: 'integration',
        integration_id: 'slack',
        request_type_id: 'post_chat_postMessage',
        oauth: 'slack.myconnection',
        payload: {
          base_url: 'https://slack.com/api',
          url: '/chat.postMessage',
          method: 'post',
          data: { channel: '#engineering', text: '$.SUMMARISER.result' },
        },
      },
    },
    notes:
      'Result shape: { status, statusText, headers, data }. 4xx/5xx responses become node errors (use options.ignore_response_codes or attempts to tolerate/retry).',
  },

  http: {
    summary: 'Plain HTTP request (no OAuth integration metadata). Same handler and payload as "integration".',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        url: 'endpoint path or full URL',
        method: 'HTTP method',
      },
      optional: {
        base_url: 'base URL joined with url — snake_case',
        data: 'request body',
        params: 'params object',
        query: 'query params',
        headers: 'headers map',
        timeout: 'ms',
      },
    },
    example: {
      id: 'FETCH_USERS',
      data: {
        id: 'FETCH_USERS',
        node_type: 'http',
        payload: { url: 'https://api.example.com/users', method: 'GET' },
      },
    },
  },

  flow: {
    summary: 'Invoke another (published) workflow as a sub-flow.',
    required: ['id', 'node_type', 'subject', 'payload'],
    nodeLevelProps: {
      subject: 'REQUIRED — sub-workflow subject (ms.hub.config.workflow.<collection>.<flow>); must exist. There is NO "published" segment — see the gotcha; only drafts carry ".draft.". The two segments are hashes of the collection and flow names (hub-service/data/const.go:190-193), so read them off list_workflows rather than composing them from names.',
      await: 'boolean — wait for the sub-flow to finish',
      response_map: 'optional JSONPath mapping over the sub-flow output',
      options: '{ flat_map, backoff_ms, timeout (ms), attempts, ignore_response_codes }',
    },
    payload: {
      required: {
        payload: 'any JSON passed as the sub-flow trigger; JSONPath supported',
      },
      optional: {},
    },
    example: {
      id: 'ENRICH',
      data: {
        id: 'ENRICH',
        node_type: 'flow',
        subject: 'ms.hub.config.workflow.2408930879.1009853675',
        await: true,
        payload: { record: '$.trigger.record' },
      },
    },
  },

  eval: {
    summary: 'Run a JavaScript expression over named params.',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        code: 'JavaScript expression/function body. Plain JS — JSONPath is NOT resolved inside code.',
        params:
          'object of named params usable in code; each VALUE is JSONPath-resolved, e.g. {"c": "$.AGENT.result"}',
      },
      optional: {},
    },
    example: {
      id: 'CLEAN_UP',
      data: {
        id: 'CLEAN_UP',
        node_type: 'eval',
        payload: {
          code: "c.replace('```javascript\\n','').replace('\\n```','')",
          params: { c: '$.CODE_EXPERT.result' },
        },
      },
    },
  },

  condition: {
    summary:
      'Branching. The payload IS a conditional chain (rule-engine v2): an ordered array of { condition, outcome } branches; the first truthy one activates its target node(s). Non-selected branches are skipped.',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        '<the payload itself>':
          'an ARRAY of branches, each { condition: { operator, input }, outcome: "NODE_ID" }. The LAST branch may omit "condition" to act as the catch-all (the UI calls these IF / ELSE IF / ELSE). NOT wrapped in a "rules" key — the engine evaluates the whole payload as the rule.',
      },
      optional: {
        outcomeMessage: 'per-branch: a string or expression explaining the decision',
      },
    },
    example: {
      id: 'CHECK_FOR_DUPLICATES',
      data: {
        id: 'CHECK_FOR_DUPLICATES',
        node_type: 'condition',
        payload: [
          {
            condition: { operator: '=', input: ['$.DEDUPE_CHECK.duplicate_exists', false] },
            outcome: 'CREATE_FOLDER',
          },
          {
            condition: { operator: '=', input: ['$.DEDUPE_CHECK.duplicate_exists', true] },
            outcome: 'CONFLICT_RESPONSE',
          },
          { outcome: 'RESOLVE_ERROR' },
        ],
      },
    },
    notes:
      'DO NOT use { if, then, else } — the engine does not recognise it; the whole payload becomes the outcome and the run fails with "value has to be a string or an array of strings". Each "outcome" must be a node id, an array of node ids, or the reserved RESOLVE_SUCCESS (end flow successfully) / RESOLVE_ERROR (fail flow). Condition nodes get EMPTY facts, so "@fact:" does not work here — reference upstream data with plain JSONPath ("$.NODE.field"), resolved before the rule runs. Also add edges condition -> target for every branch. Full DSL: get_flows_reference("rules-syntax"); real example: get_example("client-folder-creation").',
  },

  rules: {
    summary:
      'Evaluate a MAP of named rules against declared facts; returns { <ruleName>: outcome }. Same rule-engine v2 dialect as condition nodes, but with a facts envelope and chaining. (Not in the OpenAPI spec.)',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        rules:
          'map of rule name -> rule (a conditional chain, expression, or literal). Rules CHAIN: a later rule may reference an earlier rule\'s key with "@fact:<name>".',
      },
      optional: {
        facts: 'map of fact name -> value; values may be JSONPath ("$.NODE.field") and are resolved before evaluation. Referenced in rules as "@fact:<name>".',
        context: 'context object, e.g. { timezone: <int> }',
      },
    },
    example: {
      id: 'PRODUCT_SELECTION_RULES',
      data: {
        id: 'PRODUCT_SELECTION_RULES',
        node_type: 'rules',
        payload: {
          facts: { 'state.value': '$.GEOCODE_RESPONSE.state', 'limit.value': '$.trigger.valueLimit' },
          rules: {
            'productDecision.value': [
              { condition: { operator: 'in', input: ['@fact:state.value', ['CA', 'FL', 'NY']] }, outcome: 'Product1' },
              {
                condition: {
                  operator: 'and',
                  input: [
                    { operator: 'in', input: ['@fact:state.value', ['MA', 'TX']] },
                    { operator: '>', input: ['@fact:limit.value', 10000000] },
                  ],
                },
                outcome: 'Product2',
              },
              { outcome: 'Product3' },
            ],
          },
          context: {},
        },
      },
    },
    notes:
      'Returns { <ruleName>: <outcome> } — verified live. Read a single outcome as $.<ID>.<ruleName>, but ONLY if the rule name has no dots: a dotted key like "AvatarUrl.visible" cannot be read with $.<ID>.AvatarUrl.visible (the resolver walks AvatarUrl -> visible instead of matching the literal key, and you get []). Either keep rule names dot-free when a downstream node needs them, or read the whole map with $.<ID> and pick the key in an eval node. NOTE the "rules" NODE unwraps to bare outcomes, whereas the shared rules COMPUTE FUNCTION (a "function" node with an ms.compute.* subject, as used by the production Builders Risk flow) returns the raw engine output — which is why that flow reads $.NODE..outcome. Same payload, different return shape. Full DSL: get_flows_reference("rules-syntax"); real example: get_example("builders-risk-product-selection").',
  },

  jsonlogic: {
    summary:
      'Evaluate a MAP of named json-logic rules against data — the same rule language the form builder writes, so one rule set can drive both the browser gate and the server decision. Non-short-circuiting: every rule runs. (Not in the OpenAPI spec.)',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        rules: 'map of rule id -> json-logic rule expression, evaluated against "data"',
      },
      optional: {
        data: 'object the rules are evaluated against; JSONPath supported',
        timeout: 'milliseconds; 0 (or omitted) uses the engine default deadline',
      },
    },
    example: {
      id: 'GATE_CHECK',
      data: {
        id: 'GATE_CHECK',
        node_type: 'jsonlogic',
        payload: {
          rules: { over18: { '>=': [{ var: 'age' }, 18] } },
          data: { age: '$.trigger.age' },
        },
      },
    },
    notes:
      'Result is FLAT: $.<ID>.<ruleId>, NOT $.<ID>.result.<ruleId> like an agent node. Every rule is evaluated regardless of earlier results, so a run can assert which rules did NOT fire as well as which did.',
  },

  map: {
    summary: 'Transform/reshape data: the payload itself is JSONPath-resolved and becomes the node output.',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        payload: 'object or array template; every string value may be a JSONPath reference',
      },
      optional: {},
    },
    nodeLevelProps: {
      options: '{ flat_map: true } to flatten array results',
    },
    example: {
      id: 'SHAPE_OUTPUT',
      data: {
        id: 'SHAPE_OUTPUT',
        node_type: 'map',
        payload: {
          summary: '$.SUMMARISER.result',
          source: '$.trigger.url',
        },
      },
    },
  },

  static: {
    summary: 'Merge literal values into $.static for downstream nodes. LITERALS ONLY — JSONPath is not resolved here.',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        payload: 'object of literal key/values merged into $.static',
      },
      optional: {},
    },
    example: {
      id: 'CONSTANTS',
      data: {
        id: 'CONSTANTS',
        node_type: 'static',
        payload: { region: 'eu-west-2', max_items: 50 },
      },
    },
  },

  delay: {
    summary: 'Pause the branch for a number of milliseconds. (The OpenAPI spec calls this "wait" — the engine only accepts "delay".)',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        time_ms: 'integer milliseconds to wait; supports JSONPath',
      },
      optional: {},
    },
    example: {
      id: 'PAUSE_5S',
      data: {
        id: 'PAUSE_5S',
        node_type: 'delay',
        payload: { time_ms: 5000 },
      },
    },
  },

  schedule: {
    summary: 'Schedule another workflow run for later (relative delay or cron/ISO date).',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        flow_subject: 'workflow subject to schedule; supports JSONPath',
        trigger: 'trigger data for the scheduled run; supports JSONPath',
      },
      optional: {
        trigger_in: 'delay like "5m", "1h", "2d"',
        trigger_on: 'cron expression or ISO date',
      },
    },
    example: {
      id: 'FOLLOW_UP',
      data: {
        id: 'FOLLOW_UP',
        node_type: 'schedule',
        payload: {
          flow_subject: 'ms.hub.config.workflow.2408930879.1009853675',
          trigger: { customer: '$.trigger.customer' },
          trigger_in: '2d',
        },
      },
    },
  },

  input: {
    summary:
      'Pause the flow and wait for human input; creates an escalation task. Resume via run_workflow with run_id + new trigger.',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        message: 'prompt shown to the human; supports JSONPath',
      },
      optional: {
        title: 'escalation task title',
        description: 'escalation task description',
        priority: 'task priority',
        assignees: 'comma-separated user ids; each is emailed a task + flow link',
      },
    },
    example: {
      id: 'CONFIRM_DETAILS',
      data: {
        id: 'CONFIRM_DETAILS',
        node_type: 'input',
        payload: {
          message: 'Please confirm the extracted policy details: $.EXTRACTOR.result',
          title: 'Confirm policy details',
          assignees: 'user_123',
        },
      },
    },
    notes:
      'The value supplied on resume becomes this node\'s output. The OpenAPI spec\'s "notify" email/slack block is NOT read by the current engine — use title/assignees instead.',
  },

  'human-in-the-loop': {
    summary: 'Alias of "input": pause for human approval/input via an escalation task.',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        message: 'prompt for the approver; supports JSONPath',
      },
      optional: {
        title: 'escalation task title',
        description: 'escalation task description',
        priority: 'task priority',
        assignees: 'comma-separated user ids',
      },
    },
    example: {
      id: 'APPROVAL',
      data: {
        id: 'APPROVAL',
        node_type: 'human-in-the-loop',
        payload: {
          message: 'Approve expense of $.trigger.amount?',
          title: 'Expense approval',
          assignees: 'manager_456',
        },
      },
    },
  },

  'quiva-endpoint': {
    summary: 'Invoke a Quiva endpoint by subject. (Not in the OpenAPI spec; use list_quiva_endpoints to discover subjects.)',
    required: ['id', 'node_type', 'subject', 'payload'],
    subject_is_allowlisted:
      'THE SUBJECT IS A CLOSED ALLOWLIST, not an arbitrary bus subject. providers.InvokeEndpoint (hub-service/providers/endpoint.go:22) checks the subject against data.AllowedEndpoints and returns "endpoint not allowed: <subject>" for anything else. list_quiva_endpoints returns that exact list (32 subjects: microstrate.storage.* KV/object/stream operations, plus microstrate.hub.post.workflow-run). A flow therefore CANNOT reach an arbitrary platform service this way. Worked example of the consequence, 2026-08-04: numbergen-service provides atomic counters (microstrate.numbergen.put.increment, with compare-and-swap and 10 retries — exactly what generating a gap-free sequential reference number needs) and it is unreachable from a flow BOTH ways: not in the allowlist, and not exposed through the API gateway either — PUT https://api.microstrate.io/numbergen/increment returns 404 while known routes such as /records/{config} and /workspaces/task return 401 unauthenticated, so the 404 is absence of a route and not an auth failure. For a counter from a flow, use microstrate.storage.get.kv-entry + microstrate.storage.put.kv-entry, which ARE allowlisted — but that is read-modify-write with no compare-and-swap, so two concurrent runs can produce the same number. If a reference must be collision-free, derive it from something already unique (a record id) rather than a counter.',
    nodeLevelProps: {
      subject: 'REQUIRED — endpoint subject, and it MUST be one of the allowlisted subjects from list_quiva_endpoints',
    },
    payload: {
      required: {
        payload: 'any JSON passed to the endpoint; JSONPath supported',
      },
      optional: {},
    },
    example: {
      id: 'CALL_ENDPOINT',
      data: {
        id: 'CALL_ENDPOINT',
        node_type: 'quiva-endpoint',
        subject: 'ms.gateway.endpoint.example',
        payload: { input: '$.trigger' },
      },
    },
  },

  task: {
    summary:
      'Act on a workspace task: create, update, set status, assign, comment, or complete one of its actions. (Not in the OpenAPI spec; added 2026-08.) The operation — NOT a subject — selects the endpoint, so unlike quiva-endpoint there is nothing to look up.',
    required: ['id', 'node_type', 'operation', 'payload'],
    nodeLevelProps: {
      operation:
        'REQUIRED, and it sits on data.operation, NOT in the payload. One of: create_task, update_task, set_task_status, assign_task, comment_task, complete_task_action. An unknown value fails the node with the valid list, so a typo here is loud (unlike node_type, which is not validated at all).',
    },
    payload: {
      required: {
        'task_id (all except create_task)':
          'Task reference such as LEADS-7. Usually mapped from an earlier node. The node moves it out of the body for you — see notes.',
        'title (create_task)': 'Task title.',
        'status (set_task_status)': "One of the space's own statuses.",
        'assignees (assign_task)': 'Array of user ids.',
        'body (comment_task)': 'Comment text; plain text or markdown.',
        'action_id (complete_task_action)': "Id of the action to tick off.",
      },
      optional: {
        space_id:
          'Space the task belongs to. OMITTING THIS IS NOT NEUTRAL — it falls back to ESCALATE, so name the space you mean.',
        description: 'Markdown supported.',
        priority: "One of the space's own priorities.",
        due_date: 'ISO 8601 timestamp.',
        scheduled_at: 'ISO 8601 timestamp.',
        tags: 'Array of strings.',
        folder: 'Folder name. The only usable partition for linking, since task indexes cover no payload fields.',
        parent: 'Task reference — makes this a subtask.',
        reporter: 'User id.',
        archived: 'Boolean, update_task only.',
        attachments: 'Array of file ids.',
        internal: 'comment_task only: hidden from client users. A flow runs as the account, so this is not refused for it.',
        mentions: 'comment_task only: array of user ids.',
        reply_id: 'comment_task only: id of the comment being replied to.',
        done: 'complete_task_action only: defaults to true. Pass false to untick.',
      },
    },
    example: {
      id: 'RAISE_TASK',
      data: {
        id: 'RAISE_TASK',
        node_type: 'task',
        operation: 'create_task',
        payload: {
          space_id: 'LEADS',
          title: 'New enquiry from |$.trigger.company',
          description: '$.trigger.message',
          tags: ['web-form'],
        },
      },
    },
    notes:
      'STATUS, PRIORITY AND TAGS ARE FREE STRINGS SERVER-SIDE. A value the space does not define is accepted, stored, and then matches no filter — the task effectively disappears from every board. Read the space first rather than guessing a status name. ' +
      'An empty assignees list CLEARS the task assignees — only an ABSENT field leaves them unchanged. Assignees is *[]string with omitempty (workspaces-service/model/api.go:430), so an explicit [] survives encoding, and DeepMerge (workspaces-service/transform/transform.go:167-188) replaces the whole value. A mapped "$.X.users" that resolves to nothing sends exactly that empty list. ' +
      'task_id is authored in the payload for every operation, but the node lifts it onto a header for comment_task and complete_task_action, and renames it to "id" for update_task/set_task_status/assign_task — you do not do either yourself (hub-service/runner/task_node.go). ' +
      'complete_task_action reads the action back before writing it, because the underlying endpoint replaces the stored action wholesale: a blind write drops the action\'s resources, and is refused outright without a description. That means it costs two calls, and it fails with "task has no action <id>" if the id is wrong. ' +
      'The node reaches nothing the quiva-endpoint node could not — the same allowlist and secrets guard applies.',
  },

  'verify-challenge': {
    summary:
      'Check a Cloudflare Turnstile token with Cloudflare, so a flow started by a form or chat embedded on a website can tell a person from a bot. (Not in the OpenAPI spec; added 2026-08.)',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        token:
          'The token the widget put in the submission. Map it from the trigger, usually "$.trigger.turnstile_token".',
        secret:
          'The account\'s Cloudflare Turnstile SECRET key. Use a secret reference — "SECRET::TURNSTILE_SECRET::" — never the literal key: a flow config is readable by anyone who can read the flow.',
      },
      optional: {
        remote_ip: "The submitter's IP, if the trigger carries one. Cloudflare uses it as a further signal.",
      },
    },
    example: {
      id: 'VERIFY_HUMAN',
      data: {
        id: 'VERIFY_HUMAN',
        node_type: 'verify-challenge',
        payload: {
          token: '$.trigger.turnstile_token',
          secret: 'SECRET::TURNSTILE_SECRET::',
        },
      },
    },
    notes:
      'A FAILED CHALLENGE IS A RESULT, NOT AN ERROR. The node succeeds and returns { success: false, ... }; the run carries on to whatever is downstream. You MUST branch on $.VERIFY_HUMAN.success or every bot submission proceeds exactly as a person\'s would. Only being unable to ask fails the node: no token, no secret, an unresolved SECRET:: reference, or Cloudflare unreachable. ' +
      'Result fields: success, hostname, action, cdata, challenge_ts, error_codes. Note error_codes is snake_case on the node result even though Cloudflare sends "error-codes". ' +
      'CHECK hostname AS WELL AS success. One widget can allow several domains, and a token solved on any of them verifies on all of them — so success alone does not tell you the submission came from the site you meant. ' +
      'Each account supplies its own Turnstile secret; there is no platform-wide key, because Cloudflare requires a hostname allowlist per widget and a shared widget would make tokens interchangeable between customers. Create the secret in the account first — an unresolved reference is refused with instructions rather than sent to Cloudflare as literal text. ' +
      'The token is redacted in the run log: enough to correlate a run with a submission, not enough to replay one.',
  },

  error: {
    summary: 'Terminate the flow with an error status code and message. (Not in the OpenAPI spec.)',
    required: ['id', 'node_type', 'payload'],
    payload: {
      required: {
        status_code: 'integer status code surfaced on the run result',
      },
      optional: {
        message: 'error message (defaults to "flow terminated with error (status N)")',
      },
    },
    example: {
      id: 'FAIL_VALIDATION',
      data: {
        id: 'FAIL_VALIDATION',
        node_type: 'error',
        payload: { status_code: 422, message: 'Missing required policy number' },
      },
    },
  },
};

export function listNodeTypes() {
  return Object.entries(NODE_TYPES).map(([type, doc]) => ({
    node_type: type,
    summary: doc.summary,
  }));
}

export function getNodeTypeReference(type) {
  const doc = NODE_TYPES[type];
  if (!doc) {
    return {
      error: `Unknown node_type "${type}". Valid types: ${Object.keys(NODE_TYPES).join(', ')}`,
    };
  }
  return { node_type: type, ...doc };
}
