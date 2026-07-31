# The platform specs

Six files that the documentation in this repo argues with.

| File | What it is |
| --- | --- |
| `quiva-flows.json` | hub-service / workflows |
| `quiva-records.json` | records-service |
| `quiva-documents.json` | file-generator-service |
| `quiva-workspace.json` | workspaces-service |
| `quiva-agents.json` | hub-service / agents |
| `quiva-endpoints.json` | the API gateway route registry — 468 entries |

The first five are **Quiva agent-tool definitions**, not bare OpenAPI documents.
Each is shaped `{ name, schema }` where `schema` is an OpenAPI 3.1 document, which
is the format Quiva ingests to give one of its own agents the ability to call the
platform's REST API. They are the same job the MCP servers do for Claude Code,
aimed at a different consumer.

`quiva-endpoints.json` is a different kind of thing: a flat list of
`{path, method, is_public, resource, resource_type}` describing what the gateway
will actually route. It is the authority on whether an endpoint is reachable at
all, which is why it decides what gets exposed as a tool — the file-generator's
AI-generation handlers exist in the service but are absent from the registry, so
they 404 at the gateway and are deliberately not tools.

## Why they are here, and how to read them

**Do not trust these specs.** Most of the engine-truth documentation in this repo
exists specifically because they are wrong in ways that fail silently: the spec
says `wait` for a delay node (the engine has no such handler), says PATCH for
record updates (the service registers PUT), says `/templates` at the top level
(everything lives under `/file-generator`). `docs/lessons.md` opens with a case
where the flows spec contained zero mentions of the syntax the engine actually
required, and the wrong syntax shipped for two weeks.

So the reading order is: spec for the shape, `get_*_reference` for the truth, and
the harvested examples for proof. Where they disagree, the engine wins.

`quiva-workspace.json` carries an `x-gateway-routes-not-in-this-spec` extension
recording routes the gateway serves that the spec omits. That extension is the
pattern worth continuing — when a discrepancy is found, record it in the spec
rather than only in an MCP doc, because the spec is what Quiva's own agents read.

## Provenance

Snapshotted from `myevari/evari-olympus`, branch `brack-vertical-mcp`, at
`8a332624825aae4cdfd71f48f067b56521874a33`.

Worth knowing: **these files were never on `main`.** They were authored on that
branch alongside the MCP work itself, which is why they came here rather than
being left behind and cited across a boundary. `engine/sync.mjs` therefore does
not drift-check them — there is no upstream `main` copy to compare against. They
are maintained here now.

`quiva-endpoints.json` was never committed to any branch; it was a working file.
It is a dated dump, and the gateway changes, so prefer the live route list when it
matters:

```
list_quiva_endpoints          # tool on quiva-flows-mcp, reads /hub/quiva-endpoints
```

Refresh this file from that tool when a routing question turns on it.
