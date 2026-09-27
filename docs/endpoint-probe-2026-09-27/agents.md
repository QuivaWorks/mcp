# Endpoint probe — quiva-agents-mcp (2026-09-27)

Unauthenticated requests against both hosts. 401 = mapped at the gateway (route
exists, auth required). 404 = not mapped. Baseline confirmed first: an
unrouted path (`/hub/this-route-does-not-exist-xyz`) returns 404 on both hosts,
so the 401s below are not a blanket WAF response.

`curl --cacert /etc/ssl/cert.pem -X <method> https://<host><path>`

| Method | Path | api.quiva.ai (prod) | api.microstrate.io (staging) | Tool |
|---|---|---|---|---|
| GET | `/hub/agent` | 401 | 401 | `list_agents` (existing) |
| GET | `/hub/agent/{id}` | 401 | 401 | `get_agent` (existing) |
| POST | `/hub/agent` | 401 | 401 | `create_agent` (existing) |
| PUT | `/hub/agent/{id}` | 401 | 401 | `update_agent` (existing) |
| DELETE | `/hub/agent/{id}` | 401 | 401 | `delete_agent` (existing) |
| POST | `/hub/agent/invoke` | 401 | 401 | `invoke_agent` (existing) |
| POST | `/hub/agent/cancel` | 401 | 401 | `cancel_agent` (existing) |
| GET | `/hub/mcp/registry` | 401 | 401 | `list_mcp_servers` (**new** — added) |
| POST | `/hub/mcp/register` | 401 | 401 | `register_mcp_server` (**new** — added) |

Baseline (not a tool):

| Method | Path | api.quiva.ai | api.microstrate.io |
|---|---|---|---|
| GET | `/hub/this-route-does-not-exist-xyz` | 404 "404 page not found" | 404 "404 page not found" |

## Result

Every endpoint this workstream wraps or extends is mapped on **production**
(and staging). Both new tools were added: `list_mcp_servers` (`GET
/hub/mcp/registry`) and `register_mcp_server` (`POST /hub/mcp/register`).

## Notes

- `GET /hub/mcp/registry` browses the **official public MCP registry**
  (`registry.modelcontextprotocol.io`), not this account's own registered
  servers — confirmed by reading `hub-service/handler/mcp.go`
  (`BrowseMCPRegistry`) and the OpenAPI description before adding the tool.
  There is a separate `list-mcp-servers` route key
  (`hub-service/service/service.go:157`, `handler.GetMCPServerList`) that
  *does* list an account's own registered servers, but it has no path in
  `hub-service/openapi-hub-coworker.json` and was not probed — it is not known
  to be gateway-mapped, so it was left out per "only wrap what's mapped on
  prod." `list_mcp_servers` in this MCP is named after the tool the plan
  specified (`GET /hub/mcp/registry`) and its docs say plainly what it
  actually does.
- `POST /hub/mcp/register` writes to the caller's own account catalog only
  (`hub-service/handler/mcp.go:90-105`); it is intentionally unreachable from
  bellerophon-workforce (Abbie's own runtime cannot register a server for
  herself). That is a workforce-side restriction, not a gateway mapping gap —
  the HTTP route itself is live, hence the tool.
- Not probed / not added: `GET /hub/mcp-server/{id}` (single-server get),
  `DELETE /hub/mcp-server/{id}`, `POST /hub/mcp/server-oauth` — out of this
  workstream's scope (agents.go's 7 spec'd operations plus the two explicitly
  named in the plan).

## Live check (staging, read-only, quiva-agents-mcp/.env, 2026-09-27)

Two findings that only a live call surfaced (not visible from the 401 probe or
from reading the engine source alone):

1. **`list_agents` paging is designed but not live on staging.** Sent `limit`,
   `offset`, `search`, and `sort` — individually and combined — against
   `api.microstrate.io`. Every call still returned the full 194-agent list
   under `{ results, results_total }` with no `metadata` block; `search`
   matching nothing narrowed the set at all. Staging is running a hub-service
   build that predates `hub-service/handler/agent-list.go`'s paging feature.
   Docs and the `list_agents` tool description now say the paging shape is
   *designed*, not *confirmed live*, and flag this explicitly rather than
   asserting metadata appears "when paging params are sent" (the open
   question Wave 0 left). A production check was not run (no production
   credentials in this session).
2. **`GET /hub/mcp/registry`'s response shape disagrees with its own OpenAPI
   spec.** The spec (`hub-service/openapi-hub-coworker.json`
   `BrowseMCPRegistryResponse`) documents `{ servers, cursor, received,
   skipped }`. A live call (`limit=3` and `limit=100`, both against staging)
   returned `{ servers, next_cursor, received, total }` — the paging field is
   actually `next_cursor`, not `cursor`, and `total` appeared where the spec
   promises `skipped`. `list_mcp_servers`'s tool description and the
   `mcp-servers`/gotchas reference topics were corrected to the verified
   shape.

