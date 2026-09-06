# Quiva MCP hardening — handoff

**Date:** 2026-07-29 (started 2026-07-27) · **Environment:** staging
(`https://api.microstrate.io`, UI `https://app.microstrate.io`)

Written so a fresh session can resume with no prior context. Read this file, then
[lessons.md](./lessons.md) for the *why* and
[quiva-mcp-treatment-scope.md](./quiva-mcp-treatment-scope.md) for the remaining plan.

## Status board

| | |
|---|---|
| **quiva-flows-mcp** | Done. 36 checks, 240-config sweep, 0 regressions. |
| **quiva-records-mcp** | Done. 68 checks, 19-config golden gate, 28/28 live E2E. |
| **`risk_programme` config** | Correct and live on staging (27 fields). Verified by read-back. |
| **quiva-documents-mcp** | Examples + golden gate done (31 checks). **The `conditions` bug is now PROVEN LIVE and the docs + validator are fixed** (§8.1). |
| **quiva-workspaces-mcp** | Examples + golden gate done (61 checks). Live artefact on staging. 2 findings (§8.2). |
| **quiva-agents-mcp** | Examples + golden gate + 189-config sweep done (34 checks). **150/189 live configs would be blocked by the validator** (§8.3). Staging artefact blocked on a bearer token. |
| **Frontend (microstrate)** | **4 open bugs found 2026-07-29** — see §4.0. One is data-loss. Nothing fixed; all await approval. |
| **Commits** | Nothing committed. Entire session is in the working tree (§6). |

All five MCPs now have `examples/`, `list_examples` / `get_example`, and a golden
gate. **230 checks pass across the five suites** (31 + 61 + 34 + 36 + 68).

> ⚠️ **Two things to know before you touch anything**
>
> 1. **Do not press "Save schema" on the `risk_programme` config in the UI.** A
>    frontend bug deletes any field named `type`, and saving persists the deletion
>    (§4.0, bug 1). The stored config is currently correct — a UI save would
>    break it and take four form rules with it.
> 2. **Restart Claude Code before using the records/flows MCP tools.** Servers
>    load their code at session start, so an old session serves the pre-fix
>    validator and docs. `npm test` and the E2E scripts spawn fresh processes and
>    always exercise current code.

---

## 1. Why this work happened

The flows MCP documented and **enforced** the wrong syntax for `condition` nodes:
`{ rules: [{ if, then, else }] }`. The engine actually uses Evari **rule-engine
v2** — `{ condition: { operator, input }, outcome }` branches. Verified live: the
old shape fails with `value has to be a string or an array of strings`.

Root cause, in one line:

> The process verified the tooling against the spec and against runtime failures.
> It never verified the tooling against the corpus of configs that already work.

Full post-mortem with all eight contributing factors: [lessons.md](./lessons.md).

**Key discovery for anyone touching rules:** the rule engine has readable
TypeScript source at `file-generator-service/src/utils/rule-engine/` (`v1/` and
`v2/`). `v2/types/rule.ts` is authoritative; `calculating-operations.ts` is the
operator set. `hub-service/jseval/rules.go` embeds a compiled build of it as a
base64 blob — do **not** reverse-engineer the blob, read the TS.

---

## 2. What is DONE

### quiva-flows-mcp — complete

| Area | Change |
|---|---|
| Rules DSL | New `src/rules-docs.js` — v2 contract, 3 operator vocabularies, validator |
| Reference topics | New `src/reference-docs.js` — `list_reference_topics` / `get_flows_reference` (`rules-syntax`, `jsonpath`, `geometry`, `lifecycle`, `gotchas`) |
| Real examples | New `tools/harvest-examples.mjs` + `examples/` — `list_examples` / `get_example` |
| Validator | `src/validate.js` — v2 branches, rejects `{if,then,else}`, unknown operators error, branch targets read `outcome`, catch-all + missing-edge warnings |
| UI geometry | New `src/geometry.js` — auto-fills node `position`/`type`/`measured`, edge `type`/`edgeType`/handles |
| Node docs | `src/node-docs.js` — condition/rules rewritten, pipe-concat + `SECRET::` documented |
| Tests | `test/validate.test.js` (36 checks incl. golden gate), `test/e2e-staging.mjs`, `test/e2e-rules-node.mjs`, `tools/sweep-validate.mjs` |

**Bugs fixed beyond the original report:**
1. `condition` / `rules` DSL (the reported one).
2. **No flow-editor geometry** — MCP-built flows rendered stacked at the origin.
   `FlowNode.position` is non-optional in the frontend type.
3. **`delete_workflow` silently orphaned every draft.** There is no `keep_draft`
   param in the engine; `DeleteWorkflowHandler` branches on whether the subject
   contains `.draft.`, built from `?draft=true`. A draft subject deletes BOTH
   versions; a published one deletes only the published. The API returned
   `{"message":"success"}` regardless.
4. **The MCP could not update any UI-authored flow.** `ValidateConfig` only runs
   when a request carries `validate=true` (`handler/create-workflow.go:92`) and
   the editor never sends it — so production has node ids like
   `QsY6OWA5xVhZn9aS3lF-Z` that violate `validate.ValidateID`. Added
   `server_validate`.
5. A false positive I introduced: scalar `input` on an expression. The engine
   wraps a lone operand, so it runs — now a warning. Caught by the 240-config
   sweep, not by the 2-config golden gate.

**Verification:** 36 unit/golden checks · 34 live condition-flow checks ·
23 live rules-node checks · 240-config regression sweep with **0 regressions**
(25 of 27 live condition nodes were already v2; **zero** used `if/then/else` —
that shape was purely an MCP invention) · flow editor's own rule builder and
validator accept the payload.

### quiva-records-mcp — harvest + golden gate done

| Area | Change |
|---|---|
| Real examples | New `tools/harvest-examples.mjs` → `examples/harvested/` (19 live configs, configs only). Old hand-written fixtures moved to `examples/authored/` and labelled *not evidence*. New `src/examples.js`, `list_examples` / `get_example` |
| Validator | `src/validate.js` — unrecognised view node types now match the renderer instead of erroring |
| Tests | `test/validate.test.js` (68 checks incl. golden gate + form-render lints), `test/e2e-staging.mjs`, `test/fixtures/risk-programme.mjs` |

**Defect found by the golden gate:** a live config uses view node type
`"element"`. The renderer
(`microstrate/src/components/records/form/record-view-renderer.component.svelte`)
dispatches `grid` / `table` / `array-field` and sends **everything else to
`ViewField`** — so erroring was a false positive.

**But there is a real bug behind it, still open:** that node is
`{ type: "element", element: "card", children: [...] }` — a presentational
container. **No component in the records or embed form palettes handles it**, and
`ViewField` ignores `children`, so its contents never render. Config
`sc8DhU6CEXh4gkJPnS_Le`, form `create_as_client` ("Create as Client"). The
validator now warns naming exactly what is dropped. **Someone should look at that
form in the UI and decide whether to fix the config or add renderer support.**

For records the golden gate **is** the environment sweep — all 19 live configs
are harvested.

### Risk Programme record config — built, then FIXED (2026-07-28)

27 schema fields, 2 forms. Source of truth:
`quiva-records-mcp/test/fixtures/risk-programme.mjs`.

**The first version passed every check and the form was still broken three ways.**
Found by reading the renderer instead of the config. All three are silent — the
API accepts them and the validator passed them:

| Defect | Effect | Fix |
|---|---|---|
| No `props.options` on enum inputs | 7 dropdowns rendered **empty** — nothing derives options from a schema `enum` (`InputControl` never sees the schema field; `options` defaults to `[]`) | `options` seeded from the enum, on all 10 choice inputs |
| `props.currencyField: 'currency'` | Invented prop — no such prop exists on `InputCurrency`. Props are spread onto the component, so it was dropped silently (10 occurrences) | Removed; `decimalPlace: 2` + `min: 0` used instead |
| Repeater config on `array-field` children | The renderer **ignores** array-field children (`ViewArray` points `ViewField` at `{item: field.items}` with no nodeProps). All 5 repeaters + the insurer panel used type defaults: currency → plain number, textarea → single-line, 2 enum leaves → free text | Config mirrored onto `schema.<array>.items.properties.<leaf>.ui` (18/18 leaves), which is what actually renders |

Live config re-pushed and **verified by read-back**: 10/10 choice inputs carry
options, 0 `currencyField`, 18/18 item leaves carry the `ui` mirror.

**Validator hardened so none of this can recur** (`src/validate.js`, 68 checks, up
from 54):
- choice input with no resolvable `options` → warning (mirrors the renderer's
  `nodeProps ?? field.ui.props` fallback exactly, so bare-node configs are not
  falsely flagged)
- `options` values that disagree with the schema `enum` (missing or extra) → warning
- a prop the input type does not accept → warning, naming the accepted set
- `array-field` child carrying `inputType`/`props` with no `items.properties.*.ui`
  mirror → warning naming the exact path to write
- schema-level `ui` declaring a choice input with no options → warning
- enum field left on a text-ish input → warning

**Corpus sweep: 37 → 3.** The first version of the options check produced 37
warnings against live configs that render fine — bare `{type,field}` nodes whose
options live on `schema.*.ui`. That false-positive wave is what pinned down the
fallback rule. The 3 that remain are genuine, all in `sc8DhU6CEXh4gkJPnS_Le` (the
config already known to be broken — see the `element`/card issue above): one
optionless dropdown and two array-field children with no `ui` mirror.

Reference docs corrected too (`src/records-docs.js`): the `form-builder` topic now
carries the array-item gotcha, the mandatory enum→options rule, the wholesale-vs-
merge props fallback, and an `array_field_example` showing **both** halves.

> ⚠️ **A running MCP server has stale code.** Servers connect at session start, so
> the corrected validator and docs are not served until Claude Code is restarted.
> `npm test` and the E2E scripts spawn fresh processes and always test current code.

---

## 3. Everything left on staging, and how to check it

Nothing has been cleaned up, per instruction. Two artefacts:

### A. Flow — `mcp-verification-rules-node-ui`

Collection **Test Flows** (`805092869`). 6 nodes: `TRIGGER → FORM_RULES(rules) →
{SHOW, GATE(condition)} → {ONBOARD, REQUEST_MORE_INFO}`.

```
Draft (editor):     https://app.microstrate.io/en/hub/flows/ms+hub+config+workflow+draft+805092869+1512734875
Published:          https://app.microstrate.io/en/hub/flows/ms+hub+config+workflow+805092869+1512734875
Collection listing: https://app.microstrate.io/en/hub/flows?collection=ms.hub.config.collection.workflow.805092869
```

(Subjects are URL-encoded by replacing every `.` with `+` — `dotString = '+'` in
`microstrate/src/utils/transform.utils.ts`.)

**How to check it — 4 things:**

1. **Layout.** Six nodes stepping left-to-right with a fork after `GATE`, edges
   drawn with arrowheads. Before the geometry fix they would all sit stacked at
   the top-left. Positions stored: x = 0, 296, 592, 592, 888, 888.
2. **The condition node.** Click `GATE` → **Rules** tab → toggle from
   **`Code Editor`** to **`Conditions`**. ✅ **Already confirmed working:** two
   panels, `IF` (Input `$.FORM_RULES.profile_complete`, Operator `Equal`, Value
   `"complete"`) and `ELSE` (`{"outcome": "REQUEST_MORE_INFO"}`). Those labels are
   *derived* from whether a cell has a `condition`, so seeing IF+ELSE means the
   editor recognised the shape. The old `{if,then,else}` payload renders zero
   panels, and the panel's own validity check is
   `isJSON(v) && JSON.parse(v)?.outcome` — the editor itself tests for `outcome`.
