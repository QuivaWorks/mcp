# Building a vertical from scratch

You have some rough requirements for a domain — a chat transcript, meeting notes,
a wishlist — and this repository. This document takes you from there to a vertical
that installs into a customer account.

A **vertical** is a bundle of configuration for one industry. Switch it on for an
account and they get a working system on day one. Two exist (`financial_advisor`,
`insurance_broker`); this repo built a third (`crm`) and everything below was
learned doing it.

**Read this whole page before you start.** The mechanical build — writing configs
and creating them — is about a third of the work. The rest is orienting yourself,
verifying what you are told, and diagnosing things that appear to work and don't.
A plan that only covers the building sets you up to ship something broken.

---

## Phase A — Orient before you touch anything

### 1. Read the repo's own documents

In this order:

- **[CLAUDE.md](../CLAUDE.md)** — the working rules. Short.
- **[docs/lessons.md](lessons.md)** — every incident this tooling exists to
  prevent. Shorter.
- **[verticals/README.md](../verticals/README.md)** — the path rule and folder
  semantics.
- **[docs/quiva-mcp-handoff.md](quiva-mcp-handoff.md)** — the long history. Skim
  it; come back when something surprises you.

The one-sentence version of all of it: **this platform fails silently.** A `200`
means the request parsed. It does not mean anything happened. A `wait` node does
nothing. `baseURL` is ignored. An unmatched placeholder renders as an empty
string. All of these return success.

### 2. Get set up, and prove it

```sh
npm install
npm test          # 356 checks, no network. All must pass before you change anything.
```

Credentials live in a per-server `.env`, copied from `.env.example`. Most servers
work with an API key. **`quiva-agents-mcp` needs `QUIVA_API_KEY` left EMPTY and a
bearer token set** — those endpoints read claims from the JWT, and an API key
silently shadows the token.

Bearer tokens last about a day. That interrupted us three times. Fill in
`QUIVA_EMAIL` / `QUIVA_PASSWORD` / `QUIVA_ACCOUNT` instead and the client logs
itself back in.

### 3. Learn to check a claim against the engine

This is the single most valuable skill for this work. Every real blocker we found
was found this way, and none of them would have shown up by probing the API.

```sh
engine/fetch.sh accounts-service/accounts/updateaccount.go
node engine/sync.mjs --list     # every engine file this repo cites
node engine/sync.mjs            # has any cited file changed since we read it?
```

If you have `evari-olympus` cloned, **fetch it properly**:

```sh
git fetch origin '+refs/heads/*:refs/remotes/origin/*'
git rev-list --count HEAD..origin/main
```

A plain `git fetch origin main` writes only `FETCH_HEAD`. We reported a stale
clone as current and documented a filename that had been renamed that morning.

**Reach for the engine whenever the platform returns 200 and nothing happens.**

### 4. Read the deployment contract

Read `deployVerticals` in `accounts-service/accounts/updateaccount.go` before
designing anything. It defines what a vertical actually is:

- Adding an id to an account's `verticals` list **is** the deploy. There is no
  deploy endpoint.
- It is **delta-only** — re-sending an unchanged list does nothing.
- `SHARED` is always appended, so the `Client` contact record comes free.
- It matches files on the index entry's **name**. A blank name means silently
  skipped.
- Only six category names are recognised. Anything else deploys nothing, quietly.
- Flows are **rewritten in flight**: a collection is created and injected, and
  `auto_publish: true` is forced. Never set `collection` in a committed flow.
- Assistants must be `{"config": {...}}`-wrapped or you deploy an empty one.
- Its only output is a stream. The API response tells you nothing.

---

## Phase B — Close the tooling gaps

### 5. Find out what the tooling cannot do yet

For `crm`, creating a folder and writing a file on the platform **did not exist**
in any MCP. Neither route had ever been exercised. Expect to find gaps.

The check is quick: list the tools, look for what your plan needs, and try the
route by hand before assuming it works.

### 6. Build what is missing — with a validator and tests

Anything you add follows the house pattern: a tool, a rule in the local
validator, engine-truth notes in the docs module, and dependency-free tests.

Two rules from CLAUDE.md that matter here:

- **The golden gate.** A validator must accept every configuration that is live
  on the platform. Rejecting working config is a validator bug. Sweep new rules
  across `examples/harvested/` before tightening them.
- Some rules are deliberately **warnings, not errors**, where a list was
  hand-transcribed and will drift. Do not promote those without re-reading the
  source.

### 7. Verify new tooling against the consumer, not the API

Our folder-creation tool reported `verified: true` for eight folders. They were
not visible in the UI. The tool had checked the file index; the user was looking
at the renderer, which needs a field the index entry did not have.

The fix was to stop reporting one boolean and report **two different questions**:
`visible_in_ui` and `will_deploy`. Those are the two consumers, and they disagree.

> **The habit to build:** when a mechanical check goes green, write down which
> consumer it speaks for. If you cannot name one, it is not evidence.

---

## Phase C — Get to a reviewed spec

### 8. Pick an id and make the folders

