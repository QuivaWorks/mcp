# Playbook: Building an MCP for Quiva Flows, hardening the spec, and proving it on real resources

A record of the instructions given (and the process that followed) to go from an
OpenAPI spec to a working MCP server, an accurate spec, and a verified real
flow on staging. Repeatable for any similar "spec + service code → agent
tooling" effort.

> **Correction (2026-07-27).** This process shipped a **wrong condition-node
> rules syntax** and no flow-editor geometry, and neither the tests nor the live
> E2E caught it. The five amendments below are what was missing; the full
> post-mortem is in [lessons.md](./lessons.md). Read them before reusing this
> playbook — the newer [records playbook](./quiva-records-mcp-playbook.md)
> already contains amendments 1 and 2.
>
> 1. **Phase 0 (new, before anything): harvest working configs.** Real configs
>    that already run are the ground truth. Reference examples must be harvested,
>    never hand-written — for a DSL-shaped field, the example *is* the
>    constraint, and a hand-written one is how the bad syntax shipped.
> 2. **Phase 1 must verify the RENDERER, not just the engine.** When the server
>    stores a field opaquely (`Payload any`, `[]map[string]any`), the consumer is
>    the contract. For flows that meant
>    `microstrate/src/utils/json-schema.utilts.ts` (`rulesInputJSONSchema`) and
>    `components/flows/flow/node/edit/condition-type/`. Also chase interpreters
>    to their terminal implementation, including embedded/bundled code —
>    `condition`'s truth was inside a base64 JS bundle in `jseval/rules.go`.
> 3. **Phase 3's token-economy rule is "cut *redundant* examples".** A field
>    whose value is a mini-language keeps its example. `quiva-flows.json` ended up
>    with zero condition examples, so the MCP's own docs were the only source —
>    and they were wrong.
> 4. **Phase 5 needs two non-runtime gates.** (a) A **golden gate**: the local
>    validator must accept every harvested config, because those configs
>    demonstrably run — any rejection is a validator bug. (b) A **round-trip
>    assertion**: fetch what the platform stored and diff it, which is what
>    catches missing presentation fields. "The run passed" is not enough; this
>    playbook's Phase 5 asserted only that.
> 5. **Every fix needs a negative control.** Prove the *old* shape still fails,
>    or you have not verified the fix — only that the new code runs. See
>    `quiva-flows-mcp/test/e2e-staging.mjs`.
>
> Also: tests must never assert "X is valid" without citing a real config that
> contains X. The original suite asserted the broken condition shape was valid,
> so it was green *because* it encoded the defect.

## Phase 1 — Build the MCP server from the spec AND the engine code

**Instruction:** *"Build me an MCP server I can run with Claude Code. I want to
build flows using this MCP. I have included an OpenAPI spec (quiva-flows.json)
which contains agent instructions, but you should also review the flow code to
ensure the MCP is able to build everything correctly. Pay special attention to
the node types and the required props for each node."*

The critical part of the instruction: **don't trust the spec — verify it
against the engine source** (`hub-service/runner/graph.go`,
`hub-service/model/request.go`, `hub-service/handler/create-workflow.go`).
That review found, before any code was written: `wait` vs `delay`, `baseURL`
vs `base_url`, four undocumented node types (`rules`, `http`, `error`,
`quiva-endpoint`), the real input/human-in-the-loop payload, no server-side
cycle detection, and the ID/reserved-word rules.

**Decisions made when asked** (plan-mode questions):
- Auth: support all three — API key → bearer token → email/password login (in
  that precedence).
- Tool scope: full builder toolkit (reference docs, local validation,
  collections, workflow CRUD/publish/run, paused/errored/run-log debugging,
  function/endpoint discovery, test-jpath/eval/http helpers) — not just the 4
  spec endpoints.
- Plain JavaScript, new `quiva-flows-mcp/` dir in the monorepo.
- Default to staging (`https://api.microstrate.io`).

Deliverables: `quiva-flows-mcp/` (server, client, validator, node-type docs,
tests), `.mcp.json` registration, launcher script that finds Node ≥ 18.

## Phase 2 — Configuration ergonomics

**Instructions:** *"Which env file do I add the variables into? Do I need to
export them before I can run the MCP?"* and *"Run the mcp command to launch
the MCP."*

Outcome: `quiva-flows-mcp/.env` (gitignored, loaded by `bin/run.sh`, no shell
exports needed; a `.env.example` documents the options), and registration via
`claude mcp add quiva-flows -- sh .../bin/run.sh`. Note: MCP servers connect at
session start — a session that predates registration can't use the tools until
restart.

## Phase 3 — Make the OpenAPI spec accurate and complete, within a token budget

**Instruction:** *"Update the OpenAPI spec to make it more accurate. This is
used as a tool made available to agents — it's loaded into their context so it
can't be hugely token consuming (that's why it didn't have every request). Fix
the existing requests with the details required to make sure the configs
created are accurate, and also add any missing tools an agent needs to create
and manage flows."*

