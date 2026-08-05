RE: Generate a markdown file containing the complete Insurance Underwriting Portal Requirements Specification with all secti…

Your document is ready!

URI: `obj://microstrate-agent-knowledge/assistant_files.UCSBRFWNTVHXDRMLMD5A45LENJZBSEBV6D7ROWZAYEKKDU26NFXP5RKP.insurance_underwriting_portal_requirements_specification_8b5a456f.md`Here's the complete requirements specification in markdown format:

---

# Insurance Underwriting Portal - Requirements Specification

## Commercial & Specialty Risks - Builders Risk Product

---

## 1. EXECUTIVE SUMMARY

This document specifies the functional and non-functional requirements for an Insurance Underwriting Portal designed to support commercial and specialty risk underwriting, with initial focus on the Builders Risk product line. The system will enable insurance company underwriters to efficiently manage the complete quote-to-policy lifecycle, including automated pricing, document generation, and renewal management.

The portal leverages an existing platform with capabilities for client onboarding, record management with dynamic forms, task management, workflow automation, and AI-assisted underwriting support.

---

## 2. SYSTEM OVERVIEW

### 2.1 Platform Capabilities

The system is built on a platform that provides:

- **Client Management**: Onboarding and folder-based organization of insurance clients
- **Record Management**: Flexible record sets with dynamic form configuration and conditional logic
- **Task Management**: Kanban and list-view task tracking with assignment, scheduling, and status management
- **Workflow Automation**: Configurable workflows for business process automation and referrals
- **Meeting Records**: Documentation of underwriter meetings and notes
- **AI Assistant Integration**: Chat-based AI support for underwriter assistance
- **Dynamic Document Generation**: DOCX template-based document creation with field mapping

### 2.2 User Base

Primary users are **underwriters at the insurance company** responsible for:
- Evaluating builder risk applications
- Pricing quotes based on risk assessment
- Managing policy lifecycle
- Handling renewals and policy modifications
- Coordinating with other underwriters and support staff

### 2.3 Product Focus

Initial implementation focuses on **Builders Risk** product, covering:
- New construction projects
- Renovation projects
- Demolition projects
- Commercial and residential construction

---

## 3. FUNCTIONAL REQUIREMENTS

### 3.1 Client Management

**Requirement 3.1.1**: The system shall support onboarding of insurance clients (builders, contractors, project owners).

**Requirement 3.1.2**: Each client shall have a dedicated folder within the system for organizing all associated records.

**Requirement 3.1.3**: Client information shall include:
- Legal business name
- Business address
- Contact person(s) and phone numbers
- Email address(es)
- License numbers (if applicable)
- Years in business
- Business classification/type

**Requirement 3.1.4**: Client information shall be searchable and filterable by underwriters.

---

### 3.2 Quote Record & Form

**Requirement 3.2.1**: The system shall support creation and management of Quote records within client folders.

**Requirement 3.2.2**: Quote records shall capture all information necessary for pricing and policy creation through a dynamic form configuration.

**Requirement 3.2.3**: The Quote form shall capture the following information:

#### Builder/Applicant Information:
- Builder/applicant name
- Business address
- Contact person and phone number
- Email address
- License number (if applicable)
- Years in business
- Prior loss history (if applicable)

#### Project Details:
- Project name/description
- Project address/location
- Project type (New Construction / Renovation / Demolition)
- Estimated start date
- Estimated completion date
- Construction type (Wood Frame / Masonry / Steel)
- Square footage
- Number of stories
- Estimated contract value

#### Coverage Details:
- Total Insurable Value (TIV)
- Coverage limits requested
- Deductible preference
- Special coverage requirements
- Exclusions or limitations requested

#### Risk Assessment:
- Site access and security measures
- Temporary structures on site
- Hazardous materials on site
- Adjacent property concerns
- Additional risk factors

**Requirement 3.2.4**: The Quote form shall support dynamic field visibility using conditional rules. Example: "Show renovation scope field only if project type = 'Renovation'".

**Requirement 3.2.5**: Quote records shall track status through the following states:
- Draft (form in progress)
- Submitted (ready for pricing)
- Priced (pricing calculated)
- Accepted (insured accepted quote)
- Declined (insured declined quote)
- Expired (quote validity period expired)

**Requirement 3.2.6**: Quote records shall include:
- Unique quote number (auto-generated)
- Quote creation date
- Quote validity period (default 30 days)
- Pricing information (base premium, modifiers, total premium)
- Underwriter assigned
- Status and status change history

---

### 3.3 Pricing & Rating Workflow

**Requirement 3.3.1**: The system shall execute an automated pricing ruleset upon quote submission.

**Requirement 3.3.2**: The pricing ruleset shall calculate premium based on:
- Project type (base rate)
- Total Insurable Value (TIV)
- Project duration
- Construction type
- Builder experience
- Geographic location/risk zone

