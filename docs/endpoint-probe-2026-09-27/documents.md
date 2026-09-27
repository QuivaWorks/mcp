# Endpoint probe — quiva-documents-mcp (2026-09-27)

Unauthenticated requests against both hosts. 401 = mapped at the gateway (route
exists, auth required). 404 = not mapped. Baseline confirmed first: an
unrouted path (`/file-generator/totally-bogus-path-xyz`) returns 404 on both
hosts, and a real path with the wrong HTTP verb returns 405 — so a 401 below
is not a blanket WAF response and is specific to that path.

`curl --cacert /etc/ssl/cert.pem -X <method> https://<host><path>`

| Method | Path | api.quiva.ai (prod) | api.microstrate.io (staging) | Tool |
|---|---|---|---|---|
| GET | `/file-generator/templates` | 401 | 401 | `list_templates` (existing) |
| GET | `/file-generator/documents?query=%3E` | 401 | 401 | `list_documents` (existing) |
| POST | `/file-generator/templates` | 401 | 401 | `create_template` (existing; now accepts `pdf`) |
| POST | `/file-generator/templates/validate` | 401 | 401 | `validate_docx` (existing; now accepts `application/pdf` + `pdf`/`signatory_count`) |
| POST | `/file-generator/brand-extract` | 401 | 401 | `extract_brand` (**new** — added) |
| GET | `/file-generator/assigned-files` | 401 | 401 | `list_assigned_files` (**new** — added) |

Baseline (not a tool):

| Method | Path | api.quiva.ai | api.microstrate.io |
|---|---|---|---|
| GET | `/file-generator/totally-bogus-path-xyz` | 404 | 404 |
| GET | `/records/upsert-record` (known unrelated route, wrong verb) | 405 | 405 |

## Result

Every endpoint this workstream touches is mapped on **production** (and
staging). PDF template support (`pdf` on `create_template`/`update_template`,
`application/pdf` on `validate_docx`) rides the same, already-wrapped
`/file-generator/templates*` routes — no new route to probe there. Both
`brand-extract` and `assigned-files` came back **401 on production**, so per
the plan's "doc note only; no tools unless mapped on prod" they graduated from
doc-note to real tools: `extract_brand` and `list_assigned_files`.

## Notes

- `specs/openapi/quiva-endpoints.json` (this repo) lists neither
  `brand-extract` nor `assigned-files` at all — consistent with the audit's
  note that the endpoints dump is stale (`openapi-spec-surfaces-and-drift`).
  The probe is the source of truth here, not the spec file.
- Both handlers require the caller's own `Authorization: Bearer <jwt>` (not a
  service-side connection) — `brand-extract` explicitly reads an arbitrary
  object-store key by request, so only the requesting user's own connection is
  safe to use for that read (`file-generator-service/src/handler/brand-extract.ts`
  comment). `X-Api-Key` still works via the gateway's usual swap-for-JWT.
- Not probed / not added: the AI-generation handlers (pptx, docx-generator,
  docx-editor, pdf-python, xlsx, html-pdf), `hellosign-callback`, and
  `approval-audit` — already documented as absent from the gateway route
  registry and out of scope; nothing in this workstream changed that.
