# Lessons

## 2026-07-28 — The risk-programme form "passed" with three silent UI defects

The `risk_programme` config was reported complete: 27 fields, 2 forms, 47 field
nodes, validator clean, E2E 25/25. Every one of those numbers was true and the
form was still broken in three ways, because **nothing in the loop rendered it**.
All three are silent — the API accepts them, the validator passed them, and the
config reads correctly to a human.

1. **Enum inputs had no `props.options`, so every dropdown rendered empty.**
   `InputControl` is handed `{...inputProps}` plus type/value and never sees the
   schema field; `options` defaults to `[]`. Nothing anywhere derives options from
   a schema `enum`. 7 top-level enum inputs were unusable.
2. **`props.currencyField: 'currency'` was invented.** `InputCurrency` has no such
   prop — grep across the whole frontend found it only in our own fixture. Props
   are spread onto the component, so a wrong name is dropped without a whisper.
   10 occurrences.
3. **All 5 repeaters + the insurer panel silently used default inputs.** The
   renderer *ignores* an `array-field` node's `children`: `ViewArray` renders each
   item by pointing `ViewField` at `{ item: field.items }` with no `nodeInputType`
   and no `nodeProps`. Item inputs come from
   `schema.<array>.items.properties.<leaf>.ui`. So currency became plain number,
   textarea became single-line, and two enum leaves became free-typed text boxes.

**Why the process missed it.** The same root cause as the condition-node bug, one
layer down:

> Last time the tooling was verified against the spec instead of the corpus. This
> time the corpus *was* harvested — and then read wrong. `grep -c '"options"'` on
> the harvested configs said "13 of 15 configs seed options", which I took as
> confirmation. Those options were in `schema.*.ui.props`, not on the form nodes.
> I counted a string, not a shape, and the count agreed with what I wanted.

The first hardened validator then produced **37 "empty dropdown" warnings against
live configs that render fine** — bare `{type,field}` nodes whose options come
from the schema `ui`. That false-positive wave is what forced reading the
renderer's fallback exactly: `inputProps = nodeProps ?? field.ui.props ?? {}`.
It is a **wholesale** choice, not a merge — so a node carrying only a `label`
discards a schema `ui.props` that does have options. That trap is now its own
warning, and the corpus sweep went 37 → 3, all 3 genuine (in the config already
known to be broken).

**Rules for next time:**

- A form config is not verified until something **renders** it. Field counts,
  schema validity, and a green E2E round-trip say nothing about whether a human
  can use the form. The E2E proved data went in and came back; the *inputs* were
  never exercised.
- When a prop or key is the thing under test, `grep` for it and then **read the
  match in place**. A count of occurrences is not evidence about location, and
  location was the entire bug in defects 1 and 3.
- Ask "what reads this?" for every key written. Three sinks existed here (node
  props, schema `ui`, and nothing at all) and we assumed one.
- **A false positive against the live corpus is a finding, not a nuisance.** Both
  times, the wave of warnings against working configs was what located the real
  contract. Sweep the corpus *before* trusting a new check.
- Fallback chains need their combining rule pinned down: `??` over whole objects
  behaves nothing like a merge, and the difference is invisible until render.
- Prefer deriving one representation from another over writing both by hand. The
  fixture now seeds `options` from the schema `enum` and generates repeater
  children and the `ui` mirror from one registry, so they cannot drift.

## 2026-07-27 — The condition-node rules syntax was wrong for two weeks, and nothing caught it

The flows MCP documented and *enforced* `{ rules: [{ if, then, else }] }` for
condition nodes. The engine uses rule-engine v2: `{ condition: { operator, input },
outcome }`. Verified live — the legacy shape fails with *"value has to be a string
or an array of strings"* (`quiva-flows-mcp/test/e2e-staging.mjs`, negative control).

**Why the process missed it** (the root cause is one line):

> The process verified the tooling against the spec and against runtime failures.
> It never verified the tooling against the corpus of configs that already work.

Each contributing link, because none of them is individually careless:

- **The source review stopped one indirection short.** Every other node type's
  contract is a Go struct (`RulesPayload`, `EvalPayload`, `HTTPPayload`).
  `condition` is `Payload any`, and its truth is two hops out through
  `handleConditionNode` → `evaluateRules` → a base64-embedded JS bundle in
  `hub-service/jseval/rules.go`. Greppable everywhere except here.
