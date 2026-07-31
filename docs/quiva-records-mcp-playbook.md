# Playbook: Building the Records MCP, hardening its spec, and proving it on real resources

A record of the instructions to give Claude Code — **in order** — to go from an
OpenAPI/tool spec to a working MCP server, an accurate spec, and a verified real
resource on staging. Modelled on `docs/quiva-flows-mcp-playbook.md`.

**How to use this:** paste each **Instruction** block below into Claude Code, one
at a time, waiting for it to finish before the next. Each phase lists what it
should produce so you can confirm before moving on. To reproduce for another
service, swap the paths (`records-service/` → the new service, `quiva-records.json`
→ its spec).

> **Correction (this revision).** The first pass built a competent config-CRUD
> MCP but **left out the most important part for records: how to build the form
> UI**. The records-service stores `views.forms`/`views.tables` as OPAQUE
> `[]map[string]any` and never validates their inner shape (records-service/model/api.go),
> so the ONLY real contract for the form UI shape is the **frontend renderer**
> (`microstrate/src/components/records/form/**` and `rules/**`). That contract is
> exactly what the two agent instruction docs describe:
> `form-creator.md` (how to shape the form) and `form-rule.md` (how to write rule
> expressions). Those MUST be embedded in the MCP as reference topics. Phase 2.5
> below is the phase that was missing; Phase 1 now includes the renderer.

---

## Phase 1 — Verify the spec against the engine AND the renderer (before any code)

**Instruction:** *"Read `docs/quiva-flows-mcp-playbook.md` so you understand the
method. I want to build a similar MCP server for the **records** service — the way
`quiva-flows-mcp/` was built for flows — that I can run with Claude Code. The agent
tool spec is in `quiva-records.json`, but do NOT trust it. Verify every claim
against the engine source in `records-service/` (the handlers, `model/api.go`, the
`service/service.go` route map, and `response/response.go`) and against the frontend
client at `microstrate/src/services/api/records/records.services.ts`. **Also verify
how form views are actually shaped and rendered** — read
`microstrate/src/types/records.types.ts` and `microstrate/src/components/records/form/**`
and `.../rules/**`. Pay special attention to the real endpoints, field names, which
props are required, the update method (PUT vs PATCH), how record IDs are generated,
auth, and — critically — **where a placed field's `inputType`/`props`/`rules` live**
(node vs schema) and how `views.forms` is stored server-side. List every
spec-vs-engine and spec-vs-renderer discrepancy you find before writing any code."*

**Produces:** a discrepancy table. Alongside the config/record findings (`field`≠`ref`;
server-generated record id; config needs only `id`+`name`; PUT with partial-merge;
query needs `folder|space_id`+Bearer; no schema back-migration; wrong DELETE-config
`x-resource`; undocumented `records-count-by-config`), the **form-shape findings**:
(a) the server stores `views.forms`/`.tables` as opaque `[]map[string]any` — it does
NOT validate form shape, so the renderer is the source of truth; (b) a placed field's
`inputType`/`props`/`rules` live **on the view node**, and the schema field's `ui` is
only a legacy fallback (stripped on save); (c) `views.forms` (array of
`{id,title,description?,layout}`) is current, singular `views.form` is deprecated;
(d) rules are json-logic-engine with five properties, field nodes support all five,
containers support `visible` only. **No code yet.**

---

## Phase 2 — Build the MCP

**Instruction:** *"Good. Build it now as `quiva-records-mcp/`, mirroring
`quiva-flows-mcp/`: plain JavaScript, ESM, `@modelcontextprotocol/sdk` + `zod`,
Node ≥18. Include the full toolkit — record-config CRUD, record CRUD, query, a local
validator that encodes the engine truth you found, and reference docs the agent can
query. Same three auth options as flows (API key → bearer → email/password), default
to staging `https://api.microstrate.io`. Copy the flows HTTP client but add a `put()`
method (records update with PUT). Write `bin/run.sh` fresh — the flows one is missing
— to find Node ≥18 and load `.env`. Do NOT expose a tool for `records-count-by-config`
(no public REST route). Register the server in `.mcp.json` and add
`quiva-records-mcp/node_modules` and `quiva-records-mcp/.env` to `.gitignore`."*

