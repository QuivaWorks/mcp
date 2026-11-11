# Quiva MCP servers

Seven MCP servers over one platform, so that an agent can build real Quiva
configuration — flows, records, document templates, workspaces, assistants,
distribution and the Abbie coworker — without guessing at payload shapes. A
remote, hosted variant is also available; see below.

| Server | Builds | Backing service |
| --- | --- | --- |
| [quiva-flows-mcp](quiva-flows-mcp/) | workflows (DAGs of nodes), collections, rules | hub-service |
| [quiva-records-mcp](quiva-records-mcp/) | record configs (JSON Schema + form UI), records | records-service |
| [quiva-documents-mcp](quiva-documents-mcp/) | DOCX templates, generated documents, e-signature | file-generator-service |
| [quiva-workspaces-mcp](quiva-workspaces-mcp/) | spaces, tasks, comments, time tracking | workspaces-service |
| [quiva-agents-mcp](quiva-agents-mcp/) | assistant definitions, invocation | hub-service |
| [quiva-distribution-mcp](quiva-distribution-mcp/) | distribution products, invites, messages | accounts-service |
| [quiva-coworker-mcp](quiva-coworker-mcp/) | Abbie's skills, todos, org memory, profile, corrections | hub-service |

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

## Install

The fastest path is the hosted endpoint, `https://api.quiva.ai/mcp`, with a Quiva
API key (Settings, API keys).

**Claude Code** (plugin: the hosted server plus the `quiva-config` skill):

```
/plugin marketplace add QuivaWorks/mcp
/plugin install quiva@quivaworks
```

**Codex**: see [AGENTS.md](AGENTS.md) for the agent instructions and the
`~/.codex/config.toml` block; the remote server needs only `url` and
`bearer_token_env_var` ([details](quiva-mcp-remote/README.md)). The
[quiva-config skill](skills/quiva-config/) pulls, diffs and pushes account
configuration from the command line.

## Run the servers locally

```sh
npm install
cp quiva-flows-mcp/.env.example quiva-flows-mcp/.env   # and the other servers
```

The root `.mcp.json` registers only the hosted server. Register the local stdio servers
you want with `claude mcp add` or a Codex `[mcp_servers.<name>]` block; each server's
README has both.

Credentials, first match wins: a **profile** (`QUIVA_PROFILE=<name>`, read from
`~/.config/quiva/profiles.json`, shared by all seven servers and the quiva-config skill;
`QUIVA_API_KEY_<NAME>` overrides the profile's key), then `QUIVA_API_KEY`, then
`QUIVA_BEARER_TOKEN`, then email + password. The profile's `env` picks the API base
URL. An API key works on every server, including `quiva-agents-mcp`: cerberus swaps it
for a user JWT at the gateway before the request reaches hub-service.

```sh
npm test                # local checks, no network
npm run engine:check    # is our engine documentation still current?
```

`npm test` at the root runs every workspace's own suite (`node:test` for
`quiva-mcp-remote`, a dependency-free `check()` harness everywhere else). None needs
network.

## Remote (hosted) server

Prefer not to run anything locally? [quiva-mcp-remote](quiva-mcp-remote/) is one
hosted MCP endpoint, `https://api.quiva.ai/mcp`, that composes every server above
behind a single connection, authenticated with a Quiva API key. See
[quiva-mcp-remote/README.md](quiva-mcp-remote/README.md) for client setup
(Claude Code, Codex, Cursor, VS Code, Claude Desktop) and how to run it yourself.

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

This is a maintainer check: it needs read access to the platform's engine source
repository, which is private. Outside contributors can ignore it. With `gh`
authenticated the files are fetched over the API; without it, point the script at a
local checkout of the engine repository (blob shas read via `git ls-tree`):

```sh
node engine/sync.mjs --local /path/to/evari-olympus [--pin|--list]
```

A changed file does not mean a claim is wrong, only that it is no longer
verified. Re-read it, fix what moved, then `npm run engine:pin` (or the
`--local` equivalent).

## Reading order

- [docs/lessons.md](docs/lessons.md): the failure modes that shaped all of this.
  Short, and the single most useful thing to read first.
- [docs/quiva-mcp-architecture.md](docs/quiva-mcp-architecture.md): how the
  servers and the platform fit together.
- [specs/](specs/): agent-instruction documents for platform features
  (form builder, form rules).
- [specs/openapi/](specs/openapi/): the platform's OpenAPI specs, generated from
  the engine repository (do not hand-edit), plus the gateway route registry. Good for
  shapes, and for deciding whether a route is routable at all; the documentation
  above exists because they can be wrong in ways that fail silently.

## Verticals

[verticals/](verticals/) is where vertical templates are authored and reviewed
before being pushed to the platform's `VERTICAL` space and deployed into accounts.
`quiva-workspaces-mcp` carries the tools (`list_files`, `create_folder`,
`read_file`, `write_file`) and the contract
(`get_workspaces_reference("files")` and `("verticals")`).

Two things to internalise before touching it: a folder's category name is a
**routing key** and an unrecognised one deploys nothing silently; and a write is
not done when the API returns 200 — indexing is asynchronous, and an index entry
whose `name` comes back empty is invisible to both the deployer and the UI. See `get_workspaces_reference("verticals")`.

## Known stale

Nothing repo-wide as of 2026-11-11. Per-package caveats that depend on which
environment you are pointed at live in that server's own tool descriptions.
