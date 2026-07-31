# Playbook: Building the Documents MCP, proving it on real resources, and hardening its spec

A record of the instructions to give Claude Code — **in order** — to go from an
OpenAPI/tool spec to a working MCP server for the **file-generator** service
(document templates, generated documents, e-signatures), a verified real
document on staging, and an accurate, lean spec. Modelled on
`docs/quiva-records-mcp-playbook.md` and `docs/quiva-flows-mcp-playbook.md`.

**How to use this:** paste each **Instruction** block below into Claude Code, one
at a time, waiting for it to finish before the next. Each phase lists what it
should produce so you can confirm before moving on. To reproduce for another
service, swap the paths (`file-generator-service/` → the new service,
`quiva-documents.json` → its spec, `quiva-endpoints.json` → the gateway route
registry).

---

## Phase 1 — Verify the spec against the engine (before any code)

**Instruction:** *"Read `docs/quiva-records-mcp-playbook.md` and
`docs/quiva-flows-mcp-playbook.md` so you understand the method. I want to build a
similar MCP server for the **documents / file-generator** service that I can run
with Claude Code. The agent tool spec is in `quiva-documents.json`, but do NOT
trust it. Verify every claim against the engine source in `file-generator-service/`
(the `handler/*.ts`, `service.ts` route map, `type/template.ts`, `type/document.ts`,
`response.ts`, `datapoint.ts`, `request.ts`, `data/*.ts`, `utils/subject.ts`) and
against the `microstrate` frontend client. Pay special attention to the real REST
paths, HTTP methods (PATCH vs PUT vs POST), required props, the draft→published
model, the response envelope, subject formats, and auth. First ensure the MCP/spec
is actually for this service, then list every spec-vs-engine discrepancy before
writing any code."*

**Produces:** confirmation the spec matches the service (the `x-resource`
`microstrate.file-generator.<method>.<endpoint>` values map 1:1 onto `service.ts`);
a discrepancy table. Expected findings: the spec's top-level paths are missing the
real gateway prefix; single resources use a path param not `?key=`; update is PATCH
(merge upsert), not PUT; the response envelope is over-nested (spec shows
`{status_code, body:{body}}`, reality is a single `body`); `apiKeyAuth` declared but
engine is Bearer-only (gateway-swapped); undocumented endpoints (6 AI-generation
handlers + internal `approval-audit`); trigger is async and needs a resolvable
`output.content_type`. **No code yet.** Decide tool scope (which extras, if any) and
verification depth here.

---

## Phase 1.5 — Confirm the REST surface live (read-only + validation-gated probes)

**Instruction:** *"The frontend paths are self-labelled 'provisional guesses' and
the spec paths don't resolve. Before building, confirm the real gateway paths with
read-only probes against staging (use the API key from `quiva-records-mcp/.env`).
Then confirm the write paths WITHOUT creating anything by POSTing empty/invalid
bodies — every handler validates first, so a correct path returns 400 and a wrong
one 404."*

**Produces:** the confirmed prefix (`/file-generator`), path-param form
(`/file-generator/templates/{key}`, not `?key=`), and the single-`body` response
envelope with extra `modified`/`sequence`/`subject`/`type` fields. Write paths
confirmed via 400-vs-404: `POST /file-generator/templates` → 400 (correct),
`POST /file-generator/template` → 404 (wrong, so plural is correct). **Nothing
created.**

---

## Phase 2 — Build the MCP

**Instruction:** *"Build it now as `quiva-documents-mcp/`, mirroring
`quiva-records-mcp/`: plain JavaScript, ESM, `@modelcontextprotocol/sdk` + `zod`,
Node ≥18. Include the full toolkit — template CRUD + publish + validate + unset +
trigger, document CRUD + unset + signature-url, a local validator that encodes the
engine truth (template-config shape AND the angular-expression tag rules), and
reference docs the agent can query. Same three auth options as records (API key →
bearer → email/password), default to staging. Copy the records HTTP client but base
it at the `/file-generator` prefix, add a `patch()` method (updates are PATCH), and
make it aware of the single-`body` envelope. Put the real key only in the gitignored
`.env`, a placeholder in `.env.example`. Register in `.mcp.json`; gitignore
`node_modules` and `.env`."*

**Produces:** `quiva-documents-mcp/` (`package.json`, `.env.example`, `.env`,
`README.md`, `bin/run.sh`, `src/client.js`, `src/index.js`, `src/documents-docs.js`,
`src/validate.js`, `test/validate.test.js`), a `quiva-documents` entry in `.mcp.json`,
`.gitignore` updated. Expect a tool set covering templates + documents (+ any scoped
extras) and a validator test suite.

---

## Phase 3 — Verify the build

**Instruction:** *"Install the dependencies, run `npm test`, and do a real stdio
handshake against the server to confirm it boots and every tool registers. Report
the tool count and any startup errors."*

**Produces:** deps installed; all validator tests pass; handshake lists the tools;
stderr shows `ready — API: https://api.microstrate.io/file-generator`.

---

## Phase 4 — Configuration ergonomics

**Instruction:** *"Which env file do I put credentials into, and do I need to export
them before running the MCP? Which operations need which auth?"*

**Produces:** copy `.env.example` → `.env` (gitignored, auto-loaded by `bin/run.sh`,
no shell exports); credential precedence (API key → bearer → email/password); note
that reads work with the API key (gateway swaps it) but tenant-scoped writes may
need a bearer token; and that MCP servers connect at session start (restart to use
natively — but the stdio driver needs no restart).

---

## Phase 5 — "Just go for the real thing"

