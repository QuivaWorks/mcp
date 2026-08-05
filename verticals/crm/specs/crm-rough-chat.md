## **Detailed Implementation Requirements by Capability**

---

### **1. Task Management → Activities & Follow-ups**

**Record Type: Activity**
```
Fields:
- activity_id (UUID, auto-generated)
- activity_type (enum: Call, Email, Meeting, Demo, Follow-up, Task, Other)
- related_contact_id (foreign key to Contact)
- related_deal_id (foreign key to Deal)
- related_company_id (foreign key to Company)
- title (text, max 255 chars)
- description (rich text/markdown)
- status (enum: Scheduled, In Progress, Completed, Cancelled)
- priority (enum: Low, Medium, High, Critical)
- scheduled_date (datetime)
- scheduled_duration_minutes (integer, default 30)
- actual_start_time (datetime, nullable)
- actual_end_time (datetime, nullable)
- actual_duration_minutes (integer, calculated if both times exist)
- assigned_to_user_id (foreign key to User)
- created_by_user_id (foreign key to User)
- created_at (datetime, auto)
- completed_at (datetime, nullable)
- attendees (array of objects: [{name, email, user_id}])
- notes (rich text)
- attachments (array of file IDs)
- outcome (enum: Positive, Negative, Neutral, Pending - for calls/meetings)
- next_action (text, what should happen after this activity)
- meeting_recording_id (link to AI recording transcript)
- email_thread_id (if from email sync)
- reminders (array: [{reminder_time_minutes_before, notification_channel}])
- custom_labels (array of strings, multi-select)

Dynamic Form Configuration:
- Show "outcome" field only if activity_type = "Call" OR "Meeting"
- Show "attendees" field only if activity_type = "Meeting"
- Show "email_thread_id" only if activity_type = "Email"
- Show "meeting_recording_id" only if activity_type = "Meeting"
- Auto-populate "related_contact_id" if navigating from Contact record
- Auto-populate "related_deal_id" if navigating from Deal record
```

**Label Configuration (Multi-select, Hierarchical)**
```
Activity Labels:
├── Follow-up Type
│   ├── First Contact
│   ├── Proposal Follow-up
│   ├── Objection Handling
│   ├── Negotiation
│   └── Closing
├── Outcome Tags
│   ├── Positive Response
│   ├── No Response
│   ├── Interested
│   ├── Not Interested
│   └── Needs More Info
├── Pain Points Discussed
│   ├── Pricing
│   ├── Integration
│   ├── Implementation
│   └── Competitor Comparison
└── Next Steps
    ├── Schedule Demo
    ├── Send Proposal
    ├── Send Product Info
    ├── Check Technical Requirements
    └── Executive Alignment Needed
```

**Status Workflow**
```
Scheduled → In Progress → Completed → [Closed]
                        └→ Cancelled
                        
Trigger Rules:
- Scheduled → In Progress: Automatic when scheduled_date <= now
- In Progress → Completed: Manual (user marks done) OR automatic if actual_end_time set
- On Completed: Create automatic follow-up task if "next_action" field populated
```

**Time-Tracking Specification**
```
If activity_type = "Call" or "Meeting":
- actual_duration_minutes = actual_end_time - actual_start_time (auto-calculated)
- If manually logged (no recording): User enters actual_duration_minutes directly
- Aggregate time tracking at User level:
  - Total calls this month
  - Average call duration
  - Total meeting time
  - Activity count by type (dashboard widget)
```

---

### **2. Configurable Record Schemas → Core CRM Objects**

**Record Type 1: Contact**
```
Fields:
- contact_id (UUID, auto-generated)
- first_name (text, required)
- last_name (text, required)
- email (email, required, unique within account)
- phone (phone, with country code)
- mobile_phone (phone, optional)
- job_title (text)
- department (enum: Sales, Marketing, Finance, Operations, IT, Executive, Other)
- reports_to (foreign key to Contact, self-referential for org hierarchy)
- company_id (foreign key to Company, required)
- preferred_contact_method (enum: Phone, Email, LinkedIn, Other)
- preferred_contact_timezone (timezone list, e.g., America/New_York)
- source (enum: Inbound Demo, Partner Referral, Trade Show, Cold Outreach, LinkedIn, Website, Other)
- lead_score (integer 0-100, calculated by AI)
- engagement_level (enum: Active, Engaged, Lukewarm, Cold, Unresponsive)
- last_activity_date (datetime, auto-updated on any related activity)
- days_since_last_activity (integer, calculated = today - last_activity_date)
- next_scheduled_activity_id (foreign key to Activity, nullable)
- next_scheduled_activity_date (datetime, denormalized from Activity)
- lifecycle_stage (enum: Lead, Contact, Opportunity, Customer, Churned)
- created_at (datetime, auto)
- created_by_user_id (foreign key to User)
- modified_at (datetime, auto on any update)
- modified_by_user_id (foreign key to User)
- owner_user_id (foreign key to User, sales rep responsible)
- notes (rich text, internal notes)
- custom_fields (object: {field_name: value} - for extensibility)
- do_not_contact (boolean, compliance flag)
- is_decision_maker (boolean)
- budget_authority_level (enum: None, Influencer, Approver, Decision Maker)
- linked_contacts (array of contact_ids - for same company/related contacts)
- attachments (array of file IDs - LinkedIn profiles, biz cards, docs)
- activity_history (array of activity_ids, auto-populated)

Indexed Fields (for search/filter):
- email (full-text search)
- last_name, first_name (sort)
- company_id (filter)
- owner_user_id (filter)
- lifecycle_stage (filter)
- days_since_last_activity (range filter)
- created_at (date range filter)
```