3. **The rules node.** Click `FORM_RULES` → three rules: `AvatarUrl.visible`,
   `Email.present`, `profile_complete` (chaining off the first two via `@fact:`).
   All four operators used (`=`, `>=`, `and`, `notEmpty`) are in the editor's own
   dropdown, so expect **no** validation complaints.
4. **Run it.** `{ "age": 25, "email": "a@b.com" }` → ONBOARD branch.
   `{ "age": 16, "email": "a@b.com" }` → REQUEST_MORE_INFO. Third case
   `{ "age": 30, "email": "" }` → `Email.present` false, `profile_complete`
   incomplete.

To delete: `node -e` via the MCP `delete_workflow` with the **draft** subject, or
`DELETE /hub/workflows/805092869/1512734875?draft=true` (`draft=true` removes both
versions — see bug #3 above).

### B. Record config — `risk_programme` (+ 1 record)

```
Config:       https://app.microstrate.io/en/hub/records/configs/risk_programme
Default form: https://app.microstrate.io/en/hub/records/configs/risk_programme/forms/default
Quote form:   https://app.microstrate.io/en/hub/records/configs/risk_programme/forms/quote_capture
Config list:  https://app.microstrate.io/en/hub/records/configs
```

Those `/forms/<id>` URLs open the **form builder**, not a fillable form. Route
confirmed: `[lang]/[application]/(protected)/(with-layout)/records/configs/[id]/forms/[formId]`.

> **Click the "Preview" tab.** On the default **Edit** tab you cannot open a
> dropdown — fields render inside `EditWrapper` with `pointer-events: none`
> (`view-field.component.svelte:303`) and repeaters show one static item template.
> The Preview tab renders the live interactive form
> (`preview={activeTab === 'preview'}` → `RecordFormRenderer` → `RecordViewRenderer`
> with no `onEditField`, so edit mode is off). Edit tab cannot verify inputs at all.

**How to check it — 5 things.** Check 0 first; it is the one the first round missed.

0. **Open the Preview tab and use the inputs.** Every dropdown must actually drop
   down: Status, State, Currency, Payment status, the Subject-of-insurance toggle,
   and **Basis inside the Coverage limits and Excesses repeaters**. If any opens
   empty, the `options` regressed. Money fields should render as currency inputs
   (2 decimals) — including *inside* the repeaters, which is what defect 3 broke.
   **Expect two known frontend bugs here, not config regressions:** the **Type**
   dropdown will be missing entirely (§4.0 bug 1) and the `% of insured amount`
   +/− buttons will do nothing (§4.0 bug 2).

1. **Field types and enums.** 27 fields. `type` (info/quote/policy/renewal),
   `status` (current/expired/cancelled/superseded), `subject_type`
   (address/asset), `payment_status` (n/a/invoiced/paid), `currency`
   (AUD/NZD/USD/GBP/EUR), AU state enum on the address, dates as
   `format: date`, all money as `number, minimum: 0`.
2. **Repeaters.** Five array-field groups render as add/remove repeaters:
   coverage limits, sub-limits, excesses, specified items, endorsements — plus the
   insurer panel (`insurer_name`, `share_pct`, `policy_number`, `is_lead`).
3. **Conditional rules — the important check.** On the **default** form:
   - toggle **Subject of insurance** between `address` / `asset` → the two field
     groups should swap (container `visible` rules)
   - set **Payment status** = `invoiced` → Payment due date becomes required
   - the three `Type`-driven rules (Premium required on `policy`, Target premium
     visible on `info`/`quote`, payment group visible on `policy`/`renewal`)
     **cannot be tested in the UI until §4.0 bug 1 is fixed** — the Type field is
     deleted before the form sees it. The rules themselves are stored correctly;
     verified via the API (4 rules keyed off `type`, 7 rules total).
4. **The existing record.** One record with a 60/40 co-insurance panel, a
   Melbourne risk address, and `payment_status: paid` (it was created as
   `invoiced` then partially updated, proving `PUT` merges rather than replaces).

To delete: `delete_record_config` with `id: risk_programme` (delete the record
first, or leave it — deleting the config leaves an orphan row).

---

## 4. What is LEFT to do

### 4.0 OPEN frontend bugs (microstrate) — found 2026-07-29

All four were found by trying to verify the `risk_programme` form in the UI. **None
are fixed.** `microstrate/CLAUDE.md` requires describing an approach and getting
approval before writing code there, so all four are diagnosed and waiting.

All four were traced by **reading the source, not running the app** — microstrate's
`node_modules` is not installed and `npx vitest` fails on Node 20.14 vs vite@8's
`>=22.12` engine requirement. Reproduce before shipping fixes.

---

#### Bug 1 — fields named `type` / `required` / `$schema` are silently deleted (DATA LOSS)

**`microstrate/src/components/records/records.utils.ts:538`**, in `jsonSchemaToRecordSchema`:

```ts
const isWrapped = obj.type === 'object' && obj.properties && ...
const source = (isWrapped ? obj.properties : obj)

for (const [k, v] of Object.entries(source)) {
  // Skip JSONSchema meta-keys that can leak in when input isn't wrapped.
  if (k === '$schema' || k === 'type' || k === 'required') continue
```

The skip is correct for the *unwrapped* legacy branch, where a top-level `type`
really is the JSON Schema keyword. But it runs **unconditionally**. When the input
is wrapped — the shape the API returns — `source` is `obj.properties`, so a user
field genuinely named `type` is treated as a meta-key and dropped. The comment
says *"when input isn't wrapped"*; the check was simply never gated on `isWrapped`,
which is computed 14 lines above.

Knock-on: `recordSchemaToJsonSchema` (same file, ~line 501) rebuilds `required`
from each surviving field's `isRequired` flag, so the dropped field also vanishes
from `required` instead of leaving a dangling entry.

**Blast radius.** `deserializeConfig` calls this on *every* config read and on
every create/update response (`src/services/api/records/records.services.ts`
lines 59, 68, 76, 84, 96). So every frontend consumer sees `risk_programme`
without `type`: the record create/edit form (the Type dropdown cannot render), the
schema builder + Schema preview, the form-builder field palette, AJV validation.
**Saving from the UI persists the truncated schema** — real deletion, and the four
`type`-keyed rules break. Any config with a field named `type` is affected, and
`type` is a very common field name for insurance records.

**Proposed fix** (one line):

```ts
// Meta-keys only leak in when the input isn't wrapped; inside `properties`
// they are legitimate field names.
if (!isWrapped && (k === '$schema' || k === 'type' || k === 'required')) continue
```

Known residual: an *unwrapped* legacy flat schema containing a real field named
`type` is genuinely ambiguous and stays broken. The fix covers the wrapped shape,
which is what the API returns.

**Reproduce.** Open `/en/hub/records/configs/risk_programme/forms/default` →
Schema preview. It shows 26 properties and 5 `required`; the API returns 27 and 6.
The missing one is `type` (enum info/quote/policy/renewal).

**Regression test** (drafted, deliberately NOT added to the repo pending approval —
save as `microstrate/src/components/schema-builder/type-key-roundtrip.test.ts`):

```ts
import { describe, expect, test } from 'vitest'
import { jsonSchemaToRecordSchema, recordSchemaToJsonSchema } from '@components/records/records.utils'

describe('a property named "type" survives the record-schema round trip', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      type: { type: 'string', title: 'Type', enum: ['info', 'quote', 'policy', 'renewal'] },
      status: { type: 'string', title: 'Status', enum: ['current', 'expired'] }
    },
    required: ['type', 'status']
  } as never

  test('jsonSchemaToRecordSchema keeps a field named "type"', () => {
    expect(Object.keys(jsonSchemaToRecordSchema(schema) ?? {})).toContain('type')
  })

  test('the round trip keeps the field and its required entry', () => {
    const out = recordSchemaToJsonSchema(jsonSchemaToRecordSchema(schema))
    expect(Object.keys(out?.properties ?? {})).toContain('type')
    expect(out?.required).toContain('type')
  })

  test('an UNWRAPPED legacy schema still skips leaked meta-keys', () => {
    const flat = { $schema: 'x', type: 'object', required: ['a'], a: { type: 'string' } } as never
    expect(Object.keys(jsonSchemaToRecordSchema(flat) ?? {})).toEqual(['a'])
  })
})
```

---

#### Bug 2 — number inputs: +/− buttons and min/max clamping are dead

Reported symptom: the `% of insured amount` plus/minus signs do nothing.

Chain:
1. `input-number.component.svelte` — `handleIncrease`/`handleDecrease` propagate
   **only** via `onChange?.(value, event)`; they never touch the native
   `oninput`.
2. `input-control.component.svelte` forwards `onChange` straight through.
3. `view-field.component.svelte:283` — `onChange={eventBased ? undefined : ...}`,
   and `isEventBasedInput('number')` is `true` because
   `NUMBER_INPUT_TYPES = ['number']` (`input.utils.ts:26`).

So for **every** `number` input in **any** records form, `onChange` is `undefined`
and the spinner calls a no-op. Typing works (`oninput` is wired).

**The worse half:** `handleOnChange` (min/max clamp on native change) and
`handleOnBlur` (out-of-range clamp) also emit only through `onChange`, so they are
dead too — you can type `150` into a `max: 100` field and nothing clamps the form
data. Affects every bounded number field on the platform.

**Proposed fix.** Wire `number` to both channels in `view-field.component.svelte`:
keep `onInput` for per-keystroke typing, stop suppressing `onChange` for number
inputs. Rejected alternatives: synthesising a fake `input` event inside
`handleIncrease` (fabricating `e.target.value` rots); removing `number` from
`NUMBER_INPUT_TYPES` so it flows purely through `onChange` (typing would then only
commit on blur/Enter — risks losing a typed value on save).

Edge cases for tests: double-emit when typing then blurring (idempotent, but
assert it); `max: 0` — `handleIncrease` guards with truthy `max` while
`handleDecrease` uses `isNumber(min)`, so a `max: 0` field is inconsistent today;
`decimalPlace` rounding on increment; the same path inside a repeater item.

Touches shared input plumbing used by every records form — wants a look from
whoever owns records UI.

---

#### Bug 3 — an unbound palette input renders as `text` in Preview

Dragging e.g. **Currency** from the palette creates a placeholder
(`record-form-builder.component.svelte:332`):

```ts
return { type: 'field', field: makeUnboundRef(seq, inputType) }
//    → { type: 'field', field: '__unbound:1:currency' }   // note: no node.inputType
```

The chosen input type lives **only** inside the sentinel string. In Preview,
`resolveField(schema, '__unbound:1:currency')` returns undefined, `nodeInputType`
is undefined, so `inputType` falls back to `defaultInputForType(undefined)` →
**`'text'`**. Meanwhile the Inspector decodes the pending type from the sentinel
(`:226-227`) and displays "Currency" — so the two panels disagree and it reads as
"the input type didn't take".

Correct authoring order, worth documenting for users: create the schema field
first (currency requires `type: number`), place the input, **bind it** in the
Inspector — on bind the node gets a real `field` *and* `inputType` (`:615-622`) —
then Preview renders it properly. Unbound placeholders never persist; the builder
strips them on save, so an input you never bound silently vanishes.

**Proposed fix:** have Preview honour `unboundInputType(field)`, or render an
explicit "not bound yet" placeholder instead of a misleading text box.

---

#### Bug 4 — the builder writes repeater-child input config where the renderer never reads it

`record-form-builder.component.svelte:616-623` and `handleNodeUiChange` write a
repeater child's `inputType`/`props` onto the **node**. But `ViewArray` renders
each item by pointing `ViewField` at `{ item: field.items }` with no
`nodeInputType`/`nodeProps` — item inputs come from
`schema.<array>.items.properties.<leaf>.ui`. So repeater-child edits made in the
visual builder **do not take effect at runtime**.

This is the same renderer truth as records defect 3 (§2), approached from the
builder side. Pre-existing and independent of the MCP work. Until it's fixed,
avoid editing repeater children in the builder.

**Verified safe, related:** saving in the builder does *not* wipe the MCP's
repeater fix. `stripConfigForSave` removes `schema.*.ui` only for refs placed as
form nodes, and `usedRefs` deliberately stops at the `array-field` container
without descending into children — pinned by two tests in
`microstrate/src/components/records/form/views-repeater.test.ts:123`. So
`items.properties.*.ui` survives a UI save.

---

### 4.1 Immediate — decisions blocking me

1. **Approve or reject the four frontend fixes above** (§4.0). Bug 1 is data-loss
   and should probably go first.
2. **`showControls: true` on `share_pct`** — mine, in
   `quiva-records-mcp/test/fixtures/risk-programme.mjs`. Offered to remove it so
   there are no dead +/− buttons while bug 2 is decided; not yet done. Typing
   works either way. Removing it means re-pushing the config.
3. **Confirm or correct the Risk Programme assumptions** (§5 below), then I fold
   in corrections. Two are load-bearing: the `status` enum was invented to fill a
   truncated line in the original spec, and `insurers[]` + `share_pct` is an AI
   restructuring of two separate bullets.
4. **Nothing is committed.** All work is uncommitted in the working tree. Confirm
   whether to branch and commit — see §6 for the file inventory.

### Next work item — quiva-documents (approved, ~1.5–2 days)

**It has the same defect as flows, and it fails silently.**
`sub_templates[].conditions` is documented and *enforced* as json-rules-engine
(`{all:[{fact,operator,value}]}`) at `quiva-documents-mcp/src/documents-docs.js:76`
and `src/validate.js:118`. The engine evaluates it with rule-engine v2:

```ts
// file-generator-service/src/consumer/template-trigger.ts:274
resolveRulesV2({ rules: { trigger: x.conditions }, facts })?.['trigger']?.outcome === true
```

`{all:[...]}` has no `outcome`, so `isRuleCellV2` rejects it, the whole object
becomes the outcome, and `outcome === true` is false → **the sub-template is
silently dropped from the generated document.** Correct form (note
`type/template.ts:64` types `conditions` as `record(string, unknown)`, an object,
so prefer a single expression over an array of cells):

```json
{ "operator": "=", "input": ["@fact:client_region.value", "EU"] }
```

Facts are auto-derived as `` `${key}.value` `` from the trigger payload
(`template-trigger.ts:266`).

**First action: check whether any live template uses `conditions`.** If any use
the `{all:[...]}` form, documents are being generated with missing sections in
production *today* — that is a finding to report, not just a doc fix.

Then: harvest templates → golden gate → validator fix → E2E that triggers the same
template twice so a conditional sub-template is included once and excluded once,
with the `{all:[...]}` form as the negative control.

### Then, in order

| MCP | Effort | Scope |
|---|---|---|
| **quiva-records** (finish) | ~½ day | Round-trip and negative controls are done via the risk-programme E2E. Remaining: decide the `element`/card question above; consider a records `sweep-validate` if config count grows |
| **quiva-agents** | ~1 day | Harvest + golden gate + E2E. Opaque surface: `OutputSchema` (a `field → description` map, **not** JSON Schema), `Tool.Schema`, tool URIs (`bit://`, `mcp://`, `fun://`), knowledge URIs (`kv://`, `obj://`, …), `ContextVariables` (carries a prompt-injection warning — surface it). Validate model ids against `microstrate/static/models.json` rather than a hard-coded list. **E2E may invoke one `claude-haiku-4-5` call — approved.** Negative controls: flat agent payload, unsupported `llm_provider`. Also test the documented-but-untested 409 (subject is an MD5 of the config) |
| **quiva-workspaces** | ~½ day | Ratchet only. Negative controls: space id with a hyphen rejected, task against a missing space 400s. Worth checking whether a board renderer needs presentation fields (the geometry analogue) |
| **shared rule-engine module** | ~½ day | Generate the operator set from `file-generator-service/src/utils/rule-engine/calculating-operations.ts`, shared by flows + documents, with a test that fails when the TS source changes. Today the flows MCP has it hand-transcribed and it will drift |

### Deferred (agreed)

- `quiva-config-studio` repo — everything stays in this repo for now.
- The 13 flows tools these changes never touched (`test_jsonpath`, `search_run_logs`,
  `list_functions`, `list_quiva_endpoints`, `test_eval`, `test_http`,
  `get_workflow_history`, `list_paused_workflows`, `list_errored_workflows`,
  `list_collections`, `create_collection`, `list_node_types`,
  `get_node_type_reference`) are unexercised by the E2E — argued safe, not proven.

---

## 5. Risk Programme assumptions awaiting confirmation

1. **Insurers is a co-insurance panel** — `insurers[]` of `{insurer_name,
   share_pct, policy_number, is_lead}`, rather than a flat insurer list plus one
   `%` field. Shares should total 100 (documented, not enforced — JSON Schema
   cannot express a cross-row sum).
2. **One programme-level `currency`**; money fields reference it.
3. **`subject_type` discriminator** driving two conditionally visible groups.
4. **Conditional relevance by `type`** — renewal date required for
   policy/renewal; premium required for policy; target premium visible for
   info/quote; payment group visible for policy/renewal.
5. **`quote_form_id` is free text**, not a record reference.
6. **Stamp duty and fire levy as fixed fields.** If levies vary enough by state, a
   `{name, basis, amount}` repeater would be better.
7. `status` enum `current / expired / cancelled / superseded` — **not supplied.**
   The original spec line was truncated mid-thought (`status (current / correct`),
   so this enum was invented to fill the gap. Most likely of the seven to be wrong.

Also worth a decision, surfaced 2026-07-29 when auditing all 47 leaves:

8. **20 of 47 leaves are free text, and which fields got enums was an AI call.**
   Plausible candidates for constraining: `coverage_class` (the spec said
   "coverage class/type" — a controlled list?), `insurers[].insurer_name` (usually
   a lookup, not free text), `placed_by` (usually a user reference),
   `asset_details.asset_type`.
9. **`risk_address.country` has no `enum`.** The form constrains it via the
   `country` picker, but the schema accepts any string — the UI and the API
   disagree on what is valid.

---

## 6. File inventory (all uncommitted)

**Modified:** `docs/lessons.md`, `docs/quiva-flows-mcp-playbook.md`,
`quiva-flows-mcp/{README.md,package.json,src/index.js,src/node-docs.js,src/validate.js,test/validate.test.js}`,
`quiva-records-mcp/{package.json,src/index.js,src/validate.js,src/records-docs.js,test/validate.test.js}`

**New:** `docs/{quiva-mcp-handoff.md,quiva-mcp-hardening-plan.md,quiva-mcp-treatment-scope.md,quiva-mcp-architecture.md,quiva-mcp-e2e-test.md,quiva-mcp-e2e-test-flow.json}`,
`quiva-flows-mcp/{src/rules-docs.js,src/geometry.js,src/reference-docs.js,examples/,tools/,test/e2e-staging.mjs,test/e2e-rules-node.mjs}`,
`quiva-records-mcp/{src/examples.js,examples/,tools/,test/e2e-staging.mjs,test/fixtures/}`

**Changed on 2026-07-29** (all inside the files already listed above):
- `quiva-records-mcp/test/fixtures/risk-programme.mjs` — rewritten. `options`
  derived from the schema enum via a `select()` helper; `currencyField` removed;
  repeaters driven by a single `REPEATERS` registry that writes both the
  `items.properties.*.ui` mirror and the node children, so they cannot drift.
- `quiva-records-mcp/src/validate.js` — 6 new form-render lints (§2).
- `quiva-records-mcp/src/records-docs.js` — `form-builder` topic corrected;
  `INPUT_PROPS` and `DEFAULT_INPUT_BY_TYPE` now exported for the validator.
- `quiva-records-mcp/test/validate.test.js` — 54 → 68 checks.
- `docs/lessons.md` — new post-mortem at the top (2026-07-28).

**Nothing was changed under `microstrate/`.** All four frontend bugs in §4.0 are
diagnosis only, pending approval. A regression test for bug 1 was drafted and
deliberately kept out of the repo — its full source is inlined in §4.0.

**Note:** `quiva-records-mcp/.env.example` is untracked and **contains a real
staging API key** (line 9). `.gitignore` covers `.env` but not `.env.example`, so
`git add .` would commit it. Left in place per instruction — blank the value
before committing, and rotate the key.

## 7. Commands

```bash
# flows
cd quiva-flows-mcp
npm test                              # 36 checks incl. golden gate
npm run harvest                       # re-harvest examples/ from the platform
npm run test:e2e                      # live: condition flow + negative control
npm run test:e2e:rules                # live: rules node
node tools/sweep-validate.mjs         # validate every flow on the environment

# records
cd quiva-records-mcp
npm test                              # 68 checks incl. golden gate + form-render lints
npm run harvest                       # re-harvest examples/harvested/
KEEP=1 npm run test:e2e               # live: risk-programme create + round-trip
```

Both E2E scripts spawn a **fresh** `bin/run.sh`, so they always test current code
regardless of what an open session has loaded. `KEEP=1` leaves resources on the
platform; without it they are deleted **and the deletion is verified** (a success
response is not trusted — that is how bug #3 was found).

**Careful with the records E2E:** it uses `config.id` from the fixture —
`risk_programme` — and **without `KEEP=1` it deletes that config on cleanup**,
which would take the live artefact and its record with it. To exercise the fixture
without touching the live config, point it at a throwaway id:

```bash
cat > /tmp/rp-e2e.mjs <<'JS'
import { config as base } from '<abs-path>/quiva-records-mcp/test/fixtures/risk-programme.mjs'
export const config = { ...base, id: 'risk_programme_e2e_tmp', name: 'RP (E2E temp)' }
JS
CONFIG=/tmp/rp-e2e.mjs node test/e2e-staging.mjs   # creates, verifies, deletes itself
```

That is how the 28/28 run on 2026-07-29 was done. To re-push the fixture to the
live config, `PUT /records/config/risk_programme` with
`{id, name, description, schema, views}` (note the route is `/records/config/…`,
singular — `/records/configs/…` 404s), then **read it back and re-validate**
rather than trusting the write response.

---

## 8. Examples for documents / workspaces / agents (2026-07-29, later session)

Goal: give the remaining three MCPs the same treatment flows and records already
had — a harvested `examples/` corpus, `list_examples` / `get_example`, and a
golden gate — plus a live artefact on staging to eyeball.

### 8.0 First, a credentials fix

`quiva-workspaces-mcp/.env` and `quiva-agents-mcp/.env` both held a **bearer JWT
that expired 2026-07-25T09:29:08Z**, so every tool on both servers returned 401.
Both files were copies of `quiva-agents-mcp/.env.example` (the workspaces one
still carried the agents header comment).

The `.env.example` in both says an API key is "insufficient for most agent
tools". That is **only true for writes**: `X-Api-Key` returns 200 on
`GET /workspaces/spaces` and `GET /hub/agent`, and it also worked for every
workspaces WRITE (space, task, comment, reaction — all verified by read-back).
Both `.env` files now use the API key. **Agent writes still need a real JWT** —
that is the one thing left blocked.

### 8.1 quiva-documents — the `conditions` bug is proven, and fixed

§4 predicted that `sub_templates[].conditions` in the documented
`{ all: [ { fact, operator, value } ] }` form is silently dropped. **Confirmed
live**, by generating three documents from one template and comparing the stored
PDFs byte-for-byte (`GET /storage/obj/microstrate-documents/entries` reports
sizes):

| Run | conditions form | condition met? | PDF size | sub-template |
|---|---|---|---|---|
| VIC | `{ operator: '=', input: ['@fact:risk_state.value','VIC'] }` | yes | **46,551 B** | merged ✅ |
| NSW | same | no | **44,582 B** | omitted ✅ |
| wrongform | `{ all: [ { fact, operator, value } ] }` | **yes** | **44,582 B** | **silently dropped** ❌ |

The wrong form produces a byte-identical file to the *excluded* case. No error is
raised anywhere. The v2 form gates correctly in both directions.

**Nothing in production was affected:** all 4 live templates (2 published,
2 draft) have `sub_templates: []`, so no live template uses `conditions` at all.
That is what made the fix safe to ship immediately.

Fixed in this session:
- `src/validate.js` — new `lintConditionsInto`: `{all:…}`/`{any:…}` is now an
  **error** naming the consequence; warns on a missing `operator`/`outcome`, an
  unknown v2 operator, a `{rules:…}` wrapper, and a `@fact:` reference missing
  the `.value` suffix (facts are derived as `` `${key}.value` ``).
- `src/documents-docs.js` — `TEMPLATE_EXAMPLE` and the `sub-templates` topic
  rewritten with the engine truth, the live proof, and a
  `wrong_example_do_not_use` for contrast.
- `src/index.js` — the `sub_templates` param description.
- 8 new tests (31 total).

New files: `tools/harvest-examples.mjs`, `tools/push-example.mjs`,
`src/examples.js`, `examples/harvested/` (2 templates + 4 document shapes),
`examples/authored/certificate-of-currency.json`.

Document examples are PII-scrubbed (signatory emails/names, staff names embedded
in `spaces.FAHUB.<Owner Name>.` storage paths, and HelloSign request ids) and
kept for their **shape** only.

Incidental shape findings worth keeping: a `SENT`/`EXPIRED` signature carries
`request`, `error`, `signed_at`; a `DRAFT` one does not. A signatory whose
rendered email is missing is skipped and `signatures` comes back as **`[]`**, not
`null` — which is how the push script generates documents without sending any
e-signature request.

### 8.2 quiva-workspaces — 2 findings

The validator and docs were in better shape than expected: **all 8 spaces, 19
tasks and 4 comments pass the golden gate unchanged.** Two things came out of the
corpus:

**(a) The board reads presentation fields the API does not require** — the
flow-editor-geometry defect again. Per-field coverage across live spaces:

| field | live coverage | if omitted |
|---|---|---|
| `statuses[].color` | **45/45** | colourless column swatch |
| `statuses[].complete` | **45/45** | no done state on the board |
| `statuses[].order` | 35/45 | ties at 0 (`sortByOrder` does `a.order ?? 0`); the 10 without it are platform-generated system spaces |
| `statuses[].is_visible` | 31/45 | genuinely optional — `is_visible !== false` treats undefined as visible |
| `priorities[].icon` / `icon_type` / `icon_color` | **27/27** | `priorityIconClass()` does `priority.icon_type.replace(...)` unconditionally, so a partial priority **throws** rather than degrading |

`color` and `complete` are set on every live status, so an MCP-authored space that
omits them renders unlike every other space. Not yet enforced — candidate for a
validator warning.

**(b) `asignees` — a misspelled key, and the two task routes disagree.**
`GET /workspaces/space/{id}/tasks` returns the raw stored document; `GET
/workspaces/task/{id}` maps to a typed struct. Live tasks `ALEX-7` and `ALEX-12`
store `asignees` (one "s") and no `assignees`, so the list route shows an assignee
and the detail route shows none. Task update is a DeepMerge, so the misspelled key
persisted silently.

The same typo is in **`hub-service/agents/agents.go:412`**:

```go
Assignees   *[]string `json:"asignees,omitempty"`   // workspacesTask
```

That struct backs `resolveTaskKnowledge` (`task://<taskID>` knowledge URIs). It
only reads and re-marshals — it does **not** write back, so it is not the source
of the two bad records. Its own consequence: an agent given a `task://` knowledge
URI **never receives the assignee list** for a correctly-stored task, and does
receive it for the two mis-stored ones. Origin of the stored typo is unknown; the
only occurrence in the repo is this read-side struct.

Also worth noting: **`task://` is a real knowledge URI scheme** and is missing
from `quiva-agents-mcp`'s `KNOWLEDGE_SCHEMES`, so the agents validator warns on a
scheme the engine supports.

Undocumented links found in live data: `space.tasks.agents[]` /
`space.tasks.default_agent` hold **agent subjects** (workspaces → agents), and
`task.metadata` holds `{ flow_subject, run_id }` (flows human-in-the-loop → the
task it raised). Neither is in the workspaces docs; both are the concrete
cross-service wiring the architecture doc describes abstractly.

New files: `tools/harvest-examples.mjs`, `tools/push-example.mjs`,
`src/examples.js`, `examples/harvested/` (8 spaces + 5 task sets + 3 comment
threads), `examples/authored/renewal-review-board.json`. Harvest scrubs user ids
and emails. 61 checks.

### 8.3 quiva-agents — the validator rejects 150 of 189 live configs

`tools/sweep-validate.mjs` (new, the analogue of the flows sweep that caught the
false positive a 2-config gate missed) run over **all 189 live agent configs**:

| count | validator ERROR | reality |
|---|---|---|
| **148** | `shared "" is invalid` | `""` is the live **default**. Only 41 configs set `private`(21)/`team`(20). **Nothing uses the documented `public`.** |
| **34** | `llm_provider … is not invokable` | `gemini`(12), `openai`(6), `workforce`(1), `""`(15) are all **stored fine**. Only `invoke_agent` rejects them — create and invoke have different rules and the validator conflates them. |
| **16** | `model is required` | 16 live configs have no `model`. |
| 1 | `ai_summary_threshold 0.3 out of range` | 0.3 is live; the documented floor is 0.5. |
| 1 | `agent_type "annie" is invalid` | `agent_type` is not the closed enum `{"", "deep-research"}`. |
| 1 | `name is required` | one live config has no name. |

Plus 2 warnings for `uri://` knowledge URIs — live schemes are `obj://`, `str://`,
`kv://`, **`uri://`**; documented ones omit `uri://` and `task://`. Live tool
schemes are `mcp://` and `bit://` (`fun://` unused).

**Not fixed** — each row is a decision (error → warning? widen the enum?), and
that is the agents hardening item, not the examples task. The golden gate carries
all six as a documented allowlist with the live counts, so the suite is green, the
facts are pinned, and a rule that starts rejecting live configs for any *other*
reason still fails. A companion check fails if an allowlist entry stops
reproducing, so entries cannot go stale.

Recommended fix when approved: allow `shared: ""`; downgrade non-Claude
`llm_provider` to a warning that names `invoke_agent`'s 400; downgrade empty
`model`/`name` and unknown `agent_type` to warnings; widen or warn on
`ai_summary_threshold`; add `uri://` and `task://` to `KNOWLEDGE_SCHEMES`.

**`api_key` is a secret NAME, not a credential.** All 77 live values are
name-shaped (`CLAUDE_API_KEY` 58, `GEMINI_API_KEY` 11, `OPEN_AI` 4,
`ANTHROPIC_API_KEY` 3, `OPENAI_API_KEY` 1), and 107/189 configs set
`api_key_source: "system"` so the platform resolves them. It *can* carry a literal
key — `hub-service/agents/agents.go:175` forwards it as `X-LLM-API-Key` whenever
`api_key_source != "system"` — so the harvester keeps name-shaped values (they are
the lesson) and redacts anything else.

New files: `tools/harvest-examples.mjs` (a trait **spread**, not a prefix — one
config per interesting trait, so re-running preserves coverage rather than files),
`tools/sweep-validate.mjs`, `tools/push-example.mjs`, `src/examples.js`,
`examples/harvested/` (10 configs), `examples/authored/submission-triage-agent.json`.
34 checks.

### 8.4 What is on staging now, and how to check it

Two new artefacts, both named `mcp-verification*` so they are obvious and
deletable. Every claim below was verified by **read-back**, never by the write's
own success response (that is how the `delete_workflow` bug was found).

**A. Workspaces — space `MCP_VERIFICATION_RENEWALS`**

```
Board: https://app.microstrate.io/en/hub/spaces/MCP_VERIFICATION_RENEWALS/tasks
Task : https://app.microstrate.io/en/hub/spaces/MCP_VERIFICATION_RENEWALS/tasks?task=MCP_VERIFICATION_RENEWALS-1
```

Switch to **Board** view. Expect five columns in order — Awaiting Info, In Review,
Referred to Underwriter, Quoted, Bound — each with its colour, **Bound rendering
as the completed column**, the task sitting in In Review with an **Urgent**
priority icon, and one comment carrying an 👀 reaction. Confirmed by read-back:
the lowercase id was uppercased server-side, all 5 statuses kept
`color`/`order`/`complete`, all 3 priorities kept `icon`/`icon_type`/`icon_color`,
and the task id came back server-generated as `{SPACEID}-1`.

Re-run or remove: `node tools/push-example.mjs [--cleanup]` in
`quiva-workspaces-mcp` (cleanup verifies the deletion by re-reading).

**B. Documents — templates `mcp-verification-certificate` + `mcp-verification-terms-vic`, 3 PDFs**

```
Templates : https://app.microstrate.io/en/hub/account?tab=specialization&subtab=documents
PDFs      : https://app.microstrate.io/en/hub/resources/storage/obj/manage?bucket=microstrate-documents
```

> ⚠️ **There is no `/hub/documents` route** — it redirects to the hub. I asserted
> that URL without checking it; corrected 2026-07-29. `find src/routes -ipath
> "*document*"` in `microstrate/` returns nothing.
>
> Templates are edited in the **account Specialization dashboard**:
> `account/+page.svelte` reads `?tab=` (`+page.ts`), renders
> `SpecializationDashboard` for `tab=specialization`, which reads `?subtab=`
> and renders `TemplatesConfigSection` for `subtab=documents`. That component
> calls `listAllTemplates()` against the file-generator API, so both the draft
> and published `mcp-verification-*` templates appear there, filterable by
> Draft/Published.
>
> **Generated PDFs have no document browser at all.** The only UI is the
> object-store manager (`resources/storage/obj/manage?bucket=…`). Note the live
> `alex-test` templates write into `microstrate-workspaces` under
> `spaces.FAHUB.<Owner Name>.<file>.pdf`, which *does* surface in a space's
> **Files** tab (`spaces/[id]/files/[...path]`) — that is a nicer place to land
> output. This example follows the documented default (`output.bucket:
> microstrate-documents`) instead, so its PDFs are storage-manager only. Point
> `output.bucket`/`folder` at a space path if you want them in a Files tab.

```
mcp-verification.certificate-POL-2026-0087-vic.pdf         46,551 B  <- sub-template merged
mcp-verification.certificate-POL-2026-0087-nsw.pdf         44,582 B  <- correctly omitted
mcp-verification.certificate-POL-2026-0087-wrongform.pdf   44,582 B  <- silently dropped
```

Open the VIC and NSW PDFs side by side: VIC should carry the extra sub-template
section, NSW should not. The `-wrongform` one used the documented `{all:[...]}`
form **with the condition met** and is byte-identical to NSW — that is the bug.
The published template has been restored to the correct v2 form.

No e-signature request was sent: the trigger payload omits `insured_email`, so the
signatory is skipped (`signatures: []`). Both templates reuse the DOCX already in
storage (`Sample_Insurance_Certificate _.docx`), so nothing new was uploaded.

Re-run or remove: `node tools/push-example.mjs [--negative-control] [--cleanup]`
in `quiva-documents-mcp`. Cleanup removes the templates; the generated document
records and the PDFs in storage are left in place.

**C. Agents — BLOCKED, needs a bearer token**

`tools/push-example.mjs` in `quiva-agents-mcp` is written and locally validated
but not run: hub-service derives the user from JWT claims on every agent endpoint,
and the API key only covers reads there. With a fresh
`QUIVA_BEARER_TOKEN` in `quiva-agents-mcp/.env` it will create the agent, verify
the round trip, test the documented-but-never-tested **409** (the subject is an
md5 of the config, so an identical create must conflict), optionally invoke it
once with `--invoke` (one `claude-haiku-4-5` call), and on `--cleanup` confirm the
documented hollow-config-instead-of-404 behaviour after delete.

Its UI check URL is `agents/edit/<subject with every "." replaced by "+">`, e.g.
`https://app.microstrate.io/en/hub/agents/edit/ms+hub+config+agent+<uuid>`.
**Not** `/en/hub/agents` — that path has a `+page.ts` but no `+page.svelte` in the
repo (`git ls-files "microstrate/src/routes/*agents*"` returns only the loader and
the `edit/[subject]` pair), so do not send anyone there. Agents are labelled
**"Assistants"** in the UI.

### 8.4.1 UI route lookup, since I got one wrong

`/hub/documents` and `/hub/agents` were both asserted from the service names
rather than checked. The reliable method is to look for the route file:

```bash
cd microstrate
find src/routes -ipath "*<thing>*"            # does a route exist at all?
ls "src/routes/[lang]/[application]/(protected)/(with-layout)/<path>/"   # +page.svelte present?
```

A directory with only `+page.ts` is not a page. Verified this way, the URLs used
in this document are:

| Artefact | URL | Verified |
|---|---|---|
| Records config / form builder | `/en/hub/records/configs[/<id>/forms/<formId>]` | `records/configs/+page.svelte` |
| Flow editor | `/en/hub/flows/<subject with . -> +>` | `flows/[subject]/+page.svelte` |
| Space board | `/en/hub/spaces/<ID>/tasks[?task=<TASK-ID>]` | `spaces/[id]/tasks/+page.svelte`, and the API returns exactly this in `task.url` |
| Document templates | `/en/hub/account?tab=specialization&subtab=documents` | `account/+page.svelte` -> `SpecializationDashboard` -> `TemplatesConfigSection` |
| Generated files | `/en/hub/resources/storage/obj/manage?bucket=<bucket>` | `resources/storage/obj/manage/+page.svelte` |
| Agent ("Assistant") | `/en/hub/agents/edit/<subject with . -> +>` | `agents/edit/[subject]/+page.svelte` |

Subjects are URL-encoded by replacing every `.` with `+` (`dotString = '+'` in
`microstrate/src/utils/transform.utils.ts`).

### 8.5 Also corrected

`docs/quiva-mcp-architecture.md` still documented the **disproven**
`{ if, then, else }` flows rules syntax in its "Shared concepts" section — the
exact shape the flows work established never existed. Replaced with the v2 branch
array, plus a note distinguishing the three rule dialects that look alike: flows
branching (`{condition, outcome}` array), records form-rules (json-logic), and
documents `conditions` (a single v2 expression, no `outcome` wrapper).

### 8.6 Commands

```bash
# documents
cd quiva-documents-mcp
npm test                                   # 31 checks incl. golden gate
npm run harvest                            # re-harvest templates + document shapes
node tools/push-example.mjs                # create + publish + generate 2 documents
node tools/push-example.mjs --negative-control   # + reproduce the conditions bug
node tools/push-example.mjs --cleanup      # remove the templates (verified)

# workspaces
cd quiva-workspaces-mcp
npm test                                   # 61 checks incl. golden gate
npm run harvest                            # re-harvest + print board-field coverage
node tools/push-example.mjs [--cleanup]    # push/remove the verification space

# agents
cd quiva-agents-mcp
npm test                                   # 34 checks incl. golden gate
npm run harvest                            # re-harvest the trait spread
npm run sweep                              # validate ALL 189 live configs (exits 1 while findings are open)
node tools/push-example.mjs [--invoke] [--cleanup]   # NEEDS A BEARER TOKEN
```

---

## 9. All five staging artefacts — one URL list (2026-07-29)

Every artefact below was confirmed live at the time of writing, and every route was
confirmed to have a `+page.svelte` (see §8.4.1 for the lookup method). Subjects are
URL-encoded by replacing every `.` with `+`.

### 1. quiva-flows — flow `mcp-verification-rules-node-ui`

Collection **Test Flows** (`805092869`), flow `1512734875`. 6 nodes, published and
draft both present.

```
Editor (draft) : https://app.microstrate.io/en/hub/flows/ms+hub+config+workflow+draft+805092869+1512734875
Published      : https://app.microstrate.io/en/hub/flows/ms+hub+config+workflow+805092869+1512734875
Collection     : https://app.microstrate.io/en/hub/flows?collection=ms.hub.config.collection.workflow.805092869
```

**Check:** six nodes stepping left-to-right with a fork after `GATE` (x = 0, 296,
592, 592, 888, 888) — before the geometry fix they stacked at the origin. Click
`GATE` → **Rules** tab → switch **`Code Editor`** to **`Conditions`**: two panels,
`IF` and `ELSE`. Click `FORM_RULES` for three rules using all four operators.
Full detail in §3A.

### 2. quiva-records — record config `risk_programme`

27 schema fields, 2 forms, plus 1 record.

```
Config      : https://app.microstrate.io/en/hub/records/configs/risk_programme
Default form: https://app.microstrate.io/en/hub/records/configs/risk_programme/forms/default
Quote form  : https://app.microstrate.io/en/hub/records/configs/risk_programme/forms/quote_capture
Config list : https://app.microstrate.io/en/hub/records/configs
```

**Check:** the `/forms/<id>` URLs open the form **builder**. Click the **Preview**
tab — the Edit tab has `pointer-events: none` on fields, so dropdowns cannot be
opened there at all. Every dropdown must actually drop down, including Basis
inside the Coverage limits and Excesses repeaters. Expect two known frontend bugs,
not config regressions: the **Type** dropdown is missing entirely (§4.0 bug 1) and
the `% of insured amount` +/− buttons do nothing (§4.0 bug 2). Full detail in §3B.

> ⚠️ Do not press **Save schema** on this config — §4.0 bug 1 deletes the field
> named `type` and saving persists the deletion.

### 3. quiva-documents — templates `mcp-verification-certificate` + `mcp-verification-terms-vic`

```
Templates : https://app.microstrate.io/en/hub/account?tab=specialization&subtab=documents
PDFs      : https://app.microstrate.io/en/hub/resources/storage/obj/manage?bucket=microstrate-documents
```

**Check:** Account → Specialization → Documents lists both templates (filter
Draft/Published). In the storage manager, find the three PDFs and compare sizes:

| file | size | meaning |
|---|---|---|
| `mcp-verification.certificate-POL-2026-0087-vic.pdf` | 46,551 B | v2 conditions, condition met → sub-template merged |
| `mcp-verification.certificate-POL-2026-0087-nsw.pdf` | 44,582 B | v2 conditions, condition unmet → correctly omitted |
| `mcp-verification.certificate-POL-2026-0087-wrongform.pdf` | 44,582 B | documented `{all:[…]}` form, condition MET → silently dropped |

There is **no** `/hub/documents` route (§8.4.1).

### 4. quiva-workspaces — space `MCP_VERIFICATION_RENEWALS`

```
Board : https://app.microstrate.io/en/hub/spaces/MCP_VERIFICATION_RENEWALS/tasks
Task  : https://app.microstrate.io/en/hub/spaces/MCP_VERIFICATION_RENEWALS/tasks?task=MCP_VERIFICATION_RENEWALS-1
```

**Check:** switch to **Board** view. Five columns in order — Awaiting Info, In
Review, Referred to Underwriter, Quoted, Bound — each with its colour, **Bound as
the completed column**. The task sits in In Review with an **Urgent** priority
icon and carries one comment with an 👀 reaction.

### 5. quiva-agents — agent `Submission Triage (MCP verification)`

Subject `ms.hub.config.agent.d2e1b8d4-1dda-329c-b10e-5662835425ef`.

```
Editor : https://app.microstrate.io/en/hub/agents/edit/ms+hub+config+agent+d2e1b8d4-1dda-329c-b10e-5662835425ef
```

**Check:** agents are labelled **"Assistants"**. Confirm behaviour, provider
`claude` / model `claude-haiku-4-5`, the three `output_schema` fields, and
`llm_config { temperature: 0, max_tokens: 16000 }`. `/en/hub/agents` is not a page
(§8.4.1). Verified live: created, 409 on an identical config, full round-trip
read-back, and **one successful `claude-haiku-4-5` invoke**.

### Removing them

```bash
(cd quiva-workspaces-mcp && node tools/push-example.mjs --cleanup)
(cd quiva-documents-mcp  && node tools/push-example.mjs --cleanup)   # templates only
(cd quiva-agents-mcp     && node tools/push-example.mjs --cleanup)
# flows:   delete_workflow with the DRAFT subject (removes both versions — §2 bug 3)
# records: delete_record_config id=risk_programme (delete the record first)
```

## 10. Two more findings from invoking the agent (2026-07-29)

Both came out of running `quiva-agents-mcp/tools/push-example.mjs --invoke` once
the bearer token was available. Both are silent at create time.

### 10.1 `llm_config.max_tokens <= 8000` makes invoke fail — 8 live agents affected

```
400 EXECUTION_ERROR: thinking_tokens must be less than max_tokens (thinking=8000, max=1024)
```

`bellerophon-workforce/cmd/agent-service/service/process_invoke.go:893-902`: when
`ENABLE_NATIVE_THINKING` is on and the model supports thinking, the service
**injects** `thinking_enabled=true` and `thinking_tokens=8000` into any field the
caller left nil — and never reconciles that budget against `max_tokens`.

The config stores and reads back perfectly; it only fails at invoke. `1024` and
`2048` are exactly the values a person would pick.

**8 of the 144 live configs carrying an `llm_config` are in this state and cannot
currently be invoked:** Anthropic Model Selector (1000), Decision-Making Assistant
×3 (1024), email-priority-organizer (2000), JavaScript Code Review Agent (2000),
weather-historian (2000). Worth telling whoever owns those.

Three ways out: raise `max_tokens` above 8000; set `llm_config.thinking_tokens`
below `max_tokens` explicitly (injection only fills nil fields); or omit
`max_tokens`. Now a validator **warning** naming all three (4 new tests).

### 10.2 The invoke result is markdown-fenced, so `JSON.parse` throws

Both this MCP and quiva-flows-mcp said the result was a JSON-encoded string to be
`JSON.parse`'d. **That advice fails as written.** Observed twice live:

````
```json
{
  "class_of_business": "Builders Risk",
  "in_appetite": true,
  "reason": "Sum insured of 2,500,000 AUD is below the 50,000,000 AUD threshold..."
}
```
````

A bare `JSON.parse` on that throws. Extract the object first:
`JSON.parse(String(result).match(/\{[\s\S]*\}/)[0])`.

Corrected in `quiva-agents-mcp/src/agents-docs.js` (new gotcha) and
`quiva-flows-mcp/src/node-docs.js:42` (the top-level gotcha said just "JSON.parse
them"). `node-docs.js:131` already carried the correct regex-extract workaround, so
the two statements in the flows MCP disagreed with each other.

### 10.3 One more credential note

`quiva-agents-mcp/.env` must keep `QUIVA_API_KEY` **empty**.
`QuivaClient.authHeaders()` checks `apiKey` first, so a key set there silently
shadows the bearer token — and agent WRITES need the JWT claims. The commented-out
key is left in the file above the empty assignment with that explanation.

---

## 11. The workspaces/records release (2026-07-29) — what changed and what it broke

Source: `workspace-changes.md`, cross-read against git. The three commits that
matter are `9ff04e387` (Workspaces new endpoints), `d21d91291` (Flow record
trigger) and `cf10d4077` (vertical documents). Everything below was probed live
against `https://api.microstrate.io` unless it says otherwise.

### 11.1 What actually changed, by service

| Service | Change | MCP impact |
|---|---|---|
| workspaces-service | `TaskAction` subsystem (new `handler/task_actions.go`) | **quiva-workspaces-mcp** — 2 new tools |
| workspaces-service | `time_tracking` on `Task` + `UpdateTaskRequest` | **quiva-workspaces-mcp** — validator, docs, example |
| workspaces-service | `createTask` fills `status` from the space's `default_status` | **quiva-workspaces-mcp** — behaviour change, documented |
| workspaces-service | `ClientProfile` + `POST /workspaces/client` | inventoried, not exposed (writes a space AND a `Client` record) |
| workspaces-service | approvals + files/folders routes opened on the gateway | inventoried, not exposed |
| records-service | `validate`, `completed`, `test_flow` on record write | **quiva-records-mcp** — 2 tools, 2 new reference topics |
| records-service | `RepublishRecord` → `hub.trigger.record.<config>.<id>` | **quiva-flows-mcp** — new trigger type |
| hub-service | record-trigger dispatch in `StartSubscriber` | **quiva-flows-mcp** — validator fix |
| hub-service | `session-member.go` generic-type fix | none (internal, chat sessions) |
| microstrate | new `/[lang]/[application]/documents` route | corrects a URL claim in §8.4.1 |
| microstrate | approvals moved from file-generator to workspaces-service | documents MCP unaffected (no backend change) |

`file-generator-service` has **no** diff in this range, so the documents MCP's
API surface is untouched.

### 11.2 Task actions are write-only — a gateway misroute

The highest-value finding. `GET /workspaces/task/{task_id}/action` is mapped at
the **write** resource `microstrate.workspaces.put.task-action`, so it invokes
`AddTaskActionHandler` and answers `400 "description is required"` for every
call. Verified live.

`ListTaskActionsHandler` exists — `workspaces-service/handler/task_actions.go:94`,
registered as `get.task-actions` in `service/service.go:64` — but no gateway
mapping points at it, so it is unreachable. `get.task-actions` appears nowhere in
this repo outside that registration.

Consequences:

- A task action cannot be listed, counted, or swept.
- The write handler responds with **your request echoed back**
  (`response.SuccessWithBody(request, body)`), not the stored aggregate. With no
  read route, a task-action write is the one operation in this programme that
  **cannot follow the read-back rule** — including whether a partial write merges
  or replaces, which stays unknowable.
- No component in `microstrate/src` reads task actions, so an action written today
  is invisible in the UI too.

**Fix:** repoint the GET mapping at `microstrate.workspaces.get.task-actions`.
`tools/push-example.mjs` asserts the 400 still happens and tells you what to
update when it stops.

Verified live: `PUT` 200 · `GET` 400 · `DELETE` 200 `{message:"success"}` ·
`DELETE` unknown id 404 `"resource not found"` · `PUT` on a nonexistent task 404
`"task not found"`. `description` is required on **every** write, including one
that only flips `done`.

### 11.3 `time_tracking` merge semantics — all four cases proved

| PATCH body | Result |
|---|---|
| `time_tracking` omitted | untouched |
| `time_tracking` present, **no** `logs` key | existing logs **preserved** |
| `"logs": []` | every log **cleared** |
| `"logs": [ ... ]` | array **replaced wholesale**, never appended |

The second row is the interesting one. `TimeTracking.Logs` has no `omitempty`, so
a body without `logs` marshals as `"logs": null` — which looks destructive and is
not. I predicted data loss from the struct and **the live test disproved it**; the
comment I had already written was wrong and was corrected.

The fourth row is the real trap: adding one entry is read-modify-write, so
`update_task` warns and the validator warns.

Every `TimeLog` field is client-supplied — the backend generates no `id`, stamps
no `created_at`, and does **not** fill `user` from the token. Totals, remaining,
progress and progress colour are all derived in the browser
(`task-time-tracking.utils.ts`, Jira conventions 1w = 5d, 1d = 8h) and must never
be sent.

Corpus sweep now reports it: **3/41 live tasks** carry `time_tracking`, and
`ALEX-4` is a genuine UI-created log (`time_log_<uuid>`, ms-precision timestamps),
which is what validates the authored example's shape.

### 11.4 `default_status` on create — a behaviour change

`createTask` now fetches the space (`GetAggregate`) instead of only checking it
exists (`SubjectExists`), so it can fill `status` from `space.default_status`.
Verified: `POST {title, space_id:"MCP_VERIFICATION_RENEWALS"}` came back
`status: "awaiting_info"`. Only applies when `space_id` is set. A status-less task
used to sit outside every board column; it now lands in the default one.

Live: `0/41` tasks have no status, and `7/9` spaces define a `default_status`.

### 11.5 The record trigger breaks the flows validator

`records-service` publishes `hub.trigger.record.<config_id>.<record_id>` and
hub-service matches trigger nodes by **glob on the node subject**:
`ms.hub.config.workflow-node.*.*.record.<config_id>`
(`service/service.go` `recordTriggerNodeSubject`). A node subject is the flow
subject with `.workflow.` → `.workflow-node.` plus `.` + `node.id`.

So **the trigger node's id must be literally `record.<record_config_id>`** — which
is exactly what the editor writes (`trigger-record.component.svelte:113`). That id
contains a dot, which `hub-service validate.ValidateID` rejects and which
`quiva-flows-mcp`'s validator was rejecting as an error.

This is the §0 defect class again: the tooling was checked against the spec, not
against what the platform actually stores. Fixed — the id error is now a **warning**
when `node_type` is `trigger` and `trigger_type` is `record`, and it tells you to
send with `server_validate=false`. A dotted id on any other node is still an error.

Two more traps now documented:

- The glob has exactly two wildcards, so it matches **published** node subjects
  only. A draft carries an extra `.draft.` token and never matches — a record
  trigger on an unpublished flow does nothing, silently.
- `trigger_type` was documented as `"manual" | "schedule" | "webhook" | "embed"`.
  hub-service also dispatches on `record`, `object-store` and `email`
  (`data.TriggerType*`). All three are now in the reference.

### 11.6 Records: `validate: false` and the opt-in trigger

- `validate: false` **skips schema validation entirely**. Verified: a create
  carrying only `{"not_in_schema":123}` 400s by default and returns 200 with
  `validate:false`, stored verbatim. Nothing marks such a record afterwards. The
  tool now returns an explicit warning alongside the result.
- Record events are **opt-in**: nothing publishes unless the write sets
  `completed: true` or passes `test_flow`. A plain create is silent.
- `completed` is **stored on update** (`existing.Completed` is assigned) but
  **not on create** — so the field shows on later reads after an update and not
  after a create-with-completed.
- The create response is the **request struct**, not the stored record: it echoes
  `validate` and always carries `test_flow: null` (no `omitempty`). Neither is
  stored.
- `test_flow: { subject, run_id }` is create-only and needs **both** fields, or
  hub-service falls through to the normal trigger lookup — a half-filled
  `test_flow` silently behaves like `completed`.

### 11.7 An observability gap: run logs miss runs that definitely happened

I could not confirm the record trigger end to end, and the blocker is the
instrument rather than the feature. A create with `test_flow` returned 200 and
echoed the payload, but no run surfaced. Then, as a control, I ran the same flow
**manually with `await: true`** — it succeeded and returned
`tracking_id: ms.hub.run.a8da44ac-…805092869.1512734875`. **That run does not
appear in `POST /hub/run-logs/search` either**, and
`GET /hub/workflows/{c}/{f}/history` lists config versions, not runs.

So there is currently **no read channel for an asynchronously-triggered run**, and
the flows MCP instruction "Debug with search_run_logs" does not hold for at least
some runs. The record-trigger docs are marked source-derived, not observed.

Worth a look by someone who can read hub-service logs. Open question, not a
delivered fix.

### 11.8 Corrections to earlier sections

- **§8.4.1 URL table:** `/en/hub/documents` **now exists** (added today in
  `cf10d4077`) at `[lang]/[application]/(protected)/(with-layout)/documents`. It
  is the **client-facing signer portal**, listed as "Docs" in the *client* sidebar
  menu (`$isClientApp$`), not the templates admin page. The §9 documents URLs
  (`/account?tab=specialization&subtab=documents` for templates, the storage
  bucket for PDFs) remain the right ones for checking template artefacts.
- **Earlier claim "nothing is committed":** stale. The programme is committed as
  `a542eeaff` … `a4bc45996`.

### 11.9 A PII leak the harvest sweep caught

The workspaces harvest redacted user **ids** and emails but not the `name` inside
`time_tracking.logs[].user`, so a colleague's name landed in a harvested example
on the first run. Fixed with a shape-matched rule: an object under a `user`-ish
key whose keys are exactly `{id, name}` is a user snapshot and both fields are
redacted. Space/status/priority `name` values are untouched — verified both ways.

This is the same failure as the documents harvest (§8.2): the sweep knew about one
carrier of a person's identity and not another.

### 11.10 State

261 checks pass across the five suites, 0 failures — flows 41, records 71,
documents 31, workspaces 83, agents 38 (up from 234).

`MCP_VERIFICATION_RENEWALS` now also demonstrates the new surface:

- `MCP_VERIFICATION_RENEWALS-1` — 2h estimate, 1h30m logged over two entries, one
  task action (invisible, see §11.2)
- `MCP_VERIFICATION_RENEWALS-3` — created with **no** `status`, sitting in
  Awaiting Info, proving §11.4

`tools/push-example.mjs` is now re-runnable (it reuses the space, task and comment
instead of creating a new one each run) and asserts all four `time_tracking` merge
cases plus the task-action 400.

**Not done, and why:** files/folders (7 routes), file approvals (8) and client
folders (1) are live on the gateway but not exposed as MCP tools. Each is a
subsystem rather than a task/space operation, the approvals surface overlaps
quiva-documents-mcp, and `POST /workspaces/client` writes into both a space and
the `Client` record config so it needs a throwaway space to exercise safely. They
are inventoried with per-route notes — marked PROBED where verified — in
`quiva-workspace.json` under `x-gateway-routes-not-in-this-spec` and in
`get_workspaces_reference("endpoints").not_exposed`. Say the word and they get the
same treatment.

### 11.11 Record-trigger flow artefact (added after the first review)

`quiva-flows-mcp/tools/push-record-trigger.mjs` creates and publishes
**`mcp-verification-record-trigger`** in collection `805092869` — the artefact that
was missing when §11.5 was written (the validator was fixed, but no flow existed
to look at).

- Published: `ms.hub.config.workflow.805092869.4074260964`
- Trigger node id: `record.risk_programme` (rule 1 — not a free choice)
- Wired into an eval node echoing `$.trigger`, so the run output shows what the
  trigger delivered

Three things it proves live, by assertion:

1. The local validator accepts the dotted id and warns about server validation.
2. **The server really does reject it** — the same config posted with
   `validate=true` is refused, so `validate=false` is mandatory, not cautious.
3. The published node subject
   `ms.hub.config.workflow-node.805092869.4074260964.record.risk_programme` has
   exactly the four segments the dispatch glob expects. A draft has five and can
   never match.

**Still not observable.** `--fire` writes a `risk_programme` record with
`completed: true`, and no run appears in `POST /hub/run-logs/search`. That index
looks *frozen* rather than merely lagging: its newest entry was unchanged across
the whole session, including after a manual awaited run that definitely executed
and returned a `tracking_id`. So §11.7 stands and is now better characterised —
the problem is the run-log index, not the record trigger. Confirming a triggered
run needs the flow's run/monitor view in the UI or hub-service logs.

Record `RDSOo2hMij` is left in `risk_programme` as the triggering write.

---

## 12. Form elements (`new-form-creator.md`) — the MCP was telling agents the opposite

`new-form-creator.md` (1031 lines, vs 417 for the old `form-creator.md`) documents a
node kind the records MCP did not know about: `{ type: "element", element: "<kind>",
props, children? }` — headings, paragraphs, notes, links, alerts, and the two
containers card and card-collapsable.

### 12.1 The reversal

`quiva-records-mcp/src/validate.js` was **actively warning against the thing the new
spec mandates**:

> `…has view node type "element" with children, but the records form renderer only
> branches on "grid", "table" and "array-field" — anything else falls through to
> the FIELD renderer, which IGNORES children. Its N child node(s) will NOT render.`

That was **true when written and is false now**. `record-view-renderer.component.svelte`
gained an `{:else if view.type === 'element'}` branch (line 73) that hands the whole
node to the new `view-element.component.svelte` (511 lines, added in this release).
An agent following the MCP would have refused to build the form the spec asks for.

§0's defect class, third instance: tooling checked against the spec of the day and
never re-checked against the renderer.

### 12.2 Where the three sources disagree

The spec is written for an authoring agent. The builder catalog
(`element-catalog.config.ts`) gates the **editor UI**. The renderer
(`view-element.component.svelte`) gates **runtime**. They do not agree, and runtime
is what a stored config actually does. All three read directly, not inferred:

| Divergence | Runtime | Builder / spec | Verdict |
|---|---|---|---|
| `text-note` alignment | reads `props.align` | catalog's prop editor writes `props.textAlign` | **FRONTEND BUG** — aligning a note in the UI does nothing. Author `align`. `text-heading`/`text-paragraph` really do use `textAlign`. |
| `visible` on `card` / `card-collapsable` | both branches wrapped in `{#if !ruleState.visible}` — it works | catalog's `allowedRuleProperties` omits `visible` | Safe to author; the builder's Rules tab will not offer it. |
| `visible` on `array-field` | renderer passes field/children/props to `ViewRepeater` and **never** `rules` — inert | the spec claims the repeater supports `visible` | **Spec is wrong.** Put the rule on the enclosing grid row. |

A fourth, smaller one: `card-collapsable` lists `borderRadius` in its rule targets
but not in its editable props.

### 12.3 The spec caught two errors in *our* prop table

Worth recording because it went the other way for once. The showcase example
tripped two warnings from the MCP's own `INPUT_PROPS`, and on checking the input
components the **spec was right and the MCP was wrong**:

- `number` accepts `step` — `input-control.component.svelte:166` declares it and
  passes it to `InputNumber` (line 661), which uses it for the spinner and forwards
  it to the native input.
- `slider` accepts `decimalPlace`, `showControls`, `showIndicatorMin`,
  `showIndicatorMax` — all declared on input-control and passed straight through
  (lines 748-757).

Both tables fixed. `slider` still cannot take `step` (it derives one from
`decimalPlace`), so that stays out.

### 12.4 Corpus sweep

Across every bundled harvested + authored config (2026-07-30): **211** `field`,
**158** `grid`, **46** `""`, **17** `table`, **4** `array-field`, **1** `element`.

That one element is an `element: "card"` in the live `sc8DhU6CEXh4gkJPnS_Le` config,
correctly shaped with grid-row children. **It did not render before this release and
does now** — that form silently gained a card it had been missing. It is now the
golden gate for element support.

**Zero** configs use `type: "element"` without an `element` kind. That shape would
now render *nothing* (view-element derives `kind` from `node.element` and its branch
chain has no final `else`), where previously it degraded to a field. Nothing live is
affected, but the validator warns because the failure is invisible. An earlier
comment in the validator claiming that live config used the kindless shape was
wrong and has been corrected.

### 12.5 What changed

- **`src/validate.js`** — the stale rejection replaced with real element validation:
  kind whitelist, container-vs-leaf children rules, per-kind prop and rule-property
  whitelists built from one catalog, value-token checks, the empty-content and
  empty-`href` warnings, `helpText`-must-be-an-object, and named corrections for the
  near-miss prop keys (`textAlign` on a note, `text` where `markdown` is meant,
  `title` on a plain card, `defaultCollapsed` vs `defaultOpen`).
- **`src/records-docs.js`** — `ELEMENT_CATALOG` / `ELEMENT_KINDS` /
  `ELEMENT_CONTAINERS` / `ELEMENT_VALUE_TOKENS`, a new `form-elements` reference
  topic carrying the divergence table, an `element` entry and `structural_rules` in
  the form-builder guide, three new gotchas, and the input-type list split into
  `INPUT_TYPES_EXTENDED_USABLE` (markdown/password/secret — renderer-backed, just
  absent from the builder dropdown) vs `INPUT_TYPES_AVOID` (the twelve the spec
  forbids, now warned on).
- **`examples/authored/form-elements-showcase.json`** — all seven kinds, both
  containers, every rule-driven element property, with the divergences and corpus
  counts recorded inline.
- **`tools/push-form-elements.mjs`** (`npm run push:elements`) — pushes and verifies
  by read-back, including that the note kept `align` and not `textAlign`, that
  `helpText` is still an object, that container children are all grids, and that the
  config **as returned by the server** still passes the validator (the service stores
  `views` as opaque `[]map[string]any` and validates nothing inside it).

Records suite: 71 → **93** checks. All five suites green: flows 41, records 93,
documents 31, workspaces 83, agents 38 — 286 total, 0 failures.

### 12.6 Staging artefact

```
https://app.microstrate.io/en/hub/records/configs/MCP_FORM_ELEMENTS/forms/default
```

Use the **Preview** tab. Behaviour to check is listed in the example's
`how_to_verify_on_staging` and printed by the push script — including one thing
expected to look broken: changing the note's alignment in the inspector does
nothing, which is §12.2's frontend bug.

---

## 13. Verticals: the folder/file surface and the `crm` skeleton (2026-07-31)

**Goal:** stand up a new vertical (`crm`) as a reviewable folder tree in git that
mirrors the `VERTICAL` template space on staging, so MCP-authored configs can be
pushed to it and deployed into accounts.

Three phases were agreed. **Phase 0 and Phase 1 are done. Phases 2 and 3 are not
started.** Nothing is committed — the whole session is in the working tree (§13.8).

### 13.0 The deployment contract — read this first

`accounts-service/accounts/updateaccount.go` `deployVerticals` is the **only**
consumer of the `VERTICAL` space (the entire engine references it in two files,
one of which is the constant). It fires from an account update when `verticals` is
set, as `go deployVerticals(...)`.

It lists `spaces.VERTICAL.*`, skips `*.metadata.json` / `*.__meta__.json`, takes
**the first path segment after `spaces.VERTICAL.<vertical>.`** as the config type,
and forwards the file bytes verbatim to one of exactly six endpoints:

| Folder (exact) | Endpoint | Transform |
|---|---|---|
| `assistants` | `microstrate.hub.post.agent` | must be `{config:{…}}`; `config.shared` **forced** to `"team"` |
| `document_templates` | `microstrate.file-generator.post.template` | verbatim |
| `flows` | `microstrate.hub.post.workflow` | collection auto-created; `collection` + `auto_publish:true` injected |
| `meeting_templates` | `microstrate.recall.post.summarization-template` | verbatim |
| `record_configs` | `microstrate.records.post.config` | verbatim |
| `spaces` | `microstrate.workspaces.post.space` | verbatim |

Rules that bite, all source-verified:

- **The folder name is the routing key.** An unrecognised name is `continue`d —
  no error, no log line. `record_config` instead of `record_configs` deploys
  nothing and says nothing.
- **`SHARED` is always appended** (`verticals = append(verticals, "SHARED")`).
  That is how every account gets the `Client` record config.
- **Delta-only.** Only verticals *not already* on the account deploy. Re-adding an
  existing one does nothing; redeploy means remove, save, re-add.
- **No dependency order.** Files deploy in index-listing order, so a space
  referencing `Client` can be created before `Client` exists.
- **Only observability** is the stream
  `microstrate-accounts.<account_id>.deploy-verticals`, one message per file with
  `{name, vertical, config_type, subject, status, error}`.
- Flow collection name = the vertical id split on `_`, first letter upper-cased
  only (`util.CapitalizeFirst`). So **`crm` yields a collection named "Crm"**, not
  "CRM". No override exists. Accepted knowingly.

### 13.1 `record_config_ids` is the LEGACY key — corrects the original instruction

`microstrate/src/components/spaces/records/space-record-configs.utils.ts:12`:

```ts
if (space.record_configs) return space.record_configs
return (space.record_config_ids ?? []).map((id) => ({ id }))
```

`record_configs: [{id, form_id?}]` is current and **wins on read**;
`record_config_ids: string[]` is only consulted when `record_configs` is absent,
and `withRecordConfigs` **deletes** it when persisting from the UI.

So adding a config to `record_config_ids` alone, while `record_configs` exists, is
silently ignored. **Write both, identically.** Both live space configs
(`fahub.json`, `ibhub.json`) do exactly that, which is why they work. Now a
validator warning when they disagree, plus a golden-gate assertion that the live
pair agree.

### 13.2 Phase 0 — the file/folder surface (DONE)

`POST /workspaces/files/folder` was live on the gateway but **never probed and not
an MCP tool**; the config-file write route was not established at all. Both now
are, live.

| Operation | Route | Notes |
|---|---|---|
| list index | `GET /workspaces/files?space_id=&subfolder=&search=&exact=` | the index, not the bucket |
| create folder | `POST /workspaces/files/folder` `{space_id, subfolder?, folder, full_path?, metadata?}` | `subfolder` is the PARENT prefix. Returns **no body**. 409 if it exists |
| read content | `GET {base}/api/default-storage/object/{bucket}/{key}` | different URL root, **absent from `quiva-endpoints.json`** |
| write content | `POST` the same URL | raw bytes; returns `{name,size,digest,…}` |

Bucket `microstrate-workspaces`. An API key suffices for all four. Writing an
object **self-registers** in the index — `/workspaces/files/file-record` and
`/sync-files` are repair paths, and the UI never calls them.

**New tools (25 → 29):** `list_files`, `create_folder`, `read_file`, `write_file`.
**New validator kinds:** `folder`, `file`. **New reference topics:** `files`,
`verticals`. **Tests 296 → 356**, including a golden gate over every live
`VERTICAL` key.

Four things a source read alone would have got wrong:

1. **The folder marker is `__meta__.json`, not `.metadata.json`** — renamed *and
   migrated in place* by evari-olympus `3a7ab968b` (#1291) on 2026-07-31. Watched
   change mid-session. `accounts-service` skips both suffixes.
2. **An index entry's `name` is frequently EMPTY** while its `subject` is correct.
   The subject is `ms.workspace-files.` + one base64 `RawStdEncoding` segment per
   path segment; the engine decodes it in this case itself
   (`DeleteFolderHandler` → `transform.ObjKeyUnsafe`). See §13.4 — this is the
   important one.
3. **The digest is base64URL, not base64.** `SHA-256=<hash>` with `-`/`_`.
4. **Indexing is asynchronous** (0.5s–minutes). Since `deployVerticals` reads the
   index, push-then-immediately-deploy silently deploys a subset.

**Delete is deliberately NOT exposed.** Source-derived and unverified: query
params not body, recursive, soft (copies to a trash bucket), hard-requires a JWT
(unlike create), and a partial failure returns 400 while keeping what it removed.
Documented in `get_workspaces_reference("files")`. Reason: `delete_workflow`
already silently orphaned every draft it "deleted" while returning success.

### 13.3 Phase 1 — the tree (DONE)

New top-level `verticals/` in the repo. **21 folders on staging, 21 in the repo,
zero difference either way** (verified by comparing both trees).

```
verticals/
├── README.md            the path rule, the seven folders, deploy semantics
├── SHARED/record_configs/
├── financial_advisor/   (6)
├── insurance_broker/    (2)
├── uig/                 (stub)
└── crm/                 assistants document_templates flows meeting_templates
                         record_configs spaces specs
```

One path rule both directions:

```
verticals/<vertical>/<category>/<name>.<ext>
   ⟷   spaces.VERTICAL.<vertical>.<category>.<name>.<ext>
```

`.` is the hierarchy separator, so **no path segment may contain a dot**. Markers
are not committed (recreated on push); empty dirs carry `.gitkeep`.

**`specs` is the seventh folder and is deliberately non-deploying.** It holds the
markdown brief a vertical was built from. It is *inside* the vertical (agreed
after discussion) so one path rule covers everything and the brief travels with
what it describes. Note it is **one** layer of protection rather than two: a file
at the VERTICAL root never matches the vertical prefix, whereas one inside a
vertical does and is stopped only by the config-type table. If a `specs` config
type were ever added upstream, spec markdown would start being POSTed.
`VERTICAL_NON_DEPLOYING_FOLDERS = ['specs']` records the intent, the validator
stays quiet on it, and the golden gate accepts "deployable OR known
non-deploying" while still failing on a genuine seventh type.

Structure was **generated from**
`quiva-workspaces-mcp/examples/harvested/vertical-template-library.json`, a
harvest of the live space — so it reflects the platform, not someone's memory.
Existing verticals' file **contents are not mirrored yet** (deferred to Phase 2's
`pull`, because pulling raises push-time identity substitution — see §13.6).

### 13.4 An empty folder can be INVISIBLE in the UI — and my check was a false green

Reported by the user: `crm/document_templates` and `crm/flows` could not be seen,
though `create_folder` had returned `verified: true` for all eight.

Measured live across `VERTICAL`: **16 of 21 folder markers have a blank `name`;
0 of 8 config files do.** Three of the eight `crm` markers created in a *single
fresh run* came back blank, in no pattern — so it is a race in the folder-create
indexing path, not migration damage, and it is **permanent** (re-listed over
40s; names never fill in). The marker objects themselves are intact.

Why it matters, and it differs by kind:

- `buildTreeStructure` (`microstrate/src/utils/storage-file-tree.utils.ts:250`)
  does `item.name.split('.')` and derives folders from **each file's own path**
  (`parts.slice(0,-2)`). An entry with `name: ""` yields one part, hits the
  `parts.length <= 2` branch, and never produces a folder node. So a folder that
  is empty *and* has an unnamed marker does not render — while one containing a
  named file renders fine, because the file builds the path itself.
- **For a folder this is cosmetic.** `deployVerticals` skips markers anyway.
- **For a CONFIG it would be serious:** `deployVerticals` matches on `file.Name`,
  so an unnamed config fails the prefix test and would silently never deploy.

Live confirmation, no writes needed: six folders already have a blank marker *and*
named files (`financial_advisor/flows` among them) and render correctly. The
model predicts `financial_advisor/meeting_templates`,
`financial_advisor/record_configs`, `insurance_broker/record_configs` and **`uig`**
are also invisible today — i.e. the platform already has a vertical nobody can see.
**Unconfirmed in the UI; ask the user.**

**Fixed in the tools:** `waitForIndex` now reports `indexed` (found by name *or*
subject) separately from `name_indexed`. `create_folder` returns `visible_in_ui`;
`write_file` returns `will_deploy` and no longer calls a write verified unless the
name is present. The gotcha claiming freshly created markers keep their name was
wrong and is corrected with the 16/21 measurement.

⚠️ **Do not add a placeholder file to force a folder visible.** A `README.md` in
`flows/` is POSTed to the workflow endpoint at deploy time and fails. Only `specs/`
can safely hold markdown.

**Platform bug worth reporting:** folder creation intermittently fails to persist
`name` into the file index, permanently.

### 13.5 Phase 2 — sync (NOT STARTED)

Three verbs:

- **`pull`** platform → repo. Seeds the existing verticals' contents; after a push,
  the diff should be empty.
- **`push`** repo → platform. Must wait for the index, **check `will_deploy` on
  every config** (§13.4), substitute identities (§13.6), and be re-runnable
  (`create_folder` already treats 409 as success).
- **`deploy`** platform → an account. Adds the vertical id to the account's
  `verticals`. Must handle delta-only, and must read the
  `deploy-verticals` stream — that is the only way to know what deployed.

Done means: push `crm`, read the stream, one `SUCCESS` per config, then open the
account and find the resources. Not "the API said 200". Publish and confirm
`SHARED` first, since there is no dependency order.

**Blocked on:** a throwaway sub-account to test `deploy` against (it writes real
resources), and the `.docx` question in §13.7.

### 13.6 Nobody's identity in a committed file

`financial_advisor`'s assistant carries a real user id in
`config.escalate_user_ids` — **functional config, not metadata**. Per CLAUDE.md the
convention is placeholder-in-git, real value substituted at push, as the per-MCP
`tools/push-example.mjs` scripts do. Not yet implemented; it is a Phase 2 `push`
requirement.

**Related finding for whoever owns that vertical:** a main-account user id is
deployed unchanged into every sub-account taking `financial_advisor`, where it
almost certainly does not resolve. That template may already ship a dead
escalation target.

### 13.7 Phase 3 — the spec agent (NOT STARTED)

A Quiva agent takes a rough spec (the user's example source is an AI chat session)
and opens a PR into this repo containing `verticals/<vertical>/specs/<name>.md`,
which is then what a human points Claude Code and the MCPs at. The agent writes
the brief, never the configs — that keeps a review gate between "what we intend"
and "what got built".

Shape: `trigger → AUTHOR_SPEC (agent) → EXTRACT (eval) → GH_BRANCH → GH_COMMIT →
GH_PR`. The `EXTRACT` node is mandatory: agent results come back **markdown-fenced**,
so a bare `JSON.parse` throws (§10.2). The agent's output needs a `vertical` field
now that specs live inside verticals.

**Hard external blocker:** a `SECRET::GITHUB_TOKEN::` must be provisioned
platform-side. Confirm that before building the flow — the sanctions.io node in the
flows playbook is still dead for exactly this reason.

**A route that may help, half-verified:** an object-store trigger appends
`obj://<bucket>/<key>` to a run's `knowledge`
(`hub-service/service/service.go:293`), and `obj://` is a real agent knowledge
scheme (`hub-service/model/agents.go:46`) resolved at invoke time by
`bellerophon-workforce/agent/llmagent/llm_agent.go:599`. So dropping a spec in
storage could hand it to an agent with no glue. **But nothing in the engine
publishes that trigger** — `TriggerTypeObjectStore` appears exactly twice: the
constant and the consumer. Test it early rather than designing around it.

### 13.8 State, and what is left on staging

**356 checks pass across the five suites, 0 failures** — flows 41, records 93,
documents 35, workspaces 156, agents 38 (was 296 at session start).

**Partly committed.** `4f79af1 "folder create vertical mcp"` landed the Phase 0
tooling mid-session: `quiva-workspaces-mcp/{src/client.js,src/index.js,
src/validate.js,src/workspaces-docs.js,test/validate.test.js,
tools/harvest-examples.mjs}`, the re-harvested examples, and
`examples/harvested/vertical-template-library.json`.

**Still uncommitted** at the time of writing: `verticals/**` (untracked — the whole
Phase 1 tree), `docs/{lessons.md,quiva-mcp-handoff.md}`, `CLAUDE.md`, `README.md`,
and the §13.4 false-green fixes to `src/index.js` / `src/workspaces-docs.js` /
`src/validate.js` / `test/validate.test.js` that were made after that commit.

**Engine drift is NOT pinned.** `node engine/sync.mjs` reports 3 unpinned (new
citations: `storage.api.ts`, `workspaces-service/data/const.go`,
`space-record-configs.utils.ts`) and 4 changed (main moved 3 commits during the
session). `--pin` would re-baseline all 30 at once, marking those 4 verified
without anyone re-reading them — deliberately not run. The one that mattered was
checked: the `get.task-actions` misroute is **unchanged**, so that documented claim
still holds.

**Left on staging (creates only, nothing deleted — the user asked to be consulted
before any delete):**

```
spaces.VERTICAL.crm.*                                  8 folder markers (Phase 1, intended)
spaces.MCP_VERIFICATION_RENEWALS.zzz_mcp_probe.*       probe folders + 3 zzz_probe*.json configs
```

The probe artefacts are in a throwaway space and inert — `deployVerticals` reads
only `space_id=VERTICAL`. Remove with
`DELETE /workspaces/files/folder?space_id=MCP_VERIFICATION_RENEWALS&folder=zzz_mcp_probe`
(recursive, soft) and verify by re-listing, not by the response.

### 13.9 Open decisions

1. **A throwaway sub-account** for the Phase 2 `deploy` test.
2. **`document_templates` holds raw `.docx`** in `financial_advisor` with no JSON
   config. Those bytes go to a JSON template endpoint, which should fail. Do FA
   document templates actually deploy today? Changes what goes in
   `crm/document_templates`.
3. **`uig`** — abandoned stub or in progress? Per §13.4 it is probably invisible in
   the UI.
4. **Is the `GITHUB_TOKEN` secret provisioned?** Gates Phase 3 entirely.
5. **Pull the existing verticals' contents** now, with identity substitution?
6. **Commit the rest?** `4f79af1` covers the Phase 0 tooling; `verticals/**`, the
   docs, and the §13.4 fixes are still in the working tree.
7. **`SHARED`** — does `crm` need a record config that all verticals should get?
