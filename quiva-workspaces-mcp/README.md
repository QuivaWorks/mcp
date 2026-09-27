# Quiva Workspaces MCP Server

An MCP (Model Context Protocol) server for managing Quiva workspaces — spaces,
tasks, time logs, contacts, task templates, meetings, comments and files (the
`workspaces-service` `/workspaces/*` API) — from Claude Code.

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
only populated when a Bearer JWT is present. Prefer bearer/email auth.

`QUIVA_API_URL` defaults to `https://api.quiva.ai`.

## Tools

**Reference & validation (no API call)**
- `list_reference_topics` — topics + gotchas
- `get_workspaces_reference` — full reference for one topic
- `list_examples` / `get_example` — harvested reads and the authored `review-board` write set
- `validate_payload` — lint a space/task/multi_task/comment/reaction/task_action/time_log/contact/task_template/folder/file body

**Spaces** — `list_spaces`, `create_space`, `get_space`, `update_space`, `delete_space`

**Tasks** — `list_tasks`, `create_task`, `get_task`, `update_task`, `update_multi_task`, `delete_task`

**Time logs** — `add_time_log`, `list_time_logs`

**Task actions** — `set_task_action`, `delete_task_action`

**Contacts** — `create_contact`

**Task templates** — `list_task_templates`, `get_task_template`, `create_task_template`, `update_task_template`, `delete_task_template`

**Meetings** — `list_meetings`, `get_meeting_transcript`

**Comments** — `create_comment`, `list_comments`, `get_comment`, `update_comment`, `delete_comment`, `react_to_comment`

**Files** — `list_files`, `create_folder`, `read_file`, `write_file`

**Users** — `list_users` (accounts-service, for resolving assignee/reporter ids)

## Gotchas

Spec-vs-engine truths encoded in the validator and reference docs:

- **Response envelope** — every response is wrapped in `{ status_code, body }`; this MCP unwraps it and returns the inner `body`.
- **Deletes return `{ message: "success" }`** (status 200), not 204/no-body. `delete_comment` is a soft delete.
- **Space `id`** is required on create, must match `^\w+$` (letters/numbers/underscore only), and is **uppercased server-side**. A duplicate id → 409.
- **Status roles** — a status's `role` (`todo`, `working`, `done`, `won`, `lost`, ...) is what automation addresses. A task-action write moves the task status by role and never writes an id the space lacks.
- **List edits** — a sent `statuses`/`priorities`/`tags` list replaces the stored one; `upsert_*`/`remove_*` edit by id.
- **Task ids are server-generated** (`{SPACEID}-{n}`); any id you send is ignored. No `space_id` means the ESCALATE space.
- **Default status** — omitted `status` takes the space's `default_status`, else its first status.
- **Time logs** — log time with `add_time_log`; the server owns the id, user and timestamps and hydrates spent/remaining/progress. Only `time_tracking.estimate` is writable on the task.
- **`create_contact` can create a portal sign-in** when the space's `base_record.create_login_on_create` is true. The tool refuses that case unless `allow_sign_in: true`.
- **`create_task` with `identity`** is created even if the base-record link fails; check `base_record_skipped`.
- **Task-from-template is not gateway-mapped**, so there is no tool for it.
- **Updates are PATCH**, merge-style. Build payloads from scratch — do not echo nested objects from a GET.
- **`update_multi_task` returns an object keyed by request index**, not an array; one failure fails the whole call.
- **`react_to_comment` returns `{ reactions: {...} }`**, not the comment; body is `{ reaction: { "<emoji>": true|false } }`.
- **`due_date` / `scheduled_at` are RFC3339 date-times**, not `YYYY-MM-DD`.
- **The `ESCALATE` space** is built-in, always listed, and cannot be updated/deleted (403).

Run `get_workspaces_reference("gotchas")` for the full list.

## Register with Claude Code

Already added to the repo `.mcp.json` as `quiva-workspaces`. Restart Claude Code
(MCP servers connect at session start) to use the tools natively.
