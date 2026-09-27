# Quiva Documents MCP

An MCP server for the **file-generator service** — document templates, generated
documents, e-signatures (HelloSign), and AI file generation. Built for Claude
Code, mirroring `quiva-records-mcp/` and `quiva-flows-mcp/`.

Plain JavaScript (ESM), `@modelcontextprotocol/sdk` + `zod`, Node ≥ 18 (global
`fetch`). Defaults to production `https://api.quiva.ai`.

## What it talks to

All routes live under the `/file-generator` gateway prefix (verified live —
the OpenAPI spec's top-level `/templates` / `/documents` return 404). The local
validator and reference docs encode **engine truth** from
`file-generator-service/src`, not just the spec.

## Setup

```sh
cd quiva-documents-mcp
npm install
cp .env.example .env      # then fill in ONE auth option (see below)
npm test                  # runs the local validator test suite
```

### Credentials

Put credentials in `.env` (gitignored, auto-loaded by `bin/run.sh` — no shell
exports needed). One of, in precedence order:

1. `QUIVA_API_KEY` → `X-Api-Key` header (works for reads; the gateway swaps it
   for a JWT).
2. `QUIVA_BEARER_TOKEN` → `Authorization: Bearer` (needed for tenant-derived /
   write operations).
3. `QUIVA_EMAIL` + `QUIVA_PASSWORD` (+ optional `QUIVA_ACCOUNT`) → auto-login,
   JWT cached and refreshed once on 401.

> The service engine only reads `Authorization: Bearer <jwt>`; `X-Api-Key` is
> resolved by the API gateway. For write/tenant operations prefer a bearer
> token or email/password.

## Register with Claude Code

Already wired in the repo `.mcp.json` as `quiva-documents`:

```json
"quiva-documents": {
  "command": "sh",
  "args": ["quiva-documents-mcp/bin/run.sh"],
  "env": { "QUIVA_API_URL": "...", "QUIVA_API_KEY": "...", ... }
}
```

MCP servers connect at session start — restart Claude Code after registering to
use the tools natively.

## Tools (22)

**Reference & validation (no API call)**
- `list_reference_topics`, `get_documents_reference` — expression syntax,
  filters, template/output/signatory/sub-template/pdf-template shapes, trigger,
  document, endpoints, and spec-vs-engine gotchas.
- `list_examples`, `get_example` — bundled harvested (real) and authored
  (illustrative) template/document examples.
- `validate_template_config` — local lint (key, source/output shapes,
  content-type enum, PDF→DOCX guard, signatory shape, `pdf` fields/boxes shape,
  angular-tag balance).

**Templates**
- `list_templates`, `get_template`, `create_template`, `update_template`
  (both accept an optional `pdf` config for a PDF-sourced template),
  `publish_template`, `validate_docx` (server; DOCX/DOC/XML or PDF — a PDF
  returns its real field list and page geometry), `unset_template_paths`,
  `delete_template`, `trigger_templates`.

**Documents**
- `list_documents`, `get_document`, `update_document`, `unset_document_paths`,
  `delete_document`, `get_document_signature_url`.

**Account**
- `list_assigned_files`, `extract_brand` — confirmed gateway-mapped on
  production 2026-09-27, though absent from the published OpenAPI spec.

## PDF templates

A template whose `source.content_type` is `application/pdf` fills its own
AcroForm fields instead of substituting DOCX placeholders. Set `pdf: {
fields?, boxes?, flatten? }` on `create_template`/`update_template`; see
`get_documents_reference("pdf-templates")` for the full shape, and the
"gotchas" topic for what fails silently (an unmapped, untagged field is left
exactly as the source PDF had it) versus what does not (a loop tag in a field
expression, or an out-of-range choice value, both fail the trigger outright).

## Engine-truth gotchas (the short list)

- **`/file-generator` prefix** on every route; single resources use a path param
  (`/templates/{key}`), not `?key=`.
- **Update is PATCH** (merge upsert over the event stream); use `.../unset` to
  remove a field.
- **Draft → published**: writes hit the draft; `publish_template` promotes it;
  generation only uses the published version.
- **Trigger is async** and returns a **bare array** of `{template, subject}` or
  `{template, errors}` — poll `get_document`.
- Responses use a **single `body` wrapper**; errors are top-level `{error}`.
- Expressions are **single-brace** angular syntax; missing fields render empty;
  filter args are positional and all required; validate a DOCX with
  `validate_docx` before storing it.
- A **PDF** field with no `pdf.fields` mapping and no `{tag}` in its own
  value/default/tooltip is left exactly as the source PDF had it — no error, no
  warning. Loop tags and out-of-range choice values, by contrast, fail the
  trigger outright.

## Not exposed

- **AI generation** (`pptx`, `docx-generator`, `docx-editor`, `pdf-python`,
  `xlsx`, `html-pdf`) — the service has these handlers, but they are **not in the
  gateway route registry** (`quiva-endpoints.json`) and 404 at the REST gateway,
  so they are not agent-callable and are omitted. Agents invoke them by other
  means when needed.
- `hellosign-callback` — platform webhook, not agent-callable.
- `approval-audit` — internal; overwrites the object in place.
