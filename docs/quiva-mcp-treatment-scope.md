# What "the same treatment" means for each remaining MCP

Scoping document — written **before** applying anything, so the work can be
approved, re-ordered, or cut per MCP. The flows treatment is the template
(see [lessons.md](./lessons.md)); this defines each step's concrete analogue
elsewhere, because the recipe is **not** uniform.

## The treatment, distilled

Six steps. Steps 1–4 are where the defects hide; 5–6 are the ratchet that stops
them coming back.

| # | Step | Why it exists |
|---|---|---|
| 1 | **Find the opaque field** — anything the server stores as `any` / `map[string]any` / `record(string, unknown)` and never validates. Its *consumer* (renderer or interpreter) is the real contract. | This is where flows was wrong. The server accepts anything, so the spec cannot be the truth. |
| 2 | **Read the consumer to its terminal implementation** — including bundled/embedded code. | `condition`'s truth was two hops out, inside a base64 JS bundle. |
| 3 | **Harvest a golden corpus** — real configs off the platform, credentials redacted, exposed as `list_examples`/`get_example`. Never hand-write an example for a DSL-shaped field. | A hand-written example is exactly how the bad syntax shipped. |
| 4 | **Encode truth in the validator** — error on what cannot work, warn on divergences between engine and UI. | A wrong doc nobody reads is invisible; a validator error is not. |
| 5 | **Golden gate in `npm test`** — every harvested config must validate, else the validator is wrong. Plus a sweep of the whole environment (a 2-config corpus is too small — that is how a false positive of mine survived). | The one check that would have caught the original defect on day one. |
| 6 | **Live E2E with a negative control and a verified round-trip** — prove the fix, prove the *old* shape fails, and diff what the platform stored against what you sent. Assert the post-condition of destructive steps, never the response body. | "The run passed" hid the missing geometry; a success response hid `delete_workflow` orphaning drafts. |

---

## Priority 0 — shared: one rule-engine truth module (½ day, do first)

**The rule engine has readable TypeScript source**, and I reverse-engineered it
from a base64 blob without noticing:
`file-generator-service/src/utils/rule-engine/` (both `v1/` and `v2/`).
`v2/types/rule.ts` is the authoritative `isRuleCellV2` / `isRuleV2` /
`DynamicValueV2` definition; `calculating-operations.ts` is the operator set.
`hub-service/jseval/rules.go` embeds a build of it.

Both the flows MCP and the documents MCP need this dialect. It should be **one
generated module**, derived from that source, not two hand-maintained copies:

- generate the operator set from `calculating-operations.ts` (today the flows MCP
  has it hand-transcribed — correct, but it will drift)
- a test that fails when the TS source gains or loses an operator
- shared by `quiva-flows-mcp` and `quiva-documents-mcp`

Also worth folding in: the three-way operator divergence already documented for
flows (engine ≈80, editor `rulesInputJSONSchema` ≈35, visual builder
`OperatorType` ≈55 including six the engine does not implement).

---

## Priority 1 — quiva-documents (1.5–2 days) — same defect as flows, worse

**This is the urgent one.** It has the flows bug, in a form that fails silently.

`sub_templates[].conditions` decides whether a sub-template is merged into the
generated document. The MCP documents it as **json-rules-engine**:

```json
{ "all": [ { "fact": "client_region.value", "operator": "equal", "value": "EU" } ] }
```

(`quiva-documents-mcp/src/documents-docs.js:76`, and `validate.js:118` *enforces*
that shape). But the engine evaluates it with **rule-engine v2**:

```ts
// file-generator-service/src/consumer/template-trigger.ts:274
resolveRulesV2({ rules: { trigger: x.conditions }, facts })?.['trigger']?.outcome === true
```

`{ all: [...] }` has no `outcome`, so `isRuleCellV2` rejects it, `resolveRuleV2`
falls through to `{ outcome: <the whole object> }`, and `outcome === true` is
**false**. The sub-template is **silently dropped** — no error, no warning, just a
missing section in the document. Worse than the flows case, which at least failed
loudly.

The correct shape is a bare v2 expression object (note: `type/template.ts:64`
types `conditions` as `record(string, unknown)`, an **object**, so prefer a single
expression over an array of cells):

```json
{ "operator": "=", "input": ["@fact:client_region.value", "EU"] }
```

Facts are auto-derived as `` `${key}.value` `` from the trigger payload
(`template-trigger.ts:266`) — which explains the `.value` convention throughout.

Step-by-step:

1. **Opaque field:** `conditions` (`record(string, unknown)` — server never checks it).
2. **Consumer:** `consumer/template-trigger.ts` → `resolveRulesV2`. Second DSL in
   this MCP is the template expression/filter syntax (`{a.b}`, `{#items}`,
   `{d | formatdate:"yyyy-MM-dd":-5:en-US}`) — verify against `utils/docx.ts`
   rather than the spec's `x-agent-syntax-rules`.
3. **Harvest:** real published templates + their generated documents. **Check
   first whether any live template uses `conditions`** — if some do and they are
   in `{all:[...]}` form, they are silently broken in production today and that
   is a finding to report, not just a doc fix.
4. **Validator:** replace the json-rules-engine check with v2 (reusing the P0
   module); keep a lint that rejects `{all|any:[{fact,operator,value}]}` by name.
   Keep the existing filter/tag checks — they look sound.