**Requirement 3.3.3**: Calculated premium shall be stored with the Quote record and displayed to the underwriter for review.

**Requirement 3.3.4**: The pricing workflow shall support rule-based rating logic allowing for future modifications to rates and modifiers without code changes.

#### 3.3.1 Builders Risk Rating Rules & Base Rates

**Base Rate Structure** (per $100 of TIV):

| Project Type | Base Rate |
|---|---|
| New Construction | $0.35 per $100 TIV |
| Renovation | $0.45 per $100 TIV |
| Demolition | $0.55 per $100 TIV |

**Project Duration Modifier**:

| Duration | Modifier |
|---|---|
| 0-6 months | 1.0x (no adjustment) |
| 6-12 months | 1.15x |
| 12-24 months | 1.35x |
| 24+ months | 1.50x |

**Construction Type Modifier**:

| Construction Type | Modifier |
|---|---|
| Wood Frame | 1.0x (base) |
| Masonry/Concrete | 0.85x |
| Steel Frame | 0.80x |

**Builder Experience Modifier**:

| Years in Business | Modifier |
|---|---|
| Less than 2 years | 1.25x |
| 2-5 years | 1.10x |
| 5-10 years | 1.0x (base) |
| 10+ years | 0.90x |

**Location Risk Modifier** (by geographic zone):

| Zone Type | Modifier |
|---|---|
| Urban High Risk | 1.20x |
| Urban Standard | 1.0x (base) |
| Suburban | 0.95x |
| Rural | 0.90x |

**Premium Constraints**:
- Minimum Premium: $500
- Maximum Premium: No limit

**Calculation Example**:

```
Scenario:
- TIV: $500,000
- Project Type: New Construction
- Project Duration: 8 months
- Construction Type: Wood Frame
- Builder Experience: 7 years
- Location: Urban Standard

Calculation:
1. Base Rate: $0.35 per $100 TIV (New Construction)
2. Base Premium: ($500,000 / 100) × $0.35 = $1,750.00

3. Apply Modifiers:
   - Project Duration (8 months): 1.15x
   - Construction Type (Wood Frame): 1.0x
   - Builder Experience (7 years): 1.0x
   - Location (Urban Standard): 1.0x

4. Final Premium: $1,750.00 × 1.15 × 1.0 × 1.0 × 1.0 = $2,012.50

Result: Premium = $2,012.50 (exceeds $500 minimum)
```

---

### 3.4 Quote Acceptance & Policy Creation Workflow

**Requirement 3.4.1**: When an insured accepts a quote, a workflow shall be triggered to create a Policy record.

**Requirement 3.4.2**: The workflow shall automatically generate a unique policy number using the format: `BR-YYYY-XXXXX` (where YYYY is the year and XXXXX is a sequential number).

**Requirement 3.4.3**: A new Policy record shall be created with data populated from the accepted Quote record.

**Requirement 3.4.4**: Data integrity shall be maintained between the Quote and Policy records, with the Policy record containing a reference to the originating Quote.

**Requirement 3.4.5**: The Quote status shall be updated to "Accepted" and the Policy status shall be set to "Active".

---

### 3.5 Policy Record & Form

**Requirement 3.5.1**: The system shall support creation and management of Policy records within client folders.

**Requirement 3.5.2**: Policy records shall be displayed and modified through a dynamic form configuration.

**Requirement 3.5.3**: The Policy form shall display and allow modification of the following information:

#### Policy Information:
- Policy number (auto-generated, read-only)
- Issue date
- Inception date
- Expiration date
- Policy status (Active / Expired / Cancelled / Renewed)

#### Policyholder Information:
- Insured name
- Business address
- Contact person and phone number
- Email address

#### Project Information:
- Project name/description
- Project address/location
- Project type
- Construction type
- Square footage
- Number of stories

#### Coverage Information:
- Total Insurable Value (TIV)
- Coverage limits
- Deductible
- Special conditions or exclusions

#### Payment Information:
- Premium amount
- Payment status (Pending / Paid / Overdue / Cancelled)
- Payment terms
- Payment due date
- Payment method

**Requirement 3.5.4**: Policy records shall support modification of coverage details and payment information after policy inception.

**Requirement 3.5.5**: Policy records shall track status through the following states:
- Active (policy in force)
- Expired (policy term ended)
- Cancelled (policy terminated before expiration)
- Renewed (policy renewed, replaced by new policy)

**Requirement 3.5.6**: Policy records shall include:
- Reference to originating Quote record
- Issue date and creation date
- Audit trail of modifications
- Associated documents (Policy Schedule, endorsements)

---

### 3.6 Renewal Workflow

**Requirement 3.6.1**: Upon creation of a Policy record, a scheduled task shall be automatically created to manage the renewal process.

