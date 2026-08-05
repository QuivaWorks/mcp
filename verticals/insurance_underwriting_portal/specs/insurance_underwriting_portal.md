# Insurance Underwriting Portal vertical

> Produced by the Vertical Spec Writer from `Builders.md`, then reviewed and
> corrected against the engine on 2026-08-04. Every change made during review is
> listed in [Review corrections](#review-corrections) at the foot of this file,
> with the reason. Read that section before building — three of the corrections
> are the difference between a vertical that deploys and one that does not.

## Overview

This vertical supports commercial insurance underwriters managing Builders Risk quotes and policies through the full lifecycle: quote creation, pricing, acceptance, policy issuance, and renewal. The core modelling decisions are:

1. **Quotes and Policies are record configs**, not tasks — they carry structured data that needs validation, conditional forms, and document generation.
2. **Tasks track underwriter work items** (review a quote, send a renewal, complete setup) in the UNDERWRITING space; the space's status list models the task pipeline, not a deal pipeline.
3. **Pricing fields are stored values written by a flow**, not computed schema fields — JSON Schema has no derived values.
4. **Reference numbers derive from record IDs**, not sequential counters — the platform cannot mint gap-free sequential numbers.
5. **All notifications become tasks** — no notify node exists; every "alert the underwriter" step creates an assigned task instead.

---

## Underwriting

```yaml
category: spaces
id: UNDERWRITING
name: Underwriting
record_config_ids: [Client, UWClient, Quote, Policy]
statuses: [Open, In Progress, Completed, Cancelled]
```

`Client` here is the SHARED personal-contact record every account already has —
referenced, not defined. `UWClient` is this vertical's commercial applicant record.
Statuses match the four asked for in §3.7.2; the agent had proposed Blocked/Done.

Tasks in this space represent underwriter work: reviewing a priced quote, sending a renewal, completing policy setup. One task per action, assigned to the responsible underwriter. The status list is a simple workflow for task completion, not a quote pipeline — quote and policy status live on the records themselves.

---

## UWClient

```yaml
category: record_configs
id: UWClient
name: Underwriting Client
```

> **Renamed during review — do not change this back to `Client`.** A record config
> with id `Client` ALREADY EXISTS in the account: it is the shared personal-client
> record used by `financial_advisor` (dob, marital status, dependents, income,
> assets, liabilities, risk profile), and `SHARED` is appended to every deploy.
> `CreateRecordConfigHandler` (`records-service/handler/config.go:47`) returns
> **409 "a record config with this id already exists"**, and `deployVerticals`
> forwards vertical configs to the CREATE subject `microstrate.records.post.config`
> — so shipping a `Client` config here does not overwrite the financial-advisor
> record, it simply FAILS at deploy and this vertical arrives with no applicant
> record at all. The failure appears only in the deploy stream; the API says nothing.
> Platform precedent for a per-vertical client record is a scoped id: `FACLIENT`,
> `IBCLIENT`, `insurance_client` all exist.

| field | type | required | notes |
|-------|------|----------|-------|
| legal_name | string | yes | |
| business_address | string | yes | |
| contact_name | string | yes | |
| contact_phone | string | no | |
| contact_email | string | no | format: email |
| license_number | string | no | |
| years_in_business | integer | no | min: 0 |
| business_type | enum | no | Contractor, Developer, Owner, Other |

Form: single-column grid. No conditional rules required.

Quote and Policy records for an applicant are filed under a per-applicant **folder**
(§3.1.2). Records carry a `folder` field — `records-service/model/api.go:199` on
create and `:209` on update — so folder-per-client organisation is expressible.

---

## Quote

```yaml
category: record_configs
id: Quote
name: Quote
```

### Schema

| field | type | required | notes |
|-------|------|----------|-------|
| quote_reference | string | no | written by flow; format `Q-{record_id}` — not sequential. NOT required: the flow that writes it does not fire on a UI save, so a hand-created quote would fail validation on a required field nobody can fill. |
| client_id | string | yes | references a UWClient record |
| status | enum | yes | Draft, Submitted, Priced, Accepted, Declined, Expired |
| quote_date | date | no | |
| validity_days | integer | no | default 30 |
| underwriter_id | string | no | references user |
| **Insured** | | | |
| insured_name | string | yes | |
| insured_address | string | yes | |
| insured_contact | string | no | |
| insured_phone | string | no | |
| insured_email | string | no | format: email |
| insured_license | string | no | |
| insured_years_in_business | integer | no | min: 0 |
| prior_loss_history | boolean | no | |
| prior_loss_details | string | no | |
| **Project** | | | |
| project_name | string | yes | |
| project_address | string | yes | |
| project_type | enum | yes | New Construction, Renovation, Demolition |
| renovation_scope | string | no | |
| demolition_permit | string | no | |
| start_date | date | no | |
| completion_date | date | no | |
| construction_type | enum | no | Wood Frame, Masonry, Steel |
| square_footage | number | no | |
| stories | integer | no | min: 1 |
| contract_value | number | no | |
| **Coverage** | | | |
| tiv | number | yes | Total Insurable Value |
| coverage_limits | number | no | |
| deductible | number | no | |
| special_requirements | string | no | |
| exclusions | string | no | |
| **Risk** | | | |
| site_security | string | no | |
| temporary_structures | boolean | no | |
| hazardous_materials | boolean | no | |
| adjacent_concerns | string | no | |
| additional_risk_factors | string | no | |
| location_zone | enum | no | Urban High Risk, Urban Standard, Suburban, Rural |
| **Pricing (written by flow)** | | | |
| base_rate | number | no | stored by pricing flow |
| base_premium | number | no | stored by pricing flow |
| duration_modifier | number | no | stored by pricing flow |
| construction_modifier | number | no | stored by pricing flow |
| experience_modifier | number | no | stored by pricing flow |
| location_modifier | number | no | stored by pricing flow |
| total_premium | number | no | stored by pricing flow |
| **Documents** | | | |
| quote_document_key | string | no | object-store key/URL to generated DOCX |
| linked_policy_id | string | no | set when quote accepted |

### Form rules

| condition | action |
|-----------|--------|
| `prior_loss_history == true` | show `prior_loss_details` |
| `project_type == "Renovation"` | show `renovation_scope` |
| `project_type == "Demolition"` | show `demolition_permit` |

Form layout: two-column grid. Insured section, then Project, Coverage, Risk sections each in collapsible groups. Pricing fields render read-only.

### Table view

Columns: `quote_reference`, `insured_name`, `project_name`, `project_type`, `tiv`, `total_premium`, `status`, `quote_date`.

---

## Policy

```yaml
category: record_configs
id: Policy
name: Policy
```

### Schema

| field | type | required | notes |
|-------|------|----------|-------|
| policy_reference | string | yes | written by flow; format `BR-{year}-{record_id}` — not sequential |
| originating_quote_id | string | yes | references Quote |
| status | enum | yes | Active, Expired, Cancelled, Renewed |
| issue_date | date | yes | |
| inception_date | date | yes | |
| expiration_date | date | yes | |
| underwriter_id | string | no | |
| **Policyholder** | | | |
| insured_name | string | yes | |
| insured_address | string | yes | |
| insured_contact | string | no | |
| insured_phone | string | no | |
| insured_email | string | no | |
| **Project** | | | |
| project_name | string | yes | |
| project_address | string | yes | |
| project_type | enum | yes | New Construction, Renovation, Demolition |
| construction_type | enum | no | Wood Frame, Masonry, Steel |
| square_footage | number | no | |
| stories | integer | no | |
| **Coverage** | | | |
| tiv | number | yes | |
| coverage_limits | number | no | |
| deductible | number | no | |
| special_conditions | string | no | |
| premium | number | yes | |
| **Payment** | | | |
| payment_status | enum | no | Pending, Paid, Overdue, Cancelled |
| payment_terms | string | no | |
| payment_due_date | date | no | |
| payment_method | string | no | |
| **Documents** | | | |
| policy_schedule_key | string | no | object-store key/URL to generated DOCX |
| renewal_policy_id | string | no | set when this policy is renewed |

Form: two-column grid, sections for Policyholder, Project, Coverage, Payment. `policy_reference`, `issue_date`, `originating_quote_id` render read-only.

### Table view

Columns: `policy_reference`, `insured_name`, `project_name`, `inception_date`, `expiration_date`, `premium`, `payment_status`, `status`.

---

## quote-pricing

```yaml
category: flows
id: quote-pricing
name: Quote Pricing
trigger: record
fires_from_ui: false
```

**Trigger**: Quote record written with `status = "Submitted"`.

**What it does**:

1. Validate required fields (insured_name, project_name, project_type, tiv). If missing, write `status = "Draft"` and create a task "Quote [quote_reference] missing required fields" assigned to `underwriter_id`.
2. Look up base rate by `project_type`:
   - New Construction → 0.35
   - Renovation → 0.45
   - Demolition → 0.55

   **Put every rate and modifier table in the flow's `config.static`, not inline in
   the eval code.** §3.3.4 asks for rating logic that can be changed without a code
   change; static variables are editable as data in the flow editor and reachable as
   `$.static.base_rates` etc., whereas numbers buried in a JavaScript string are not.
   This is the closest the platform gets to the requirement — it is a config change,
   not a business-user change, so say so rather than claiming the requirement is met.
3. Calculate `base_premium = (tiv / 100) * base_rate`.
4. Determine modifiers from schema fields (duration from start/completion dates, construction_type, insured_years_in_business, location_zone) using the tables in the requirements.
5. Calculate `total_premium = base_premium * duration_modifier * construction_modifier * experience_modifier * location_modifier`. Enforce minimum $500.
6. Write pricing fields and `status = "Priced"` back to the Quote.
7. Create a task in UNDERWRITING: "Review priced quote: [project_name]" assigned to `underwriter_id`, status Open.

**Manual alternative (fires_from_ui: false)**: Today, changing a quote's status to "Submitted" through the form does not trigger this flow. An underwriter must either (a) call an API endpoint that writes the quote, or (b) manually run the pricing step through an assistant action once that is wired up.

---

## quote-acceptance

```yaml
category: flows
id: quote-acceptance
name: Quote Acceptance and Policy Creation
trigger: record
fires_from_ui: false
```

**Trigger**: Quote record written with `status = "Accepted"`.

**What it does**:

1. Create a new Policy record copying insured, project, and coverage fields from the Quote.
2. Set `policy_reference = "BR-" + current_year + "-" + policy_record_id` (not sequential).
3. Set `issue_date = today`, `inception_date` from quote's start_date (or today if blank), `expiration_date = inception_date + 12 months`.
4. Set Policy `status = "Active"`, `premium = quote.total_premium`.
5. Write `linked_policy_id` back to the Quote.
6. Create a task: "Complete policy setup: [policy_reference]" assigned to `underwriter_id`, due today + 1 day.

**Manual alternative (fires_from_ui: false)**: Marking a quote "Accepted" through the form does not trigger policy creation. An underwriter must write the quote via API or use an assistant action to initiate the flow.

---

## renewal-scan

```yaml
category: flows
id: renewal-scan
name: Daily Renewal Scan
trigger: schedule
trigger_every: 24h
trigger_on: "2026-08-05T08:00:00Z"
```

**What it does**:

1. Read all Policy records where `status = "Active"` and `expiration_date` is between 29 and 31 days from today.
2. Produce ONE digest task in UNDERWRITING: title "Renewal review needed", description listing each policy reference and insured name that matched, assigned to a configured default underwriter (or unassigned), status Open.

The underwriter reads the digest and manually creates renewal quotes for each listed policy. A loop that creates a separate quote per policy is not expressible (see Out of scope).

---

## Builders Risk Quote

```yaml
category: document_templates
id: builders_risk_quote
name: Builders Risk Quotation
```

DOCX template with placeholders mapped to Quote record fields:

| placeholder | source |
|-------------|--------|
| `{quote_reference}` | quote_reference |
| `{quote_date}` | quote_date |
| `{validity_days}` | validity_days |
| `{insured_name}` | insured_name |
| `{insured_address}` | insured_address |
| `{insured_contact}` | insured_contact |
| `{insured_phone}` | insured_phone |
| `{insured_email}` | insured_email |
| `{insured_license}` | insured_license |
| `{insured_years_in_business}` | insured_years_in_business |
| `{project_name}` | project_name |
| `{project_address}` | project_address |
| `{project_type}` | project_type |
| `{start_date}` | start_date |
| `{completion_date}` | completion_date |
| `{construction_type}` | construction_type |
| `{square_footage}` | square_footage |
| `{stories}` | stories |
| `{tiv}` | tiv |
| `{coverage_limits}` | coverage_limits |
| `{deductible}` | deductible |
| `{base_rate}` | base_rate |
| `{base_premium}` | base_premium |
| `{duration_modifier}` | duration_modifier |
| `{construction_modifier}` | construction_modifier |
| `{experience_modifier}` | experience_modifier |
| `{location_modifier}` | location_modifier |
| `{total_premium}` | total_premium |

Generated document is written to object-store; `quote_document_key` on the Quote stores the path. The document is accessed by following that link — not by attachment.

---

## Policy Schedule

```yaml
category: document_templates
id: builders_risk_policy_schedule
name: Builders Risk Policy Schedule
```

DOCX template with placeholders mapped to Policy record fields:

| placeholder | source |
|-------------|--------|
| `{policy_reference}` | policy_reference |
| `{issue_date}` | issue_date |
| `{inception_date}` | inception_date |
| `{expiration_date}` | expiration_date |
| `{insured_name}` | insured_name |
| `{insured_address}` | insured_address |
| `{insured_contact}` | insured_contact |
| `{insured_phone}` | insured_phone |
| `{insured_email}` | insured_email |
| `{project_name}` | project_name |
| `{project_address}` | project_address |
| `{project_type}` | project_type |
| `{construction_type}` | construction_type |
| `{square_footage}` | square_footage |
| `{stories}` | stories |
| `{tiv}` | tiv |
| `{coverage_limits}` | coverage_limits |
| `{deductible}` | deductible |
| `{premium}` | premium |
| `{payment_status}` | payment_status |
| `{payment_terms}` | payment_terms |
| `{payment_due_date}` | payment_due_date |

Generated document written to object-store; `policy_schedule_key` on the Policy stores the path.

---

## Underwriting Assistant

```yaml
category: assistants
id: UW_UNDERWRITING_ASSISTANT
name: Underwriting Assistant
llm_provider: claude
model: claude-sonnet-4-5
shared: team
```

> **Corrected during review.** `model: default` is not a value the platform accepts —
> use a real alias. The **Tools** and **Knowledge sources** the agent listed do not
> exist: there is no "record lookup" or "task creation" tool to attach, and no
> knowledge scheme that points at a record config. The identical invention appeared
> in the CRM spec. An assistant reasons over what is in its prompt and what the user
> pastes in; it cannot query records.

**Behaviour**: Assists underwriters with Builders Risk quoting and policy
management — explains the rating rules and how a premium was arrived at, talks
through coverage and exclusions, and guides the quote-to-policy-to-renewal process.

The behaviour prompt must carry the rating tables verbatim (base rates by project
type, and the duration, construction, experience and location modifiers) because
that is the only way the assistant can know them.

It must also state plainly that the assistant **cannot see any records**. When asked
about a specific quote or policy it should ask for the details to be pasted in
rather than inventing a premium — a fabricated number in an underwriting
conversation is worse than no answer. And it should say that any pricing field
sitting empty means the pricing flow has not run, not that the value is zero.

---

## Underwriter Meeting

```yaml
category: meeting_templates
id: underwriter_meeting
name: Underwriter Meeting
```

Summarization template for recorded underwriter meetings. Extracts: attendees, topics discussed, decisions made, action items, and any referenced quotes or policies by reference number.

---

## Out of scope

- **Kanban board view for tasks** — no kanban view component exists; tasks display in list/table views only.
- **Gap-free sequential quote and policy numbers** (BR-YYYY-XXXXX format) — platform has no atomic counter reachable from flows; reference numbers derive from record IDs instead.
- **Notifications to underwriters** — no notify node exists; every notification step is modelled as a task creation.
- **Document attachments on records** — records have no file attachment input type; documents are stored in object-store and referenced by a URL/key string field.
- **Record-triggered flows firing from UI saves** — the record save button does not publish events the flow engine consumes; flows are marked `fires_from_ui: false` and require API writes or manual invocation.
- **Automatic creation of individual renewal quotes per expiring policy** — flows cannot loop; renewal-scan produces one digest task listing all due renewals for manual processing.
- **Referral workflow with automatic reassignment of all open tasks** — flows cannot iterate over a set of tasks; referral must be done manually by reassigning each task.
- **Calculated project duration field** — JSON Schema has no derived values; if needed, a flow writes a stored `project_duration_months` field.
- **Calculated renewal date field** — same reason; expiration_date minus 30 days would need to be stored by a flow if displayed.
- **Task filtering, sorting, and grouping** — table views specify columns only; no saved filters or dynamic segments.
- **Status change history on Quote/Policy** — audit trail is a platform concern, not vertical configuration.
- **Reporting and analytics** (conversion rates, average premiums, underwriter productivity, renewal rates) — platform concern, not vertical configuration.
- **Role-based access control / team-based record visibility** — platform concern.
- **Field-level audit trail** — platform concern.
- **Encryption at rest/in transit, compliance (GDPR, CCPA)** — platform concern.
- **Document versioning** — platform feature, not vertical configuration.
- **Linking a task to its Quote or Policy as a typed field** (§3.7.2 "Related record") — a task has no typed custom fields; `metadata` is an untyped `map[string]any` with no validation, no form and no column. Put the reference number in the task title and description, which is what makes it findable by the term search.
- **Task completion metadata** (§3.7.5 completion date, completed by, completion notes) — a task has a status and nothing else to record who closed it or when. The status list marks Completed; the rest would need a record config, which is not worth it for this.
- **Retaining or archiving historical records** (§5.1.4 "shall not be deleted, only archived or marked as inactive") — there is no archive flag on a record and no retention control. The Quote `Expired` and Policy `Cancelled` statuses are the nearest expression, and nothing prevents a delete.
- **Performance SLAs** (sub-3-second search, 99.5% uptime) — platform concern.
- **All Section 9 future enhancements** (external rating engines, email delivery, customer portal, mobile app, accounting integration) — out of scope for initial vertical.

---

## The thing to understand before building

Every derived value in this vertical is written by a flow, and **no record-triggered
flow fires when a person saves a record**. So on a UI-created quote,
`quote_reference`, `base_rate`, `base_premium`, all four modifiers and
`total_premium` stay empty; on acceptance no Policy appears. The configuration is
correct and it works when a record is written through the API — which is how the
Phase E test must drive it — but nobody should be shown this as a working portal
until the platform sends the flag that publishes record events.

What *does* run today without any of that: both record forms with their conditional
fields, the space and its tasks, both document templates, the assistant, the meeting
template, and `renewal-scan`, which is on a schedule and therefore genuinely fires.

## Review corrections

Applied on 2026-08-04, after the agent produced this file. Recorded so the spec can
be diffed against `Builders.md` and every item accounted for.

| # | What the agent produced | Correction | Why |
|---|---|---|---|
| 1 | A `Client` record config | Renamed to `UWClient`, and `Client` now referenced as the shared record | `Client` already exists as the financial_advisor personal-client record. Deploy uses the CREATE subject, which 409s on an existing id — the config would have failed at deploy and left the vertical with no applicant record. |
| 2 | "Client folders — **no folder concept**" in Out of scope | Removed; folder-per-applicant is buildable | Factually wrong. Records carry a `folder` field, `records-service/model/api.go:199,209`. |
| 3 | `model: default`, plus a **Tools** and **Knowledge sources** list | Real model alias; invented tools and knowledge removed | `default` is not an accepted value, and no record-lookup or task-creation tool exists to attach. The same invention appeared in the CRM spec. |
| 4 | `quote_reference` marked **required** | Made optional | It is written by a flow that does not fire on a UI save, so a required field nobody can fill would block every hand-created quote. |
| 5 | Space statuses `Open, In Progress, Blocked, Done` | `Open, In Progress, Completed, Cancelled` | §3.7.2 names the four states; Blocked and Done were invented. |
| 6 | Rate tables inline in the pricing flow | Moved to `config.static` | §3.3.4 asks for rating logic changeable without a code change. Static variables are the nearest expression, and the spec now says so honestly instead of claiming the requirement is met. |
| 7 | §3.7.2 related record, §3.7.5 completion tracking, §5.1.4 archival — absent entirely | Added as three Out of scope entries with reasons | Silently dropped. The CRM build lost a whole products catalogue the same way. |
| 8 | A conversational preamble above the `#` heading | Removed | Its instructions say markdown only, no preamble. |

Not changed, and worth saying why: the three `fires_from_ui: false` flows stay in the
spec. They are correct configuration, they work through the API, and deleting them
would lose the design. What was missing was the honesty about them, which is now in
the section above.

## Open questions

- **Default underwriter for digest tasks**: Who should the renewal-scan task be assigned to when the original policy's underwriter is not available? A team lead, or left unassigned?
- **Location zone definitions**: The rating rules reference Urban High Risk, Urban Standard, Suburban, Rural — how are these determined from project address? Manual selection, or is there a lookup table by postcode/region?
- **Minimum/maximum TIV validation**: Requirements mention $100,000–$50,000,000 range — should the form enforce this, or just warn?
- **Renewal pricing adjustments**: Should the renewal quote use the original policy's risk profile, or re-evaluate all modifiers against current rules?
- **Quote expiry automation**: Should there be a scheduled flow that marks quotes past their validity period as "Expired", or is this manual?
- **Payment overdue handling**: Is there a workflow needed when payment_status becomes Overdue, or is this managed outside this vertical?
- **Agent/Broker field**: Policy Schedule template references Agent/Broker — should this be a field on Policy, or is it always blank for direct business?
