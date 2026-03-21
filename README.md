# Pipedrive CRM Automation

Automated investor follow-up pipeline that syncs Pipedrive CRM with Gmail. Evaluates contacts across a 9-stage pipeline, scores urgency, auto-advances deals, drafts context-aware emails in James's voice, creates Pipedrive activity reminders, and posts daily summaries to Slack.

**Nothing is sent automatically.** All emails land in Gmail Drafts for human review.

## Pipeline

| Stage | Agent Drafts? | Follow-up After | Auto-Advance |
|---|:---:|:---:|---|
| Follow Up #1 | Yes | 30 days | → Follow Up #2 |
| Follow Up #2 | Yes | 30 days | → Breakup |
| Breakup | Yes | 7 days | Manual (→ Declined or On Hold) |
| Engaged | Yes | 5 days | Manual |
| Post-Meeting | Yes | 3 days | Manual |
| Due Diligence | Yes | 7 days | Manual |
| Committed | No | — | Excluded |
| On Hold | Yes | 90 days | Manual |
| Declined (Cold) | Yes | 365 days | Excluded |

James sends the initial outreach manually, then places the contact in Follow Up #1. The agent handles everything from there. After each draft, a **Pipedrive activity reminder** is created on the deal, due on the next follow-up date. After breakup, James manually decides: Declined or On Hold.

## Quick Start

```bash
git clone https://github.com/georgehaddaway/pipedrive-crm-agent.git
cd pipedrive-crm-agent
npm install
cp .env.example .env            # Fill in credentials
npm run auth                    # Gmail OAuth (one-time)
node scripts/setup-fields.js    # Create custom Pipedrive fields
node scripts/backfill-dates.js  # Sync Last Outbound Date from Gmail
npm run dry-run                 # Preview without side effects
npm run setup-schedule          # Install macOS Launch Agent
```

## Setup

### 1. Environment Variables

Fill in `.env` with your credentials:

| Variable | Required | Description |
|---|:---:|---|
| `PIPEDRIVE_API_TOKEN` | Yes | Settings → Personal Preferences → API |
| `PIPEDRIVE_COMPANY_DOMAIN` | Yes | Your subdomain (`yourco` from `yourco.pipedrive.com`) |
| `GMAIL_CLIENT_ID` | Yes | Google Cloud OAuth 2.0 client |
| `GMAIL_CLIENT_SECRET` | Yes | |
| `SENDER_NAME` | Yes | Name for email signatures |
| `SENDER_EMAIL` | Yes | Gmail address used as sender |
| `FUND_NAME` | Yes | Injected into email templates |
| `SLACK_WEBHOOK_URL` | No | Enables Slack summaries |
| `ANTHROPIC_API_KEY` | No | Enables AI email personalization |

### 2. Gmail OAuth

```bash
npm run auth
```

Follow the browser prompt to authorize Gmail access. Tokens are saved to `config/gmail-token.json`.

### 3. Pipedrive Custom Fields

```bash
node scripts/setup-fields.js           # Create all missing fields
node scripts/setup-fields.js --dry-run # Preview without creating
```

Creates these custom fields in Pipedrive (all optional but recommended):

| Field | Type | Purpose |
|---|---|---|
| Lead Source | Dropdown | Urgency scoring (warm_intro=1.5x, cold=0.7x) |
| Outreach Attempts | Number | Auto-incremented after each draft |
| Last Outbound Date | Date | Tracks when agent last drafted (auto-synced from Gmail) |
| Last Inbound Date | Date | Tracks last reply received |
| Agent Tags | Set | Tags managed by agent (do-not-contact, paused) |
| Investor Type | Dropdown | Template personalization |

### 4. Backfill Last Outbound Dates

```bash
node scripts/backfill-dates.js           # Write dates to Pipedrive
node scripts/backfill-dates.js --dry-run # Preview without writing
```

Searches Gmail sent folder for each contact and sets their `Last Outbound Date` in Pipedrive. Run this once after initial setup. New contacts are automatically synced on each daily run.

### 5. Schedule Daily Runs

```bash
npm run setup-schedule
```

Installs a macOS Launch Agent that runs the agent every weekday morning (7-9 AM). Handles sleep/wake correctly.

## Usage

```bash
npm run dry-run              # Preview follow-ups (no drafts, no Slack)
npm run run                  # Full run: evaluate, draft, notify
node src/index.js --verbose  # Detailed output with email previews
```

## Voice Training

```bash
# Refresh voice profile from Gmail "Satori Power" folder
node scripts/refresh-voice.js --gmail --count 65

# With writing style analysis and sample email
node scripts/refresh-voice.js --gmail --count 65 --analysis

# Preview without saving
node scripts/refresh-voice.js --gmail --dry-run
```

## Project Structure

```
config/                       # Pipeline rules and stage definitions
├── pipeline-stages.json      # 9-stage pipeline with thresholds
├── follow-up-rules.json      # Exclusions, urgency formula, attempt limits
├── pipedrive-ids.json        # Stage key → Pipedrive stage ID mapping
├── pipedrive-fields.json     # Custom field definitions
├── template-mapping.json     # Stage → email template routing
└── voice-profile.json        # James's writing style for AI polish

src/
├── index.js                  # CLI entry point
├── orchestrator.js           # 7-step pipeline runner
├── config/index.js           # Config loader + validation
├── rules/
│   ├── engine.js             # Urgency scoring + evaluation
│   ├── advancement.js        # Auto-stage advancement
│   └── introducer.js         # Introducer re-engagement flags
├── templates/
│   ├── router.js             # Context-aware template selection
│   └── emails/               # 13 Handlebars templates
├── api/pipedrive.js          # Pipedrive API client (rate limited, activities)
├── gmail/                    # Gmail OAuth + drafts
└── summary/builder.js        # Slack summary with flags

scripts/
├── setup-fields.js           # Create Pipedrive custom fields
├── backfill-dates.js         # Sync Last Outbound Date from Gmail
├── refresh-voice.js          # Voice profile training from Gmail
├── import-contacts.js        # Bulk import contacts
└── launchd-setup.sh          # macOS Launch Agent installer

tests/                        # 28 tests (rules + templates)
```

## Testing

```bash
npm test
```

28 tests (15 rules engine + 13 template router) using Node's built-in test runner.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical overview including urgency scoring formula, template routing logic, and deployment model.
