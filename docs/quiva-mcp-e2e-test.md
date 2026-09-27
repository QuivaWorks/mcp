# Quiva MCPs — End-to-End Test Walkthrough

A single scenario that exercises **all five MCPs** and their interconnections,
then verifies each result in the UI. This is the concrete version of the loop
described in [quiva-mcp-architecture.md](./quiva-mcp-architecture.md):

> author via MCP → (publish if applicable) → open the matching UI area →
> confirm it rendered / ran as a valid config.

**Scenario:** an insurance application comes in. An **agent** scores its risk, a
**flow** branches on the score using the **rules/condition** syntax, low-risk
applications are written as a **record**, and high-risk ones raise a
**workspace task** for human review. A **document** template generates the
certificate. This touches agents, records, documents, workspaces — orchestrated
by flows.

## Prerequisites

- All five MCPs connected in Claude Code (see the "Restart / connect" note in
  the architecture doc / project README). Confirm with `/mcp`.
- Staging credentials in each MCP's `.env` (shared `QUIVA_API_KEY`).

## Steps

Each step is: **create via MCP → verify in UI.**

### 1. records — schema + form

- `create_record_config` for `mcp_e2e_application`: schema with `applicant`,
  `risk_score`, `rationale`, `status`; a simple form view.
- **UI:** open Records → the config appears and its form renders with the fields.

### 2. agents — the risk assessor

- `create_agent` `risk-assessor` (`llm_provider: "claude"`,
  `model: "claude-sonnet-4-6"`, behaviour = underwriting assistant,
  `output_schema` = `{ risk_score, rationale }`).
- **UI:** open Agents → the agent appears. `invoke_agent` with a sample
  applicant returns a score + rationale.

### 3. documents — the certificate template

- `create_template` for the certificate, then `publish_template` (generation
  only uses the **published** version).
- **UI:** open Documents / Templates → the template appears; `trigger_templates`
  → `get_document` produces a PDF/DOCX.

### 4. flows — orchestrate the above (the core test)

This is the multi-node flow that ties everything together and exercises the
`condition` **rules syntax** (the item the tester flagged).

1. `list_collections` → pick or `create_collection` (e.g. "MCP E2E"). Note its
   `subject` (`ms.hub.config.collection.workflow.<id>`).
2. `list_quiva_endpoints` → find the **records create** endpoint subject and
   paste it into `CREATE_RECORD.data.subject` in
   [quiva-mcp-e2e-test-flow.json](./quiva-mcp-e2e-test-flow.json)
   (replace `REPLACE_WITH_records_create_endpoint_subject`).
3. `validate_flow_config` with that config → expect `valid: true`.
4. `create_workflow` — `name: "mcp-e2e"`, `collection: <subject>`,
   `config: <the JSON>`.
5. `publish_workflow` on the returned draft subject.
6. `run_workflow` with `await: true` and a trigger such as
   `{ "applicant": { "name": "Test Co", "industry": "logistics", "claims": 0 } }`.
7. **UI:** open Workflows → the flow renders as a graph
   (trigger → agent → eval → condition → record / review). Run it and watch the
   branch taken.

**The flow's shape** (see the JSON for the exact config):

```
TRIGGER ─▶ ASSESS_RISK (agent) ─▶ PARSE_RESULT (eval: JSON.parse)
                                        │
                                        ▼
                                 CHECK_RISK (condition)
                       risk_score > 70 ? ──┬── then ─▶ ESCALATE_REVIEW (human-in-the-loop)
                                           └── else ─▶ CREATE_RECORD (quiva-endpoint → records)
```

Why each node matters for the test:

- **ASSESS_RISK** — proves the `agent` node integration (nested under
  `payload.agent`; provider `claude`).
- **PARSE_RESULT** — required because an agent's `$.<ID>.result` is a
  JSON-**encoded string**, even with `output_schema`. Parse before branching.
- **CHECK_RISK** — the `condition` node using the correct rules syntax:
  `{ if: "$.PARSE_RESULT.risk_score > 70", then: [...], else: [...] }` with node
  IDs (or `RESOLVE_SUCCESS`/`RESOLVE_ERROR`) as targets. **This is the tester's
  Point 2** — the flow deliberately gets it right.
- **CREATE_RECORD** — `quiva-endpoint` node reaching the **records** service:
  the generic cross-service glue.
- **ESCALATE_REVIEW** — `human-in-the-loop`, which pauses the run and (per the
  engine) surfaces an assignment ≈ a **workspace** task.

### 5. workspaces — the human-review side

- Either the flow's `ESCALATE_REVIEW` produces the assignment, or directly
  `create_space` + `create_task` to represent the review queue.
- **UI:** open Workspaces → the space/task appears; add a `create_comment`.

## What "passing" looks like

- Every config created via MCP is visible and **valid** in its UI area (renders,
  no schema errors).
- The published flow **runs to completion**; a low-risk input creates a record,
  a high-risk input raises a review task.
- The `condition` node routes correctly — confirming the rules syntax and node
  structure are right.

## Notes / adjustments

- `CREATE_RECORD.data.subject` is a placeholder — you **must** substitute a real
  endpoint subject from `list_quiva_endpoints`. Alternatively, swap that node for
  a `function` node (`ms.compute.*`) or an `http` node if that better matches how
  records are created in your environment.
- Model alias `claude-sonnet-4-6` is from the platform catalog; use
  `claude-haiku-4-5` for a cheaper/faster run.
- Keep runs on **staging** (`api.microstrate.io`) until validated.