**Produces:** `quiva-records-mcp/` (`package.json`, `.env.example`, `README.md`,
`bin/run.sh`, `src/client.js`, `src/index.js`, `src/records-docs.js`,
`src/validate.js`, `test/validate.test.js`), a `quiva-records` entry in `.mcp.json`,
`.gitignore` updated. **14 tools.**

---

## Phase 2.5 — Embed the form-building and rule-writing instructions (the part that was missed)

**Instruction:** *"The MCP must teach an agent how to BUILD THE FORM UI, not just
manage configs. Two documents already define this — `form-creator.md` (how to turn a
JSON Schema into a form layout) and `form-rule.md` (how to write rule expressions).
Embed both into the MCP as first-class reference topics (`form-builder` and
`form-rules`), **reconciled to the renderer** you read in Phase 1: node-level
`inputType`/`props`/`rules` (schema `ui` is legacy fallback); the input types the
builder actually offers per data type + the props each input type accepts; the
`array-field` repeater with element-relative child refs; that a form-creator
`{ "form": <root grid> }` is a `views.forms[].layout`; the five rule properties and
which node kinds honour which; `{var}` resolution at the form root vs inside a
repeater item; and the json-logic-engine operators. Then make the LOCAL VALIDATOR
check the node-level shape too — `inputType` against the InputType union, `props`
sanity (label), and `rules` (`{id, property, logic}` with the property allowed for
the node kind). Point the server INSTRUCTIONS and the create/update tool descriptions
at these two topics. Add tests for the new validations."*

**Produces:** `records-docs.js` gains a `form-builder` and a `form-rules` reference
topic (the full form-creator/form-rule specs, reconciled to the renderer), an updated
`views`/`input-types` topic and a node-level `CONFIG_EXAMPLE`, and new gotchas
(node-level input config wins; array-field rules reserved in v1; container rules =
visible only). `validate.js` gains `inputType`/`props`/`rules` checks; the test suite
grows to **29 checks**. `list_reference_topics` now lists `form-builder` + `form-rules`.

---

## Phase 3 — Verify the build

**Instruction:** *"Install the dependencies, run `npm test`, and do a real stdio
handshake against the server to confirm it boots and every tool registers. Also call
`get_records_reference` for `form-builder` and `form-rules` to confirm they return.
Report the tool count and any startup errors."*

**Produces:** deps installed; **all 29 tests pass**; handshake lists **14 tools**;
`form-builder`/`form-rules` return their specs; stderr shows
`ready — API: https://api.microstrate.io`.

---

## Phase 4 — Configuration ergonomics

**Instruction:** *"Which env file do I put credentials into, and do I need to export
them before running the MCP?"*

**Produces:** the answer — copy `.env.example` → `.env` (gitignored, auto-loaded by
`bin/run.sh`, no shell exports needed); credentials precedence table; note that
`query_records` needs bearer/email auth, not just an API key; and that MCP servers
connect at session start (a restart is needed to use the tools natively in Claude
Code).

---

## Phase 5 — "Just go for the real thing"

**Instruction:** *"My `quiva-records-mcp/.env` has a staging API key. Just go for the
real thing: drive the MCP against staging in this session (spawn `bin/run.sh` over
stdio — no restart needed) and create a throwaway config **with a real form** — a
`views.forms[].layout` whose field nodes carry `inputType`/`props` and at least one
`rule` — then create → get → update a record and clean up. Show me each response,
confirm the engine truths (server-generated record id, PUT merges partial data, the
form round-trips), and delete both throwaway resources after."*