5. **Golden gate + sweep** over all templates.
6. **E2E:** create template → publish → trigger with two payloads so a conditional
   sub-template is included once and excluded once → poll `get_document` → assert
   the rendered output differs. **Negative control:** the `{all:[...]}` form must
   demonstrably fail to include the sub-template. Round-trip: draft vs published,
   and confirm `unset` actually removes a field.

---

## Priority 2 — quiva-records (1–1.5 days) — half-treated already

The records playbook already did steps 1, 2 and 4 properly: it identified
`views.forms` as opaque `[]map[string]any`, read the renderer, and embedded
`form-builder` + `form-rules`. **Its form rules are genuinely json-logic-engine**
(`{property, logic}`) — a different engine from flows, correctly documented. No
dialect bug expected.

What is missing is the ratchet:

- **Examples are hand-written.** All six in `quiva-records-mcp/examples/` are
  authored fixtures ("throwaway clone", "sample record") with no provenance —
  exactly the pattern that produced the flows defect. Replace with harvested
  configs (keeping one or two authored ones as *minimal* teaching aids, clearly
  labelled).
- **No golden gate, no environment sweep.** Records has far more live configs
  than flows; the sweep will likely surface validator false positives, as it did
  for me.
- **No round-trip assertion on the form.** The playbook's Phase 5 claims the form
  round-trips; make it an automated assertion (node-level `inputType`/`props`/
  `rules` survive, `schema.*.ui` is stripped on save as documented).
- **Negative control:** put `inputType`/`props` on the *schema* instead of the
  view node and prove the renderer ignores it — that is the documented trap, so
  it should be a test.
- **Dialect guard:** reject a flows-style `{condition, outcome}` rule inside a
  form rule, and vice versa. The flows MCP already rejects json-logic in a rules
  node; make it symmetric.
- **Harvest data safety:** configs only, never record rows — prod records hold
  client PII.

---

## Priority 3 — quiva-agents (1 day) — different shape of risk

No rules DSL. The opaque fields are:

- `OutputSchema map[string]any` (`hub-service/model/agents.go:38`) — a flat
  `field -> description` map, **not** JSON Schema. Its consumer is the prompt
  builder, so read how it is injected. Related known truth: the result comes back
  as a JSON-**encoded string** even with an output schema.
- `Tool.Schema map[string]any` (`:541`) and the tool URI mini-language
  (`bit://web_search`, `mcp://`, `fun://`) — verify the resolver, and validate
  URI schemes rather than accepting any string.
- Knowledge URIs (`kv://`, `obj://`, `str://`, `sid://`, `dta://`) plus
  `Knowledge.Metadata` filters (`:553`, AND-combined).
- `ContextVariables map[string]json.RawMessage` — carries an explicit
  **prompt-injection warning** in the model. The MCP should surface that warning,
  not just pass it through.

Steps: harvest real agents (redact any provider keys); golden gate; validate
model ids against the platform catalogue (`microstrate/static/models.json`)
instead of a hard-coded list; validate tool/knowledge URI schemes; E2E that
actually **invokes** an agent — this is the one MCP where the E2E spends real LLM
tokens, so keep it to one cheap Haiku call. Negative control: a flat agent
payload, and an unsupported `llm_provider`, must both fail.

Also verify the three-identifier trap the MCP already documents (`subject` is an
MD5 of the config, so the same config twice returns 409) — that is asserted in
docs but, as far as I can tell, never tested.

---

## Priority 4 — quiva-workspaces (½ day) — least at risk

Genuinely little DSL surface. Opaque fields are metadata bags
(`Task.Metadata`, `Comment.Reaction`, `Space` context) plus
`model/scheduler.go` `Payload json.RawMessage` behind the task-event-schedule
route the MCP deliberately does not expose.

So the treatment is mostly the ratchet, not a truth hunt: harvest real spaces and
tasks; golden gate; an E2E round-trip covering the documented quirks
(`id` uppercased server-side and `^\w+$`, server-generated task ids as
`{SPACE}-{n}`, soft-deleted comments, PATCH-not-PUT, the `{status_code, body}`
envelope). Negative control: a space id with a hyphen must be rejected, and a
task against a non-existent space must 400.

Two things worth checking that could upgrade this: whether a frontend board
renderer needs presentation fields the MCP omits (the flows-geometry analogue),
and whether task statuses have a config contract the MCP should validate.

---

## Recommended order and cost

| Order | MCP | Effort | Rationale |
|---|---|---|---|
| 0 | shared rule-engine module | ½ day | Unblocks 1, de-duplicates flows |
| 1 | **quiva-documents** | 1.5–2 days | Same defect as flows, fails **silently**, may already be broken in production |
| 2 | quiva-records | 1–1.5 days | Truth is right; the ratchet and harvested examples are missing |
| 3 | quiva-agents | 1 day | No DSL, but opaque schema/URI surface and an untested identifier trap |
| 4 | quiva-workspaces | ½ day | Ratchet only |

Roughly **4.5–5.5 days**. Each is independently shippable; stopping after
documents still removes the one silent-failure bug.

## Decisions needed before starting

1. **Documents first, or a different order?** My recommendation is documents,
   because it is the only remaining *silent* failure.
2. **Does the agents E2E get to spend LLM tokens?** One Haiku call per run, or
   should it stop short of `invoke_agent`?
3. **Harvest scope for records:** configs only (my recommendation) — confirm no
   record rows, given prod PII.
4. **Do these land in this repo or in `quiva-config-studio`?** The harvest /
   golden-gate / E2E machinery is now proven and generic; extracting it as shared
   tooling is cheaper than copying it four more times.
