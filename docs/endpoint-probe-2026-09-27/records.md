# Endpoint probe — quiva-records-mcp (2026-09-27)

## Why the curl probe alone is not enough here

Unauthenticated requests: 401 = mapped at the gateway, 404 = not mapped.
`curl --cacert /etc/ssl/cert.pem -X <method> https://<host><path> -d '{}'`

For `/records` the 401 proves nothing on its own. `POST /records/{config_id}`,
`GET /records/{config_id}` and `DELETE /records/{config_id}/{id}` are
path-parameter routes, so any unmatched `POST /records/<word>` or
`DELETE /records/<x>/<y>` also returns 401. The authority for this table is
therefore the gateway mapping store itself (read-only):

```
bcli --context microstrate-prod stream subjects microstrate-gateway 'ms.gateway.T41F4CcPZpws.mapping-version.>' --names
bcli --context microstrate-prod stream get microstrate-gateway -S 'ms.gateway.T41F4CcPZpws.mapping-version.<method>.<path>.1' -j   # .resource
bcli --context <ctx> request '$SRV.INFO.records-service' ''   # which subjects the deployed service answers
```

Staging gateway id `lqTzBJz_D5ms`, production `T41F4CcPZpws`.

## Table

"Mapped" is the gateway mapping store; "served" is the deployed service's
`$SRV.INFO`. Both columns agree with the curl result (401 everywhere below).

| Method | Path | Subject | Prod mapped | Prod served | Staging mapped | Staging served | Curl (prod / staging) | Tool |
|---|---|---|---|---|---|---|---|---|
| GET | `/records` | `get.query-records` | yes | yes | yes | yes | 401 / 401 | `query_records`, `list_records` (rebuilt) |
| GET | `/records/{config_id}` | `get.records` | yes | **no** (handler deleted) | yes | **no** | 401 / 401 | none — was `list_records`; live call on staging: 500 "no responders" |
| GET | `/records/count?ids=` | `get.records-count-by-config` | yes | yes | yes | yes | 401 / 401 | used inside `list_records` |
| GET | `/records/config` | `get.configs` | yes | yes | yes | yes | 401 / 401 | `list_record_configs` (+ `limit`/`cursor`) |
| POST | `/records/csv-import` | `post.csv-import` | yes | yes | yes | yes | 401 / 401 | `csv_import` (new) |
| POST | `/records/export-records` | `post.export-records` | yes (2026-09-22) | yes | yes | yes | 401 / 401 | `export_records` (new) |
| DELETE | `/records/{config_id}/purge` | `delete.purge-records` | yes | yes | yes | yes | 401 / 401 | `purge_records` (new, `confirm: true`) |
| POST | `/records/upsert-record` | `post.upsert-record` | yes (2026-09-08) | yes | yes | yes | 401 / 401 | `upsert_record` (new) |
| POST | `/records/reindex` | `post.reindex` | yes (2026-09-08) | yes | yes | yes | 401 / 401 | none — documented in `index-fields` |
| GET/DELETE | `/records/{config_id}/{id}/history` | `get/delete.record-history` | yes | **no** | yes | yes | — | none — doc note |
| GET | `/records/{config_id}/series` | `get.record-series` | yes | **no** | yes | yes | — | none — doc note |
| POST | `/records/{config_id}/{id}/history/{version}/{amend,erase,hide,restore}` | — | **no** | — | yes | — | — | none — staging only |

Baseline: `GET /records/nonexistent-zz/zz/zz` returns 404 "404 page not found"
on both hosts; `POST /records/zz/zz` returns 405.

## Result

- Every endpoint given a tool is mapped **and served** on production.
- The plan listed upsert-record and reindex as staging-only; both have been
  mapped on production since 2026-09-08, and production's records-service
  answers both. `upsert_record` is added; reindex is documented, not wrapped.
- `GET /records/{config_id}` is mapped on both hosts but its subject has no
  responder anywhere, so `list_records` no longer calls it.
- History and series are mapped on production ahead of the service: a call
  would reach a gateway route with nothing behind it. Not wrapped.
