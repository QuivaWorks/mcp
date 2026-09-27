# Endpoint probe — quiva-flows-mcp (2026-09-27)

Unauthenticated requests against both hosts, body `{}`. 401 = mapped at the
gateway (route exists, auth required). 404 `404 page not found` (plain text) =
the router has no mapping. An unrouted baseline path returns 404 on both hosts,
so the 401s are not a blanket WAF response.

`/usr/bin/curl -X <method> -H 'Content-Type: application/json' -d '{}' https://<host><path>`

## New: server-side validation (`microstrate.hub.post.workflow-validate`)

The handler exists (`hub-service/handler/validate-workflow.go`, registered in
`hub-service/service/service.go`), but no gateway path for it is known: nothing
in `microstrate/` or the mapping docs calls it. Every plausible path was probed.

| Method | Path | api.quiva.ai (prod) | api.microstrate.io (staging) |
|---|---|---|---|
| POST | `/hub/workflows/validate` | 404 | 404 |
| GET | `/hub/workflows/validate` | 404 | 404 |
| PUT | `/hub/workflows/validate` | 404 | 404 |
| POST | `/hub/workflow-validate` | 404 | 404 |
| POST | `/hub/workflow/validate` | 404 | 404 |
| POST | `/hub/workflows-validate` | 404 | 404 |
| POST | `/hub/validate-workflow` | 404 | 404 |

**Result: not mapped on either host. No `validate_workflow_server` tool was
added.** The docs say so and point at `publish_workflow`, which runs the same
validator. A guessed-path 404 cannot rule out a mapping under another name; the
authoritative check is the gateway mapping store or `$SRV.INFO.hub`.

## Existing tools (controls)

| Method | Path | api.quiva.ai | api.microstrate.io | Tool |
|---|---|---|---|---|
| GET | `/hub/collections` | 401 | 401 | `list_collections` |
| POST | `/hub/collections` | 401 | 401 | `create_collection` |
| GET | `/hub/workflows` | 401 | 401 | `list_workflows` |
| POST | `/hub/workflows` | 401 | 401 | `create_workflow` |
| GET | `/hub/workflows/{c}/{f}` | 401 | 401 | `get_workflow` |
| PATCH | `/hub/workflows/{c}/{f}` | 401 | 401 | `update_workflow` |
| DELETE | `/hub/workflows/{c}/{f}` | 401 | 401 | `delete_workflow` |
| GET | `/hub/workflows/{c}/{f}/history` | 401 | 401 | `get_workflow_history` |
| POST | `/hub/workflows/publish` | 401 | 401 | `publish_workflow` |
| POST | `/hub/workflows/run` | 401 | 401 | `run_workflow` |
| GET | `/hub/workflows/paused` | 401 | 401 | `list_paused_workflows` |
| GET | `/hub/workflows/errored` | 401 | 401 | `list_errored_workflows` |
| POST | `/hub/run-logs/search` | 401 | 401 | `search_run_logs` |
| GET | `/compute/functions` | 401 | 401 | `list_functions` |
| GET | `/hub/quiva-endpoints` | 401 | 401 | `list_quiva_endpoints` |
| POST | `/hub/test-jpath` | 401 | 401 | `test_jsonpath` |
| POST | `/hub/test-eval` | 401 | 401 | `test_eval` |
| POST | `/hub/test-http` | 401 | 401 | `test_http` |

Baseline:

| Method | Path | api.quiva.ai | api.microstrate.io |
|---|---|---|---|
| GET | `/hub/nonexistent-route-xyz` | 404 | 404 |

## Not probed: in-flow calls

The new node surfaces (`email`, `verify-signature`, `sign-envelope`, the 13
`task` operations, `schedule` `name`) run over the mesh from inside a flow, gated
by hub's in-code allowlist (`hub-service/data/endpoints.go`,
`data/task_endpoints.go`, `data/email_endpoints.go`). They need no gateway
mapping, so they are documented and validated rather than probed.