**Instruction:** *"My `.env` has a staging API key. Drive the MCP against staging in
this session (spawn `bin/run.sh` over stdio — no restart needed) and run a full
throwaway lifecycle: list → create template → get → (create again to see 402) →
update (PATCH) → get (confirm merge) → publish → trigger → poll document → delete.
Then generate a REAL document from an EXISTING published template + a real DOCX
(don't modify/delete the existing template — trigger it read-only with an output
override into a throwaway folder, and omit the signatory email so no HelloSign
request is sent). Also exercise unset, update_document, validate_docx, and
get_document_signature_url (against an existing embedded signature — read-only).
Show each response, confirm the engine truths, and clean up everything you create."*

**Produces:** a live end-to-end pass — single-`body` envelope; create→402-on-dup;
PATCH merge (untouched fields preserved); publish→published subject; **async trigger
returns a bare array**, document generated (`output.key` set) within seconds;
delete→`{message:"success"}`; missing/deleted resource GET → **500 "resource not
found"**. Real generation from the existing template produces a PDF; the signatory
is safely skipped by omitting `email`. `get_document_signature_url` returns a real
embedded HelloSign URL. **Every failure back-propagated:** e.g. `unset_template_paths`
was PATCH → **405**; the gateway routes template-unset as **POST** (document-unset
stays PATCH) — fixed in the client + docs. All throwaways deleted; existing
resources untouched (one residue: a generated PDF blob, no object-store delete tool).

---

## Phase 6 — Harden the spec

**Instruction:** *"Check the AI-generation endpoints (and all file-generator routes)
against the gateway route registry `quiva-endpoints.json`. Remove any tools that
aren't routed (they 404 and can't be called). Then apply every engine-truth
discrepancy to `quiva-documents.json`, using the registry as authoritative for
paths/methods. Keep the JSON valid and bump the version. Flag whether this file is a
sourced copy whose edits may be overwritten."*

**Produces:** confirmation the registry has **17 file-generator routes and none of
the 6 AI-generation endpoints** → the 6 AI-gen tools removed from the MCP (down to
18). Spec corrections (v1.0.0 → 1.0.1): (1) `/file-generator` prefix on all paths;
(2) template-unset PATCH → **POST**; (3) HelloSign webhook →
`/file-generator/webhooks/hellosign/{account}` + `account` param; (4) response
envelope flattened to a single `body` (status_code removed from bodies; errors are
`{error}`; trigger is a bare array); (5) `apiKeyAuth`/`bearerAuth` clarified;
(6) `signature_url` snake_case note fixed; (7) read-only `modified`/`sequence`/
`subject`/`type` added to `Template`/`Document`; (8) an `x-engine-gotchas` block.
Flag: `quiva-documents.json` is a `{name, schema}` agent-tool wrapper (a sourced
copy) — reapply fixes at the real source.

---

## Phase 7 — Token economy

**Instruction:** *"Check how token economy was handled in the flows/records specs,
then apply the same discipline to `quiva-documents.json`. Measure before/after
tokens. Keep lean, non-redundant examples and do NOT minify — trim duplicate/oversized
examples rather than stripping everything."*

**Produces:** the finding that flows/records keep ~5–7 lean examples, pretty-printed.
The conservative trim on documents: collapse the multi-`examples` operations
(`POST /templates`, `PATCH /templates/{key}`, `trigger` request + response,
`GET /documents/{key}`) to one representative example each; drop the verbose
webhook payload example; remove `x-externalDocs-links` (URLs duplicated in
`x-agent-syntax-rules`). Keep `x-agent-syntax-rules` (core expression guidance) and
both tiny `validate` examples. Expect **~22,600 → ~19,600 tokens** (~13%), JSON
still valid, all `$ref`s resolving, ~in line with `quiva-records.json`.

---

## The distilled process

1. **Verify the spec against the engine source first** — and confirm the MCP is for the right service — listing discrepancies before writing tooling.
2. **Confirm the live REST surface** with read-only and validation-gated (400-vs-404) probes before building — never trust "provisional" frontend paths.
3. **Build the MCP by mirroring an existing one**; encode engine truth in a local validator (here: template shape **and** angular-expression tag rules) + reference docs, not the spec.
4. **Verify the build** — tests pass, tool count correct, server boots.
5. **Prove it on real resources** — throwaway lifecycle + a real artifact from an existing resource, read-only where possible; back-propagate every failure into the validator/docs/client.
6. **Cross-check coverage against the gateway route registry** (`quiva-endpoints.json`) — remove tools that aren't routed; harden the spec; flag sourced copies.
7. **Trim for token economy** to match the template's convention — never blindly, never minify.

## Watch-outs (mistakes made / avoided this time)

- **Trusting the spec's paths.** They lacked the `/file-generator` prefix and 404. The frontend's paths were self-labelled provisional guesses. Only live probes + the gateway registry are authoritative.
- **Assuming symmetry.** Template-unset is **POST**, document-unset is **PATCH** — an asymmetry only staging revealed (405 vs 200).
- **PATCH creates.** A PATCH to a non-existent template key silently creates a draft — a stray comparison probe created a phantom `zzzprobe`; catch and delete it.
- **Sending real e-signatures.** The `alex-test` signatory email is an expression `{email}`; supplying it dispatches a real HelloSign request. Omit `email` so the signatory is skipped.
- **Shipping dead tools.** The 6 AI-generation handlers exist in the service but aren't in the gateway registry — they 404. Verify against `quiva-endpoints.json` and remove them; agents invoke them by other means.
- **Putting the real key in the git-tracked `.env.example`** — keep it in the gitignored `.env`; use a placeholder in `.env.example`.
- **Over-nesting responses.** The gateway returns the service `body` directly (single wrapper); the spec's `{status_code, body:{body}}` was wrong by a level.
- **Minifying / stripping all examples** — match the flows/records convention: keep lean examples, pretty-printed.
