# Quiva Flows MCP Server

An MCP (Model Context Protocol) server for building, publishing, running and
debugging Quiva workflows from Claude Code.

The node-type reference and local validator are derived from the actual flow
engine source (`hub-service/`), not just the OpenAPI spec — they correct
several spec-vs-engine discrepancies (see [Gotchas](#gotchas)).

## Setup

Requires **Node.js >= 18** (uses global `fetch`). The launcher
`bin/run.sh` automatically finds a suitable Node (checks `$QUIVA_NODE`,
`PATH`, nvm installs, then `/usr/local/bin` and `/opt/homebrew/bin`), so a
Node 16 default (e.g. from nvm) is fine.

```bash
cd quiva-flows-mcp
npm install
```

### Credentials

Copy the example env file and fill in one auth option:

```bash
cp quiva-flows-mcp/.env.example quiva-flows-mcp/.env
```

`bin/run.sh` loads `quiva-flows-mcp/.env` automatically — no shell exports
needed. (Variables already exported in your environment take precedence over
the file.) The file is gitignored.

Auth options (checked in this order):

| Env var | Sent as |
|---|---|
| `QUIVA_API_KEY` | `X-Api-Key` header |
| `QUIVA_BEARER_TOKEN` | `Authorization: Bearer` |
| `QUIVA_EMAIL` + `QUIVA_PASSWORD` (+ optional `QUIVA_ACCOUNT`) | Logs in via `/accounts/auth-with-password`, caches the JWT, re-logs-in on 401 |

`QUIVA_API_URL` selects the environment (default: staging
`https://api.microstrate.io`; production: `https://api.quiva.ai`).

### Register with Claude Code

The repo-level [.mcp.json](../.mcp.json) already registers the server. With
credentials in `quiva-flows-mcp/.env`, just (re)start Claude Code in this repo
and approve the server when prompted.

Alternatively register it manually:

```bash
claude mcp add quiva-flows \
  -e QUIVA_API_URL=https://api.microstrate.io \
  -e QUIVA_API_KEY=$QUIVA_API_KEY \
  -- sh /path/to/evari-olympus/quiva-flows-mcp/bin/run.sh
```

## Tools

**Reference / validation** (no API call)
- `list_node_types` — all 19 node types + JSONPath guide + gotchas
- `get_node_type_reference` — required/optional props and a correct example per type
- `list_reference_topics` / `get_flows_reference` — cross-cutting contracts:
  **`rules-syntax`** (the condition/rules DSL — read this first), `jsonpath`,
  `geometry`, `lifecycle`, `gotchas`
- `list_examples` / `get_example` — real published workflows harvested from the
  platform (credentials redacted). These configs demonstrably run, so copy their
  conventions rather than inventing a payload shape
- `validate_flow_config` — server rules + cycle detection + rules-DSL checks +
  gotcha lints

**Collections**: `list_collections`, `create_collection`

**Workflows**: `list_workflows`, `get_workflow`, `create_workflow`,
`update_workflow`, `publish_workflow`, `delete_workflow`, `get_workflow_history`

**Execution / debugging**: `run_workflow` (sync/async, batch, resume paused
runs), `list_paused_workflows`, `list_errored_workflows`, `search_run_logs`

**Discovery**: `list_functions` (compute function subjects),
`list_quiva_endpoints`

**Payload helpers** (use the real engine): `test_jsonpath`, `test_eval`,
`test_http`

## Typical flow-building session

1. `list_collections` → pick/create a collection
2. `list_node_types` / `get_node_type_reference` → design nodes
3. `get_flows_reference("rules-syntax")` → **before** any condition/rules node
4. `get_example("client-folder-creation")` → copy a working condition node
5. `validate_flow_config` → lint locally
6. `create_workflow` → draft (server validates too; geometry auto-filled)
7. `publish_workflow` → runnable
8. `run_workflow` with `await: true` → inspect results
9. Iterate: `update_workflow` → `publish_workflow` again

## Tests

```bash
npm test        # validator unit checks + the golden gate
npm run harvest # re-harvest examples/ from the platform (redacts credentials)
npm run test:e2e   # live: creates a throwaway flow on staging, runs both
                   # condition branches, checks the round-trip, deletes it
node tools/sweep-validate.mjs   # run the validator over EVERY flow on the
                                # environment and group the failures
```

The **golden gate** is the important one: every config in `examples/` is a real
published workflow, so if the local validator rejects one, the validator is
wrong. That check is what would have caught the `{ if, then, else }` condition
defect on day one.

## Gotchas

These are enforced/linted by the validator because the OpenAPI spec and the
engine disagree:

- The delay node type is **`delay`**, not `wait` (a `wait` node is a silent
  no-op).
- HTTP/integration payloads use **`base_url`** (snake_case) — `baseURL` is
  silently ignored.
- **`condition` / `rules` nodes use the rule-engine v2 DSL** — branches are
  `{ condition: { operator, input }, outcome }`, **not** `{ if, then, else }`.
  The editor labels them IF / ELSE IF / ELSE, which is why the wrong shape looks
  right; the engine rejects it with *"value has to be a string or an array of
  strings"*. A `condition` payload **is** the branch array (no `rules` wrapper);
  a `rules` payload is `{ rules: { name: <rule> }, facts, context }`.
- An operator the engine does not implement **fails silently** (undefined →
  branch skipped → *"failed to determine next steps"*). The validator errors on
  unknown names.
- Node IDs: `^[a-zA-Z_][a-zA-Z0-9_:]*$`; reserved: `trigger`, `static`,
  `RESOLVE_ERROR`, `RESOLVE_SUCCESS`. The server only enforces this when a
  request carries `validate=true` and **the flow editor does not send it**, so
  UI-authored flows contain hyphenated nanoid ids that cannot be re-sent with
  validation on — use `server_validate=false` to update those.
- Nodes and edges need flow-editor presentation fields (`position`, `type`,
  `measured`; edge `type`/`edgeType`/handles) or the graph renders stacked at the
  origin. `create_workflow`/`update_workflow` auto-fill them (`auto_layout`).
- The graph must be **acyclic** — the server does not check; cyclic nodes
  simply never run.
- `trigger` nodes are editor metadata, skipped at runtime.
- `input`/`human-in-the-loop` payloads take
  `{message, title, description, priority, assignees}`; the spec's `notify`
  block is not read by the engine.
- Extra engine node types not in the spec: `rules`, `http`, `error`,
  `quiva-endpoint`, `task`, `verify-challenge`.
- A **`verify-challenge`** failure is a *result*, not an error — the node
  succeeds with `{ success: false }` and the run carries on. Branch on
  `$.<ID>.success`, and check `$.<ID>.hostname` as well: one widget can allow
  several domains and a token solved on any of them verifies on all of them.
- **`task`** nodes carry `operation` at node level (`data.operation`), not in
  the payload. Omitting `space_id` falls back to the `ESCALATE` space, and
  status/priority/tags are free strings — an undefined value is stored and then
  matches no filter.
