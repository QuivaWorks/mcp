# Antipodean flows — what is live, and what is retired

`build-flows.mjs` takes flow names **explicitly** on the command line and never
scans this directory, so a file sitting here is inert until someone names it.
That is why a retired flow is recorded rather than deleted — and why this file
has to exist, because nothing else here distinguishes the two.

## Live

`underwriting-evaluate` · `quote-bind` · `invoice-overdue` · `policy-void` ·
`renewal-generate` · `renewal-dispatch` · `quote-expiry` · `referral-decide` ·
`lifecycle-reconcile` · `policy-reinstate` · `mta-renewal-collision` ·
`claim-intake` · `send-templated-email` · `lookup-resolve` ·
`distribution-ingress-rate` · `distribution-ingress-bind` · `decision-project` ·
`outcome-materialise`

`*.gateway.json` files are **not** flow definitions. They are the reproducible
record of the three API calls that made a route, because there is nowhere else in
this repo that records a mapping.

## Retired — do not install

| File | Superseded by | Why it is still here |
|---|---|---|
| `occupation-lookup.json` | `lookup-resolve.json` | The flow and its mapping are **deliberately left live** in `antipodean_build`. Deleting a flow orphans its drafts, and a gateway mapping cannot be removed at all — `DELETE`/`PATCH` on a tenant gateway's mapping and mapping/version both **405**. Nothing points at it any more. |
| `occupation-lookup.gateway.json` | `lookup-resolve.gateway.json` | Same route, same reason. |

**Do not name either on a `build-flows.mjs` run.** Installing them would recreate
a live-but-unreferenced flow, which is the state this note exists to prevent.

`lookup-resolve` replaced `occupation-lookup` because it is one flow, one mapping
and five kinds branched on a `kind` body field — so adding a kind is an edit to
**contract artefact 7's** table rather than a new flow and a new route. It closed
open questions **A-06** and **A-07** together.

## The source of record for `lookup-resolve`

`lookup-resolve.json` here is a **copy**. It is authored by
`docs/antipodean spec/flows/build-lookup-resolve.mjs` in the `evari-olympus`
repo, where the reasoning lives — the credential swap, the spend bound, and why
the six `GO_*` gates exist. **Edit there and re-copy; never edit the JSON.**

One asymmetry that must survive any edit: `GOOGLE_PLACES_KEY` is provisioned
(account-**shared** scope) and its two nodes carry a real `SECRET::` reference,
while the two ABR nodes keep an inert sentinel spelled with hyphens. An
unresolvable `SECRET::` reference fails the **whole run** closed, not the branch
using it — `ReplaceSecretValues` scans the entire serialised node set before the
graph is built. So swapping `ABR_GUID` in early would not degrade the ABN branch;
it would take `occupation` down with it, with a 400 at run start that looks
nothing like an ABR problem.
