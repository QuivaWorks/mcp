---
name: quiva-config
description: Pull, edit, diff, push and copy Quiva account configuration (record sets, records, spaces, task templates, flows and secrets) on api.quiva.ai. Use when the user asks to read, change, copy between accounts, publish or delete any of these, to set up secrets a flow needs, or pastes an app.quiva.ai link to a flow, space or record set.
---

# Quiva config

Everything goes through one script, `scripts/quiva.mjs` (Node 18+, no dependencies). It talks to `https://api.quiva.ai` with the user's API key.

```sh
Q="${CLAUDE_PLUGIN_ROOT}/skills/quiva-config/scripts/quiva.mjs"
node "$Q"            # usage
```

Outside the plugin (for example in Codex), use the script's path inside the cloned repo. Run it from the user's working directory: pulled files go to `./.quiva/` (add it to `.gitignore`).

Routes and traps: [reference/routes.md](reference/routes.md). Read it before using `get` on a route the script doesn't wrap.

## Profiles and keys

A profile is one account, kept in `~/.config/quiva/profiles.json` (mode 600). To override a profile's key, set `QUIVA_API_KEY_<PROFILE>` (uppercased, other characters as `_`).

- Start with `node "$Q" profile list`, then `node "$Q" check <profile>`. `check` prints the account id and name behind the key.
- **Missing profile:** never ask for the key in chat. Tell the user to create a key in the app under **Settings → API keys**, then run this in their own terminal (the `!` prefix works in Claude Code):
  `node <path>/skills/quiva-config/scripts/quiva.mjs profile add <name>`
  The script asks for the key with hidden input and looks up the account itself. `--account <id>` is optional and is checked against the key.
- **401:** the key has expired or was revoked.
- Writing shared secrets needs an **admin's** key.

## Reading links

- `app.quiva.ai/.../flows/ms+hub+config+workflow+draft+<collection>+<flow>` is flow id `<collection>.<flow>`.
- `.../hub/spaces/<SPACE>/...` is space id `<SPACE>`.
- The `acct=` query value is not the account id; match on the profile's account.

## Ids by kind

| kind | id | notes |
|---|---|---|
| `record-config` | config id | the app calls it a **record set** |
| `config-collection` | collection id | |
| `space` | space id | |
| `task-template` | template id | |
| `flow` | `<collection topic>.<flow topic>` | edits go to the **draft**; `publish` makes them live |
| `records` | `<config_id>@<space_id>` | the row array, read 200 at a time (up to 5000 rows) |

## Changing something

1. `node "$Q" pull <profile> <kind> <id>` writes `.quiva/<profile>/<kind>/<id>.json` and a base copy.
2. Edit that file.
3. `node "$Q" push <file>` is a **dry run**. It prints the host, account, the diff against live, and the requests. Exit code 3 means nothing was written.
4. Show the user the diff and wait for their yes. Then run `push <file> --yes`.

A push is refused when live changed since the pull. Pull again and re-apply the edit; never work around it.
Each write backs up the live object to `.quiva/<profile>/backups/<timestamp>/` first.

## Copying between accounts

`node "$Q" copy <from> <to> <kind> <id> [--as <new id>] [--space <space>]` creates the object in the target and refuses if it already exists there. As with push, run it without `--yes` first, show the user the output, and add `--yes` after they agree.

- **Space:** `owner`, `url` and the uploaded logo are not copied. Compare the space's `record_configs` with the target's (`list <to> record-config`) and say which are missing.
- **Record set:** a 409 `config_id_reserved` means another account published that id. Ask the user whether to copy it under a new id (`--as`).
- **Records:** the record set must already exist in the target. Rows already there are skipped. A set larger than 5000 rows is refused unless `--partial` is passed.
- **Flow:** creates the workflow collection by name if needed, then a draft (`auto_publish:false`).
- After any copy, report what still points at the source. The script warns about account gateway URLs and missing secrets.

## Publishing a flow

`node "$Q" publish <profile> <collection>.<flow>` refuses while the flow references a `SECRET::NAME::` the account lacks. One unresolvable reference fails the **whole run**, not just its branch. With `--yes` it publishes and then confirms the published subject (no `.draft.`) is listed.

## Secrets

Values never enter the conversation. Claude handles names; the script handles values and never prints them.

| command | use |
|---|---|
| `secrets list <profile> [--user]` | names only |
| `secrets check <profile> <collection.flow \| pulled flow file>` | which referenced secrets are missing |
| `secrets set <profile> NAME` | reads `~/.config/quiva/inbox/NAME`, which **the user** writes; deleted after a successful write |
| `secrets set <profile> NAME --prompt` | hidden prompt; the user runs it in their terminal |
| `secrets delete <profile> NAME` | only when the user named it; no backup exists |

All of them are dry runs without `--yes`. Default scope is shared (account-wide). Use `--user` only when asked.

Never call `GET /secrets/{key}`, never pass `reveal=true`, and never `cat` the inbox or profiles file. `get` refuses `/secrets` routes for this reason.

## Deleting

Only when the user named the object: `node "$Q" delete <profile> <kind> <id>`, then `--yes` after they confirm.
Flows are deleted as both published and draft. A single row is `delete <profile> record <config_id>/<row id>`.

## After a task

Report the profile and object ids that changed, the backup paths, and anything left pointing at another account.