**Record Type 2: Company/Account**
```
Fields:
- company_id (UUID, auto-generated)
- company_name (text, required, unique)
- industry (enum: SaaS, Financial Services, Healthcare, Manufacturing, Retail, Tech, Other)
- company_size (enum: 1-10, 11-50, 51-200, 201-500, 500-1000, 1000+)
- annual_revenue (integer, denormalized estimate)
- website_url (url)
- headquarters_city (text)
- headquarters_country (text, with country code)
- linkedin_company_id (text, for integration)
- crunchbase_id (text, for enrichment)
- account_type (enum: Prospect, Customer, Partner, Competitor)
- account_health_score (integer 0-100, calculated)
- account_status (enum: Active, At Risk, Churned, Inactive)
- primary_owner_user_id (foreign key to User, account executive)
- secondary_owners_user_ids (array of User IDs, team members)
- arr_value (integer, Annual Recurring Revenue if customer)
- lifetime_value (integer, calculated from closed deals)
- contract_value (integer, total value of contracts)
- contract_renewal_date (datetime, null if prospect)
- est_contract_start_date (datetime)
- next_renewal_date (datetime, calculated from contract_renewal_date)
- days_to_renewal (integer, calculated)
- contact_count (integer, denormalized count of related contacts)
- deal_count (integer, denormalized count of related deals)
- open_deal_value (currency, sum of open deals)
- total_activity_count (integer, sum of all related activities)
- last_activity_date (datetime, most recent activity on any contact)
- last_interaction_summary (text, brief description of last interaction)
- created_at (datetime, auto)
- owner_user_id (foreign key to User)
- notes (rich text)
- attachments (array of file IDs)
- contact_list (array of contact_ids, auto-maintained)
- deal_list (array of deal_ids, auto-maintained)

Indexed Fields:
- company_name (full-text, sort)
- industry (filter)
- company_size (filter)
- account_type (filter)
- account_status (filter)
- primary_owner_user_id (filter)
- contract_renewal_date (date range, for renewals report)
```

**Record Type 3: Deal/Opportunity**
```
Fields:
- deal_id (UUID, auto-generated)
- deal_name (text, required, e.g., "Acme Corp - Enterprise Plan")
- company_id (foreign key to Company, required)
- primary_contact_id (foreign key to Contact, required)
- secondary_contact_ids (array of Contact IDs)
- deal_value (currency, required)
- deal_value_usd (currency, if multi-currency, normalized to USD)
- currency (enum: USD, EUR, GBP, etc.)
- deal_stage (enum: Prospect, Qualified, Proposal, Negotiation, Closed Won, Closed Lost)
  └─ See Stage Timeline section below
- stage_change_date (datetime, when entered current stage)
- days_in_current_stage (integer, calculated = today - stage_change_date)
- probability_percent (integer 0-100, linked to stage defaults)
  └─ Default: Prospect=10%, Qualified=25%, Proposal=50%, Negotiation=75%, Closed Won=100%, Closed Lost=0%
- expected_revenue (currency, calculated = deal_value * (probability_percent/100))
- deal_category (enum: New Business, Expansion, Renewal, Upsell, Downsell)
- deal_type (enum: Standard, Complex, Strategic, Low-Touch)
- close_date (datetime, required)
- days_to_close (integer, calculated = close_date - today, can be negative if closed)
- actual_close_date (datetime, nullable, set on close)
- deal_duration_days (integer, calculated from created_at to actual_close_date OR close_date)
- lost_reason (enum, if closed lost: Budget, Competitor, Not a Fit, Delayed, Stalled, Other)
- lost_reason_details (text, if closed lost)
- competitor_mentioned (text, array of competitor names)
- deal_owner_user_id (foreign key to User, sales rep)
- deal_owner_manager_id (foreign key to User, manager overseeing deal)
- discount_percent (integer 0-100, if discount offered)
- discount_reason (text)
- requires_approval (boolean, true if discount > 20% or deal > $X threshold)
- approval_status (enum: Not Needed, Pending, Approved, Rejected)
- approved_by_user_id (foreign key to User, nullable)
- approval_notes (text, nullable)
- created_at (datetime, auto)
- created_by_user_id (foreign key to User)
- modified_at (datetime, auto)
- updated_stage_at (datetime, auto when stage changes)
- activity_count (integer, denormalized)
- last_activity_date (datetime)
- activity_list (array of activity_ids)
- related_file_ids (array, proposals, contracts, SOW, etc.)
- deal_health_score (integer 0-100, calculated by AI based on activity, stall indicators)
- deal_health_status (enum: Healthy, At Risk, Stalled)
- stall_indicators (array: [days_without_activity, no_decision_maker_activity, competitor_activity])
- next_recommended_action (text, AI-generated)
- notes (rich text)
- custom_fields (object)

Stage Timeline (for historical tracking):
- stage_timeline (array of objects):
  [{
    stage: "Prospect",
    entered_date: "2024-01-15",
    exited_date: "2024-02-10",
    days_in_stage: 26
  },
  {
    stage: "Qualified",
    entered_date: "2024-02-10",
    exited_date: null,
    days_in_stage: null (still in progress)
  }]

Indexed Fields:
- deal_stage (filter, critical for pipeline view)
- company_id (filter)
- deal_owner_user_id (filter)
- deal_value (range filter, sort)
- close_date (date range filter)
- days_in_current_stage (range filter, for "stuck deals" query)
- deal_health_status (filter)
- probability_percent (sort)
- expected_revenue (calculated sort)
```

