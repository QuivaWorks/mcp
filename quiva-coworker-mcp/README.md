# Quiva Coworker MCP Server

An MCP server for reading, and carefully changing, the settings of **Abbie**,
the Quiva AI coworker (the `hub-service` `/hub/coworker/*` API).

Abbie's behaviour comes from several places: the organisation profile, the
personality (voice), each person's personal profile, memories, corrections,
skills, environment variables and the todo backlog. This server reads all of
them, and writes the ones whose permissions are clear.

The reference docs and pre-checks come from the hub-service source, not from
the app. Where the two disagree, the source wins (see [Gotchas](#gotchas)).

## Setup

Requires **Node.js >= 18**. The launcher `bin/run.sh` finds a suitable Node
(`$QUIVA_NODE`, `PATH`, nvm, then `/opt/homebrew/bin` and `/usr/local/bin`).

```bash
cd quiva-coworker-mcp
npm install
cp .env.example .env   # then fill in one auth option
```

`bin/run.sh` loads `.env` itself. Variables already exported take precedence.

### Credentials

| Option | Variables | Notes |
|---|---|---|
| API key | `QUIVA_API_KEY` | The gateway swaps it for a token carrying the key's user and role. A restricted `msr-` key must allow `/hub/coworker*` and `/hub/agent/model-pool`. |
| Bearer token | `QUIVA_BEARER_TOKEN` | A user JWT. |
| Email and password | `QUIVA_EMAIL`, `QUIVA_PASSWORD`, optional `QUIVA_ACCOUNT` | Logs in and re-logs in once on a 401. |

The API defaults to `https://api.quiva.ai`. Admin-only writes (organisation
profile, task space, organisation env) need an admin or root user.

## Tools

**Reference (no API call):** `list_reference_topics`, `get_coworker_reference`, `list_examples`, `get_example`, `validate_payload`

| Area | Read | Write |
|---|---|---|
| Skills | `list_skills`, `test_skill_activation`, `list_skill_drafts`, `get_skill_exec` | none |
| Backlog | `list_todos` | `update_todo`, `promote_todo_to_task` |
| Memories | `list_memories` | `create_memory`, `update_memory`, `delete_memory` |
| Profiles | `get_org_profile`, `get_personal_profile`, `get_personality` | `update_org_profile`, `update_personal_profile` |
| Corrections | `list_corrections` | `update_corrections` |
| Task space | `get_task_space` | `set_task_space` |
| Environment | `list_env` | `set_env`, `delete_env` |
| Models | `get_model_catalog`, `get_model_pool`, `get_memory_settings` | none |

### What the write tools guard

| Guard | Applies to |
|---|---|
| `confirm: true`, because the change reaches everyone in the account | organisation memory (the server itself does not restrict these to admins), organisation profile, task space, organisation env |
| `confirm: true`, because the change resumes Abbie's run and spends tokens | `update_todo` from `awaiting_user` to `pending` or `in_progress` |
| Scope must be exactly `organisation` or `user` | memory, env, todos. The server silently widens anything else. |
| Refuses a write that would leave a profile empty | `update_org_profile`, `update_personal_profile` |
| At most 6 corrections | `update_corrections` |
| A secret is only ever a `SECRET::<name>::` reference | `set_env`. Literals are shown to Abbie's model, so a credential-looking key with a literal is refused. |

Every write reads the current value first, merges only what you pass, sends
it (with `if_revision` for profiles), then reads it back and reports `verified`.

### Deliberately not here

| Left out | Why |
|---|---|
| Chatting with Abbie | Spends tokens across a multi-stage run and answers on a stream. Use the Assistants server (`invoke_agent`). |
| Backlog admin view | Returns every member's email. |
| Model pool writes | No admin gate on the server, and the body carries provider keys. |
| Skill writes, personality, organisation corrections, admin switches, integration consent | Change Abbie for the whole account; left to the app. |

`get_coworker_reference("not-exposed")` lists each one, plus routes that exist
in hub-service but are not reachable through the API gateway.

## Gotchas

- **Response envelope.** Every response is `{ status_code, body }`. The tools unwrap it and treat an error status inside the envelope as a failure.
- **Scope is widened silently.** For memory and env, any scope other than `user` means organisation. For todos, any scope other than `organisation` means user.
- **Organisation memories have no admin gate** on the server.
- **Leaving `awaiting_user` resumes the run.** Moving an item back to `pending` or `in_progress` restarts Abbie's work straight away.
- **Profiles are whole-document writes.** `{}` clears the profile for everyone.
- **A memory update replaces its topics** unless they are re-sent.
- **Empty can mean unreadable.** An unreadable memory store lists as empty, and an unreadable task space reports `ESCALATE`.
- **A promotion can be half done.** It can create the task and still fail to close the todo, and it answers 200 with `{ task, error }` when that happens.

Run `get_coworker_reference("gotchas")` for the full list with source paths.

## Tests

```bash
npm test
```

The tests make no network calls. They cover the pre-checks and every tool-level
refusal, using a fake client.