- **Records already knew the fix and flows never got it.** The records playbook's
  Phase 1 reads *the renderer* because the server stores `views.forms` opaquely.
  `condition`'s payload is opaque in exactly the same way, and the authoritative
  contract was sitting in the frontend the whole time as a machine-readable JSON
  Schema: `microstrate/src/utils/json-schema.utilts.ts:242` `rulesInputJSONSchema`
  (plus `components/flows/flow/node/edit/condition-type/`, which serialises
  `payload: rules` directly).
- **The token-economy pass deleted the one artifact that carries a DSL.**
  `quiva-flows.json` contains *zero* mentions of if/then/else — the wrong syntax
  lived only in the MCP's own docs. For a schema-shaped field an example is
  redundant; for a DSL-shaped field **the example is the constraint**.
- **Copying a production config masked the bug.** The KYC flow was built from
  `client-folder-creation`, which was correct. The artifact was right while the
  tooling was wrong, so no run ever failed for this reason.
- **The one diagnostic signal got a correct-but-different explanation.**
  *"failed to determine next steps"* during the KYC E2E was attributed to
  agent-results-are-JSON-strings (true, and fixed with a PARSE node). It is also
  what `evaluateRules` emits when no branch matches. That was the only moment
  the condition node was under suspicion.
- **The validator was lenient in the wrong direction.** It accepted both shapes
  and only printed the wrong one in an error that fires on an *empty* payload —
  a path nobody hits. A wrong message on a never-taken path is invisible.
- **`checkConditionTargets` was silently dead**, reading `then`/`else` that no
  real config has. Zero coverage looks identical to working coverage.
- **The tests locked the bug in**, asserting the broken shape was *valid*. Tests
  written from the docs can only ever confirm the docs.

**Prevention, now in place** (`quiva-flows-mcp`):

- `examples/` holds real published workflows harvested by
  `tools/harvest-examples.mjs` (credentials redacted), exposed as
  `list_examples`/`get_example`. Reference examples are never hand-written again.
- A **golden gate** in `npm test`: every harvested config must pass the local
  validator, because those configs demonstrably run. Any error not on a
  documented allowlist is a validator bug by definition.
- `list_reference_topics`/`get_flows_reference` — flows was the only MCP with no
  place to document a DSL. `rules-syntax` now states the IF/ELSE-IF/ELSE ↔
  `condition`/`outcome` mapping outright, since the UI vocabulary is what makes
  the wrong shape plausible.
- `npm run test:e2e` runs a live multi-node flow through **both** condition
  branches and includes a **negative control** proving the old shape still fails.
  A fix nobody can see fail is not verified.

**A two-example golden gate is not enough — sweep the whole environment.**
`tools/sweep-validate.mjs` runs the validator over *every* workflow on an
environment and diffs old-vs-new. Across 240 versions on staging it found:

- **25 of 27 live condition nodes already used the v2 shape and ZERO used
  `{ if, then, else }`.** The platform never produced that shape; it was purely
  an MCP-doc invention. Nothing to migrate.
- **One false positive in the new validator.** It errored on
  `{ operator: "empty", input: "$.X.body.results" }` (live "Authorise CIP Test"
  flow) because `input` was a scalar. The engine wraps a lone operand —
  `if (!Array.isArray(params) && operator !== "not") params = [params]` — so it
  runs, and reads naturally for unary operators. Only the editor's
  `rulesInputJSONSchema` insists on an array, so this is a WARNING. Two harvested
  examples were too small a corpus to catch this; 240 configs caught it at once.
- Final diff: **0 regressions**, 109 valid under both validators, 107 invalid
  under both (all pre-existing: drafts with missing payloads, editor nanoid ids,
  dangling edges).

**Three further defects found by trying to clean up after myself:**

1. `ValidateConfig` only runs when a request carries `validate=true`
   (`handler/create-workflow.go:92`), and the flow editor does not send it. So
   production contains node ids like `QsY6OWA5xVhZn9aS3lF-Z` that violate
   `validate.ValidateID` — and the MCP, which always sent `validate=true`, could
   not update *any* UI-authored flow. Fixed with a `server_validate` option.
2. Nodes and edges need flow-editor presentation fields (`position`, `type`,
   `measured`; edge `type`/`edgeType`/`sourceHandle`/`targetHandle`) or the graph
   renders stacked at the origin. The MCP emitted none. Now auto-filled, and the
   E2E asserts the round-trip keeps them — flows' original Phase 5 asserted only
   "the run passed", which is why this went unseen.