Lowercase with underscores: `shopping_cart`. It becomes the folder name, the
deploy key, and — capitalised — the flow collection name the platform creates.

```sh
node tools/vertical/create-vertical.mjs shopping_cart
```

One command, both places: the repo and the platform. Seven folders, each verified.

Six names are routing keys and are **not yours to choose**:

```
assistants   document_templates   flows
meeting_templates   record_configs   spaces
```

`specs` is the deliberate seventh — it never deploys, so notes can live there.

If it reports a blank folder name, that is cosmetic: the folder will not show in
the UI tree, but configs inside it still deploy.

### 9. Park the rough requirements

Drop what you have into `verticals/shopping_cart/specs/shopping_cart-rough.md`.
**Do not tidy it up** — imposing structure is the agent's job.

Two things must be true, both of which we got wrong first time:

- **Everything you want is in that one file.** Our products catalogue was asked
  for in an email, not the chat we fed the agent, so it silently never appeared.
- **Say what the platform already provides**, or the agent reinvents it. It
  proposed an `Activity` record duplicating the built-in task system, and a
  `User` record when users already exist.

### 10. Turn it into a build sheet

Invoke the **Vertical Spec Writer**
(`ms.hub.config.agent.c558f816-40e0-305a-806b-c30d0c6dfd17`, config at
[quiva-agents-mcp/examples/authored/vertical-spec-writer.json](../quiva-agents-mcp/examples/authored/vertical-spec-writer.json))
with the rough file as the prompt. Save the result to
`verticals/shopping_cart/specs/shopping_cart.md`.

It emits one section per artifact, each opening with a routing block:

````markdown
## Sales pipeline

```yaml
category: spaces
id: SALES_PIPELINE
name: Sales Pipeline
record_config_ids: [Client, Company]
statuses: [Lead, Qualified, Proposal, Won, Lost]
```
````

[verticals/crm/specs/crm.md](../verticals/crm/specs/crm.md) is a real worked
example. Read it before writing your own.

**Check the output is not empty.** One of our invocations returned
`success: true` with a zero-length result. Check the byte count, not the status.

### 11. Review the build sheet — do not skip this

The agent knows only what its prompt says and **cannot look anything up**, so it
produces plausible inventions. On `crm` it needed five corrections before a single
thing was built:

| What it claimed | Reality |
|---|---|
| a per-user filtered table view | not expressible |
| a table grouped by stage | not expressible |
| two AI tool names | do not exist |
| seven automations | none could work |
| *(omitted)* the products catalogue | explicitly requested, silently dropped |

