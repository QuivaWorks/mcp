# Quiva MCP servers

Five MCP servers over one platform, so that an agent can build real Quiva
configuration — flows, records, document templates, workspaces and agents —
without guessing at payload shapes.

| Server | Builds | Backing service |
| --- | --- | --- |
| [quiva-flows-mcp](quiva-flows-mcp/) | workflows (DAGs of nodes), collections, rules | hub-service |
| [quiva-records-mcp](quiva-records-mcp/) | record configs (JSON Schema + form UI), records | records-service |
| [quiva-documents-mcp](quiva-documents-mcp/) | DOCX templates, generated documents, e-signature | file-generator-service |
| [quiva-workspaces-mcp](quiva-workspaces-mcp/) | spaces, tasks, comments, time tracking | workspaces-service |
| [quiva-agents-mcp](quiva-agents-mcp/) | agent definitions, invocation | hub-service |

## Why these exist

The platform's OpenAPI spec is wrong in ways that fail *silently*. A `wait` node
does nothing. A `baseURL` key is ignored and the request goes to a bare path. An
agent payload without its `agent` wrapper is dropped. An unmatched `{placeholder}`
renders as an empty string. In every one of those cases the API returns 200.

So each server carries three things beyond a thin API wrapper:

- **Engine-truth documentation** (`src/*-docs.js`) — how the platform actually
  behaves, with the spec's errors called out. Reachable as MCP tools
  (`list_reference_topics`, `get_*_reference`).
- **A local validator** (`src/validate.js`) — lints a config before it is sent,
  including the spec-vs-engine traps. Its contract is the **golden gate**: it must
  accept every configuration that is live on the platform. A validator that
  rejects working config is a bug in the validator.
- **A corpus of real examples** (`examples/`) — configs harvested from the live
  platform (credentials and PII stripped) plus a few hand-authored ones. Served
  via `list_examples` / `get_example`. Harvested examples are evidence: they are
  known to work.

## Setup

```sh
npm install
cp quiva-flows-mcp/.env.example quiva-flows-mcp/.env   # and the other four
```

Fill in **one** auth option per `.env`. Precedence is `QUIVA_API_KEY`, then
`QUIVA_BEARER_TOKEN`, then email + password.

> `quiva-agents-mcp` is the exception: leave `QUIVA_API_KEY` **empty** there. The
> agent endpoints read claims out of the JWT, so an API key shadowing the bearer
> token makes every agent write fail with 401.

`.mcp.json` registers all five servers, so Claude Code picks them up on open.
Verify with `claude mcp list`.

```sh
npm test                # 296 local checks, no network
npm run engine:check    # is our engine documentation still current?
```

## Keeping the docs honest

Every engine-truth claim here was established by reading a specific file in
`myevari/evari-olympus`, and cites it by path. `engine/provenance.json` pins the
blob sha each file was read at, so a claim that has quietly gone stale becomes
*detectable*:

```sh
npm run engine:check              # diff cited files against evari-olympus main
npm run engine:list               # what we cite, and which of our files cite it
engine/fetch.sh <path-in-repo>    # read one engine file, no clone needed
```

This needs the `gh` CLI authenticated as someone with read access to
`myevari/evari-olympus` — any member of that org. There is no submodule and no
vendored copy: 27 files are fetched over the API on demand.

A changed file does not mean a claim is wrong, only that it is no longer
verified. Re-read it, fix what moved, then `npm run engine:pin`.

## Reading order

- [docs/quiva-mcp-architecture.md](docs/quiva-mcp-architecture.md) — how the five
  servers and the platform fit together.
- [docs/lessons.md](docs/lessons.md) — the failure modes that shaped all of this.
  Short, and the single most useful thing to read first.
- [docs/quiva-mcp-handoff.md](docs/quiva-mcp-handoff.md) — the running log:
  current state, open questions, what is known to be stale.
- `docs/quiva-*-playbook.md` — per-server working notes.
- [specs/](specs/) — agent-instruction documents for platform features
  (form builder, form rules).
- [specs/openapi/](specs/openapi/) — the platform's own OpenAPI specs, as Quiva
  agent-tool definitions, plus the gateway route registry. **Do not trust them**:
  most of the documentation above exists because they are wrong in ways that fail
  silently. Good for shapes, and for deciding whether a route is routable at all.

## Known stale

`quiva-workspaces-mcp` still documents the superseded inline `time_tracking.logs[]`
shape. Staging has moved to a `PUT/GET /workspaces/task/{id}/time-log` subresource
that generates log ids server-side; `add_time_log` and `list_time_logs` are not
implemented yet. See the handoff for detail.