**Record Type 4: User/Sales Team Member** (if not already in system)
```
Fields:
- user_id (UUID)
- email (email, unique)
- first_name (text)
- last_name (text)
- role (enum: Admin, Sales Manager, Sales Rep, Support, Analyst)
- team_id (foreign key to Team, for grouping)
- manager_user_id (foreign key to User, for hierarchy)
- is_active (boolean)
- timezone (timezone)
- deal_quota_annual (currency, if sales rep)
- assigned_contact_count (integer, denormalized)
- assigned_deal_count (integer, denormalized)
- assigned_open_deal_value (currency, denormalized)

Dashboard Fields (performance metrics):
- ytd_deals_closed (integer)
- ytd_revenue_closed (currency)
- current_month_activities (integer)
- current_month_calls (integer)
- current_month_meetings (integer)
- current_month_emails (integer)
- avg_deal_size (currency, calculated)
- win_rate_percent (integer, calculated)
```

---

### **3. Dynamic Forms → Sales Workflow Forms**

**Form 1: Quick Activity Log (3-field rapid entry)**
```
Form Name: "Log Activity"
Fields (In order):
1. Activity Type (dropdown, required)
   - Call
   - Email
   - Meeting
   - Task
   - Demo
   
2. Related Contact (searchable dropdown, required)
   - Auto-populates if coming from Contact record
   - Search: first/last name, email
   - Shows: name | company | title
   
3. Notes (rich text textarea, optional)
   - Placeholder: "What happened? Next steps?"
   
4. Outcome (conditional dropdown, only if activity_type = "Call" or "Meeting")
   - Positive
   - Negative
   - Neutral
   
5. Next Action (conditional text, only if outcome filled)
   - Auto-suggests based on activity type
   - Shows label options for quick-select

On Submit:
- Create Activity record with auto-populated fields
- If next_action filled: create follow-up Task automatically
- If Deal associated: update deal's last_activity_date
```

**Form 2: Create/Edit Deal**
```
Form Name: "Deal Details"
Sections:

Section 1: Basic Info (required fields in bold)
- **Deal Name** (text input)
- **Company** (searchable dropdown → Company record)
- **Primary Contact** (searchable dropdown, filtered to company's contacts → Contact record)
- Secondary Contacts (multi-select, filtered to company's contacts)
- **Deal Value** (currency input with currency selector)
- **Close Date** (date picker)

Section 2: Stage & Probability
- **Deal Stage** (dropdown with options)
  - Prospect (default probability 10%)
  - Qualified (default 25%)
  - Proposal (default 50%)
  - Negotiation (default 75%)
  - Closed Won (100%)
  - Closed Lost (0%)
- Probability % (auto-populated from stage, editable)
- Stage Changed Date (auto-populated, read-only)

Section 3: Deal Classification
- Deal Category (dropdown: New Business, Expansion, Renewal, Upsell)
- Deal Type (dropdown: Standard, Complex, Strategic, Low-Touch)
- Competitor Mentioned (multi-select text with suggestions)

Section 4: Closing Info (appears on stage = "Negotiation" or "Closed")
- Discount % (integer input, conditional)
  - If > 20%: Requires Approval (auto-set flag)
- Expected Close Date (date picker)
- Lost Reason (enum dropdown, only if stage = Closed Lost)
- Lost Reason Details (text, only if Lost Reason selected)

Section 5: Internal Notes
- Owner (User dropdown, defaults to current user)
- Internal Notes (rich text)
- Attachments (file upload area)

Conditional Logic:
- Show "Lost Reason" section only if stage = "Closed Lost"
- Show "Discount" fields only if stage = "Negotiation" or "Closed Won"
- Lock "Deal Value" editing if stage = "Closed Won" or "Closed Lost"
- Auto-calculate "Expected Revenue" = Deal Value × (Probability/100)

On Save:
- Update deal_stage field
- If stage changed: trigger workflow (see Workflow section)
- Update deal's modified_at timestamp
```