**Requirement 3.6.2**: The renewal task shall be scheduled for 30 days prior to the policy expiration date.

**Requirement 3.6.3**: When the renewal task is triggered, the system shall:
- Create a new Quote record (renewal quote) linked to the original policy
- Copy relevant policy details to the renewal quote
- Create a task assigned to the underwriter to send the renewal quote to the insured
- Update the renewal quote status to "Submitted"

**Requirement 3.6.4**: The renewal quote shall maintain a reference to the original policy for historical tracking.

**Requirement 3.6.5**: Upon acceptance of the renewal quote, a new Policy record shall be created following the same process as initial policy creation.

**Requirement 3.6.6**: The original policy status shall be updated to "Renewed" and linked to the new policy record.

---

### 3.7 Task Management

**Requirement 3.7.1**: The system shall support task creation and assignment for tracking underwriter activities.

**Requirement 3.7.2**: Tasks shall include the following attributes:
- Task ID (auto-generated)
- Description (detailed task information)
- Raised by (creator/originator)
- Assigned to (owner/responsible party)
- Scheduled date (when task should be completed)
- Status (Open / In Progress / Completed / Cancelled)
- Priority (optional)
- Due date (optional)
- Related record (Quote or Policy)

**Requirement 3.7.3**: The system shall provide two views for task management:
- **Kanban view**: Visual workflow representation with columns for each status
- **List view**: Detailed table view with filtering and sorting

**Requirement 3.7.4**: Tasks shall be filterable and searchable by:
- Assigned to (underwriter)
- Status
- Scheduled date
- Related client
- Related record (Quote/Policy)

**Requirement 3.7.5**: Task completion shall be tracked with:
- Completion date
- Completed by
- Completion notes (optional)

**Requirement 3.7.6**: Tasks shall be automatically created by workflows for:
- Quote review and pricing
- Policy setup completion
- Renewal quote distribution
- Payment follow-up

---

### 3.8 Document Generation - Quote Document

**Requirement 3.8.1**: The system shall generate a dynamic Quote document in DOCX format using a configurable template.

**Requirement 3.8.2**: The Quote document shall be generated automatically when a quote is priced and shall be attached to the Quote record.

**Requirement 3.8.3**: The Quote document template shall include the following sections:

#### Document Header:
- Company logo and branding
- Document title: "BUILDERS RISK QUOTATION"
- Quote reference number
- Quote date
- Quote validity period (e.g., "Valid for 30 days")

#### Section 1: Insured Information
- Applicant/Builder name
- Business address
- Contact person and phone number
- Email address
- License number (if applicable)
- Years in business

#### Section 2: Project Details
- Project name/description
- Project address/location
- Project type (New Construction / Renovation / Demolition)
- Estimated start date
- Estimated completion date
- Project duration (calculated in days/months)
- Construction type (Wood Frame / Masonry / Steel)
- Square footage
- Number of stories

#### Section 3: Coverage Details
- Total Insurable Value (TIV)
- Coverage limits
- Deductible
- Special conditions or exclusions

#### Section 4: Pricing Summary
- Base rate (per $100 TIV) with project type
- Base premium calculation (shown as formula)
- Applicable modifiers with descriptions:
  - Project duration modifier and value
  - Construction type modifier and value
  - Builder experience modifier and value
  - Location risk modifier and value
- Subtotal after modifiers
- Taxes and fees (if applicable)
- **TOTAL PREMIUM** (highlighted/bold)

#### Section 5: Terms & Conditions
- Policy period
- Payment terms
- Cancellation clause
- Renewal information

#### Section 6: Acceptance Instructions
- How to accept the quote
- Contact information for questions
- Signature block for acceptance (date and signature lines)

#### Document Footer:
- Page numbers
- Company contact information
- Disclaimer/legal text

**Requirement 3.8.4**: The Quote document template shall support the following field mappings:

