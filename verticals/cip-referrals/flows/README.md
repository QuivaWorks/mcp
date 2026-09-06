# CIP referral flows

Three flows joining evari-mordor CIP (Builders Risk / Toolbox) to the
`CIP_REFERRALS` space on QuivaWorks. Authored source of truth; nothing here
deploys itself.

```
mordor: broker submits referral
   └─ collation QUIVA_CREATE_REFERRAL_TASK ──POST──▶ cip-referral-intake (webhook)
                                                        creates decision record
                                                        creates task
                                                        seeds decision form action
                                                        sets status
                                                        creates submission (completed:true)
                                                                    │ record trigger
                                                                    ▼
                                                        cip-referral-research
                                                          agent + bit://web_search
                                                          writes research record
                                                          copies headline to decision
                                                          task -> In Review
                                                                    │
                                          underwriter fills the decision form,
                                          switches on "Submit this decision to CIP"
                                                                    │ record trigger
                                                                    ▼
                                                        cip-referral-decide
                                                          gets a mordor AT (route undecided)
                                                          writes the decision fields
                                                          presses the mordor button
                                                          task -> approved/declined/awaiting_broker
   ◀── mordor collations do the rest: emails, BR_REFERRALS de-index, quote unlock
```

## The governing rule

**Quiva never re-implements underwriting and never sends an email.** `referral-decide`
sets exactly the answers a human underwriter sets, so `CHANGE_UW_DECISION`,
`UNDERWRITER_APPROVED`, `UNDERWRITER_DECLINED` and `UNDERWRITER_INFO_REQUESTED` fire
unchanged and send the SendGrid templates CIP already uses. Accept also sets
`CIP_BR_accept_refer_rules_button`, which is the quote unlock.

## Install order

1. `cip-referral-research` and `cip-referral-decide` carry RECORD triggers, so:
   - the node id is `record:<config_id>` — a COLON, not a dot. Hub globs the node
     subject as `ms.hub.config.workflow-node.*.*.record:<config_id>`, and a dot would
     split the id into two subject tokens. This needs no `server_validate=false`
     bypass; it passes `validate=true`. (See "the record-trigger fix" below.)
   - **publish them.** The trigger glob matches published node subjects only. A record
     trigger on a draft flow does nothing, silently.
2. `cip-referral-intake` is triggered by a **webhook** — see the next section. It is
   live on staging today.
3. `$AUTHENTICATE/CONFIG/QUIVAWORKS` in mordor is NOT ready to create. QuivaWorks is
   not an IdP and the mechanism that does exist lets the caller choose the identity.
   Read `evari-mordor/cloudstream/output/cip-test/authenticate.quivaworks.README.md`
   before doing anything on the write-back path.

## The intake trigger is a webhook, not a raw trigger

A webhook trigger IS a gateway mapping. The flow editor creates one behind the scenes
and the node's `data.subject` is the mapping subject
(`trigger-type.component.svelte:18`: a node is treated as a webhook when its subject
contains `.webhook-`). So "gateway trigger" and "webhook trigger" are the same
mechanism reached two ways, and the webhook is the one to use: it mints the per-flow
path, and an `msr-` key can be scoped to exactly that path.

Live on staging:

```
gateway  ms.gateway.Nrlz-Pmv8qiH.gateway        ("default-gateway")
mapping  ms.gateway.Nrlz-Pmv8qiH.mapping.post.webhook-4273291493-638137998
version  1, resource ms.hub.config.workflow.4273291493.638137998, resource_type flow
URL      https://nrlz-pmv8qih.microstrate.io/webhook/4273291493/638137998
key      msr-, name "cip-referral-intake", scoped {post, /webhook/4273291493/638137998,
         gateway_id Nrlz-Pmv8qiH}
```

Verified 2026-09-06: no key -> `401`; correct key + `{}` -> the flow runs and stops at
`GATE` as designed. The path encodes `<collection topic>/<flow topic>`.

**Do not call `api.microstrate.io/hub/workflows/run` instead.** That is the platform's
generic run endpoint on an alias that belongs to the microstrate main account only;
every other account is served at `<gateway-id>.microstrate.io`. `quivaApiRoot` in
`config.static` is a different thing — it is the platform API root for the records
calls, which have no `quiva-endpoint` equivalent, and it is correct at
`api.microstrate.io` for staging / `api.quiva.ai` for production. Anything that is
account-scoped must come from the account's own gateway.

