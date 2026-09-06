# Working in this repo

Five MCP servers that let an agent build real Quiva configuration. See
[README.md](README.md) for what each one does and how to set it up.

## The defect class this repo exists to prevent

Read [docs/lessons.md](docs/lessons.md) first — it is short. The pattern behind
every incident in it is the same:

> Tooling was verified against the spec of the day, and never re-checked against
> the renderer or the engine that actually consumes the output.

The consequence is that **the platform's failures are silent**. A `wait` node does
nothing. `baseURL` is ignored. An agent payload missing its `agent` wrapper is
dropped. An unmatched `{placeholder}` renders as an empty string. All of these
return 200.

The most recent example is worth internalising: a certificate template was pushed,
the trigger was queued, documents were generated, byte sizes differed between
variants — every mechanical check green — and every PDF came out blank, because
the payload keys were snake_case and the DOCX placeholders were camelCase. Zero
overlap. Nothing errored.

So:

- **Never trust a write response.** Read the resource back and check the field you
  set. `delete_workflow` returns `{"message":"success"}` while orphaning drafts.
- **Verify against the consumer, not the API.** For a document, open the PDF. For a
  form, render it. A 200 means the request parsed, nothing more.
- **When a mechanical check passes, ask what it did not look at.**

## Reaching the engine source

Claims here about how the platform behaves are backed by files in
`myevari/evari-olympus`. You do not need it cloned:

```sh
engine/fetch.sh workspaces-service/handler/tasks.go
engine/fetch.sh hub-service/handler/agents.go | sed -n '380,460p'
node engine/sync.mjs --list      # every path we cite, and who cites it
node engine/sync.mjs             # has any cited file changed since we read it?
```

Reach for this whenever the platform returns 200 and nothing happens. That class
of bug is invisible from outside — someone has to read the handler. Probing the
API only finds the loud failures.

If you establish a new engine fact, cite the file by path in the same style as the
surrounding docs, then run `node engine/sync.mjs --pin` so it is pinned.

## The golden gate

Each validator must **accept every configuration that is live on the platform**. A
validator that rejects working config is a bug in the validator, not in the config.
Before tightening a rule, sweep it across the harvested corpus.

This is why `examples/harvested/` matters: those are real configs pulled from the
platform, so they are proof. `examples/authored/` are hand-written and prove
nothing until pushed — that is what the `test:e2e` scripts and
`tools/push-example.mjs` are for.

Some validator rules are deliberately **warnings rather than errors** where a list
was hand-transcribed and will drift. Do not promote those to errors without
re-reading the source; that mistake has been made once already.

## Examples must carry nobody's identity

Harvest tools strip credentials and PII. Authored examples use placeholder UUIDs,
and `tools/push-example.mjs` substitutes real accounts at push time. A colleague's
name has leaked into an example file through `time_tracking.logs[].user.name`
before. Never hard-code a real person into a committed file.

## Conventions

- Tests are dependency-free `node:test`-style scripts: `npm test` runs all five
  suites (356 checks) with no network.
- `npm run harvest` re-pulls the live corpus. Run it after platform changes; if the
  validators still accept everything, the corpus is current.
- `verticals/` holds vertical templates authored for the `VERTICAL` space (see
  [verticals/README.md](verticals/README.md)). One path rule:
  `verticals/<v>/<category>/<name>.<ext>` <-> `spaces.VERTICAL.<v>.<category>.<name>.<ext>`.
  The category folder is a **routing key** — an unrecognised name deploys nothing
  and says nothing. `specs/` is the one folder that deliberately never deploys.
- Credentials live only in per-server `.env` files. `.env.example` files must stay
  blank — a live staging key has been committed to one before.
- `quiva-agents-mcp` needs `QUIVA_API_KEY` **empty** and a bearer token set; the
  agent endpoints read JWT claims.

## Ground rules carried over

- Do not press **Save schema** on the `risk_programme` record config in the UI. A
  frontend bug deletes any field named `type`, and saving persists the deletion,
  taking four form rules with it.
- Frontend fixes in `evari-olympus/microstrate` are **out of scope** here. Several
  are diagnosed and drafted in the handoff, awaiting approval in that repo.