| Template Field | Source Record Field |
|---|---|
| Quote Reference Number | Quote.QuoteNumber |
| Quote Date | Quote.CreatedDate |
| Quote Validity Period | Quote.ValidityDays |
| Insured Name | Quote.Insured.Name |
| Insured Address | Quote.Insured.Address |
| Contact Person | Quote.Insured.Contact |
| Contact Phone | Quote.Insured.Phone |
| Contact Email | Quote.Insured.Email |
| License Number | Quote.Insured.LicenseNumber |
| Years in Business | Quote.Insured.YearsInBusiness |
| Project Name | Quote.Project.Name |
| Project Address | Quote.Project.Address |
| Project Type | Quote.Project.Type |
| Start Date | Quote.Project.StartDate |
| Completion Date | Quote.Project.CompletionDate |
| Project Duration | Quote.Project.Duration (calculated) |
| Construction Type | Quote.Project.ConstructionType |
| Square Footage | Quote.Project.SquareFootage |
| Number of Stories | Quote.Project.Stories |
| Total Insurable Value | Quote.Coverage.TIV |
| Coverage Limits | Quote.Coverage.Limits |
| Deductible | Quote.Coverage.Deductible |
| Base Rate | Quote.Pricing.BaseRate |
| Base Premium | Quote.Pricing.BasePremium |
| Project Duration Modifier | Quote.Pricing.Modifiers.DurationModifier |
| Construction Type Modifier | Quote.Pricing.Modifiers.ConstructionModifier |
| Builder Experience Modifier | Quote.Pricing.Modifiers.ExperienceModifier |
| Location Risk Modifier | Quote.Pricing.Modifiers.LocationModifier |
| Subtotal | Quote.Pricing.SubTotal |
| Taxes/Fees | Quote.Pricing.Taxes |
| Total Premium | Quote.Pricing.TotalPremium |

---

### 3.9 Document Generation - Policy Schedule

**Requirement 3.9.1**: The system shall generate a dynamic Policy Schedule document in DOCX format using a configurable template.

**Requirement 3.9.2**: The Policy Schedule document shall be generated automatically when a policy is created and shall be attached to the Policy record.

**Requirement 3.9.3**: The Policy Schedule document template shall include the following sections:

#### Document Header:
- Company logo and branding
- Document title: "BUILDERS RISK POLICY SCHEDULE"
- Policy number
- Issue date
- Inception and expiration dates

#### Section 1: Policyholder Information
- Policyholder/Insured name
- Business address
- Contact person and phone number
- Email address
- Policy number
- Agent/Broker information (if applicable)

#### Section 2: Project Information
- Project name/description
- Project address/location
- Project type
- Inception date (policy start)
- Expiration date (policy end)
- Construction type
- Square footage
- Number of stories

#### Section 3: Coverage Summary
- Total Insurable Value (TIV)
- Coverage limits
- Deductible
- Premium amount
- Payment status

#### Section 4: Payment Information
- Total premium due
- Payment terms (e.g., "Due upon inception")
- Payment method options
- Due date
- Account/reference number for payments

#### Section 5: Policy Terms & Conditions
- Coverage period
- Renewal date (30 days before expiration)
- Cancellation provisions
- Modification procedures
- Claims reporting procedures

#### Section 6: Endorsements (if applicable)
- List of any endorsements
- Effective dates
- Description of changes

#### Section 7: Important Notices
- Renewal reminder (30 days before expiration)
- Contact information for claims
- Contact information for policy questions
- Cancellation notice requirements

#### Document Footer:
- Page numbers
- Company contact information
- Policy issue date
- Authorized signature block

**Requirement 3.9.4**: The Policy Schedule document template shall support the following field mappings:

| Template Field | Source Record Field |
|---|---|
| Policy Number | Policy.PolicyNumber |
| Issue Date | Policy.IssueDate |
| Inception Date | Policy.InceptionDate |
| Expiration Date | Policy.ExpirationDate |
| Policyholder Name | Policy.Insured.Name |
| Policyholder Address | Policy.Insured.Address |
| Contact Person | Policy.Insured.Contact |
| Contact Phone | Policy.Insured.Phone |
| Contact Email | Policy.Insured.Email |
| Agent/Broker Name | Policy.Agent.Name |
| Project Name | Policy.Project.Name |
| Project Address | Policy.Project.Address |
| Project Type | Policy.Project.Type |
| Construction Type | Policy.Project.ConstructionType |
| Square Footage | Policy.Project.SquareFootage |
| Number of Stories | Policy.Project.Stories |
| Total Insurable Value | Policy.Coverage.TIV |
| Coverage Limits | Policy.Coverage.Limits |
| Deductible | Policy.Coverage.Deductible |
| Premium Amount | Policy.Premium |
| Payment Status | Policy.PaymentStatus |
| Payment Terms | Policy.PaymentTerms |
| Payment Due Date | Policy.PaymentDueDate |
| Renewal Date | Policy.RenewalDate (calculated as ExpirationDate - 30 days) |
| Endorsements | Policy.Endorsements[] |

---

### 3.10 Supporting Features

**Requirement 3.10.1**: The system shall support meeting records for documenting underwriter meetings, discussions, and notes related to quotes and policies.

**Requirement 3.10.2**: The system shall provide AI assistant chat integration to support underwriters with:
- Policy research and information lookup
- Rating rule clarification
- Process guidance
- General underwriting support

**Requirement 3.10.3**: The system shall support workflow automation for referrals, allowing underwriters to:
- Refer quotes or policies to other underwriters
- Automatically reassign associated tasks
- Maintain audit trail of referrals
- Notify the assigned underwriter of the referral

