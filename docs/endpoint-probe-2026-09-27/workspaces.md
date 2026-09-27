# Endpoint probe — quiva-workspaces-mcp (2026-09-27)

Unauthenticated requests: 401 = mapped at the gateway, 404 = not mapped.
`curl -X <method> https://<host><path> -d '{}'`

Decoys rule out a catch-all: `GET|PUT /workspaces/task/X-1/zzzz`, `POST /workspaces/zzzz`,
`GET /workspaces/task-templatez`, `GET /workspaces/meetingz`, `POST /workspaces/clientz`
and `GET /recall/recording/x/zzzz` all return 404 on both hosts.

"Prod resource" is the `resource` of the route's version-1 record in the production
gateway mapping store (read-only
`bcli --context microstrate-prod stream get microstrate-gateway -S 'ms.gateway.T41F4CcPZpws.mapping-version.<method>.<path>.1' -j`).

| Method | Path | Prod | Staging | Prod resource | Tool |
|---|---|---|---|---|---|
| PUT | `/workspaces/task/{task_id}/time-log` | 401 | 401 | `workspaces.put.task-time-log` | `add_time_log` |
| GET | `/workspaces/task/{task_id}/time-log` | 401 | 401 | `workspaces.get.task-time-logs` | `list_time_logs` |
| POST | `/workspaces/client` | 401 | 401 | `workspaces.post.client-folder` | `create_contact` |
| GET | `/workspaces/task-templates` | 401 | 401 | `workspaces.get.task-templates` | `list_task_templates` |
| POST | `/workspaces/task-template` | 401 | 401 | `workspaces.post.task-template` | `create_task_template` |
| GET | `/workspaces/task-template/{id}` | 401 | 401 | `workspaces.get.task-template` | `get_task_template` |
| PATCH | `/workspaces/task-template/{id}` | 401 | 401 | `workspaces.patch.task-template` | `update_task_template` |
| DELETE | `/workspaces/task-template/{id}` | 401 | 401 | `workspaces.delete.task-template` | `delete_task_template` |
| POST | `/workspaces/task-from-template` | **404** | **404** | — (no mapping) | none |
| POST | `/workspaces/task/from-template` | 405 | 405 | matches `/workspaces/task/{id}` | none |
| GET | `/workspaces/meetings` | 401 | 401 | `workspaces.get.meetings` | `list_meetings` |
| GET | `/recall/recording/{recording_id}/transcript` | 401 | 401 | mapped (version 1 present) | `get_meeting_transcript` fallback |
| GET | `/api/default-storage/object/microstrate-recall-files/{key}` | 401 | 401 | object store, not a gateway mapping | `get_meeting_transcript` |
| GET | `/workspaces/task/{task_id}/action` | 401 | 401 | latest record is a middleware patch; resource not read | none (see below) |

## Authenticated checks on staging (read-only unless noted)

- `GET /workspaces/task/{id}/action` returns `{ results: [TaskAction], results_total }` on staging
  (CRM_ACTIVITIES-1: one action, matching `get_task.task_actions`). The old misroute to
  `put.task-action` is gone on staging. Production's target is unverified, so no tool; read
  through `get_task`.
- `GET /recall/recording/{id}/transcript` answered 400 "key not found" for all nine QUIVA
  transcripts: the handler keys on the CALLER's user id (`recall-service/config/service.go`
  `TranscriptKey`). Reading `file.name` from `microstrate-recall-files` worked (utf8 text).
- `GET /workspaces/meetings?space_id=QUIVA` returned 34 entries (video 8, audio 8,
  transcript 9, summary 9).
- `GET /workspaces/task-templates` returned 13 templates.

## Live writes on staging (all cleaned up and verified gone)

`node --env-file=.env tools/push-example.mjs --cleanup` created space `MCP_TEST_REVIEW_BOARD`
(space ids cannot contain `-`), tasks `-1` (parent), a sub-task, an identity task, two time
logs, two task actions, a comment with a reaction, and contact `mcp-test-contact@example.com`
(a `Client` record, `create_login_on_create: false`, so no sign-in). Every check passed but one.

- Time logs: server-minted `tl_` ids, client `id`/`user` ignored, user stamped, totals
  hydrated (spent 5400, remaining 1800, progress 75), a 0-second log refused with 400.
- Task actions: one open action -> `awaiting_info` (todo role); all done -> `approved`
  (done role); some done -> `in_review` (working role).
- Sub-tasks: `parent` set, a sub-task of a sub-task refused, `?parent=` filter finds it,
  `delete_subtasks=true` removes it.
- **Failed:** the task created with `identity` came back with no `folder` and no
  `base_record_skipped`. A separate probe (space `MCP_TEST_IDENTITY`, deleted) confirmed the
  staging build ignores `identity`, and also that a space with no `default_status` gives a
  new task no status — #1436 is not on staging either.
- Sign-in gate: space `MCP_TEST_SIGNIN_GATE` with `create_login_on_create: true`;
  `create_contact` without `allow_sign_in` refused before any write (0 records), space deleted.

Cleanup verified: tasks and sub-task 404, contact record deleted
(`DELETE /records/Client/{id}`), all three spaces absent from `list_spaces`, and
`GET /records?space_id=` empty for both test spaces.