### Two frontend bugs found while doing this — both reproduced from live data

Neither is in these flows; both are in `evari-olympus/microstrate`.

1. **The create-webhook modal scopes its API key to the gateway SUBJECT, not the
   gateway id.** `flow-trigger-webhook-modal.component.svelte:181-183` reads
   `gatewayOptions.find(...)?.value`, and those options are built with
   `value: item.subject` (`gateway.services.svelte.ts`, `getGateways`). The node
   editor gets this right — `trigger-webhook.component.svelte:103` uses
   `gateway?.subject?.split('.')[2]`.
   Enforcement matches the pattern `/<gateway_id><path>` against the request path
   segment by segment (`bellerophon-cerberus/http/middleware/ms_auth.go:63-75,116`),
   so a subject in that slot makes a 5-segment pattern that can never match a
   4-segment path. The key authorises nothing, and because the modal also sets
   `is_public: false`, the webhook is left unreachable.
   Live evidence: key `webhook/4273291493/638137998` carries
   `gateway_id: "ms.gateway.nrlz-pmv8qih.gateway"`.

2. **The duplicate-mapping fallback builds the wrong node subject.**
   `flow.component.svelte:1726` composes
   `` `...post.webhook-${collection}-${getCollectionTopicFromFlowSubject(subject)}` ``,
   but `getCollectionTopicFromFlowSubject` is `split('.').at(-2)` — the COLLECTION
   again, where the flow topic belongs (`flow.services.ts:511`). The real mapping is
   `webhook-<collection>-<flow>`. This runs on the 400 "this mapping already exists"
   branch, i.e. on the retry after any first failure, so the node ends up pointing at a
   mapping that does not exist: the editor's `getGatewayMapping` finds nothing, Save is
   disabled on `!mapping`, and generating a key there names it after the phantom path.
   Live evidence: key `webhook/4273291493/4273291493`, and mapping
   `webhook-3930917318-3930917318` in another collection.

Together these are the "error when saving a webhook with an msr key": the first attempt
mints a dead key, the retry hits the duplicate branch and produces an unsaveable node.
The mapping and version created by the first attempt are fine — that is why the URL
above works once a correctly scoped key is minted over the API.

## Ordering rules that are load-bearing

- **Seed the task action BEFORE setting the status.** Writing an action recomputes the
  task status (`workspaces-service/handler/task_actions.go:50-98`): 0 done -> role
  `todo` else `default_status`, all done -> role `done`, some done -> role `working`.
  Verified live 2026-09-05: a task set to `in_review` came back `open` after one
  undone action was written.
- **Create the submission LAST**, with `completed: true`. That write is what fires
  `cip-referral-research`, and it carries `task_id`/`decision_id` so research needs no
  lookup. A record write without `completed: true` publishes nothing at all.
- `CIP_REFERRALS` deliberately declares no `todo` role and puts `closed` (role `done`)
  last, so the status recompute can only ever land on `open`, `in_review` or `closed` —
  never on `approved`/`declined`. Do not add a `todo` role.

## Other traps carried in

- Agent results are markdown-fenced strings even with `output_schema`. `PARSE` extracts
  with `String(r).match(/\{[\s\S]*\}/)` before parsing — never bare `JSON.parse`.
- Records update with **PUT**; PATCH returns 500 despite the OpenAPI spec.
- `task` nodes: `operation` sits on `data.operation`, not in the payload, and omitting
  `space_id` silently falls back to ESCALATE. status/priority/tags are free strings
  server-side, so a value the space does not define is stored and the task then matches
  no filter and vanishes from every board.
- HTTP nodes use `base_url`, never `baseURL`; safest is a full URL in `url`.
- A digit-leading string in `config.static` is JSON-parsed into a NUMBER by the flows
  MCP. Coerce with `String()` inside evals — every eval here already does.

---

## Verified live on staging, 2026-09-06

Hub carries the record-trigger fix (evari-olympus `bfb3da01c`), so the colon form works:

- `cip-referral-decide` and `cip-referral-research` were created with node ids
  `record:<config_id>` and **`validate=true`** — no `server_validate=false` bypass.
- **A record trigger dispatched for the first time.** Creating a `cip_referral_decision`
  with `completed:true` produced run `7c7bb6af`. The mechanism the reference called
  never-observed is now observed.
