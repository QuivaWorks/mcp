# Quiva Records MCP Server

An MCP (Model Context Protocol) server for creating and managing Quiva record
configs and records from Claude Code.

The reference docs and local validator are derived from the actual records
service source (`records-service/`), not just the OpenAPI spec — they correct
several spec-vs-engine discrepancies (see [Gotchas](#gotchas)).

## Setup

Requires **Node.js >= 18** (uses global `fetch`). The launcher `bin/run.sh`
automatically finds a suitable Node (checks `$QUIVA_NODE`, `PATH`, nvm
installs, then `/opt/homebrew/bin` and `/usr/local/bin`), so a Node 16 default
(e.g. from nvm) is fine.

```bash
cd quiva-records-mcp
npm install
```

### Credentials

Copy the example env file and fill in one auth option:

```bash
cp quiva-records-mcp/.env.example quiva-records-mcp/.env
```

`bin/run.sh` loads `quiva-records-mcp/.env` automatically — no shell exports
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

> **Note:** `query_records` (GET /records) needs a Bearer JWT to derive the
> tenant — an API key alone is rejected on that one endpoint. Use bearer/email
> auth if you rely on it.

### Register with Claude Code

The repo-level [.mcp.json](../.mcp.json) already registers the server. With
credentials in `quiva-records-mcp/.env`, just (re)start Claude Code in this
repo and approve the server when prompted. (MCP servers connect at session
start — a session that predates registration won't see the tools until
restart.)

Alternatively register it manually:

```bash
claude mcp add quiva-records \
  -e QUIVA_API_URL=https://api.microstrate.io \
  -e QUIVA_API_KEY=$QUIVA_API_KEY \
  -- sh /path/to/evari-olympus/quiva-records-mcp/bin/run.sh
```

## Tools

**Reference / validation** (no API call)
- `list_reference_topics` — topics + gotchas
- `get_records_reference` — schema / field-types / input-types / formatters / views / record / endpoints
- `validate_record_config` — id/name/schema/views lint, incl. the `field` vs `ref` gotcha

**Record configs**: `list_record_configs` (optional `ids` batch), `get_record_config`,
`create_record_config`, `update_record_config`, `delete_record_config`

**Records**: `list_records` (all for a config), `query_records` (by folder/space,
optional config_id/limit/offset), `get_record`, `create_record`, `update_record`,
`delete_record`

## Typical session

1. `list_reference_topics` / `get_records_reference` → learn the schema + view shapes
2. `validate_record_config` → lint locally
3. `create_record_config` → define the record type
4. `create_record` → add data (validated against the schema)
5. `list_records` / `query_records` / `get_record` → read back
6. `update_record` / `update_record_config` → iterate

## Gotchas

These are enforced/linted by the validator and tools because the OpenAPI spec
and the engine disagree:

- View field nodes use **`field`** (a dotted schema path), **not `ref`** — the
  spec's own note is wrong; a `ref` key is ignored.
- **Record IDs are server-generated** (10-char nanoid); any `id` you send when
  creating a record is ignored. Config IDs are client-supplied
  (`^[a-zA-Z0-9_-]+$`).
- Config create requires only **`id` + `name`**; `schema` must compile as JSON
  Schema; **`views` is optional**. Record create/update doesn't strictly
  require `data`.
- Updates are **PUT** (not PATCH). Config update applies only the fields sent;
  record update **merges `data`** key-by-key.
- `query_records` requires **`folder` or `space_id`** and a **Bearer JWT**; it
  also accepts `config_id` (comma-separated), `limit`, `offset`.
- Editing a config schema does **not** retroactively re-validate existing
  records.
- The engine has a `records-count-by-config` endpoint with **no confirmed
  public REST route**, so it is not exposed as a tool.
