# Pipedrive CRM Automation

Automated investor follow-up pipeline that syncs Pipedrive CRM with Gmail. Evaluates contacts across a 9-stage pipeline, scores urgency, auto-advances deals through early stages, drafts context-aware emails, and posts daily summaries to Slack.

**Nothing is sent automatically.** All emails land in Gmail Drafts for human review.

## Pipeline

| Stage | Follow-up After | Max Attempts | Auto-Advance |
|---|:---:|:---:|---|
| Initial Outreach | 4 days | 1 | → Follow-Up |
| Follow-Up | 5 days | 2 | → Breakup |
| Breakup | 7 days | 1 | → Declined |
| Engaged | 5 days | 3 | Manual |
| Post-Meeting | 3 days | 2 | Manual |
| Due Diligence | 7 days | — | Manual |
| Committed | — | — | Excluded |
| On Hold | 90 days | 1 | Manual |
| Declined (Cold) | 365 days | 1 | Excluded |

Stages 1-3 auto-advance when max attempts are exhausted with no reply. Reply detection advances contacts to Engaged. All advancements are logged to Pipedrive.

## Quick Start

```bash
git clone <repo-url>
cd pipedrive-crm-automation
npm install
cp .env.example .env          # Fill in credentials
npm run auth                  # Gmail OAuth (one-time)
npm run dry-run               # Preview without side effects
npm run setup-schedule        # Install macOS Launch Agent
```

## Setup

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

## Usage

```bash
npm run dry-run              # Preview follow-ups (no drafts, no Slack)
npm run run                  # Full run: evaluate, draft, notify
node src/index.js --verbose  # Detailed output with email previews
```

## Project Structure

```
config/                       # Pipeline rules and stage definitions
├── pipeline-stages.json      # 9-stage pipeline with thresholds
├── follow-up-rules.json      # Exclusions, urgency formula, attempt limits
├── pipedrive-ids.json        # Stage key → Pipedrive stage ID mapping
├── pipedrive-fields.json     # Custom field definitions
└── template-mapping.json     # Stage → email template routing

src/
├── index.js                  # CLI entry point
├── orchestrator.js           # 7-step pipeline runner
├── config/index.js           # Config loader + validation
├── rules/
│   ├── engine.js             # Urgency scoring + evaluation
│   ├── advancement.js        # Auto-stage advancement
│   └── introducer.js         # Introducer flags
├── templates/
│   ├── router.js             # Context-aware template selection
│   └── emails/               # 16 Handlebars templates
├── api/pipedrive.js          # Pipedrive API client (rate limited)
├── gmail/                    # Gmail OAuth + drafts
└── summary/builder.js        # Slack summary with flags

tests/                        # 27 tests (rules + templates)
scripts/launchd-setup.sh      # macOS Launch Agent installer
```

## Pipedrive Custom Fields

The agent auto-discovers these fields at startup. All are optional:

| Field | Type | Purpose |
|---|---|---|
| Lead Source | Dropdown | Urgency scoring boost (warm_intro=1.5x, cold=0.7x) |
| Outreach Attempts | Number | Auto-incremented after each draft; enables stage advancement |

## Testing

```bash
npm test
```

Runs 27 tests (15 rules engine + 12 template router) using Node's built-in test runner.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical overview including urgency scoring formula, template routing logic, and deployment model.