**Form 3: Contact Quick Create**
```
Form Name: "Add Contact"
Fields:
- **First Name** (text, required)
- **Last Name** (text, required)
- **Email** (email, required)
- **Company** (searchable dropdown, required → Company record)
- Phone (text, optional)
- Job Title (text, optional)
- Department (dropdown, optional)
- Preferred Contact Method (dropdown: Phone, Email, LinkedIn)
- Source (dropdown: Inbound, Referral, Trade Show, Cold Outreach, LinkedIn, Website, Other)
- Notes (text area, optional)

On Submit:
- Create Contact record
- Add to company's contact_list
- Trigger workflow: "New Contact Created" (send welcome activity, etc.)
```

**Form 4: Company/Account Quick Add**
```
Form Name: "Add Company"
Fields:
- **Company Name** (text, required)
- Website (url, optional)
- Industry (dropdown, optional)
- Company Size (dropdown, optional)
- Location (text, optional)
- Account Type (dropdown: Prospect, Customer, Partner)
- Primary Owner (User dropdown, defaults to current user)
- Notes (text area)

On Submit:
- Create Company record
- Allow user to immediately add contacts
```

---

### **4. Table Views → Sales Data Visualization**

**View 1: Sales Pipeline Kanban Board**
```
View Type: Kanban (not table, but critical)
Data Source: Deal records
Group By: deal_stage (columns)

Columns (in order):
1. Prospect (count: X deals, value: $Y)
2. Qualified (count: X deals, value: $Y)
3. Proposal (count: X deals, value: $Y)
4. Negotiation (count: X deals, value: $Y)
5. Closed Won (count: X deals, value: $Y)
6. Closed Lost (count: X deals, value: $Y)

Each Card shows:
- Deal Name (large)
- Company Name (smaller)
- Deal Value (currency, bold)
- Close Date (with color: green if >10 days, yellow if 5-10 days, red if <5 days)
- Days in Stage (with color indicator: normal < 30 days, warning > 45 days, alert > 60 days)
- Primary Contact name (small)
- Deal Owner avatar/initials (if filtering by owner)

Card Actions (right-click / hover menu):
- Edit Deal
- Log Activity
- Move to Stage (drag-drop enabled)
- View Details
- Add File

Filters (above board):
- Deal Owner (multi-select User)
- Company (multi-select Company)
- Close Date Range (date picker)
- Deal Value Range (currency slider)
- Days in Stage (range slider, to highlight stuck deals)

Aggregates (displayed at bottom):
- Total Pipeline Value (sum of all deal values)
- Total Expected Revenue (sum of deal_value * probability%)
- Deals by Owner (bar chart mini)
- Average Days in Stage (by stage)
```

**View 2: Contact Master Table**
```
View Type: Table / List
Data Source: Contact records
Default Sort: last_activity_date DESC (most recently active first)

Columns (configurable, defaults):
1. Contact Name (first_name + last_name, clickable to detail view)
2. Company (clickable to Company record)
3. Email (copyable)
4. Phone (copyable)
5. Job Title (text)
6. Last Activity (date, formatted "X days ago")
7. Days Since Last Activity (integer, color coded: green <14 days, yellow 14-30, red >30)
8. Next Scheduled Activity (date, clickable to Activity)
9. Lifecycle Stage (badge: Lead, Contact, Opportunity, Customer)
10. Lead Score (0-100, visual bar)
11. Engagement Level (badge: Active, Engaged, Lukewarm, Cold, Unresponsive)
12. Owner (User name, clickable to filter)

Inline Actions (per row):
- Edit Contact (pencil icon)
- Log Activity (phone/email icons)
- View Details (expand row)
- Quick Filter by Company

Filters (above table):
- Search by name/email (full-text)
- Company (multi-select)
- Owner (multi-select User)
- Lifecycle Stage (multi-select)
- Days Since Last Activity (range: 0-7, 8-14, 15-30, 30+)
- Lead Score (range slider)
- Created Date (date range)

Bulk Actions:
- Assign to Owner (change owner for selected)
- Update Lifecycle Stage (bulk update)
- Add Tag (bulk add label)
- Export to CSV

Column Display Settings:
- User can toggle columns on/off
- User can reorder columns
- Save as view preset
```

