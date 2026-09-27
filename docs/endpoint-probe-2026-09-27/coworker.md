# Endpoint probe — quiva-coworker-mcp (2026-09-27)

Unauthenticated requests against both hosts. 401 = mapped at the gateway, 404 =
not mapped. Baseline: `GET /hub/coworker/nonexistent-control` returns 404 on both
hosts, so the 401s are not a blanket response. `{id}` rows were probed with a
literal `x`.

`curl --cacert /etc/ssl/cert.pem -X <method> [-d '{}'] https://<host><path>`

Handlers: `hub-service/handler/*.go`, subjects in `hub-service/service/service.go`
(evari-olympus `main` 6af2ba497).

| Method | Path | api.quiva.ai (prod) | api.microstrate.io (staging) |
|---|---|---|---|
| GET | `/hub/coworker/skills` | 401 | 401 |
| GET | `/hub/coworker/skill-catalog` | 401 | 401 |
| GET | `/hub/coworker/skill-discover` | 404 | 404 |
| GET | `/hub/coworker/skill-bundle` | 401 | 401 |
| GET | `/hub/coworker/skill-sources` | 401 | 401 |
| PUT | `/hub/coworker/skill-sources` | 401 | 401 |
| GET | `/hub/coworker/skill-drafts` | 401 | 401 |
| PUT | `/hub/coworker/skill-draft` | 401 | 401 |
| POST | `/hub/coworker/skill-draft/approve` | 401 | 401 |
| DELETE | `/hub/coworker/skill-draft/{id}` | 401 | 401 |
| GET | `/hub/coworker/skill-exec` | 401 | 401 |
| PUT | `/hub/coworker/skill-exec` | 401 | 401 |
| PUT | `/hub/coworker/skill-exec-approval` | 401 | 401 |
| PUT | `/hub/coworker/skill` | 401 | 401 |
| PUT | `/hub/coworker/skill/settings` | 401 | 401 |
| POST | `/hub/coworker/skill/test` | 401 | 401 |
| POST | `/hub/coworker/skill/files` | 401 | 401 |
| DELETE | `/hub/coworker/skill/{id}` | 401 | 401 |
| DELETE | `/hub/coworker/skill/file` | 401 | 401 |
| GET | `/hub/coworker/todos` | 401 | 401 |
| GET | `/hub/coworker/todos-admin` | 401 | 401 |
| PUT | `/hub/coworker/todo` | 401 | 401 |
| POST | `/hub/coworker/todo/promote` | 401 | 401 |
| POST | `/hub/coworker/todo/promote/task` | 401 | 401 |
| POST | `/hub/coworker/todo/schedule` | 404 | 404 |
| GET | `/hub/coworker/org-memories` | 401 | 401 |
| POST | `/hub/coworker/org-memory` | 401 | 401 |
| PUT | `/hub/coworker/org-memory` | 405 | 405 |
| DELETE | `/hub/coworker/org-memory/{id}` | 401 | 401 |
| GET | `/hub/coworker/profile` | 401 | 401 |
| PUT | `/hub/coworker/profile` | 401 | 401 |
| GET | `/hub/coworker/profile-drafts` | 401 | 401 |
| PUT | `/hub/coworker/profile-draft` | 401 | 401 |
| POST | `/hub/coworker/profile-draft/approve` | 401 | 401 |
| DELETE | `/hub/coworker/profile-draft/{id}` | 401 | 401 |
| GET | `/hub/coworker/personal-profile` | 401 | 401 |
| PUT | `/hub/coworker/personal-profile` | 401 | 401 |
| GET | `/hub/coworker/personality` | 401 | 401 |
| PUT | `/hub/coworker/personality` | 401 | 401 |
| GET | `/hub/coworker/corrections` | 401 | 401 |
| PUT | `/hub/coworker/corrections` | 401 | 401 |
| GET | `/hub/coworker/correction-drafts` | 401 | 401 |
| POST | `/hub/coworker/correction-drafts/approve` | 401 | 401 |
| DELETE | `/hub/coworker/correction-drafts/{id}` | 401 | 401 |
| POST | `/hub/coworker/corrections/promote` | 401 | 401 |
| GET | `/hub/coworker/org-corrections` | 401 | 401 |
| PUT | `/hub/coworker/org-corrections` | 401 | 401 |
| GET | `/hub/coworker/task-space` | 401 | 401 |
| PUT | `/hub/coworker/task-space` | 401 | 401 |
| GET | `/hub/coworker/env` | 401 | 401 |
| POST | `/hub/coworker/env` | 401 | 401 |
| PUT | `/hub/coworker/env` | 401 | 401 |
| DELETE | `/hub/coworker/env` | 401 | 401 |
| GET | `/hub/coworker/model-catalog` | 401 | 401 |
| GET | `/hub/agent/model-pool` | 401 | 401 |
| PUT | `/hub/agent/model-pool` | 401 | 401 |
| POST | `/hub/agent/model-pool/test` | 401 | 401 |
| GET | `/hub/coworker/native-provider-tools` | 401 | 401 |
| PUT | `/hub/coworker/native-provider-tools` | 401 | 401 |
| GET | `/hub/coworker/memory-consolidation` | 401 | 401 |
| PUT | `/hub/coworker/memory-consolidation` | 401 | 401 |
| GET | `/hub/coworker/rapport-analysis` | 401 | 401 |
| PUT | `/hub/coworker/rapport-analysis` | 401 | 401 |
| GET | `/hub/coworker/rapport-log` | 401 | 401 |
| POST | `/hub/coworker/rapport-log/revert` | 401 | 401 |
| GET | `/hub/coworker/outreach-config` | 401 | 401 |
| PUT | `/hub/coworker/outreach-config` | 401 | 401 |
| GET | `/hub/coworker/authorisations` | 401 | 401 |
| POST | `/hub/coworker/authorisation` | 401 | 401 |
| DELETE | `/hub/coworker/authorisation` | 401 | 401 |
| GET | `/hub/coworker/server-credentials` | 401 | 401 |
| POST | `/hub/coworker/denial` | 401 | 401 |
| GET | `/hub/agent/coworker-unavailable-servers` | 401 | 401 |
| GET | `/hub/coworker/auto-approvals` | 404 | 404 |
| POST | `/hub/coworker/session-read` | 404 | 404 |
| GET | `/hub/coworker/authorisation-status` | 404 | 404 |
| POST | `/hub/agent/invoke` | 401 | 401 |
| POST | `/hub/agent/steer` | 401 | 401 |
| POST | `/hub/agent/cancel` | 401 | 401 |
| GET | `/hub/agent/user-rapport` | 401 | 401 |
| GET | `/hub/coworker/nonexistent-control` | 404 | 404 |
| PUT | `/hub/coworker/org-memory/{id}` | 401 | 401 |

## Not mapped on either host (404)

| Route | Consequence |
|---|---|
| `GET /hub/coworker/skill-discover` | The app's skill Discover tab calls it (`microstrate/src/services/api/skill.api.ts:62`); the mappings doc marks it "INTENDED — not yet created". |
| `POST /hub/coworker/todo/schedule` | Listed in the rename table of `docs/abbie-gateway-mappings.md`, but not mapped. |
| `GET /hub/coworker/auto-approvals` | Registered in hub; no mapping. |
| `POST /hub/coworker/session-read` | Registered in hub; no mapping. |
| `GET /hub/coworker/authorisation-status` | Internal by design (mesh-gated); must stay unmapped. |

`PUT /hub/coworker/org-memory` (no id) answers 405: the mapping is
`PUT /hub/coworker/org-memory/{id}`, which is 401.

## Result

Every route proposed for `quiva-coworker-mcp` is mapped on production. None of
the five unmapped routes is wrapped.