**Requirement 3.10.4**: The system shall maintain a comprehensive audit trail for:
- All record changes (Quote and Policy)
- Document generation and access
- Task assignments and completions
- Workflow executions
- User actions

**Requirement 3.10.5**: Documents (Quote documents and Policy Schedules) shall be:
- Stored with their associated records
- Accessible for download and printing
- Tracked in the audit trail
- Versioned if regenerated

---

## 4. WORKFLOW SPECIFICATIONS

### 4.1 Quote Submission & Pricing Workflow

**Workflow Name**: Quote Submission & Pricing

**Trigger**: Quote record status changed to "Submitted"

**Steps**:

1. **Validate Quote Data**: System validates that all required fields are populated
   - If validation fails: Update status to "Draft" and notify underwriter of missing fields
   - If validation passes: Proceed to step 2

2. **Execute Pricing Ruleset**: System executes the pricing ruleset with quote data
   - Retrieve base rate based on project type
   - Calculate base premium: (TIV / 100) × Base Rate
   - Apply all applicable modifiers (duration, construction, experience, location)
   - Calculate final premium: Base Premium × (Product of all modifiers)
   - Verify premium meets minimum ($500) and maximum constraints
   - Store all pricing details with quote record

3. **Generate Quote Document**: System generates Quote document from template
   - Populate all template fields from quote record
   - Create DOCX document
   - Attach document to quote record
   - Store document reference

4. **Update Quote Status**: Update quote status to "Priced"

5. **Create Review Task**: Create task for underwriter review
   - Task Description: "Review and approve quote for [Project Name]"
   - Assigned to: Original underwriter or designated reviewer
   - Scheduled date: Current date
   - Status: Open

6. **Notify Underwriter**: Send notification to assigned underwriter that quote is ready for review

**End State**: Quote record with status "Priced", calculated premium, generated document, and review task

---

### 4.2 Quote Acceptance & Policy Creation Workflow

**Workflow Name**: Quote Acceptance & Policy Creation

**Trigger**: Quote record status changed to "Accepted"

**Steps**:

1. **Generate Policy Number**: System generates unique policy number
   - Format: BR-YYYY-XXXXX
   - YYYY: Current year
   - XXXXX: Sequential number (padded with zeros)
   - Verify uniqueness in system

2. **Create Policy Record**: System creates new Policy record
   - Copy all relevant data from Quote record to Policy record
   - Set Policy.PolicyNumber to generated number
   - Set Policy.IssueDate to current date
   - Set Policy.InceptionDate to quote inception date (or current date if not specified)
   - Set Policy.ExpirationDate to inception date + 12 months
   - Set Policy.Status to "Active"
   - Create reference link from Policy to Quote record

3. **Generate Policy Schedule Document**: System generates Policy Schedule document from template
   - Populate all template fields from policy record
   - Create DOCX document
   - Attach document to policy record
   - Store document reference

4. **Create Renewal Task**: System creates scheduled task for renewal
   - Task Description: "Send renewal quote for [Project Name] - Policy [Policy Number]"
   - Scheduled date: Policy.ExpirationDate - 30 days
   - Assigned to: Original underwriter
   - Status: Open
   - Link to Policy record

5. **Update Quote Status**: Update quote status to "Accepted"

6. **Create Setup Task**: Create task for policy setup completion
   - Task Description: "Complete policy setup for [Policy Number]"
   - Assigned to: Original underwriter
   - Scheduled date: Current date + 1 day
   - Status: Open

7. **Notify Underwriter**: Send notification to assigned underwriter that policy has been created

**End State**: Policy record created with status "Active", Policy Schedule document generated, renewal task scheduled, and setup task created

---

### 4.3 Policy Renewal Workflow

**Workflow Name**: Policy Renewal

**Trigger**: Scheduled renewal task reaches scheduled date

**Steps**:

1. **Create Renewal Quote**: System creates new Quote record
   - Copy relevant data from original Policy record to new Quote record
   - Set Quote.Status to "Submitted"
   - Create reference link from renewal Quote to original Policy record
   - Mark as renewal quote

2. **Execute Pricing Ruleset**: System executes pricing ruleset for renewal quote
   - Apply same pricing logic as initial quote
   - Calculate premium based on current policy details
   - Store pricing details with renewal quote record

3. **Generate Renewal Quote Document**: System generates Quote document from template
   - Populate all template fields from renewal quote record
   - Create DOCX document
   - Attach document to renewal quote record
   - Store document reference

4. **Create Distribution Task**: System creates task to send renewal quote
   - Task Description: "Send renewal quote to [Insured Name] - Policy [Policy Number]"
   - Assigned to: Original underwriter
   - Scheduled date: Current date
   - Status: Open
   - Link to renewal Quote record

5. **Update Renewal Task**: Mark original renewal task as completed

