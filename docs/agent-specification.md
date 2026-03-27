# Pipedrive CRM Automation Agent - Complete Technical Specification

**Version:** 3.1.0
**Runtime:** Node.js >= 20.0.0 (ES Modules)
**Deployment:** Docker container on Railway (cron-scheduled) or macOS launchd (local)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Pipeline Stages](#3-pipeline-stages)
4. [Orchestration Pipeline](#4-orchestration-pipeline)
5. [Rules Engine](#5-rules-engine)
6. [Stage Advancement](#6-stage-advancement)
7. [Email Templating and AI Polish](#7-email-templating-and-ai-polish)
8. [Web Enrichment](#8-web-enrichment)
9. [Gmail Integration](#9-gmail-integration)
10. [Pipedrive API Integration](#10-pipedrive-api-integration)
11. [Slack Notifications](#11-slack-notifications)
12. [Configuration Files](#12-configuration-files)
13. [Environment Variables](#13-environment-variables)
14. [Deployment](#14-deployment)
15. [NPM Scripts](#15-npm-scripts)

---

## 1. Overview

This agent automates investor outreach follow-ups for a fund distribution pipeline. It runs on a cron schedule (weekday mornings), reads all open deals from a Pipedrive CRM pipeline, evaluates which contacts are overdue for follow-up based on configurable rules, renders personalized emails using Handlebars templates polished by Claude AI, and creates Gmail drafts for human review before sending.

The agent never sends emails directly. It creates drafts only. A human reviews and sends each draft.

### What It Does Per Run

1. Fetches all contacts from Pipedrive (open deals in the configured pipeline)
2. Checks Gmail for the latest email activity with each contact
3. Syncs last outbound dates for new contacts
4. Checks for existing unsent drafts (deduplication)
5. Evaluates follow-up rules to identify overdue contacts
6. Fetches email thread history for context
7. Enriches contacts with Pipedrive notes and DuckDuckGo web search
8. Evaluates and applies stage advancements
9. Renders emails from stage-specific templates
10. Polishes emails with Claude AI using the sender's voice profile
11. Creates Gmail drafts (threaded replies when prior conversation exists)
12. Updates CRM fields (outreach attempts, last outbound date)
13. Creates Pipedrive follow-up reminder activities
14. Generates flags (stale contacts, hot leads, breakup pending, introducer nudges)
15. Posts a structured summary to Slack
16. Saves a JSON run report to `data/runs/`

---

## 2. Architecture

### File Structure

```
src/
  index.js              # Entry point, CLI flag parsing
  orchestrator.js       # 7-step pipeline orchestration
  config/
    index.js            # Config loader, stage helpers, validation
  api/
    pipedrive.js        # Pipedrive API client (read + write), CSV fallback
  gmail/
    auth.js             # One-time OAuth2 consent flow
    client.js           # Gmail API client (read threads, create drafts)
  rules/
    engine.js           # Follow-up evaluation, urgency scoring, stale detection
    advancement.js      # Stage advancement rules, breakup/hot-lead flags
    introducer.js       # Introducer re-engagement flags
  templates/
    router.js           # Template resolution, Handlebars rendering, AI polish
    emails/             # 13 Handlebars (.hbs) email templates
  enrichment/
    enrichment.js       # DuckDuckGo web search enrichment
  summary/
    builder.js          # Slack message formatting and posting
config/
  pipeline-stages.json  # 9-stage pipeline definition
  follow-up-rules.json  # Rules engine config (thresholds, scoring, exclusions)
  template-mapping.json # Stage-to-template routing, AI instructions
  pipedrive-ids.json    # Pipedrive stage ID mappings
  pipedrive-fields.json # Custom field definitions and API rate limits
  voice-profile.json    # Sender voice profile for AI polish
```

### Dependencies

| Package | Version | Purpose |
|---|---|---|
| `googleapis` | ^144.0.0 | Gmail API (OAuth2, read, compose) |
| `@anthropic-ai/sdk` | ^0.39.0 | Claude AI for email personalization |
| `@slack/webhook` | ^7.0.0 | Slack incoming webhook |
| `handlebars` | ^4.7.0 | Email template rendering |
| `dotenv` | ^16.4.0 | Environment variable loading |

### Data Flow

```
Pipedrive API (contacts, deals, notes)
       |
       v
  Normalize to Contact shape
       |
       v
  Gmail API (last email dates, thread history, existing drafts)
       |
       v
  Rules Engine (exclusions -> overdue check -> urgency scoring -> rank & cap)
       |
       v
  Stage Advancement Engine (auto-advance on no-reply or reply-detected)
       |
       v
  DuckDuckGo Web Enrichment + Pipedrive Notes
       |
       v
  Template Router (stage-specific Handlebars template)
       |
       v
  Claude AI Polish (voice profile + contact context + email history)
       |
       v
  Gmail Draft Creation (threaded replies when applicable)
       |
       v
  Pipedrive Field Updates (outreach attempts, last outbound date)
       |
       v
  Pipedrive Activity Creation (follow-up reminders)
       |
       v
  Slack Summary + JSON Report
```

---

## 3. Pipeline Stages

The pipeline has 9 stages in order. Each stage has a type, a follow-up threshold, an attempt limit, and auto-advancement rules.

| # | Key | Name | Type | Threshold (days) | Max Attempts | Auto-advance (no reply) | Auto-advance (reply) |
|---|---|---|---|---|---|---|---|
| 1 | `follow_up_1` | Follow Up #1 | active | 30 | 1 | `follow_up_2` | `engaged` |
| 2 | `follow_up_2` | Follow Up #2 | active | 30 | 1 | `breakup` | `engaged` |
| 3 | `breakup` | Breakup | active | 7 | 1 | none | `engaged` |
| 4 | `engaged` | Engaged | active | 5 | 4 | none | none |
| 5 | `post_meeting` | Post-Meeting | active | 3 | 3 | none | none |
| 6 | `due_diligence` | Due Diligence | active | 2 | 6 | none | none |
| 7 | `committed` | Committed | won | null | 0 | n/a | n/a |
| 8 | `on_hold` | On Hold | on_hold | 90 | unlimited | n/a | `engaged` |
| 9 | `declined_cold` | Declined (Cold) | lost_cold | 365 | 1 | n/a | n/a |

### Stage Descriptions

- **Follow Up #1:** First automated follow-up, 30 days after the sender's manual initial outreach. One email with a performance data hook.
- **Follow Up #2:** Second follow-up, 30 days after Follow Up #1. Different angle (valuation comparison). Last attempt before breakup.
- **Breakup:** Permission-to-close email. Respectful close. 7-day threshold. These often get the fastest responses.
- **Engaged:** Contact has responded, had a call, or requested materials. Goal: schedule a call with Paul. 5-day cadence, up to 4 attempts.
- **Post-Meeting:** Contact has met with the team. Follow-up within 48 hours asking for candid feedback. 3-day cadence, up to 3 attempts.
- **Due Diligence:** Contact is reviewing materials or has data room access. Tight 2-day cadence, up to 6 attempts. Offer to clarify DD items.
- **Committed:** Invested or verbal commitment. No automated follow-up.
- **On Hold:** Passed but left the door open. Quarterly touch-base with substantive updates only.
- **Declined (Cold):** No response after breakup or clear "not interested." Annual check-in at most.

---

## 4. Orchestration Pipeline

The orchestrator (`src/orchestrator.js`) runs a 7-step pipeline:

### Step 1: Fetch Contacts
- Calls `getContacts()` from `api/pipedrive.js`
- If `PIPEDRIVE_API_TOKEN` + `PIPEDRIVE_COMPANY_DOMAIN` are set, fetches from the Pipedrive API v2
- Otherwise, falls back to parsing a CSV file at `data/pipedrive-export.csv`
- All contacts are normalized to a standard `Contact` shape (see Section 10)

### Step 2: Check Gmail Activity
- For each contact email, searches Gmail sent mail for the most recent outbound message (last 3 months)
- Returns a `Map<email, ISO date string>` for overdue calculations
- If Gmail is not configured, falls back to CRM-only dates

### Step 2b: Sync Last Outbound Date
- For contacts that have no `lastOutboundDate` in the CRM but do have Gmail history, writes the Gmail date back to Pipedrive's "Last Outbound Date" custom field

### Step 2c: Draft Deduplication
- Fetches all existing Gmail drafts
- Checks the `To` header of each draft against the contact list
- Returns a `Set<email>` of contacts that already have an unsent draft
- These contacts are excluded from follow-up generation to prevent duplicate drafts

### Step 3: Evaluate Follow-Up Rules
- Runs the full rules engine evaluation pipeline (see Section 5)
- Filters out contacts with existing unsent drafts
- Outputs a ranked, capped array of `FollowUp` objects

### Step 3b: Fetch Email History
- For each follow-up contact, fetches the 5 most recent emails (sent and received) from Gmail
- Extracts plaintext bodies (truncated to 500 chars each)
- Captures threading metadata (`threadId`, `messageId`, `references`) from the most recent message
- Attaches `emailHistory` and `threadInfo` to each follow-up

### Step 3c: Contact Enrichment
- Only runs if Claude AI is enabled
- For each follow-up contact, runs two enrichment sources in parallel:
  1. **Pipedrive Notes:** Fetches the 5 most recent notes from the Pipedrive Notes entity (v1 API), concatenates them (truncated to 2000 chars)
  2. **Web Enrichment:** Searches DuckDuckGo for the contact's name + company (see Section 8)

### Step 4: Stage Advancements
- Evaluates auto-advancement rules (see Section 6)
- Applies advancements by updating the deal stage in Pipedrive, resetting outreach attempts to 0, and logging an activity note

### Step 5: Render and Create Drafts
- For each follow-up:
  1. Resolves the template name using `template-mapping.json` routing rules
  2. Renders the Handlebars template with contact context
  3. If AI polish is enabled for the stage, sends the draft + contact context + email history + enrichment data to Claude
  4. Creates a Gmail draft (as a threaded reply if `threadInfo` exists, otherwise standalone)
  5. Updates `Outreach Attempts` (increment by 1) and `Last Outbound Date` (today) in Pipedrive
  6. Creates a Pipedrive follow-up reminder activity (skipped if the contact already has an open activity)
- BCC: Every draft includes `satoriir@pipedrivemail.com` in BCC for CRM email tracking

### Step 6: Collect Flags
Generates 4 types of flags for the daily summary:
- **Introducer nudges:** Contacts in engaged/post_meeting/due_diligence with an introducer, silent for 21+ days
- **Stale contacts:** Contacts in active stages with no activity for 180+ days
- **Breakup pending:** Contacts in follow_up_2 who have exhausted max attempts
- **Hot leads:** Contacts in due_diligence with activity in the last 7 days

### Step 7: Slack Summary
- Posts a structured Block Kit message to Slack with:
  - Follow-up count and draft count
  - Stage breakdown with urgency scores
  - Stage advancements applied
  - Flags and alerts (grouped by type with emojis)
  - Draft review reminder

### Post-Run
- Saves a JSON run report to `data/runs/YYYY-MM-DD.json`
- If errors occurred, posts a separate error alert to Slack

---

## 5. Rules Engine

The rules engine (`src/rules/engine.js`) processes contacts through a 5-step evaluation pipeline defined in `follow-up-rules.json`.

### Step 1: Check Exclusions

Contacts are excluded from follow-up if any of these match:

| Exclusion Type | Items |
|---|---|
| **No email** | Contacts without an email address |
| **Tags** | `do-not-contact`, `legal-hold`, `unsubscribed`, `paused` |
| **Stages** | `committed` |
| **Conditions** | `email_bounced == true`, `days_since_last_outbound < 1` (already contacted today) |

Tags are checked against the contact's `tags` array (sourced from Pipedrive person labels).

### Step 2: Check Overdue

For each non-excluded contact:
1. Look up the overdue threshold for the contact's stage from `overdue_thresholds`
2. Determine the last contact date: prefer Gmail activity data, fall back to CRM `lastContactDate`
3. Calculate days since last contact (business days if `business_days_only` is true, calendar days otherwise)
4. Contact is overdue if `daysSince >= threshold`
5. Never-contacted contacts are always overdue (`daysSince = Infinity`)

Also checks `attempt_limits` - if the contact's `outreachAttempts` >= the limit for their stage, they are skipped (the advancement engine handles them).

### Step 3: Calculate Urgency

Formula: `base_urgency * source_multiplier * recency_decay * stage_weight`

**Base urgency:** `days_since_contact / threshold_days`, capped at 1.0. Never-contacted contacts get `threshold * 2 / threshold = 2.0` (double urgency, still capped at 1.0).

**Source multipliers** (from `lead_source` field):

| Lead Source | Multiplier |
|---|---|
| `warm_intro` | 1.5 |
| `mutual_connection` | 1.4 |
| `inbound_inquiry` | 1.3 |
| `conference_meeting` | 1.2 |
| `conference_lead` | 1.1 |
| `cold_email` | 0.7 |
| `distribution_list` | 0.5 |
| null/unknown | 1.0 |

**Recency decay:** Exponential decay with a 90-day half-life and a 0.1 floor. Contacts who have been idle longer get deprioritized. Formula: `max(0.5^(daysIdle/90), 0.1)`.

**Stage weights:**

| Stage | Weight |
|---|---|
| `post_meeting` | 1.0 |
| `due_diligence` | 1.0 |
| `engaged` | 0.9 |
| `breakup` | 0.7 |
| `follow_up_2` | 0.6 |
| `follow_up_1` | 0.5 |
| `on_hold` | 0.3 |
| `declined_cold` | 0.1 |

### Step 4: Priority Multiplier

Adjusts final urgency based on contact priority (from Pipedrive labels):
- `high` priority: 1.5x multiplier
- `medium` priority: 1.0x (no change)
- `low` priority: 0.5x multiplier

### Step 5: Rank and Cap

1. Sort all follow-ups by `urgencyScore` descending
2. Filter out any with `urgencyScore < 0.3` (the `min_urgency_to_draft` threshold)
3. Take the top 15 (`max_drafts_per_run`)

### Stale Contact Detection

Separate from the follow-up pipeline, `detectStaleContacts` flags contacts in active stages with no activity for 180+ calendar days.

---

## 6. Stage Advancement

The advancement engine (`src/rules/advancement.js`) evaluates and applies automatic stage transitions.

### Rules

Three rules execute in order (one advancement per contact per run):

1. **No reply after max attempts in follow_up_1:** Advance to `follow_up_2`
2. **No reply after max attempts in follow_up_2:** Advance to `breakup`
3. **Reply detected from follow_up_1, follow_up_2, breakup, or on_hold:** Advance to `engaged`

### No-Reply Detection

A contact has "no reply after max attempts" when:
- `outreachAttempts >= attempt_limit` for their current stage
- AND they have no inbound date more recent than their last outbound date

### Reply Detection

A reply is detected when:
- Gmail shows activity for the contact's email (via the `gmailActivity` map)
- AND the Gmail activity date is more recent than the contact's `lastOutboundDate`

### Advancement Actions

When a stage advancement is applied:
1. Update the deal's `stage_id` in Pipedrive to the target stage's ID
2. Reset `Outreach Attempts` to 0 on the person record
3. Add a note to the deal: `[CRM Agent] Auto-advanced from "X" to "Y" (trigger: Z)`

### Flags

- **Breakup pending:** Contacts in `follow_up_2` with `outreachAttempts >= max_attempts` (about to enter breakup)
- **Hot lead:** Contacts in `due_diligence` with activity in the last 7 days

---

## 7. Email Templating and AI Polish

### Template Resolution

The template router (`src/templates/router.js`) selects a Handlebars template based on the stage and contact context, using routing rules from `template-mapping.json`.

| Selection Method | Stages | Routes By |
|---|---|---|
| `single` | follow_up_1, follow_up_2, breakup, on_hold, declined_cold | Always uses the default template |
| `by_deal_context` | engaged | `dealContext` field (schedule_paul_call, materials_followup, default) |
| `by_attempt_number` | post_meeting | Attempt number (1st attempt gets feedback template, rest get concerns) |
| `by_data_room_access` | due_diligence | Data room access status (not_requested, requested, granted, reviewing) |

### Templates (13 total)

| Template File | Stage | Purpose |
|---|---|---|
| `followup-performance-hook.hbs` | follow_up_1 | Performance data hook after 30-day silence |
| `followup-comparison-hook.hbs` | follow_up_2 | Valuation comparison angle |
| `followup-general.hbs` | (fallback) | Generic follow-up |
| `breakup.hbs` | breakup | Permission-to-close email (no AI polish) |
| `engaged-nudge.hbs` | engaged | Default: check-in and offer call with Paul |
| `engaged-schedule-paul.hbs` | engaged | Push to schedule Paul call |
| `engaged-materials-followup.hbs` | engaged | Follow up on materials sent |
| `post-meeting-feedback.hbs` | post_meeting | First follow-up: ask for candid feedback |
| `post-meeting-concerns.hbs` | post_meeting | Subsequent: address concerns proactively |
| `dd-data-room.hbs` | due_diligence | Offer/confirm data room access |
| `dd-clarify.hbs` | due_diligence | Offer to clarify DD items |
| `on-hold-quarterly.hbs` | on_hold | Quarterly substantive update |
| `declined-cold-annual.hbs` | declined_cold | Annual light-touch reconnect |

### Template Variables

Templates have access to:
```
{{firstName}}, {{lastName}}, {{fullName}}, {{email}}, {{company}}
{{stage}}, {{fundName}}, {{senderName}}
{{daysSinceLastContact}}, {{attemptNumber}}
{{leadSource}}, {{investorType}}
{{meetingDate}}, {{agenda}}, {{pendingDocuments}}
{{lastDiscussionPoint}}, {{deadline}}, {{dataRoomAccess}}, {{notes}}
```

### Subject Line Format

Each template starts with `Subject: ...` on the first line. The subject is extracted, sanitized (em-dashes replaced with hyphens, smart quotes normalized, non-ASCII stripped), and provided separately from the body.

### AI Polish

When enabled for a stage (all stages except `breakup`), the rendered template and subject are sent to Claude for personalization.

**System Message** contains:
- Sender identity and role
- Voice profile: tone, register, warmth level
- Structure patterns: greeting, opening, body, ask, closing, length
- DO/DON'T rules
- Data points to weave in
- Subject line rules
- Few-shot email examples written by the sender

**User Message** contains:
- Contact data (name, company, stage, lead source, investor type, attempt number, days since contact, CRM notes)
- Pipedrive notes (if available, with instruction to use subtly and not reveal source)
- Web research snippets (if available, with instruction to use 1-2 references subtly)
- Prior email correspondence (newest first, with direction labels)
- Stage-specific guidance from `voice-profile.json`
- Stage-specific AI instructions from `template-mapping.json`
- The rendered draft (subject + body)
- Rewrite rules (keep intent, don't invent facts, specific sign-off, no exclamation marks, under 200 words, don't repeat prior messages, only SUBJECT/BODY output format)

**Output Parsing:** Claude's response is parsed for `SUBJECT: ...` and `BODY: ...` markers. If parsing fails, the original template output is used as fallback.

**Model:** Configurable via `ANTHROPIC_MODEL` env var, defaults to `claude-sonnet-4-20250514`.

---

## 8. Web Enrichment

The enrichment module (`src/enrichment/enrichment.js`) searches DuckDuckGo for public information about each contact. No API key required.

### Process

1. Build a search query from `{firstName} {lastName}` and `{company}` (needs at least one component)
2. Fetch `https://html.duckduckgo.com/html/?q={query}` with a browser-like User-Agent
3. Parse the HTML response using regex to extract result titles and snippets
4. Return up to 5 snippet strings in the format `"Title - Snippet"`
5. Results are cached in memory per contact email for the duration of the run

### Failure Handling

Never throws. Returns `{ webSnippets: [] }` on any error. Logs a warning.

### Toggle

Enabled by default. Disable via `ENRICHMENT_ENABLED=false` env var.

---

## 9. Gmail Integration

### OAuth Scopes

- `https://www.googleapis.com/auth/gmail.readonly` - Read email
- `https://www.googleapis.com/auth/gmail.compose` - Create drafts

### Authentication

**Local:** Run `npm run auth` to start a local OAuth consent flow. Opens a browser, captures the auth code via a localhost callback server, and saves the token to `data/gmail-token.json`.

**Cloud (Railway):** The token JSON is stored as the `GMAIL_TOKEN_JSON` environment variable. The agent parses it at startup.

Token refresh: When running locally, refreshed tokens are auto-persisted to the token file. In cloud mode, the token in the env var is used as-is (must be manually updated if it expires).

### Read Operations

- **`getLastEmailDate(email)`** - Searches `in:sent to:{email} -in:draft after:{3 months ago}` for the most recent sent message. Returns the `Date` header as an ISO string.
- **`batchGetLastEmailDates(emails)`** - Parallel wrapper with concurrency limit of 5.
- **`getRecentThreadSnippets(email)`** - Searches `(from:{email} OR to:{email}) -in:draft after:{3 months ago}`. Fetches up to 5 full messages, extracts plaintext bodies (max 500 chars), determines sent/received direction, and captures threading metadata.
- **`batchGetRecentThreads(emails)`** - Parallel wrapper with concurrency limit of 3.
- **`getExistingDraftsForContacts(emails)`** - Lists all drafts, checks `To` headers against the contact list. Returns a `Set<email>` of contacts that already have a draft.

### Write Operations

- **`createDraft(to, subject, body, threadInfo)`** - Constructs an RFC 2822 message with `From`, `To`, `Bcc` (satoriir@pipedrivemail.com), `Subject`, and `Content-Type` headers. If `threadInfo` is provided, adds `In-Reply-To` and `References` headers and creates the draft in the existing thread. Base64url-encodes the message and calls `gmail.users.drafts.create`.

---

## 10. Pipedrive API Integration

### Data Source Selection

- If `PIPEDRIVE_API_TOKEN` and `PIPEDRIVE_COMPANY_DOMAIN` are both set, uses the Pipedrive API
- Otherwise, falls back to a CSV file at `data/pipedrive-export.csv`

### API Versions

- **v2 API** for deals and persons (main data fetching)
- **v1 API** for person field updates, deal field discovery, activities, and notes (v2 has limited support for custom fields)

### Rate Limiting

- Max 10 requests/second (sliding window)
- Retry on HTTP 429 with 2-second delay, up to 3 retries

### Contact Fetching (Read)

1. **Discover custom field keys:** Fetches all person fields and deal fields from the v1 API. Maps human-readable field names (e.g., "Lead Source") to Pipedrive's internal hash keys. Also builds a label ID-to-name map for exclusion matching.
2. **Fetch all open deals** in the configured pipeline (v2 API, paginated)
3. **Map persons to deals:** Each person gets their most recently updated deal
4. **Fetch person records** by ID (v2 API)
5. **Normalize** each person + deal into a standard Contact shape

### Contact Shape (Normalized)

```javascript
{
  id: String,           // Pipedrive person ID
  firstName: String,
  lastName: String,
  email: String,        // Primary email
  company: String,      // Organization name
  stage: String,        // Pipeline stage key (e.g., "follow_up_1")
  priority: String,     // "high", "medium", or "low"
  tags: String[],       // Person labels (lowercase)
  lastContactDate: String|null,   // ISO date
  notes: String,
  leadSource: String|null,        // "warm_intro", "cold_email", etc.
  introducerPersonId: String|null,
  lastOutboundDate: String|null,  // ISO date
  lastInboundDate: String|null,   // ISO date
  outreachAttempts: Number,       // Count in current stage
  investorType: String|null,
  dataRoomAccess: String|null,
  emailBounced: Boolean,
  meta: {
    meetingDate: String|null,
    paulMeetingDate: String|null,
    agenda: String|null,
    pendingDocuments: String[],
    lastDiscussionPoint: String|null,
    deadline: String|null,
    dealId: Number|null,
    dealValue: Number|null,
  }
}
```

### Write Operations

| Operation | API | Use |
|---|---|---|
| `updateDealStage(dealId, stageId)` | v2 PATCH /deals/{id} | Stage advancement |
| `updatePersonField(personId, fieldName, value)` | v1 PUT /persons/{id} | Outreach attempt count, last outbound date |
| `addActivityNote(dealId, text)` | v2 POST /notes | Advancement audit trail |
| `createActivity({subject, dueDate, personId, dealId, type, note})` | v1 POST /activities | Follow-up reminders |
| `createFollowUpReminder(contact)` | (wrapper) | Creates a task activity with due date based on stage threshold. Skips if the contact already has an open activity. |

### Notes Fetching

`getPersonNotes(personId)` fetches the 5 most recent notes from the Pipedrive Notes entity (v1 API, `sort=add_time DESC`). HTML is stripped, notes are concatenated with `---` separators, and truncated to 2000 chars.

---

## 11. Slack Notifications

### Daily Summary

Posted via Slack Incoming Webhook using Block Kit format:

- **Header:** "Pipeline Follow-Up Summary"
- **Stats:** Follow-up count, draft count, live/dry-run mode, date
- **By Stage:** Grouped follow-ups with urgency scores (fire emoji for >= 0.8, warning for >= 0.5)
- **Stage Advancements:** List of contacts auto-advanced with before/after stages
- **Flags & Alerts:** Grouped by type with emojis:
  - :handshake: Introducer nudge
  - :hourglass: Stale contact
  - :wave: Breakup pending
  - :fire: Hot lead
- **Draft Reminder:** "N drafts ready for review in Gmail. Take 15 minutes to review and send."

### Error Alerts

Separate message posted for pipeline errors or fatal crashes.

---

## 12. Configuration Files

### `config/pipeline-stages.json`

Defines the 9-stage pipeline with:
- `key`: Internal identifier used throughout the codebase
- `name`: Display name
- `order`: Sort order
- `type`: `active`, `won`, `on_hold`, or `lost_cold`
- `deal_probability`: Percentage for pipeline reporting
- `follow_up`: `threshold_days`, `max_attempts`, `cadence`, `notes`
- `auto_advance`: `on_no_reply`, `on_reply`, `manual_advance_to`

### `config/follow-up-rules.json`

Complete rules engine configuration:
- `evaluation_order`: 5-step pipeline
- `global_defaults`: `business_days_only`, `timezone`, `max_drafts_per_run` (15), `min_urgency_to_draft` (0.3), `stale_contact_days` (180)
- `exclusions`: Tags, stages, and conditional exclusions
- `overdue_thresholds`: Days-per-stage thresholds
- `urgency_scoring`: Formula, source multipliers, stage weights, recency decay
- `attempt_limits`: Max attempts per stage
- `introducer_tracking`: Enabled, silent days threshold (21), stage whitelist
- `auto_stage_advancement`: Rules for automatic stage transitions
- `daily_summary_flags`: Flag definitions

### `config/template-mapping.json`

Maps each stage to:
- `selection` method (single, by_lead_source, by_attempt_number, by_deal_context, by_data_room_access)
- `templates` map (selection value to .hbs filename)
- `ai_polish` toggle
- `ai_instructions` (stage-specific prompt guidance for Claude)

### `config/pipedrive-ids.json`

Maps stage keys to Pipedrive stage IDs:
```json
{
  "pipeline_id": 2,
  "stages": {
    "follow_up_1": 159,
    "follow_up_2": 160,
    "breakup": 161,
    "engaged": 162,
    "post_meeting": 163,
    "due_diligence": 164,
    "committed": 165,
    "on_hold": 166,
    "declined_cold": 167
  }
}
```

### `config/pipedrive-fields.json`

Defines expected custom fields in Pipedrive:

**Person fields:** Lead Source, Introducer, Last Outbound Date, Last Inbound Date, Outreach Attempts, Agent Tags, Investor Type

**Deal fields:** Data Room Access, Paul Meeting Date, Decline Reason, Estimated AUM

Also contains API rate limit settings.

### `config/voice-profile.json`

Sender voice profile used by Claude AI polish. Contains:
- Sender identity (name, role, firm)
- Tone settings (overall, register, warmth)
- Structure patterns (greeting, opening, body, ask, closing, length)
- DO/DON'T rules
- Data points to include
- Subject line patterns
- Few-shot email examples
- Stage-specific voice notes

This file is generated/updated by `scripts/refresh-voice.js` which analyzes the sender's actual sent emails and uses Claude Opus to extract the voice profile.

---

## 13. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PIPEDRIVE_API_TOKEN` | Yes* | Pipedrive API token (Settings > Personal Preferences > API) |
| `PIPEDRIVE_COMPANY_DOMAIN` | Yes* | Subdomain (e.g., "yourcompany") |
| `GMAIL_CLIENT_ID` | Yes | Google OAuth2 client ID |
| `GMAIL_CLIENT_SECRET` | Yes | Google OAuth2 client secret |
| `GMAIL_REDIRECT_URI` | No | Default: `http://localhost:3000/oauth2callback` |
| `GMAIL_TOKEN_JSON` | Cloud only | JSON string of the Gmail OAuth token (used instead of file) |
| `ANTHROPIC_API_KEY` | No | Enables AI email polish |
| `ANTHROPIC_MODEL` | No | Default: `claude-sonnet-4-20250514` |
| `SLACK_WEBHOOK_URL` | No | Enables Slack summaries |
| `ENRICHMENT_ENABLED` | No | Default: `true`. Set to `false` to disable DuckDuckGo search |
| `CRON_SCHEDULE` | No | Default: `0 7 * * 1-5` (7am weekdays) |
| `SENDER_NAME` | Yes | Sender name for email signatures |
| `SENDER_EMAIL` | Yes | Sender email address |
| `FUND_NAME` | Yes | Fund name injected into templates |

*\*Required for API mode. Without these, the agent falls back to CSV import.*

---

## 14. Deployment

### Railway (Production)

**Dockerfile:**
```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY src/ ./src/
COPY config/ ./config/
RUN mkdir -p data/runs data/logs
CMD ["node", "src/index.js"]
```

**railway.json:**
```json
{
  "build": { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": { "cronSchedule": "0 12 * * 1-5", "restartPolicyType": "NEVER" }
}
```

The container runs once per cron trigger and exits. `restartPolicyType: NEVER` prevents Railway from restarting it after exit.

All environment variables are set in Railway's dashboard. The `GMAIL_TOKEN_JSON` variable stores the full OAuth token JSON as a string.

### Local (macOS)

Run manually:
```bash
npm run dry-run    # Preview mode
npm start          # Live mode
```

Schedule via launchd:
```bash
npm run setup-schedule    # Install weekday morning schedule
npm run remove-schedule   # Remove schedule
npm run schedule-status   # Check status
```

---

## 15. NPM Scripts

| Script | Command | Description |
|---|---|---|
| `start` / `run` | `node src/index.js` | Run the pipeline (live) |
| `dry-run` | `node src/index.js --dry-run` | Preview mode: no drafts, no Slack, no CRM writes |
| `auth` | `node src/gmail/auth.js` | One-time Gmail OAuth setup |
| `setup-schedule` | `bash scripts/launchd-setup.sh install` | Install macOS launch agent |
| `remove-schedule` | `bash scripts/launchd-setup.sh uninstall` | Remove macOS launch agent |
| `schedule-status` | `bash scripts/launchd-setup.sh status` | Check schedule status |
| `update-voice` | `node scripts/refresh-voice.js` | Regenerate voice profile from sent emails |
| `test` | `node --test tests/rules.test.js tests/templates.test.js` | Run unit tests |
| `test:integration` | `node --test tests/integration.test.js` | Run integration tests |
| `test:all` | `node --test tests/*.test.js` | Run all tests |
| `healthcheck` | `node scripts/healthcheck.js` | Verify all API connections |

### CLI Flags

| Flag | Description |
|---|---|
| `--dry-run` | Skip Gmail draft creation, Slack posting, and CRM writes. Shows previews. |
| `--verbose` / `-v` | Detailed output including email previews and follow-up lists |
| `--help` / `-h` | Show usage information |
