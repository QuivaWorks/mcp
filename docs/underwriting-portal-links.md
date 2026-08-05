# Insurance Underwriting Portal — links

Builders Risk. Built 4 August 2026 on Quiva. Full walkthrough:
[underwriting-portal-explained.html](underwriting-portal-explained.html).

**Status key** — Live: works now. Inert: built and correct, but does not start on
its own (the record Save button omits a flag the automation needs). Waiting:
created at install time, so nothing exists to open yet.

## Forms

| | Status | Link |
|---|---|---|
| Quote — 47 fields, conditional questions | Live | https://app.microstrate.io/en/hub/records/configs/UWQuote |
| Policy — 29 fields | Live | https://app.microstrate.io/en/hub/records/configs/UWPolicy |
| Applicant — 8 fields | Live | https://app.microstrate.io/en/hub/records/configs/UWClient |

## Workspace

| | Status | Link |
|---|---|---|
| To-do list (4 test jobs in it) | Live | https://app.microstrate.io/en/hub/spaces/UNDERWRITING/tasks |
| Applicants, quotes, policies | Live | https://app.microstrate.io/en/hub/spaces/UNDERWRITING/records |
| A job the system wrote itself | Live | https://app.microstrate.io/en/hub/spaces/UNDERWRITING/tasks?task=UNDERWRITING-2 |

## Automatic helpers

| | Status | Link |
|---|---|---|
| Quote Pricing | Inert | https://app.microstrate.io/en/hub/flows/ms+hub+config+workflow+3184361339+3685425597 |
| Quote Acceptance → Policy | Inert | https://app.microstrate.io/en/hub/flows/ms+hub+config+workflow+3184361339+3737665316 |
| Daily Renewal Scan (07:00 UTC) | **Live** | https://app.microstrate.io/en/hub/flows/ms+hub+config+workflow+3184361339+695113787 |
| All helpers + run history | | https://app.microstrate.io/en/hub/flows |
| What is scheduled | | https://app.microstrate.io/en/hub/scheduled |

## Paperwork

| | Status | Link |
|---|---|---|
| Both templates (Quotation, Policy Schedule) | Live | https://app.microstrate.io/en/hub/account?tab=specialization |
| Generated PDFs + template sources | Live | https://app.microstrate.io/en/hub/resources/storage/obj/manage?bucket=microstrate-documents |

## Packaged for install

| | Status | Link |
|---|---|---|
| 11 components ready to switch on | Not installed anywhere | https://app.microstrate.io/en/hub/spaces/VERTICAL/files |

## No link yet

Underwriting Assistant and Underwriter Meeting Summary are written and packaged,
but both are created at the moment the portal is installed into an account.

## Best first click

The [Quote form](https://app.microstrate.io/en/hub/records/configs/UWQuote) —
turn on "Prior losses?" and switch project type between New Construction,
Renovation and Demolition to see the questions change.