6. **Notify Underwriter**: Send notification to assigned underwriter that renewal quote is ready to send

**End State**: Renewal Quote record created with pricing and document, distribution task created, original renewal task completed

**Note**: Upon acceptance of renewal quote, the Quote Acceptance & Policy Creation Workflow is triggered, creating a new Policy record and updating the original policy status to "Renewed"

---

### 4.4 Referral Workflow

**Workflow Name**: Quote/Policy Referral

**Trigger**: Underwriter initiates referral of Quote or Policy record

**Steps**:

1. **Validate Referral**: System validates that referral target is valid
   - Verify target underwriter exists and is active
   - Verify record can be referred
   - If validation fails: Notify referring underwriter of error

2. **Reassign Associated Tasks**: System reassigns all open tasks related to the record
   - Find all tasks linked to Quote or Policy record
   - Filter for tasks with status "Open" or "In Progress"
   - Update task "Assigned to" field to target underwriter
   - Update task "Assigned date" to current date

3. **Create Audit Entry**: System creates audit entry documenting referral
   - Record original underwriter
   - Record target underwriter
   - Record referral date/time
   - Record reason (if provided)

4. **Update Record**: Update Quote or Policy record with referral information
   - Add referral note to record
   - Update "Assigned to" field to target underwriter

5. **Notify Target Underwriter**: Send notification to target underwriter
   - Notification includes record details
   - Notification includes list of reassigned tasks
   - Notification includes referral reason (if provided)

6. **Notify Referring Underwriter**: Send confirmation to referring underwriter
   - Confirmation includes target underwriter name
   - Confirmation includes list of reassigned tasks

**End State**: Quote or Policy record reassigned to target underwriter, all associated tasks reassigned, audit trail created, both underwriters notified

---

## 5. DATA MANAGEMENT

### 5.1 Record Sets

**Requirement 5.1.1**: Quote and Policy records shall be organized within client folders for easy navigation and management.

**Requirement 5.1.2**: Quote records shall be linked to Policy records to maintain the relationship between the quote and the resulting policy.

**Requirement 5.1.3**: Renewal quotes shall be linked to the original policy record to maintain historical tracking of renewal activity.

**Requirement 5.1.4**: Historical records shall be retained for audit purposes and shall not be deleted, only archived or marked as inactive.

**Requirement 5.1.5**: Associated documents (Quote documents, Policy Schedules) shall be stored with their respective records and shall be accessible through the record interface.

### 5.2 Form Configuration

**Requirement 5.2.1**: Quote and Policy forms shall support dynamic field visibility using conditional rules.

**Requirement 5.2.2**: Conditional rules shall be based on the values of other fields in the form. Example:
- Show "Renovation Scope" field only if "Project Type" = "Renovation"
- Show "Demolition Permit" field only if "Project Type" = "Demolition"
- Show "Prior Loss Details" field only if "Prior Loss History" = "Yes"

**Requirement 5.2.3**: Forms shall include validation rules to ensure data quality:
- Required field validation
- Data type validation (e.g., dates, numbers)
- Range validation (e.g., TIV must be between $100,000 and $50,000,000)
- Format validation (e.g., phone numbers, email addresses)

**Requirement 5.2.4**: Fields shall be designated as either required or optional, with required fields clearly marked in the form.

**Requirement 5.2.5**: Form configuration shall be maintainable without code changes, allowing business users to modify field visibility rules and validation rules.

---

## 6. REPORTING & ANALYTICS

**Requirement 6.1**: The system shall support reporting on:
- Quote to policy conversion rate (number of quotes accepted vs. total quotes)
- Average premium by project type
- Average premium by geographic location
- Premium by construction type
- Quote processing time (from submission to pricing)
- Policy count by status

**Requirement 6.2**: The system shall support task management analytics:
- Task completion rate
- Average task completion time
- Task volume by underwriter
- Task volume by type (review, distribution, setup, etc.)

**Requirement 6.3**: The system shall support underwriter productivity metrics:
- Number of quotes processed per underwriter
- Number of policies created per underwriter
- Average premium per underwriter
- Conversion rate per underwriter

**Requirement 6.4**: The system shall support renewal analytics:
- Renewal rate (policies renewed vs. policies expired)
- Renewal quote acceptance rate
- Average time to renewal quote acceptance

**Requirement 6.5**: The system shall maintain an audit trail of all document generation activities:
- Document type (Quote, Policy Schedule)
- Document generation date/time
- Associated record (Quote or Policy)
- Generated by (system or user)
- Document version

---

## 7. SECURITY & COMPLIANCE

**Requirement 7.1**: The system shall implement role-based access control (RBAC) to restrict access to underwriters only.

**Requirement 7.2**: Underwriters shall only be able to access clients and records assigned to them or their team.

