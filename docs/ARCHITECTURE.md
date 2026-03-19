# Pipedrive CRM Automation Agent - Architecture

## What It Does

An automation agent that connects Pipedrive CRM to Gmail, handling investor follow-up tracking across a 9-stage pipeline. The agent evaluates contacts against configurable rules, scores urgency using a multi-factor formula, auto-advances deals through early stages, drafts context-aware emails using AI, and posts daily summaries to Slack.

**Nothing is sent automatically.** All emails land in the Gmail Drafts folder for human review before sending.

---

## Pipeline Flow

The agent executes a seven-step pipeline (default: 7 AM weekdays via macOS launchd):

| Step | What Happens |
|---|---|
| **1. Fetch Contacts** | Pulls persons with open deals from Pipedrive API v2, discovers custom fields, resolves pipeline stages |
| **2. Check Gmail Activity** | Cross-references contacts against Gmail history to find actual last email dates |
| **3. Evaluate Rules** | 5-step evaluation: exclusions → overdue check → urgency scoring → priority multipliers → rank & cap |
| **4. Stage Advancement** | Auto-advances deals through stages 1-3 (Initial Outreach → Follow-Up → Breakup → Declined) on no-reply; detects replies to advance to Engaged |
| **5. Draft Emails** | Selects templates by context (lead source, attempt number, deal state), renders with Handlebars, optionally polishes with Claude AI |
| **6. Collect Flags** | Generates summary flags: introducer nudge, stale contact, breakup pending, hot lead |
| **7. Slack Summary** | Posts structured summary with stage groupings, urgency scores, advancements, and flags |

---

## 9-Stage Pipeline

| # | Stage | Pipedrive ID | Threshold | Max Attempts | Auto-Advance |
|:-:|-------|:---:|:---:|:---:|---|
| 1 | Initial Outreach | 159 | 4 days | 1 | → Follow-Up on no-reply |
| 2 | Follow-Up | 160 | 5 days | 2 | → Breakup on no-reply |
| 3 | Breakup | 161 | 7 days | 1 | → Declined on no-reply |
| 4 | Engaged | 162 | 5 days | 3 | Manual only |
| 5 | Post-Meeting | 163 | 3 days | 2 | Manual only |
| 6 | Due Diligence | 164 | 7 days | — | Manual only |
| 7 | Committed | 165 | — | — | Excluded |
| 8 | On Hold | 166 | 90 days | 1 | Manual only |
| 9 | Declined (Cold) | 167 | 365 days | 1 | Excluded |

Stages 1-3 have automated write-back to Pipedrive. Stages 4+ require manual advancement. All advancements are logged as Pipedrive activity notes.

---

## Urgency Scoring

Contacts are scored using a multi-factor formula:

```
urgency = base * source_multiplier * recency_decay * stage_weight * priority_multiplier
```

| Factor | Description | Range |
|---|---|---|
| `base` | days_since_contact / threshold, capped at 1.0 | 0 – 1.0 |
| `source_multiplier` | Lead source boost (warm_intro=1.5, cold_email=0.7) | 0.5 – 1.5 |
| `recency_decay` | Exponential decay (half-life 30 days, floor 0.3) | 0.3 – 1.0 |
| `stage_weight` | Stage importance (due_diligence=1.2, initial_outreach=0.5) | 0.3 – 1.2 |
| `priority_multiplier` | Contact priority (high=1.5, low=0.5) | 0.5 – 1.5 |

Contacts scoring below 0.3 are dropped. The top 15 per run get drafts.

---

## Template Routing

Templates are selected by context, not just stage:

| Stage | Selection Logic | Templates |
|---|---|---|
| Initial Outreach | By lead source | warm-intro, conference, cold |
| Follow-Up | By attempt number | performance hook (1), comparison hook (2), general (3+) |
| Breakup | Single | permission-to-close |
| Engaged | By deal context | schedule-paul, materials-followup, nudge |
| Post-Meeting | By attempt number | feedback request (1), address concerns (2+) |
| Due Diligence | By data room access | data-room offer, clarify |
| On Hold | Single | quarterly update |
| Declined | Single | annual re-engagement |

16 Handlebars templates in `src/templates/emails/`. AI polish is stage-specific with per-stage instructions.

---

## Project Structure

```
├── config/
│   ├── pipeline-stages.json     # 9-stage definitions, thresholds, cadence
│   ├── follow-up-rules.json     # Exclusions, urgency formula, attempt limits
│   ├── pipedrive-ids.json       # Stage key → Pipedrive stage ID mapping
│   ├── pipedrive-fields.json    # Custom field definitions, rate limits
│   └── template-mapping.json    # Stage → template routing rules
├── src/
│   ├── index.js                 # CLI entry point (--dry-run, --verbose)
│   ├── orchestrator.js          # 7-step pipeline orchestration
│   ├── config/
│   │   └── index.js             # Config loader, validation, stage helpers
│   ├── rules/
│   │   ├── engine.js            # 5-step evaluation pipeline
│   │   ├── advancement.js       # Auto-stage advancement (stages 1-3)
│   │   └── introducer.js        # Introducer re-engagement flags
│   ├── templates/
│   │   ├── router.js            # Context-aware template selection + AI polish
│   │   └── emails/              # 16 Handlebars templates
│   ├── api/
│   │   └── pipedrive.js         # API client: rate limiting, write-back, field discovery
│   ├── gmail/
│   │   ├── client.js            # Gmail API: activity lookup, draft creation
│   │   └── auth.js              # One-time OAuth flow
│   ├── summary/
│   │   └── builder.js           # Slack summary with flags and stage groupings
│   └── pipedrive/
│       └── types.js             # JSDoc type definitions
├── tests/
│   ├── rules.test.js            # 15 tests for rules engine
│   └── templates.test.js        # 12 tests for template router
├── scripts/
│   └── launchd-setup.sh         # macOS Launch Agent installer
├── data/                        # Runtime data (gitignored)
│   ├── gmail-token.json
│   ├── runs/
│   └── logs/
└── docs/
    └── ARCHITECTURE.md          # This file
```

---

## Technical Stack

| Component | Technology |
|---|---|
| Runtime | Node.js (>= 20) |
| CRM | Pipedrive REST API v1/v2 |
| Email | Gmail API (OAuth 2.0) |
| Templates | Handlebars (.hbs) |
| AI Polish | Anthropic Claude API (optional) |
| Notifications | Slack Incoming Webhooks |
| Scheduling | macOS launchd |
| Config | dotenv + JSON |

---

## Pipedrive Custom Fields

The agent auto-discovers these at startup via the v1 API:

| Field | Type | Purpose | Required |
|---|---|---|:---:|
| Lead Source | Enum (dropdown) | Urgency scoring + template routing | No |
| Outreach Attempts | Number | Auto-increment + stage advancement | No |
| Introducer | Person link | Re-engagement flags | No |
| Last Outbound Date | Date | Exclusion rules | No |
| Investor Type | Text | Future segmentation | No |

All fields are optional. The agent degrades gracefully without them.

---

## Deployment

```bash
git clone <repo-url>
cd pipedrive-crm-automation
npm install
cp .env.example .env          # Fill in credentials
npm run auth                  # Gmail OAuth (one-time)
npm run dry-run               # Preview without side effects
npm run setup-schedule        # Install macOS Launch Agent
```

---

## Security

- OAuth 2.0 for Gmail (no password storage)
- API tokens in local `.env` (gitignored)
- No data leaves the machine except API calls to Pipedrive, Gmail, Slack, and optionally Anthropic
- Email content stays in the user's Gmail account
- No telemetry or analytics