- **Full chain proven:** `cip-referral-intake` ran to completion (decision `gcILuG8nRC`,
  submission `fqtskjafUk`, task `CIP_REFERRALS-3`), the submission write fired
  `cip-referral-research` via its record trigger ~20s later, and the task ended in
  `in_review` with the decision form action attached and the record linked.

### Four traps this cost, all silent

1. **eval `code` is an EXPRESSION, not a function body.** A bare `return` is
   `SyntaxError: Line 1:1 Illegal return statement` at RUN time — nothing catches it
   earlier. Wrap multi-statement logic in an IIFE: `(() => { ...; return x; })()`.
   Every eval here does. `test_eval` runs the real evaluator — use it before deploying.
2. **An http node's request body is `payload.data`, NOT `payload.body`.** A `body` key is
   silently ignored and the request goes out EMPTY. That produced a bare `400` with no
   detail, because an http node also discards the response body on 4xx. The tell is a 400
   on a call that succeeds byte-identically through the API.
3. **An http node's RESULT is `{status, statusText, headers, data}`** — the response body
   is under `.data`, not `.body`. `$.NODE.body.id` resolves to nothing, so a URL built
   from it loses its last segment and 405s (method not allowed on the collection path)
   rather than 404ing.
4. **An agent node with tools could report success and return NOTHING.** With
   `has_tools: true` + `bit://web_search` on a thinking-capable model, the node returned
   `success: true, complete: true, error: ""` and an EMPTY `result`. The real error was
   buried in `events[].choices[].message` as `callable tool execution failed: agent
   error: API error (status 400): "messages.1.content.0.thinking.thinking: Field
   required"` — agent-service replayed a thinking+tool_use turn without the `thinking`
   field. **Fixed in agent-service and deployed 2026-09-06** (evari-olympus
   `f7b03d306`); RESEARCH now runs on `claude-sonnet-4-6` and the pin to
   `claude-haiku-4-5` has been lifted. PARSE keeps its `events` fallback anyway, so an
   empty `.result` still cannot pass as a clean partial run.

`bit://web_search` returns snippets and links, but fetching a page is often blocked —
the research prompt tells the agent to work from what search returns and say so when it
could not read a source, rather than inferring.

### Throwaway probes
Deleted 2026-09-06. Note that deleting a flow does NOT remove its `workflow-node`
subjects from the config stream (`DeleteWorkflowHandler` removes the workflow and its
list snapshot only), so a deleted record-trigger flow keeps matching the dispatch glob
and its run fails with `resource not found` for good. Harmless once hub carries the
continue-on-error fix (evari-olympus `8e874d179`); before that it could take the other
flows on the same record config down with it, depending on map iteration order.

## Verified end to end on cip-test, 2026-09-06

Driven from the admin UI by `evari-mordor/test-harness/cip/ais-test-harness`
(`npm run refer`) against a real Builders Risk quote that referred:

```
Submit referral -> QUIVA_CREATE_REFERRAL_TASK -> webhook -> cip-referral-intake
  decision APKTVuutcS + task CIP_REFERRALS-9 + submission (completed:true)
    -> cip-referral-research: summary, confidence, red flags; task -> in_review
      -> decision set -> cip-referral-decide: basic-auth login, answers written
```

Mordor ended at `CIP_BR_underwriting_decision: ACCEPTED`,
`CIP_BR_Referral_Status: CLOSED`, `CIP_BR_Status: ACTIVE`, referral rules cleared —
the quote unlocked. Task ended **approved**.

Three schema-contract bugs were fixed on the way, all of which broke a write silently:

- `submitted_at` is `format: date-time` but mordor's `CIP_BR_ReferredDate` is a plain
  date, so `CREATE_SUBMISSION` 400d and research never fired. BUILD now coerces to ISO
  and falls back to now, so a missing referred date cannot break the chain either.
- `write_back_at` was being sent `$.env.run_id` — a uuid, into a `date-time` field.
  BUILD now computes `stampedAt`, and STAMP sets `decided_at` from it too.
- `sources` items are objects `{title,url,note}`; an agent returning bare URL strings
  would have failed validation and lost the whole research record. PARSE coerces.

Only the **accept** branch of `cip-referral-decide` has been driven end to end.
`decline` and `request_info` set different answers and send a different CIP email.