**Requirement 7.3**: The system shall maintain a comprehensive audit trail for all record changes, including:
- User who made the change
- Date and time of change
- Field(s) changed
- Previous value and new value
- Reason for change (if applicable)

**Requirement 7.4**: The system shall maintain an audit trail for all document generation activities, including:
- Document type
- Associated record
- Generation date/time
- Generated by
- Document version

**Requirement 7.5**: Sensitive information (policyholder data, financial information) shall be encrypted at rest and in transit.

**Requirement 7.6**: The system shall comply with applicable insurance regulatory requirements, including:
- Data retention requirements
- Privacy regulations (GDPR, CCPA, etc.)
- Insurance industry standards

**Requirement 7.7**: Access to documents shall be logged and tracked in the audit trail.

---

## 8. NON-FUNCTIONAL REQUIREMENTS

**Requirement 8.1**: The system shall support concurrent usage by multiple underwriters without performance degradation.

**Requirement 8.2**: The system shall provide data backup and recovery procedures to ensure data integrity and availability.

**Requirement 8.3**: The system shall maintain 99.5% uptime availability during business hours.

**Requirement 8.4**: The system shall provide a user interface optimized for underwriter workflows, with intuitive navigation and clear information hierarchy.

**Requirement 8.5**: Document generation shall complete within 5 seconds for Quote documents and Policy Schedule documents.

**Requirement 8.6**: Quote pricing calculation shall complete within 2 seconds.

**Requirement 8.7**: The system shall support search and filtering across all records with response times under 3 seconds for typical queries.

**Requirement 8.8**: The system shall provide responsive design for use on desktop and tablet devices.

---

## 9. FUTURE ENHANCEMENTS

**Enhancement 9.1**: Integration with external rating engines to support more sophisticated pricing models.

**Enhancement 9.2**: Automated document delivery via email to send Quote documents and Policy Schedules directly to insureds.

**Enhancement 9.3**: Customer portal for insureds to view quotes, policies, and manage renewals.

**Enhancement 9.4**: Advanced analytics and reporting with dashboards and custom report builder.

**Enhancement 9.5**: Multi-product support to extend the system beyond Builders Risk to other specialty products.

**Enhancement 9.6**: Integration with accounting and billing systems for automated premium collection and revenue recognition.

**Enhancement 9.7**: Mobile application for underwriters to manage quotes and policies on the go.

**Enhancement 9.8**: Integration with document management systems for centralized document storage and retrieval.

---

## APPENDIX A: GLOSSARY

| Term | Definition |
|---|---|
| **Builders Risk** | Insurance product covering construction projects against loss or damage during the construction period |
| **TIV** | Total Insurable Value - the total value of property covered under the policy |
| **Quote** | A pricing proposal provided to a potential insured for insurance coverage |
| **Policy** | A binding insurance contract between the insurer and the insured |
| **Underwriter** | Insurance company employee responsible for evaluating risk and pricing insurance coverage |
| **Renewal** | The process of extending an expiring policy for an additional term |
| **Endorsement** | A modification or addition to an existing policy |
| **Modifier** | A factor applied to a base rate to adjust pricing based on specific risk characteristics |
| **Workflow** | An automated business process that executes a series of steps based on defined triggers |
| **Kanban** | A visual workflow management method using columns to represent different stages |

---

## APPENDIX B: DOCUMENT TEMPLATES

### Quote Document Template Structure

