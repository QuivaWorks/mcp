# Quiva Workspaces MCP Server

An MCP (Model Context Protocol) server for managing Quiva workspaces — spaces,
tasks, and comments (the `workspaces-service` `/workspaces/*` API) — from Claude
Code.

The reference docs and local validator are derived from the actual workspaces
service source (`workspaces-service/`), not just the OpenAPI spec
(`quiva-workspace.json`) — they correct several spec-vs-engine discrepancies
(see [Gotchas](#gotchas)).

## Setup

Requires **Node.js >= 18** (uses global `fetch`). The launcher `bin/run.sh`
automatically finds a suitable Node (checks `$QUIVA_NODE`, `PATH`, nvm
installs, then `/opt/homebrew/bin` and `/usr/local/bin`).

```bash
cd quiva-workspaces-mcp
npm install
```

### Credentials

Copy the example env file and fill in one auth option:

```bash
cp quiva-workspaces-mcp/.env.example quiva-workspaces-mcp/.env
```

`bin/run.sh` loads `quiva-workspaces-mcp/.env` automatically — no shell exports
needed. (Variables already exported in your environment take precedence.)

Auth precedence (first configured wins):

1. `QUIVA_API_KEY` → `X-Api-Key`
2. `QUIVA_BEARER_TOKEN` → `Authorization: Bearer`
3. `QUIVA_EMAIL` + `QUIVA_PASSWORD` (+ optional `QUIVA_ACCOUNT`) → auto-login

**Auth note:** the core space/task/comment CRUD works with an API key alone,
but attribution fields (space `owner`, task `created_by`, comment `author`) are
only populated when a Bearer JWT is present, and comment reactions need the JWT
to key the reacting user. Prefer bearer/email auth.

## Tools

**Reference & validation (no API call)**
- `list_reference_topics` — topics + gotchas
- `get_workspaces_reference` — full reference for one topic
- `validate_payload` — lint a space/task/multi_task/comment/reaction body

**Spaces** — `list_spaces`, `create_space`, `get_space`, `update_space`, `delete_space`

**Tasks** — `list_tasks`, `create_task`, `get_task`, `update_task`, `update_multi_task`, `delete_task`

**Comments** — `create_comment`, `list_comments`, `get_comment`, `update_comment`, `delete_comment`, `react_to_comment`

**Users** — `list_users` (accounts-service, for resolving assignee/reporter ids)

## Gotchas

Spec-vs-engine truths encoded in the validator and reference docs:

- **Response envelope** — every response is wrapped in `{ status_code, body }`; this MCP unwraps it and returns the inner `body`.
- **Deletes return `{ message: "success" }`** (status 200), not 204/no-body. `delete_comment` is a soft delete.
- **Space `id`** is required on create, must match `^\w+$` (letters/numbers/underscore only), and is **uppercased server-side**. A duplicate id → 409.
- **Task ids are server-generated** (`{SPACEID}-{n}` or `t_<nanoid>`); any id you send is ignored. If `space_id` is set the space must already exist.
- **Updates are PATCH**, merge-style. Build payloads from scratch — do not echo nested objects (statuses, assignees) from a GET.
- **`update_multi_task` returns an object keyed by request index**, not an array; one failure fails the whole call.
- **`react_to_comment` returns `{ reactions: {...} }`**, not the comment; body is `{ reaction: { "<emoji>": true|false } }`.
- **`due_date` / `scheduled_at` are RFC3339 date-times**, not `YYYY-MM-DD`.
- **`get_task`** returns extra `watchers[]` / `muted[]`.
- **The `ESCALATE` space** is built-in, always listed, and cannot be updated/deleted (403).

Run `get_workspaces_reference("gotchas")` for the full list.

## Register with Claude Code

Already added to the repo `.mcp.json` as `quiva-workspaces`. Restart Claude Code
(MCP servers connect at session start) to use the tools natively.