**View 3: Company Account Table**
```
View Type: Table
Data Source: Company records
Default Sort: open_deal_value DESC (highest potential first)

Columns (defaults):
1. Company Name (clickable to detail)
2. Industry (text)
3. Company Size (enum badge)
4. Account Type (Prospect, Customer, Partner)
5. Account Status (Active, At Risk, Churned)
6. Open Deal Value (currency, sum of open deals)
7. Contact Count (integer, clickable to filter)
8. Active Deals (count, clickable)
9. Last Activity Date (date, formatted "X days ago")
10. Days to Renewal (integer, if customer, color coded)
11. Primary Owner (User, clickable)
12. Account Health Score (0-100 visual bar)

Inline Actions:
- View Account (expand)
- Add Contact
- Create Deal
- Log Activity

Filters:
- Company Name (search, full-text)
- Industry (multi-select)
- Account Type (multi-select)
- Account Status (multi-select)
- Owner (multi-select User)
- Contract Renewal Date (within X days)
- Open Deal Value Range (currency slider)

Bulk Actions:
- Assign to Owner
- Update Account Status
- Assign Team Member
- Export CSV
```

**View 4: Activity Log / Sales Activity Report**
```
View Type: Timeline / Table
Data Source: Activity records
Default Sort: actual_start_time DESC (most recent first)

Columns (defaults):
1. Activity Type (icon + label: Call, Email, Meeting, Task)
2. Related Contact (name, clickable)
3. Company (name, clickable)
4. Description (short text from notes)
5. Scheduled Date (datetime, if future)
6. Actual Date (datetime, if past)
7. Duration (for calls/meetings, in minutes)
8. Outcome (badge: Positive, Negative, Neutral)
9. Assigned To (User)
10. Status (Completed, Scheduled, In Progress)

Inline Actions:
- View Full Activity (expand)
- Edit
- Log Related Activity
- Attach File

Filters:
- Activity Type (multi-select)
- Assigned User (multi-select)
- Related Company (multi-select)
- Activity Status (multi-select)
- Date Range (date picker)
- Outcome (multi-select)
- Duration Range (for calls)

Aggregates (dashboard widgets):
- Total Activities (count by type)
- Total Call Time (hours, by user)
- Total Meetings (count)
- Activities by Outcome (% Positive, Negative, Neutral)
- Activities Completed vs. Scheduled
```

**View 5: Deal Details Expanded View**
```
View Type: Record Detail Page (when deal record is clicked)
Layout:

Header Section:
- Deal Name (editable title)
- Company Name (clickable link)
- Deal Value (currency, prominent)
- Close Date (countdown indicator)
- Status Badge (deal_stage)
- Menu (Edit, Delete, Archive, Share)

Tabs/Sections:

Tab 1: Overview
- Key Info Grid (2-column):
  - Deal Stage | Probability %
  - Deal Value | Expected Revenue
  - Close Date | Days to Close
  - Created Date | Days Open
  - Owner | Manager
  
Tab 2: Activity Timeline
- Chronological list of all related Activities
- Add Activity button (inline)
- Filter by activity type
- Show most recent 20, load more option

Tab 3: People
- Primary Contact (expanded card with contact info)
- Secondary Contacts (list, add/remove)
- Team Members assigned to deal

Tab 4: Documents
- Attached files (proposals, contracts, specs)
- Upload new file
- Download, Preview, Delete actions
- Show file upload date + uploader

Tab 5: Notes & History
- Internal notes (rich text, edit/delete)
- Stage change history with timestamps
- Deal value changes history
- Close date changes history

Tab 6: Collaboration
- @mentions in notes (if supported)
- Activity on this deal (by team)
- Comments/discussion thread

Right Sidebar (always visible):
- AI Insights Panel:
  - Deal Health Score (visual indicator)
  - Health Status (Healthy, At Risk, Stalled)
  - "Days in current stage" vs. average
  - Red flags (no activity for X days, decision maker not engaged, etc.)
  - Recommended next action (AI-generated)
  - Suggested follow-up activities

Bottom Action Bar:
- Log Activity (dropdown: Call, Email, Meeting, Task)
- Add Contact
- Attach File
- Change Stage (dropdown or drag)
- Edit Deal
```

---

### **5. File Storage → Document Management**

**File Attachment Specification**
```
Attachment Record:
- file_id (UUID)
- file_name (text)
- file_size (bytes)
- file_type (mime type)
- uploaded_by_user_id (User)
- uploaded_at (datetime)
- related_contact_id (nullable)
- related_company_id (nullable)
- related_deal_id (nullable)
- related_activity_id (nullable)
- file_category (enum: Proposal, Contract, SOW, Product Info, Case Study, Demo Recording, Call Recording, Other)
- is_confidential (boolean, for access control)
- version_number (integer, for version control)
- previous_version_file_id (nullable, if updated)
- access_level (enum: Public, Team Only, Restricted)
- storage_url (secure signed URL)
- preview_available (boolean, for PDF/image preview)

Usage in Workflows:
- Attach proposal to deal on stage change to "Proposal"
- Auto-attach meeting recording to Activity on completion
- Link contract file to Company on renewal
- Show "Proposals in Deal" count as metric

Integration with Email:
- Auto-attach email attachments to related Contact/Deal
- Email thread stored as attachment reference
```

---

### **6. AI Meeting Recording/Transcription → Call Intelligence**