The constraint that shaped everything: **accuracy up, token count down.** All
engine-truth corrections from Phase 1 went into the schemas; 9 endpoints were
added (collections, list/get/delete workflow, paused/errored, run-log search,
function/endpoint discovery, test helpers); and the file *shrank* 27% by
deleting UI-prop-laden examples, duplicate examples, and verbose response
schemas, and factoring shared node props into a `NodeDataCommon` base.

## Phase 4 — Build a real flow from a real spec

**Instruction:** *"In this file we have the KYC specification. This will work
by capturing the details required either by a form or chatbot, and then
running the KYC process. The KYC process should be a flow. Create me a new
flow with all the relevant nodes required to do proper KYC."*

Process: read the domain spec (`ADVISOR-VERTICAL-CONFIG-SPEC.md` §4.1/§5.2)
AND the existing production flow (`flows/client-folder-creation.json`) to copy
its proven conventions (condition payload format, records/workspaces
integration shape, pipe-concatenation JSONPath). Built `flows/kyc.json`
(validate → create record → sanctions screen → AI assessment → verified /
advisor-review-pause / failed) plus the missing `record_configs/kyc.json`,
validated locally with the MCP validator before ever touching the API.

## Phase 5 — "Just go for the real thing": test by creating real resources

**Instructions:** *"My .env has an API key, the MCP should be available"*,
then *"Just go for the real thing."*

The loop that followed — run, read the failure, find the truth in the service
code, fix the flow AND the tooling, republish, rerun — surfaced one real
defect per run:

| Run failure | Engine truth discovered | Where it was encoded |
|---|---|---|
| Trigger arrived as a JSON string | MCP clients pass untyped params as strings | MCP server coerces JSON-looking strings |
| "a subject, node_subject or agent property is required" | Inline agents must be nested under `payload.agent` (`{name, llm_provider, model, ...}`); flat payloads (as shown in the old spec AND `demo-flow.go`) are silently dropped; only `claude`/`anthropic` supported | Validator error, node docs, spec schema |
| Anthropic 404 on model | Model ids are platform catalog aliases (`claude-sonnet-4-6`, `claude-haiku-4-5` — see `microstrate/static/models.json`) | Node docs, spec |
| "message not found" on run | Published subjects have **no** `published` segment: `ms.hub.config.workflow.{collection}.{flow}` | Spec patterns, gotchas |
| Update silently no-op'd | `PATCH /hub/workflows/...` needs the **draft subject in the body** | MCP client fix |
| "failed to determine next steps" at the risk gate | Agent results are **JSON-encoded strings** even with `output_schema` — parse with an eval node before branching | PARSE_ASSESSMENT node pattern, docs, spec |
| 500 updating the KYC record | Records update is **PUT**, not PATCH (records openapi is wrong) | Flow fix, gotchas, lessons.md |
| sanctions.io 401 | `SANCTIONS_IO_API_KEY` secret not provisioned (spec open question) | `sanctions_enabled` static toggle; AI web-search is the spec's documented fallback |

Final state: full pass — KYC record created in the FAHUB client folder,
AI screening (real web searches of OFAC/UN/EU/DFAT/OpenSanctions + adverse
media) concluded pass/low, record updated to `verified`. The
human-in-the-loop path was proven separately: a genuine "review" outcome
(the AI caught fabricated test data contradicting public records), pause,
escalation task, resume with `{decision: "approve"}`.

**Every failure's lesson was written back into three places**: the MCP
(validator + node docs + client), the OpenAPI spec, and `docs/lessons.md`.
That's the core of the process — the tooling gets smarter with each real
resource created.

## Phase 6 — Operational polish

**Instruction:** *"Set up the sanctions check node as an http node that will
call sanctions.io and I can just add the key in. Also, how should the trigger
be invoked?"*

- Sanctions node became a plain `http` node whose Authorization header uses
  the platform secret placeholder `SECRET::SANCTIONS_IO_API_KEY::` (resolved
  at run time by `GetWorkflowConfig(resolveSecrets=true)`). Enabling = create
  the account secret + flip `static.sanctions_enabled` to `true`.
- Trigger invocation: trigger nodes are editor metadata. Every run is
  `POST /hub/workflows/run {subject, trigger, await}` — called directly
  (MCP/bcli), from another flow (`flow` node), or via a **gateway mapping**
  that exposes a public URL whose POST body becomes `$.trigger` (the
  `client-folder-creation` pattern). Human-in-the-loop resumes reuse the same
  endpoint with `run_id` + the human response as `trigger`.

## The distilled process

1. Read the spec, then **verify every claim against the service source**; note discrepancies before writing tooling.
2. Build the MCP with a **local validator that encodes engine truth**, not spec truth, plus reference docs the agent can query.
3. Rewrite the spec for accuracy AND token economy — cut examples, keep constraints.
4. Build a real artifact with the tooling, following existing production configs for conventions.
5. Run it against the real platform. Treat every failure as a spec bug: find the truth in code, fix the artifact, **and back-propagate the lesson into the validator, docs, and spec**.
6. Finish with ergonomics: secrets via `SECRET::name::` placeholders, clear enablement steps, invocation documented.
