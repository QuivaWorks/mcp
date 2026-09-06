# Verticals

A vertical is a bundle of Quiva configuration — agents, flows, record configs,
document templates, spaces — that can be dropped into an account to stand up a
working product. This folder is where verticals are **authored and reviewed**;
the `VERTICAL` space on the platform is where they are **published**.

Configs are written here first, in git, so they get a diff and a review. Nothing
is typed directly into staging.

## The path rule

One rule, every file, both directions:

```
verticals/<vertical>/<category>/<name>.<ext>
   ⟷   spaces.VERTICAL.<vertical>.<category>.<name>.<ext>
```

`.` is the hierarchy separator in the platform's object keys, so **no path
segment may contain a dot** — not the vertical id, not a category, not a file
name. Only the extension adds one.

`*.__meta__.json` files are not committed. A folder on the platform *is* a marker
object of that name, which is a storage artefact rather than content; the push
step recreates them. Git has no concept of an empty directory, so each empty
folder here holds a `.gitkeep` instead.

## The seven folders

Six of them are **routing keys**. `accounts-service` takes the first path segment
after `spaces.VERTICAL.<vertical>.` and looks it up in a fixed table
(`accounts/updateaccount.go`, `configTypeToEndpointSubject`). A name that is not
in that table is **skipped silently** — no error, no log line, nothing deploys.
So `record_config` instead of `record_configs` is a folder that does nothing and
never tells you.

| Folder | Deployed to |
| --- | --- |
| `assistants` | `microstrate.hub.post.agent` |
| `document_templates` | `microstrate.file-generator.post.template` |
| `flows` | `microstrate.hub.post.workflow` |
| `meeting_templates` | `microstrate.recall.post.summarization-template` |
| `record_configs` | `microstrate.records.post.config` |
| `spaces` | `microstrate.workspaces.post.space` |
| `specs` | **nothing — deliberately** |

`specs` holds the markdown brief a vertical was built from. It is not a config and
is never deployed: `specs` is not in the routing table, so the deployer reaches it
and drops it. It is there so the intent behind a vertical sits next to the
vertical, in git where it can be reviewed, and (after a push) in the platform's
Files tab where it can be read without the repo.

## `SHARED` is not a vertical

`deployVerticals` appends `"SHARED"` to whatever verticals were requested, so
**everything under `SHARED/` is deployed to every account that gets any
vertical**. That is how every account ends up with the `Client` record config. Put
something here only if it genuinely belongs to all verticals.

## How a vertical reaches an account

Two hops, and it is easy to think there is one.

1. **Publish** — push this folder to the `VERTICAL` space in the main account.
   That makes the template *available*. Nothing has been deployed yet.
2. **Deploy** — add the vertical id to a target account's `verticals` array.
   `accounts-service` then copies each config into that account.

Things that bite on hop 2:

- **It is delta-only.** Only verticals *not already* on the account are deployed.
  Re-adding one that is already listed does nothing at all. To redeploy you must
  remove it, save, and re-add.
- **It is fire-and-forget.** `go deployVerticals(...)` runs in a goroutine, so the
  account-update response tells you nothing about whether it worked. The only
  record is a stream: `microstrate-accounts.<account_id>.deploy-verticals`, one
  message per file with `{name, vertical, config_type, subject, status, error}`.
- **There is no dependency order.** Files deploy in index-listing order, so a
  space referencing the `Client` record config can be created before `Client`
  exists. Publish and confirm `SHARED` first.
- **Indexing is asynchronous.** The deployer iterates the platform's *file index*,
  not the object bucket, and a freshly written file takes seconds to minutes to
  appear. Push, then wait for the index, then deploy — otherwise a subset deploys
  and every signal is green.

## Two transforms the deployer applies to your file

Your config is forwarded verbatim except in two cases:

- **`flows`** — a workflow collection is created per vertical, and `collection`
  plus `auto_publish: true` are injected into the payload. The collection's name
  is the vertical id split on `_` and upper-cased at the first letter only, so
  `financial_advisor` becomes "Financial Advisor" and **`crm` becomes "Crm"**.
  There is no override.
- **`assistants`** — the file must be wrapped as `{ "config": { ... } }`; a flat
  agent payload is unmarshalled into an empty config and deploys a hollow
  assistant. `config.shared` is **forced** to `"team"` whatever you set.

## Space configs: which record-config key wins

A file in `spaces/` may attach record configs. There are two keys and they are not
equal:

```json
{
  "record_configs": [{ "id": "Client" }],
  "record_config_ids": ["Client"]
}
```

`record_configs` is the current shape and **wins on read**; `record_config_ids` is
legacy and is only consulted when `record_configs` is absent
(`microstrate/src/components/spaces/records/space-record-configs.utils.ts`). Saving
from the UI writes `record_configs` and *deletes* the legacy array. So a config
added to `record_config_ids` alone is silently ignored.

**Write both, identically.** Both live space configs (`fahub.json`, `ibhub.json`)
do exactly that, which is why they work.

## Nobody's identity in a committed file

Some configs carry real user ids as functional values — `financial_advisor`'s
assistant has a real person in `config.escalate_user_ids`. Those are replaced with
placeholders here and substituted at push time, the same convention the per-MCP
`tools/push-example.mjs` scripts use.

(Related, and worth someone's attention: a user id from the main account is
deployed unchanged into every sub-account taking that vertical, where it almost
certainly does not resolve.)

## Current contents

| Vertical | State |
| --- | --- |
| `SHARED` | mirrors the platform: `record_configs/Client.json` |
| `financial_advisor` | the complete reference — all six folders, configs in four |
| `insurance_broker` | partial — `record_configs`, `spaces` |
| `uig` | a stub; the folder exists and nothing is in it |
| `crm` | **new** — all six folders plus `specs`, all empty |

Folder structure here was generated from
`quiva-workspaces-mcp/examples/harvested/vertical-template-library.json`, which is
a harvest of the live `VERTICAL` space — so it reflects the platform rather than
someone's memory of it. Existing verticals' file *contents* are not mirrored yet.

## Tooling

The workspaces MCP has the file/folder tools this folder is managed with:

```
list_files      read the platform's file index (the authoritative "what is there")
create_folder   create a folder, confirmed against the index; re-runnable
write_file      upload a config, digest-checked, confirmed against the index
read_file       read content back — a write response is not proof
```

`get_workspaces_reference("files")` and `("verticals")` carry the full contract.

Deleting a file or folder is deliberately **not** exposed as a tool: the semantics
have never been exercised, and the flows MCP's `delete_workflow` silently orphaned
every draft it "deleted" while returning success (`docs/lessons.md`). The reference
topic documents the route and marks it unverified.