```
┌─────────────────────────────────────────────────────┐
│ HEADER                                              │
│ - Company Logo                                      │
│ - "BUILDERS RISK QUOTATION"                         │
│ - Quote #: [QuoteNumber]                            │
│ - Quote Date: [CreatedDate]                         │
│ - Valid for: [ValidityDays] days                    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 1: INSURED INFORMATION                      │
│ - Name: [Insured.Name]                              │
│ - Address: [Insured.Address]                        │
│ - Contact: [Insured.Contact]                        │
│ - Phone: [Insured.Phone]                            │
│ - Email: [Insured.Email]                            │
│ - License #: [Insured.LicenseNumber]                │
│ - Years in Business: [Insured.YearsInBusiness]      │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 2: PROJECT DETAILS                          │
│ - Project Name: [Project.Name]                      │
│ - Address: [Project.Address]                        │
│ - Type: [Project.Type]                              │
│ - Start Date: [Project.StartDate]                   │
│ - Completion Date: [Project.CompletionDate]         │
│ - Duration: [Project.Duration]                      │
│ - Construction Type: [Project.ConstructionType]     │
│ - Square Footage: [Project.SquareFootage]           │
│ - Stories: [Project.Stories]                        │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 3: COVERAGE DETAILS                         │
│ - TIV: [Coverage.TIV]                               │
│ - Limits: [Coverage.Limits]                         │
│ - Deductible: [Coverage.Deductible]                 │
│ - Exclusions: [Coverage.Exclusions]                 │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 4: PRICING SUMMARY                          │
│ Base Rate: [Pricing.BaseRate]                       │
│ Base Premium: [Pricing.BasePremium]                 │
│                                                     │
│ Modifiers:                                          │
│ - Duration: [Modifiers.Duration] x [Value]          │
│ - Construction: [Modifiers.Construction] x [Value]  │
│ - Experience: [Modifiers.Experience] x [Value]      │
│ - Location: [Modifiers.Location] x [Value]          │
│                                                     │
│ Subtotal: [Pricing.SubTotal]                        │
│ Taxes/Fees: [Pricing.Taxes]                         │
│ ─────────────────────────────────────────────────   │
│ TOTAL PREMIUM: [Pricing.TotalPremium] *** BOLD ***  │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 5: TERMS & CONDITIONS                       │
│ - Policy Period: [Terms.Period]                     │
│ - Payment Terms: [Terms.PaymentTerms]               │
│ - Cancellation: [Terms.Cancellation]                │
│ - Renewal: [Terms.Renewal]                          │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 6: ACCEPTANCE INSTRUCTIONS                  │
│ - How to Accept                                     │
│ - Contact Information                               │
│ - Signature Block                                   │
│   Accepted by: _______________  Date: ___________   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ FOOTER                                              │
│ - Page Number                                       │
│ - Company Contact Info                              │
│ - Disclaimer                                        │
└─────────────────────────────────────────────────────┘
```

### Policy Schedule Document Template Structure

```
┌─────────────────────────────────────────────────────┐
│ HEADER                                              │
│ - Company Logo                                      │
│ - "BUILDERS RISK POLICY SCHEDULE"                   │
│ - Policy #: [PolicyNumber]                          │
│ - Issue Date: [IssueDate]                           │
│ - Inception: [InceptionDate]                        │
│ - Expiration: [ExpirationDate]                      │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 1: POLICYHOLDER INFORMATION                 │
│ - Name: [Insured.Name]                              │
│ - Address: [Insured.Address]                        │
│ - Contact: [Insured.Contact]                        │
│ - Phone: [Insured.Phone]                            │
│ - Email: [Insured.Email]                            │
│ - Policy #: [PolicyNumber]                          │
│ - Agent/Broker: [Agent.Name]                        │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 2: PROJECT INFORMATION                      │
│ - Project Name: [Project.Name]                      │
│ - Address: [Project.Address]                        │
│ - Type: [Project.Type]                              │
│ - Inception: [InceptionDate]                        │
│ - Expiration: [ExpirationDate]                      │
│ - Construction Type: [Project.ConstructionType]     │
│ - Square Footage: [Project.SquareFootage]           │
│ - Stories: [Project.Stories]                        │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 3: COVERAGE SUMMARY                         │
│ - TIV: [Coverage.TIV]                               │
│ - Limits: [Coverage.Limits]                         │
│ - Deductible: [Coverage.Deductible]                 │
│ - Premium: [Premium]                                │
│ - Payment Status: [PaymentStatus]                   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 4: PAYMENT INFORMATION                      │
│ - Total Premium Due: [Premium]                      │
│ - Payment Terms: [PaymentTerms]                     │
│ - Payment Methods: [PaymentMethods]                 │
│ - Due Date: [PaymentDueDate]                        │
│ - Account #: [AccountNumber]                        │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 5: POLICY TERMS & CONDITIONS                │
│ - Coverage Period: [CoveragePeriod]                 │
│ - Renewal Date: [RenewalDate]                       │
│ - Cancellation: [CancellationTerms]                 │
│ - Modifications: [ModificationProcedure]            │
│ - Claims: [ClaimsProcedure]                         │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 6: ENDORSEMENTS (if applicable)             │
│ - Endorsement 1: [Description] [EffectiveDate]      │
│ - Endorsement 2: [Description] [EffectiveDate]      │
│ - ...                                               │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ SECTION 7: IMPORTANT NOTICES                        │
│ - Renewal Reminder: 30 days before expiration       │
│ - Claims Contact: [ClaimsContact]                   │
│ - Questions Contact: [QuestionsContact]             │
│ - Cancellation Notice: [CancellationNotice]         │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│ FOOTER                                              │
│ - Page Number                                       │
│ - Company Contact Info                              │
│ - Issue Date                                        │
│ - Authorized Signature Block                        │
└─────────────────────────────────────────────────────┘
```

---

**Document Version**: 1.0  
**Last Updated**: 2026-08-04  
**Status**: Draft

---

The markdown file has been generated and is available for download. You can also view it directly in the knowledge base at the provided URI. The document includes all sections with the Quote and Policy Schedule document specifications, complete pricing rules with examples, and detailed workflow specifications.