**Meeting Transcription Integration**
```
Meeting Record (extends Activity):
- meeting_id (UUID)
- recording_file_id (file ID, stored in File Storage)
- transcription_text (rich text, generated by AI)
- transcription_status (enum: Recording, Processing, Completed, Failed)
- transcription_completed_at (datetime)
- duration_minutes (auto-calculated from recording)
- attendees (array: [{name, email, company}])

AI-Generated Fields (auto-populated post-transcription):
- key_topics (array: [topic, confidence_score])
  Examples: "Pricing", "Integration", "Timeline", "Competitor Comparison"
  
- action_items (array of objects):
  [{
    action: "Send pricing proposal",
    assigned_to: "Contact/User name or unknown",
    due_date: null (if not mentioned),
    priority: "High/Medium/Low"
  }]
  
- sentiment_analysis (enum: Positive, Negative, Neutral, Mixed)
- sentiment_score (0-100, where 100 = extremely positive)

- next_steps_summary (text, AI-generated one-liner)
  Example: "Client interested in demo next week, needs pricing for 50-user seat license"

- decision_maker_engaged (boolean, did decision maker participate?)
- competitor_mentioned (array of competitor names mentioned)
- objections_raised (array: ["Budget", "Timeline", "Current Solution Fit"])
- budget_mentioned (boolean)
- timeline_mentioned (text, e.g., "Q3 2024", "In 30 days")

- call_recording_link (clickable to play recording)
- transcript_searchable (enable full-text search across transcripts)

Display in Activity:
- Show transcript excerpt in Activity view
- Show key action items highlighted
- Quick-link to assigned action items in task view
```

**Integration with Deal/Contact**
```
On Activity with recording transcription created:
1. Extract action_items → Create follow-up Activities automatically
2. If decision_maker_engaged = true → Update Contact.is_decision_maker = true
3. If competitor_mentioned → Add to Deal.competitor_mentioned array
4. Auto-populate Activity.outcome based on sentiment_analysis
5. Add Activity.next_action from transcription.next_steps_summary
6. Link transcription to Deal.related_file_ids for access

Workflow Trigger:
- If sentiment = "Negative" AND deal_stage = "Proposal" 
  → Create task "Follow up on objections from [Contact name]"
  
- If no decision_maker_engaged AND deal_value > $50k 
  → Create task "Schedule meeting with decision maker"
```

---

### **7. AI Assistant Chat → Sales Intelligence Bot**

**AI Assistant Capabilities**
```
Chat Interface: Accessible from sidebar, integrated into records

Capability 1: Prospect Research
User: "Research Acme Corp"
Bot returns:
- Company overview (from web, Crunchbase data if integrated)
- Key executives (if available)
- Recent funding/news
- Competitor landscape
- Suggested talking points

Capability 2: Deal Health Analysis
User: "Analyze the Acme Corp deal"
Bot analyzes:
- Days in current stage vs. average
- Activity frequency on this deal
- Decision maker engagement level
- Proposal sent? Contract signed? Budget confirmed?
- Risks identified (e.g., competitor mentioned, timeline slipping)
- Recommended actions

Bot response format:
"Health: At Risk 🔴
Days in Proposal: 45 days (avg: 28)
Last activity: 18 days ago (unusual)
Risks: No budget confirmation, competitor mentioned in last call

Recommended next steps:
1. Call [Primary Contact] to confirm budget approval
2. Schedule executive business review
3. Address [competitor] comparison

[View deal details] [Log activity] [Schedule call]"

Capability 3: Next Best Action
User: "What should I do with my pipeline today?"
Bot returns:
- High-priority deals at risk (sorted by value × risk)
- Overdue tasks
- Contacts not reached in >30 days
- Upcoming renewal reminders
- Top 3 recommended actions for the day

Capability 4: Lead Qualification Guidance
User: "Is this a qualified lead? [Contact name]"
Bot analyzes Contact.activity_history, engagement, company size, etc.
Bot response: "Medium qualification 🟡
Positive: Attended demo, engaged on calls
Concerns: Takes 5+ days to respond, company size 11-50 (below ideal)
Recommendation: Qualify further with product fit question"

Capability 5: Sales Coaching
User: "How should I handle this objection? [copy objection text]"
Bot provides:
- Acknowledgment of objection
- Why prospect might have this concern
- Framework for response
- Example language
- Follow-up steps

Capability 6: Sales Analytics Questions
User: "What's my win rate this quarter?"
Bot returns:
- Win rate % (Closed Won / Total Closed)
- Average deal size (by stage, by type)
- Sales cycle length
- Deals at risk (by reason)
- Comparison to previous quarter

Capability 7: Workflow & Process Help
User: "Walk me through our sales process"
Bot provides:
- Sales stages (Prospect → Closed Won)
- Typical activities at each stage
- Average time in stage
- Next actions at each stage
- Common blockers and how to overcome

Implementation:
- Fine-tune on your sales best practices
- Feed conversation context (current contact/deal in focus)
- Pull real data from your records (deals, activities, contacts)
- Provide citations (e.g., "Based on your last 3 calls with [Contact]...")
```

