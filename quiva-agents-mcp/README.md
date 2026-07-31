# Quiva Agents MCP Server

An MCP (Model Context Protocol) server for creating, managing, and invoking
Quiva agents (the `hub-service` `/hub/agent/*` API) from Claude Code.

The reference docs and local validator are derived from the actual hub service
source (`hub-service/`), not just the OpenAPI spec (`quiva-agents.json`) — they
correct several spec-vs-engine discrepancies (see [Gotchas](#gotchas)).

## Setup

Requires **Node.js >= 18** (uses global `fetch`). The launcher `bin/run.sh`
automatically finds a suitable Node (checks `$QUIVA_NODE`, `PATH`, nvm
installs, then `/opt/homebrew/bin` and `/usr/local/bin`).

```bash
cd quiva-agents-mcp
npm install
```

### Credentials

Copy the example env file and fill in one auth option:

```bash
cp quiva-agents-mcp/.env.example quiva-agents-mcp/.env
```

`bin/run.sh` loads `quiva-agents-mcp/.env` automatically — no shell exports
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

> **Important:** hub-service derives the user/account from a **Bearer JWT** on
> *every* agent endpoint (create/get/update/delete/invoke). An API key alone is
> resolved by the gateway but does not carry those claims, so it will 401 on
> most tools. Prefer the bearer token or email/password options.

### Register with Claude Code

The repo-level [.mcp.json](../.mcp.json) registers the server. With credentials
in `quiva-agents-mcp/.env`, (re)start Claude Code in this repo and approve the
server when prompted. (MCP servers connect at session start — a session that
predates registration won't see the tools until restart.)

Alternatively register it manually:

```bash
claude mcp add quiva-agents \
  -e QUIVA_API_URL=https://api.microstrate.io \
  -e QUIVA_BEARER_TOKEN=$QUIVA_BEARER_TOKEN \
  -- sh /path/to/evari-olympus/quiva-agents-mcp/bin/run.sh
```

## Tools

**Reference / validation** (no API call)
- `list_reference_topics` — topics + gotchas
- `get_agents_reference` — agent-config / providers / invoke / cancel / identifiers / auth / endpoints
- `validate_agent_config` — required fields, provider restriction, id/enum/URI-scheme lint

**Agent CRUD**: `list_agents`, `get_agent`, `create_agent`, `update_agent`,
`delete_agent`

**Invoke / cancel**: `invoke_agent` (runs the agent — spends LLM tokens),
`cancel_agent`

## Typical session

1. `list_reference_topics` / `get_agents_reference` → learn the config + invoke shapes
2. `validate_agent_config` → lint locally
3. `create_agent` → define the agent (returns its server-generated `subject`)
4. `invoke_agent` → run it (with `subject`, or an inline `agent`)
5. `list_agents` / `get_agent` → read back
6. `update_agent` / `delete_agent` → iterate / clean up

## Gotchas

These are enforced/linted by the validator and tools because the OpenAPI spec
and the engine disagree:

- **Three ids.** `subject` (`ms.hub.config.agent.<uuid>`) is the real,
  **server-generated** identifier — a hash of the config. The `{id}` path param
  is just that uuid suffix. `config.id` is a label, **not** the identifier.
  Re-creating an identical config → **409 "agent exists"**.
- **Auth needs a Bearer JWT** on every endpoint — an API key alone is
  insufficient.
- **Provider restriction**: `invoke` accepts only **`claude`** or
  **`anthropic`**; anything else → 400 "unsupported provider" (the spec's enum
  lists only `claude`).
- **Wrapped body**: create/update send `{ config: { ...definition... } }`. The
  tools build the wrapper for you.
- **Update is PUT** and **replaces** the config (owner/shared preserved) — send
  a complete definition, not a partial patch. The spec's
  `x-resource: ...patch.agent` is wrong; it's a `put` route.
- **Invoke** takes `subject` **or** an inline `agent` — the spec's
  `agent_subject` example field is ignored (use `subject`).
- The invoke-time **`x-cancel-id` / `cancel_token`** knobs in the spec are not
  read by hub-service; cancel via `cancel_agent` (`POST /hub/agent/cancel`).