**Produces:** a live end-to-end pass on staging; the record id is a 10-char nanoid you
never sent; the config's `views.forms[0].layout` round-trips with node-level
`inputType`/`props`/`rules` intact; `update_record` merges; deletes return
`{"message":"success"}`; both throwaway resources removed.

---

## Phase 6 — Create a real record from the config spec

**Instruction:** *"Now create a real record from the config spec instead of a toy one.
List the configs already on staging, compare them against
`advisor-system-spec/config/financial_advisor/record_configs/`, and pick one that is a
real spec config. Tell me which config you picked and why, read its live schema, and
show me the exact record you would create — do not write anything until I approve."*

**Produces:** the existence check, a chosen config (e.g. `KYC`) with reasoning, its
live required fields/enums, and a proposed conforming record — then waits for approval
before creating.

---

## Phase 7 — Harden the spec

**Instruction:** *"Apply every engine-truth AND renderer-truth discrepancy you found to
`quiva-records.json` so the spec is accurate. This file looks like a sourced copy (a
`{name, schema}` tool wrapper referenced by no build) — flag that edits here may be
overwritten and the same fixes should be applied at the real source. Keep the JSON
valid and bump the version."*

**Produces:** the config/record corrections (`field` not `ref`; DELETE-config
`x-resource`; `config_id`/`limit`/`offset` + Bearer note; `ids` param;
`RecordCreate.id` readOnly; relaxed `required`; `total_hits`/`info`) PLUS the
form-shape corrections — node-level `inputType`/`props`/`rules`; `views.forms[]`
current vs `views.form` deprecated; the `array-field` node. **Verify `field` fix stuck:**
`grep -c 'MUST be' quiva-records.json` → 0.

---

## Phase 8 — Token economy

**Instruction:** *"Check the git history for `quiva-flows.json` to see how token
economy was actually handled there, then apply the same discipline to
`quiva-records.json`. Measure before/after tokens. Match the flows convention — keep
lean, non-redundant examples and do NOT minify — rather than stripping every example."*

**Produces:** the finding that flows *keeps* ~5 lean examples and the conservative trim
on records — remove oversized/duplicate examples, keep the ones that show schema +
node-level views. JSON still valid.

---

## The distilled process

1. **Verify the spec against the engine source AND the renderer first** — for
   records, the renderer is the source of truth for the form shape because the
   server stores forms opaquely. List discrepancies before writing tooling.
2. **Build the MCP by mirroring an existing one**; encode engine truth in a local
   validator + reference docs (not the spec).
3. **Embed the domain's "how to build it" instructions** — for records, the
   form-creator and form-rule specs, reconciled to the renderer. Without these an
   agent can manage configs but cannot shape a form.
4. **Verify the build** — tests pass, tool count correct, server boots, reference
   topics return.
5. **Prove it on real resources** — drive it against staging, build a real form,
   confirm the engine truths, clean up.
6. **Harden the spec** for accuracy, flagging whether it's a sourced copy.
7. **Trim for token economy** to match the template's convention — never blindly.

## Watch-outs (mistakes made along the way)

- **THE BIG ONE: shipping a records MCP with no form-building instructions.** The
  first pass documented config CRUD and a thin `views` blurb, but not *how to shape a
  form*. There was "absolutely no structure to know how to create the form UI shape,"
  and the `form-creator.md`/`form-rule.md` agent instructions were absent. The form
  shape is the whole point of records — embed `form-builder` + `form-rules` and make
  the validator enforce the node-level shape.
- **Putting `inputType`/`props`/`rules` on the schema instead of the view node.** The
  renderer reads them off the node; schema `ui` is a legacy fallback and is stripped
  on save. The example and the validator must reflect node-level config.
- Re-applying spec fixes and **dropping fix #1** (`field`/`ref`). Always re-check
  `grep -c 'MUST be'` == 0.
- Putting the API key in the **git-tracked `.env.example`** instead of the gitignored `.env`.
- **Minifying** records or **stripping all examples** — diverges from the flows template.
- Exposing a **count tool** — `records-count-by-config` has no public REST route.