3. **`delete_workflow` silently orphaned every draft it "deleted".** The engine
   has no `keep_draft` param at all: `DeleteWorkflowHandler` branches on whether
   the resolved subject contains `.draft.`, which `getSubjectFromRequest` builds
   from `?draft=true` — and a draft subject deletes BOTH versions while a
   published subject deletes only the published one. The MCP sent a parameter
   that does not exist, so it only ever removed the published version and left
   the draft behind, while the API cheerfully returned `{"message":"success"}`.
   Found only because a cleanup step was *verified* rather than trusted: the tool
   reported success and the flow was still there. Lesson: assert the
   post-condition of destructive operations, not the response body.

**The `rules` node, proven live** (`test/e2e-rules-node.mjs`, 23 checks). There
are zero `rules` nodes anywhere on staging, so its docs had been derived from the
handler rather than executed. Test case: the worked rule from `form-creator.md`
translated across dialects — records forms use json-logic-engine
`{ "logic": { ">=": [ { "var": "Age" }, 18 ] } }`, flows use
`[{ "condition": { "operator": ">=", "input": ["@fact:Age", 18] }, "outcome": true }, { "outcome": false }]`.
Confirmed: the `{ rules, facts, context }` envelope, `@fact:` resolution,
derived-fact **chaining** (a rule reading two earlier rule outcomes), the
`{ ruleName: outcome }` return, and the rules -> condition handoff.

New gotcha found by it: **a dotted rule key cannot be read with dot JSONPath.**
`$.FORM_RULES.AvatarUrl.visible` returns `[]` because the resolver walks
`AvatarUrl` -> `visible` instead of matching the literal key `"AvatarUrl.visible"`.
Read the whole map (`$.FORM_RULES`) or keep rule names dot-free. Also note the
rules NODE unwraps to bare outcomes while the rules COMPUTE FUNCTION returns the
raw engine output — which is why the Builders Risk flow reads `$.NODE..outcome`.
Same payload in, different shape out.

**Rules of thumb worth keeping:**

- When the server stores a field opaquely (`any`, `map[string]any`), the
  *consumer* — renderer or interpreter — is the contract. Go find it.
- Never hand-write a reference example for a mini-language. Harvest one.
- A validator must accept everything already running in production.
- Any test asserting "X is valid" should cite a real config containing X.
- Runtime failure only catches defects that break a run. A wrong doc that
  authors route around needs a non-runtime gate.

## 2026-07-14 — Building flows against the hub API (KYC flow E2E)

Discovered by running the KYC flow live on staging; each cost a failed run:

- **Agent node payloads**: the OpenAPI spec and even `hub-service/data/demo-flow.go` show flat payloads (`api_key`/`llm_provider`/`model` at payload top level), but `InvokeAgent` (`hub-service/handler/agents.go:517`) requires `subject`, `node_subject`, or a nested `agent` object. Flat fields are silently dropped. Prevention: the MCP validator now rejects flat agent payloads.
- **Agent results are JSON-encoded strings** even with `output_schema` (`process_invoke.go:1288` marshals the content string). Any condition on `$.<AGENT>.result.<field>` needs a JSON.parse eval node in between. Prevention: documented in node docs + spec; consider a shared `PARSE_*` eval pattern in flows.
- **Published subject format**: publishing strips the `.draft.` segment — there is no `.published.` segment despite the old spec's pattern. Get the runnable subject from `list_workflows?version=published`.
- **`PATCH /hub/workflows/{c}/{f}` requires the draft subject in the body**; relying on path params returns 200-ish behaviour via some clients but can silently no-op. Always send `subject` in the body (MCP client now does).
- **Records API**: update is `PUT /records/{config}/{id}` — the records-service `openapi.json` documents PATCH, but the service only registers `put.record`; PATCH returns 500.
- **Engine retry quirk**: a node with `attempts > 1` that fails proceeds downstream with `result: null` while retries continue in parallel (`executeNode` treats a scheduled retry as success). Don't assume a retrying node blocks its children.
- **MCP tools with `z.any()` params receive JSON as strings** from the client — coerce string→JSON in the server (`quiva-flows-mcp/src/index.js` jsonValue preprocess) or triggers arrive as strings inside flows.
