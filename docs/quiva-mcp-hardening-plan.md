# Quiva MCP Hardening Plan

Goal: make the five Quiva MCP servers produce configs that are **valid in the
UI and correct at runtime**, prove it with multi-node E2E runs, and move the
whole thing into a repo where requirements → config → test → git record is a
repeatable process.

Grounded in engine source (`hub-service`) and real configs harvested from
staging (`api.microstrate.io`). Evidence links are in
[Defect register](#defect-register).

---

## Defect register

Severity: **P0** = MCP emits configs that cannot work; **P1** = configs work at
runtime but are wrong in the UI or teach the wrong pattern; **P2** = missing
knowledge, silent footgun.

| # | Sev | Defect | Evidence | Status |
|---|-----|--------|----------|--------|
| 1 | P0 | `condition` node docs + validator require `{ rules: [{ if, then, else }] }`. The engine feeds the payload straight into rule-engine v2, which knows `{ condition, outcome }` cells. `{if,then,else}` falls through `resolveRuleV2` to `{outcome: <whole payload>}` and `RawToStringArray` rejects it. | `runner/graph.go:1133` `handleConditionNode` → `evaluateRules` (`:1518`) → `jseval.ResolveRules`; `transform/transform.go:225`; `quiva-flows-mcp/src/validate.js:272` + `checkConditionTargets`; `quiva-flows-mcp/src/node-docs.js:269` | Source-confirmed; exact working payload to be locked by live A/B (Phase 1) |
| 2 | P0 | `rules` node doc has the right envelope (`{rules, facts, context}`) but wrong cell shape in its example (`{ if, then, else }` again). | `runner/graph.go:1182` `handleRulesNode`; `model/request.go:72` `RulesPayload`; `node-docs.js:300` | Source-confirmed |
| 3 | P1 | No node UI geometry. Real nodes carry `position`, `type: "custom"`, `origin`, `measured`; the flows MCP never emits them, so MCP-built flows render stacked/misplaced in the editor. | Harvested `Builders Risk Product Selection` nodes vs. `quiva-flows-mcp/src/index.js:76` | Confirmed absent; UI impact to be screenshotted (Phase 1) |
| 4 | P2 | Rule operator vocabulary is undocumented anywhere in the MCPs. ~80 operators/aliases exist. | decoded `hub-service/jseval/rules.go` const `R` → `expressionOperators` + `calculatingOperations` | Confirmed |
| 5 | P2 | `SECRET::NAME::` interpolation in payloads is undocumented. | harvested Builders Risk / Geocode nodes | Confirmed |
| 6 | P2 | `\| \|` string-concat inside map/JSONPath payloads is undocumented. | harvested `GEOCODE_RESPONSe` map node | Confirmed |
| 7 | P2 | Reading rule output (`$.NODE..outcome`) is undocumented. | harvested `CREATE_QUOTe` map node | Confirmed |
| 8 | P2 | The production pattern runs rules through a **compute function node** (`ms.compute.*.function.1116417408`), not the `rules` node type. MCP docs never mention it. | harvested `CHECK_UWING_RULES` | Confirmed |
| 9 | P2 | Two rule dialects are easy to conflate: flows = Evari rule-engine v2 (`{condition, outcome}`, `@fact:`); records forms = json-logic-engine (`{property, logic}`). | `form-rule.md`; `jseval/rules.go` | Confirmed |

### The two rule dialects — do not conflate

**Flows** (`condition`, `rules`, rules-via-function): Evari rule-engine v2.

```json
[
  { "condition": { "operator": "in", "input": ["@fact:state.value", ["CA","FL","NY"]] }, "outcome": "Product1" },
  { "outcome": "Product3" }
]
```

First cell whose `condition` is truthy wins; a trailing cell with no
`condition` is the fallback. `condition` is a *DynamicValue*: either
`{operator, input}` (nestable) or the string form `"@fact:<key>"`.

Operators (from the bundle): arithmetic `+ - * / % mod power pow ^ ceil floor
round trunc e log baseLog min max`; comparison `= equal equals != <> notEqual >
greaterThan >= greaterThanOrEqual/greaterThanInclusive < lessThan <=
lessThanOrEqual`; membership `in inArray notIn notInArray hasOptions
options-in`; string `substring concat join stringTemplate regex stringContains
stringNotContains`; array `arrayContains arrayNotContains concat-array sort
sortString split generate-array empty notEmpty`; data `jPath jsonPath jsonParse
jsonStringify map lookup numberFormat between notBetween`; date `today now
addDate subtractDate dateDiff dateFormat timeNow toISO`; logic `and & && or | ||
not !`; and `expression`/`exp` for infix chains.

**`rules` node / rules function** — keyed map, with a `facts` map:

```json
{
  "facts": { "state.value": "$.GEOCODE.state" },
  "rules": { "productDecision.value": [ { "condition": {...}, "outcome": "Product1" }, { "outcome": "Product3" } ] },
  "context": {}
}
```

Derived facts chain: a later rule may reference an earlier rule's key with
`@fact:`. Returns `{ <ruleKey>: outcome }`.

**`condition` node** — differs in two ways: (a) the payload *is* the rule (the
engine wraps it as `{ <NODE_ID>: payload }`), (b) `facts` and `context` are
passed as `{}`, so `@fact:` is useless — inputs are literal JSONPath
(`$.NODE.field`) already substituted by the resolver before evaluation. The
`outcome` must be a node id or array of node ids (`RawToStringArray`), or the
reserved `RESOLVE_SUCCESS` / `RESOLVE_ERROR`.

Leading hypothesis for the correct shape (`NodeData.Payload` is `any`, so an
array is legal — `model/request.go:63`):

```json
{
  "id": "CHECK_STATUS", "node_type": "condition",
  "payload": [
    { "condition": { "operator": "=", "input": ["$.FETCH_USERS.status", 200] }, "outcome": ["PROCESS"] },
    { "outcome": ["RESOLVE_ERROR"] }
  ]
}
```

**Records forms** are a different engine — json-logic-engine, `{ "property":
"visible|required|disabled|value", "logic": { … } }`. See `form-rule.md`.

---

## Phase 0 — Harvest the corpus (½ day)

Real configs that already work are the ground truth; everything downstream is
derived from them.

1. `tools/harvest.mjs` — talks to the REST API **directly**, not through the
   MCPs, so it can be pointed at any environment without restarting servers.
   Per-env credentials from `.env.<env>`.
2. Environments: `staging` = `api.microstrate.io` (verified: 36 workflow
   collections), `prod` = `api.quiva.ai` (needs read-only credentials).
3. Harvest per env: workflow collections; every workflow in **draft and
   published** form; record **configs** (schema + views); document templates
   (draft + published); agents; workspace spaces.
4. **Configs only — never record data rows.** Prod records hold client PII.
   Redact anything token-shaped; `SECRET::NAME::` is already a placeholder and
   is safe to keep.
5. Write to `corpus/<env>/<domain>/<name>.json`, plus `corpus/COVERAGE.md`: for
   every node type, form input type, and rule operator — does a real example
   exist, and where?

**Exit:** every node type and input type is either backed by a real example or
explicitly listed as uncovered.

## Phase 1 — Prove each truth, don't assume it (½ day)

For each P0/P1 in the register, run the minimum experiment on staging and keep
the run log as the artefact.

1. **Condition payload A/B** — one small flow, four variants: (a) array of v2
   cells at payload root, (b) single cell object, (c) `{rules: {...cells}}`,
   (d) the current documented `{rules:[{if,then,else}]}`. Record which branch
   fires and which error text the failures produce.
2. **Rules node** — keyed-map payload with a derived-fact chain; confirm the
   `{ruleKey: outcome}` return and that `$.NODE..outcome` reads it.
3. **UI geometry** — create the same flow with and without
   `position`/`type`/`origin`/`measured`; open the flow editor; screenshot
   both.
4. Write each result to `docs/engine-truth/<topic>.md` with the run log id and
   the failing error string (the error string is what makes a validator message
   actionable).

**Exit:** every register row moves to *engine-verified* with a linked run.

## Phase 2 — Fix the MCPs from the corpus (1–2 days)

Order: **quiva-flows first** — it is the only MCP with P0s, and it is the
orchestrator the other four plug into.

1. Rewrite `node-docs.js` for `condition` and `rules` to the verified v2 syntax;
   add the operator vocabulary as a reference topic.
2. Rewrite `validate.js`: accept v2 cells; **reject** `{if,then,else}` with a
   message naming the replacement; re-point `checkConditionTargets` at
   `outcome` instead of `then`/`else`; validate operator names against the known
   set (warn, don't error, on unknown).
3. Auto-fill UI geometry on create/update — simple layered auto-layout when
   `position` is absent, plus `type: "custom"`, `origin`, `measured`.
4. Document defects 5–8 (secrets, `| |`, `$.NODE..outcome`, rules-via-function).
5. `examples/` per MCP, sourced from the corpus and redacted; expose
   `list_examples` / `get_example` and cross-reference them from every node-type
   doc so an authoring model can pull a *real* example, not a hand-written one.
6. **Golden validator suite:** every harvested config must pass its own MCP's
   validator. These configs demonstrably run in production, so a failure is a
   validator bug. This is the highest-value regression test in the plan.
7. Then the same pass for records (form-rules dialect + input-type coverage),
   documents, agents, workspaces.

**Exit:** golden suite green; `condition` example round-trips through a live run.

## Phase 3 — Multi-node E2E harness (1 day)

Validation alone never catches "published but the nodes are wrong".

1. One smoke flow per node type (small, disposable, in a test collection).
2. One kitchen-sink flow: `trigger → agent → eval (JSON.parse) → condition (v2
   rules) → quiva-endpoint (create record) → human-in-the-loop → merge`.
3. Assertions from `search_run_logs`: every node id produced a result; the
   expected branch fired and the other was skipped; the record actually exists;
   the HITL pause/resume cycle completes.
4. UI checklist with screenshots: nodes laid out, edges drawn, condition
   branches rendered, payloads readable in the inspector.

**Exit:** one command runs the suite and reports per-node pass/fail.

## Phase 4 — New repo: `quiva-config-studio` (2–3 days)

```
mcp/                      the five servers
corpus/<env>/<domain>/    harvested golden reference (read-only)
specs/<deliverable>/      requirements.md + spec.yaml + test-plan.md + runs/
configs/<env>/<domain>/   the git record of what we authored & deployed
tools/                    harvest, diff/promote, e2e runner
.claude/                  skills + slash commands
```

- **Requirements capture:** `/capture-requirements` interviews to a
  `requirements.md` (intent, actors, acceptance criteria) plus a
  machine-readable `spec.yaml` that drives *both* config generation and test
  assertions — so a test is never written to match a buggy config.
- **Lifecycle:** `/build-config` (validate → create → publish) → `/test-config`
  (Phase 3 harness, evidence into `specs/<d>/runs/`) → `/promote` (diff env to
  env, then commit into `configs/<env>/`).
- **CI:** validators + golden suite + a check that everything in `configs/` is
  still valid against the current MCP validators.
- Decide: do the MCPs *move* (history-preserving subtree) or stay here and get
  vendored?

## Phase 5 — Drift watch

Nightly harvest → diff against `configs/` → open a PR when the live platform
and git disagree. Catches UI-side edits that bypass the MCP path.

---

## Open decisions

1. Read-only **prod credentials** for `api.quiva.ai`, or staging-only for now?
2. MCPs **move** into the new repo (git subtree) or stay and get vendored?
3. Corpus scrubbing: configs-only + token redaction — enough for prod, or keep
   the prod corpus local/gitignored?