Check every claim against **[the limits table](#what-the-platform-cannot-do)**.
Anything unbuildable goes in an `## Out of scope` section **with a reason**, so
the spec can be diffed against the original ask and every item accounted for.

This is the step a pull-request review is meant to formalise. Until that exists,
it is a person reading carefully.

---

## Phase D — Build the configuration

### 12. Build in dependency order

**record_configs → spaces → flows → assistants and templates**

Flows reference records and spaces, so those come first.

Write each config as JSON into `verticals/<id>/<category>/`, then run the driver.
Each validates locally, creates on the platform, reads back, and compares field
counts against what was sent.

```sh
node tools/vertical/build-records.mjs shopping_cart Company Product Order
node tools/vertical/build-space.mjs   shopping_cart sales_pipeline.json
node tools/vertical/build-flows.mjs   shopping_cart order-created abandoned-cart
```

Copy conventions from `verticals/crm/` rather than inventing them. Before writing
a form, read `get_records_reference("form-builder")` and `("form-rules")` — long,
and engine truth. Before a flow, read `get_flows_reference("rules-syntax")`; the
condition DSL is `{condition, outcome}`, **not** `{if, then, else}`, and the
editor's own labels make the wrong shape look right.

### 13. Open every one in a browser

A stored config is not a working one. This repo exists because a document
template passed every mechanical check and produced blank PDFs.

Confirm the form renders, dropdowns have options (an enum with no `options`
renders an empty picker nothing can be chosen from), and conditional fields
appear and disappear as intended.

### 14. When something looks fine but isn't, read the engine

Three examples from `crm`, each of which cost a cycle and each resolved by
reading source rather than retrying:

- A scheduled flow failed to publish with `invalid duration format for:` — an
  empty value. The cause: `trigger_on` is required, and without it the code falls
  through to parsing a field the trigger payload has no slot for.
- An object upload returned `200` and stored nothing. Object writes are **POST**,
  not PUT. Caught only by byte-comparing the read-back.
- A folder marker with a blank name looked like a deploy blocker. It is only a UI
  one — deploy skips markers by suffix and matches each config on its own name.

---

## Phase E — Prove it works

### 15. Design a controlled test

Reading source tells you what should happen. A controlled test tells you what
does. For `crm` the question was whether automations run when a person saves a
record, and the test was two identical £80,000 deals:

| how it was saved | tasks created |
|---|---|
| the normal way, as the app does | **0** |
| the same, plus `completed: true` | **2** |

That converted "I read the code and think this is a problem" into a reproduction
with a measured difference. Always prefer the second.

### 16. Diagnose precisely enough to hand over

When you find a platform fault, write it up with file and line numbers, the
call chain, and what makes it silent. Ours went:

> `RepublishRecord` (`records-service/handler/records.go:386`) is the only
> publisher of record events; both call sites are gated on `completed == true`
> (lines 74, 327). The frontend never sends it —
> `microstrate/src/stores/records.store.ts:277` sends `{data, space_id, folder}`
> and `:309` sends `{data}`. So record automations are unreachable through normal
> use, silently.

Also say what it would break to fix it. Turning that flag on switches automations
on **platform-wide**, including for the two live verticals, possibly for the first
time against real customer data.

---

## Phase F — Package and install

### 17. Push to the template area

```sh
node tools/vertical/push-vertical.mjs   shopping_cart
node tools/vertical/verify-vertical.mjs shopping_cart
```

Copies every file to `spaces.VERTICAL.<id>.<category>.<name>.json` and confirms
`will_deploy` on each. **A file whose index entry has a blank name is silently
skipped at deploy.**

Binary files are not pushed — the vertical carries the template *config*, and a
`.docx` lives in `microstrate-documents`. Upload it with a **POST** to
`/api/default-storage/object/<bucket>/<key>`.

For a document template, extract the placeholders from the DOCX and key the
payload to exactly those names:

```sh
python3 -c "import zipfile,re;print(sorted(set(re.findall(r'{[^{}]{1,60}}', zipfile.ZipFile('x.docx').read('word/document.xml').decode()))))"
```

A placeholder with no matching payload key renders as an empty string, silently,
and the job still reports success.

### 18. Install into a clean account

Add the vertical id to the account's `verticals` list, then **read the stream**:
`microstrate-accounts.<account_id>.deploy-verticals`, one message per config with
`{name, vertical, config_type, subject, status, error}`.

Use an account that does **not** already have the resources. Deploying into the
account you built in proves nothing — a success message is indistinguishable from
the resources already being there.

Then open the account and look at it. Done means you can see the forms.

---

## Phase G — Leave it better than you found it

### 19. Record every limit you found

Add it to the table below, and to the spec agent's instructions so the next spec
does not promise it. Cite the engine file by path, then run
`node engine/sync.mjs --pin`.

### 20. Promote your throwaway scripts

The drivers in [tools/vertical/](../tools/vertical/) began as scratch files. If
you write something that works twice, move it into the repo and parameterise it.

### 21. Never commit anybody's identity

Harvest tools strip credentials and PII. Authored examples use placeholder UUIDs
and real values are substituted at push time. A colleague's name has leaked into
a committed example before, via `time_tracking.logs[].user.name`.

---

## What the platform cannot do

Every one of these was found by reading engine source, not by anything failing.
Design around them from the start.

| Limit | What it means for you |
|---|---|
| **Record automations do not fire from the UI** | The save button omits a required flag. Any "react when someone saves X" automation never runs. Assume the record-triggered half of any vertical does nothing until this is fixed. |
| **Flows cannot loop** | A flow reads many records but writes to one. No foreach, no fan-out. Use a digest — one summary task per run. |
| No kanban anywhere | No board view exists, for records or tasks. |
| Table views are columns only | No sort, no filter, no grouping. |
| JSON Schema has no computed fields | Every derived value is a flow or a form rule. |
| Tasks have no typed custom fields | `metadata` is an untyped bag: no validation, no form, no typed column. |
| A `value` form rule cannot be overridden | It recomputes on every change. Choose automatic or manual, not both. |
| Record triggers cannot filter by field | Only by config id and event type. No before/after values either. |
| Scheduled flows need `trigger_on` | An absolute first-run timestamp, plus `trigger_every` as a duration like `24h`. Publish fails without it. |
| A record-trigger node id must be `record.<config_id>` | It contains a dot, so send the flow with `server_validate=false` — and **publish it**, because a draft trigger is dead. |
| Object writes are POST | A PUT returns 200 and stores nothing. |
| Agent invoke can return empty | `success: true` with a zero-length result. Check the length. |
| Node's fetch gives up at 300s | A long agent invoke dies with a bare `fetch failed`. |

---

## Where things are

| | |
|---|---|
| Worked example | [verticals/crm/](../verticals/crm/) — 16 deployable configs |
| The example spec | [verticals/crm/specs/crm.md](../verticals/crm/specs/crm.md) |
| Path rule and folder semantics | [verticals/README.md](../verticals/README.md) |
| Build drivers | [tools/vertical/](../tools/vertical/) |
| Lessons and post-mortems | [docs/lessons.md](lessons.md) |
| Full history and open questions | [docs/quiva-mcp-handoff.md](quiva-mcp-handoff.md) |
| Flow playbook | [docs/quiva-flows-mcp-playbook.md](quiva-flows-mcp-playbook.md) |

---

## If you remember one thing

**Never trust a write response.** Read the resource back and check the field you
set. `delete_workflow` returns `{"message":"success"}` while orphaning drafts.

**Verify against the consumer, not the API.** For a document, open the PDF. For a
form, render it. For a deploy, read the stream.

**When a mechanical check passes, ask what it did not look at.**
