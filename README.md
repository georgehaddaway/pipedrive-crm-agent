# Pipedrive CRM Agent

Automated investor follow-up pipeline that syncs Pipedrive CRM data with Gmail to draft personalized outreach emails and post daily summaries to Slack.

## What It Does

The agent runs a five-step pipeline on a configurable schedule (default: 7 AM weekdays):

1. **Fetches contacts** from Pipedrive (API or CSV fallback)
2. **Checks Gmail** for the most recent email exchange with each contact
3. **Evaluates follow-up rules** based on pipeline stage, days since last contact, and priority tier
4. **Renders and creates Gmail drafts** using Handlebars templates, with optional AI personalization via Claude
5. **Posts a summary to Slack** with stage breakdown, high-priority flags, and draft count

Drafts land in your Gmail drafts folder for review before sending. Nothing is sent automatically.

## Project Structure

```
├── config/
│   ├── rules.json              # Follow-up thresholds, priority multipliers, exclusions
│   ├── stage-map.json          # (Optional) Map Pipedrive stage names to rule keys
│   └── templates/              # Handlebars email templates
│       ├── initial_outreach.hbs
│       ├── meeting_followup.hbs
│       ├── due_diligence.hbs
│       └── negotiation.hbs
├── src/
│   ├── index.js                # Entry point, CLI flags, cron scheduling
│   ├── config.js               # Env/config loader
│   ├── orchestrator.js         # Pipeline runner (steps 1-5)
│   ├── engine/
│   │   ├── rules.js            # Contact evaluation, urgency scoring
│   │   └── templates.js        # Template rendering, AI personalization
│   ├── gmail/
│   │   ├── auth.js             # OAuth 2.0 flow
│   │   └── client.js           # Draft creation, activity lookups
│   ├── pipedrive/
│   │   ├── client.js           # Pipedrive API v2 / CSV data source
│   │   └── types.js            # JSDoc type definitions
│   └── slack/
│       └── notifier.js         # Webhook summary posting
├── tests/
│   ├── rules.test.js
│   └── templates.test.js
├── data/                       # Gitignored runtime data
│   ├── pipedrive-export.csv    # CSV fallback for contacts
│   ├── gmail-token.json        # OAuth token (generated)
│   └── runs/                   # JSON run reports
└── .env.example
```

## How Pipedrive Data Maps

The agent pulls data from Pipedrive's REST API v2:

| Pipedrive Entity | Agent Concept | Notes |
|---|---|---|
| Persons | Contacts | Primary email, org name, labels |
| Deals | Pipeline stage | Most recently updated open deal per person |
| Activities | Last contact date | Most recent completed activity date |
| Pipelines / Stages | Stage resolution | Stage IDs resolved to human-readable names |

If a person has multiple open deals, the agent uses the most recently updated one.

## Follow-Up Rules

Rules are defined in `config/rules.json`. Each pipeline stage specifies:

| Stage | Follow-up After | Max Attempts | Template |
|---|---|---|---|
| Initial Outreach | 3 days | 3 | `initial_outreach` |
| Meeting Scheduled | 7 days | 2 | `meeting_followup` |
| Due Diligence | 5 days | 4 | `due_diligence` |
| Negotiation | 2 days | 5 | `negotiation` |
| Closed | — | 0 | — |

Priority multipliers adjust thresholds: **high** (0.5x, faster follow-up), **medium** (1x), **low** (2x, slower).

Contacts tagged `do-not-contact` or `unsubscribed` are excluded.

### Stage Name Mapping

Pipedrive stage names are normalized to match `rules.json` keys by converting to lowercase and replacing spaces/hyphens with underscores. If your Pipedrive stages have different names, create `config/stage-map.json`:

```json
{
  "Qualified Lead": "initial_outreach",
  "Demo Scheduled": "meeting_scheduled",
  "Under Review": "due_diligence",
  "Terms Discussion": "negotiation",
  "Won": "closed",
  "Lost": "closed"
}
```

## Setup

**Prerequisites:** Node.js >= 20

```bash
npm install
cp .env.example .env
```

Fill in `.env` with your credentials:

| Variable | Required | Notes |
|---|---|---|
| `PIPEDRIVE_API_TOKEN` | No* | From Pipedrive Settings > Personal Preferences > API |
| `PIPEDRIVE_COMPANY_DOMAIN` | No* | Your subdomain (e.g. `yourcompany` from `yourcompany.pipedrive.com`) |
| `GMAIL_CLIENT_ID` | Yes | Google Cloud OAuth 2.0 client |
| `GMAIL_CLIENT_SECRET` | Yes | |
| `SENDER_NAME` | Yes | Your name for email signatures |
| `SENDER_EMAIL` | Yes | Gmail address used as sender |
| `FUND_NAME` | Yes | Injected into email templates |
| `SLACK_WEBHOOK_URL` | No | Enables Slack summaries |
| `ANTHROPIC_API_KEY` | No | Enables AI email personalization |
| `CRON_SCHEDULE` | No | Default: `0 7 * * 1-5` |

\* Leave blank to use CSV fallback (`data/pipedrive-export.csv`).

Complete Gmail OAuth:

```bash
npm run auth
```

## Usage

```bash
# Preview follow-ups without creating drafts or posting to Slack
npm run dry-run

# Single run: evaluate, draft, and notify
npm run run

# Scheduled mode: runs on cron, stays alive
npm start

# Run with verbose output
node src/index.js --dry-run --verbose
```

## Testing

```bash
npm test
```

Runs the rules engine and template rendering tests using Node's built-in test runner.