---

### **8. Deterministic Workflow Engine → Sales Automation**

**Workflow 1: Deal Stage Transition**
```
Trigger: deal_stage changes

ON stage = "Proposal":
- Create Activity: "Send Proposal to [Contact]" (Task type)
- Assign to deal_owner_user_id
- Due date: today + 1 day
- Add label: "Follow-up Type: Proposal Follow-up"
- Attach template: "Proposal Email Template"

ON stage = "Negotiation":
- If discount_percent > 20%: Set requires_approval = true
- Create task: "Get approval for discount from [Manager name]"
- Notify deal_owner_manager_id via Slack
- Condition: IF approval_status = "Pending": Lock deal editing until approved

ON stage = "Closed Won":
- Update Contact.lifecycle_stage = "Customer"
- Update Company.account_type = "Customer" (if not already)
- Update Company.arr_value = deal_value (if annual contract)
- Create Activity: "Contract signed" (auto-logged)
- Generate file: "Implementation Checklist" (attach to deal)
- Create follow-up task: "Schedule kickoff call" (due 3 days out)
- Notify: deal_owner_manager_id, Customer Success team
- Trigger: Send winning email to Contact (can configure template)

ON stage = "Closed Lost":
- Require lost_reason selection (block closing without reason)
- Create task: "Post-mortem: lost to [Lost reason]"
- Assign to: deal_owner_user_id
- Set follow-up: "Check-in with [Contact] in 6 months"
- Notify: Manager & team (to learn from loss)
- Log activity: "Deal lost to [competitor/reason]"
```

**Workflow 2: Lead Aging & Activity Monitoring**
```
Trigger: SCHEDULED (runs daily at 8 AM, user's timezone)
Look at: All Contact records with lifecycle_stage = "Lead" OR "Contact"

Check: days_since_last_activity > 30
If TRUE:
- Create activity: "Follow-up - No contact in [X] days" (Task type)
- Assign to: Contact.owner_user_id
- Priority: "High"
- Due: Today
- Label: "Follow-up Type: Check-in"
- Notify: Contact owner via Slack/Email
  Message: "[Contact name] at [Company] hasn't been contacted in 45 days"

Check: days_since_last_activity > 60
If TRUE:
- Same as above BUT Priority = "Critical"
- Also notify: Contact owner's manager
- Label: "Follow-up Type: At-Risk"

Check: days_since_last_activity > 90
If TRUE:
- Update Contact.lifecycle_stage = "Dormant" (if configured)
- Create task: "Resurrect or delete contact" (for manager review)
- Assign to: Contact.owner_user_id's manager
```

**Workflow 3: Deal Stall Detection**
```
Trigger: SCHEDULED (runs daily)
Look at: All Deal records with deal_stage NOT IN ["Closed Won", "Closed Lost"]

Check: days_in_current_stage > 45 days (configurable threshold)
AND last_activity_date < today - 14 days
If TRUE:
- Set deal_health_status = "Stalled" 🔴
- Create task: "Rescue stalled deal" 
  - Assigned to: deal_owner_user_id
  - Label: "Call Contact"
  - Description: "[Deal name] has no activity for 14 days, days in stage: 45+"
  - Priority: High
- Notify deal owner & manager
- Suggestion: "Schedule call with [Primary Contact name] or escalate to [Manager]"

Check: days_in_current_stage > 60 days
If TRUE:
- Also notify deal_owner_manager_id
- Consider escalation workflow (see below)

Check: close_date < today AND deal_stage NOT IN ["Closed Won", "Closed Lost"]
If TRUE:
- Create urgent task: "Close or update deal by [close_date]"
- Assigned to: deal_owner_user_id
- Priority: Critical
- Notify: Manager
```

**Workflow 4: Renewal Tracking (for Customers)**
```
Trigger: SCHEDULED (runs daily)
Look at: All Company records with account_type = "Customer"

Check: days_to_renewal < 90 AND days_to_renewal > 0
If TRUE:
- Create task: "Schedule renewal conversation with [Company]"
- Assigned to: Company.primary_owner_user_id
- Label: "Renewal Discussion"
- Due: 90 days before renewal date

Check: days_to_renewal < 30 AND days_to_renewal > 0
If TRUE:
- Escalate task to manager
- Create urgent activity: "Final renewal close"
- Notify account team

Check: days_to_renewal < 0 (Contract expired)
If TRUE:
- Update Company.account_status = "At Risk"
- Create task: "Reactivate lapsed customer"
- Assign to: Account manager
- Notify: Manager
```

**Workflow 5: Email/Activity Sync & Logging**
```
Trigger: Incoming email from contact email address

ON receipt:
- Match email_from to Contact record by email field
- If Contact found:
  - Create Activity record (type: Email)
  - Link to Contact
  - Link to Contact's Company
  - Link to Contact's related Deal (if any)
  - Auto-populate: activity_type, related_contact_id, created_date, notes (from email)
  - Add attachments from email to Activity
  - Set status: Completed
  - Notify: deal_owner if email is from primary contact on active deal

- If Contact NOT found:
  - Create Activity (type: Email, unmatched)
  - Flag for manual review
  - Notify: Sales Manager

ON user sends email from within CRM:
- Auto-create Activity record with same details
- Link to Contact/Deal
- Track as outbound activity
```

