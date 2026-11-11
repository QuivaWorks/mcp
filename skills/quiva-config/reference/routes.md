# Routes and traps

Base URL `https://api.quiva.ai`. Auth is the `x-api-key` header.

## Record sets (record configs)

| | route |
|---|---|
| list | `GET /records/config?limit=` |
| read | `GET /records/config/{id}` |
| create | `POST /records/config`: the whole config, including `views` and `index_fields` |
| update | **`PUT`** `/records/config/{id}`: `name, description, label, schema, views, index_fields, history, collection_id, …` |
| delete | `DELETE /records/config/{id}` |

- `PATCH /records/config/{id}` is in the OpenAPI spec but does not work. Use `PUT`.
- `views` merge per key. To remove one, send `unset_views: ["key"]`.
- A config id another account has published is reserved (409 `config_id_reserved`). Use a new id.

## Config collections

`GET /records/config-collections[/{id}]`, `POST`, **`PUT`** `/records/config-collections/{id}`, `DELETE`.

## Records

| | route |
|---|---|
| list | `GET /records?config_id=&space_id=&limit=`: `space_id` (or `folder`) is required |
| create | `POST /records/{config_id}` `{id?, data, space_id, validate}` |
| update | **`PUT`** `/records/{config_id}/{id}` `{data, replace, space_id}`: merges `data` unless `replace: true` |
| delete | `DELETE /records/{config_id}/{id}` |

- **Page with `offset`.** `limit=200&offset=200` returns the next page. A large page of big rows times out (504), so keep pages at 200. Compare `total_hits` with the rows returned.
- `GET /records/{config_id}?filter=` silently ignores the filter. Use `GET /records?config_id=…&filter=…`.
- `PATCH /records/{config_id}/{id}` does not work.

## Spaces and task templates

`GET /workspaces/spaces`, `GET /workspaces/space/{id}`, `POST /workspaces/space`, `PATCH /workspaces/space/{id}`, `DELETE`.
`GET /workspaces/task-templates`, `GET|PATCH|DELETE /workspaces/task-template/{id}`, `POST /workspaces/task-template`.

When copying a space, drop `owner`, `url`, `logo` and timestamps.

## Flows

| | route |
|---|---|
| list | `GET /hub/workflows?limit=500`: `{name, description, subject}`. Drafts carry `.draft.` |
| read | `GET /hub/workflows/{collection}/{flow}?draft=true\|false` |
| create | `POST /hub/workflows {name, description, config, collection, auto_publish:false}` |
| update | `PATCH /hub/workflows/{collection}/{flow}` with the flow object |
| publish | `POST /hub/workflows/publish {subject: <draft subject>, commit?}` |
| delete | `DELETE /hub/workflows/{c}/{f}?draft=false` **and** `?draft=true` |
| collections | `GET /hub/collections?collection_type=workflow` (400 without the type), `POST /hub/collections {name, collection_type}` |

- Never `auto_publish: true`. Create answers 201 even when the publish inside it failed.
- Record triggers match **published** flows only. An unpublished flow with a record trigger never fires.
- Strip `subject` and `modified` from nodes and edges before creating a flow somewhere else.
- One unresolvable `SECRET::NAME::` fails the whole run at start with a 400.

## Secrets

| | route |
|---|---|
| names | `GET /secrets?reveal=false&limit=`, `GET /secrets/user?reveal=false` |
| write | `PUT /secrets {key, value, scope: "account"\|"user"}`. Admin only for shared |
| delete | `DELETE /secrets/{key}[?scope=user]` |

- `GET /secrets/{key}` returns the value; the script never calls it.
- `old_key` on `PUT` renames by deleting the old secret. Don't use it.
- A value containing `"` is corrupted on read.

## Account

`GET /accounts/info` returns the account behind the key (`id`, `name`, `display_name`). `check` and `profile add` use it.

## Reading errors

- A plain-text `404 page not found` means the gateway has no route for the path.
- A JSON 404 came from a service. Under `/records/…` it is often the `{config_id}` catch-all route, so it proves nothing.
- `no responders` means the route exists but nothing is serving it right now.