**Workflow 6: Approval Routing**
```
Trigger: discount_percent > 20% OR deal_value > $100k (configurable threshold)

ON trigger:
- Set requires_approval = true
- Set approval_status = "Pending"
- Lock deal from closing until approved
- Route to manager: deal_owner_manager_id
- Create approval task in manager's queue
- Notify manager: "Approval needed for $X discount on [Deal name]"

ON manager approval:
- Set approval_status = "Approved"
- Set approved_by_user_id = [Manager]
- Unlock deal for closing
- Notify rep: "Your discount has been approved"
- Create activity: "Discount approved by [Manager name]"

ON manager rejection:
- Set approval_status = "Rejected"
- Notify rep with reason
- Create activity: "Discount rejected"
- Suggest alternatives (e.g., smaller discount, different payment terms)
```

**Workflow 7: New Deal Initialization**
```
Trigger: New Deal record created

ON creation:
- Create initial activity: "Initial qualification call" (Task)
  - Assigned to: deal_owner_user_id
  - Due: today + 2 days
  - Label: "Follow-up Type: First Contact"
  
- If deal_value > $50k:
  - Create task: "Identify decision maker"
  - Assigned to: deal_owner_user_id
  - Priority: High
  
- If deal_category = "New Business":
  - Send email template: "New opportunity discovered - next steps"
  - Log activity: "Sales rep notified of new opportunity"
  
- Create activity: "Deal created" (auto-logged)
  - Shows creation date, amount, stage, owner
  - Visible to manager for monitoring
```

**Workflow 8: Contact Lifecycle Progression**
```
Trigger: Activity logged on Contact

Track engagement:
- Each activity adds to Contact.engagement_level calculation
- More recent activities = higher weight
- Meetings + calls = higher weight than emails

ON Contact activity pattern:
- Multiple activities (2+) + positive outcomes → Update lifecycle_stage = "Opportunity"
- Associated with Closed Won deal → Update lifecycle_stage = "Customer"
- No activities for 90+ days → Update lifecycle_stage = "Dormant" (optional)
- Negative outcome on multiple activities → Keep in "Lead", flag for re-engagement

AI calculates lead_score:
- Based on: Company size, engagement, activity frequency, conversation sentiment
- Score 0-100 (higher = more likely to close)
- Update score daily
- Show in Contact view for prioritization
```

---

## **Summary: Configuration Checklist**

**Record Schemas to Create:**
- [ ] Contact (25 fields)
- [ ] Company/Account (20 fields)
- [ ] Deal/Opportunity (30+ fields)
- [ ] Activity (20+ fields)
- [ ] User (if needed)

**Forms to Build:**
- [ ] Quick Activity Log (5 fields, auto-triggers follow-up)
- [ ] Deal Create/Edit (multi-section, conditional fields)
- [ ] Contact Quick Add (8 fields)
- [ ] Company Quick Add (9 fields)

**Views to Configure:**
- [ ] Sales Pipeline Kanban (6 columns, $value aggregates)
- [ ] Contact Master Table (12+ columns, searchable)
- [ ] Company Account Table (12+ columns, sortable)
- [ ] Activity Log (timeline view)
- [ ] Deal Detail Page (multi-tab)

**File Storage:**
- [ ] Attachment categories (Proposal, Contract, SOW, etc.)
- [ ] Version control setup
- [ ] Auto-attach workflows

**AI Meeting Recording Integration:**
- [ ] Transcription service setup
- [ ] Extract action items automatically
- [ ] Link to Contact/Deal/Activity records
- [ ] Sentiment analysis + summary

**AI Assistant Chat:**
- [ ] Train on your sales process
- [ ] Connect to live data (deals, contacts, activities)
- [ ] Build 7 key capabilities (research, analysis, coaching, etc.)

**Workflow Automation (8 key workflows):**
- [ ] Deal stage transitions (with auto-task creation)
- [ ] Lead aging monitoring (30/60/90-day checkpoints)
- [ ] Deal stall detection (flag risks)
- [ ] Renewal tracking (for customers)
- [ ] Email/activity syncing
- [ ] Approval routing (discounts, high-value deals)
- [ ] New deal initialization
- [ ] Contact lifecycle progression

---

**This should take you to ~80% feature parity with HubSpot/Pipedrive.** The remaining 20% would be advanced features like:
- Territory management
- Complex forecasting models
- Custom reporting dashboards
- Advanced AI predictive models
- Third-party integrations (Salesforce sync, etc.)

Would you like me to detail any specific section further (e.g., the exact workflow automation syntax, dashboard widget specifications, or form conditional logic rules)?