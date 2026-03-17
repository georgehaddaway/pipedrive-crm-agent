# Pipedrive CRM Automation Agent - Architecture Overview

## What It Does

An intelligent automation agent that connects Pipedrive CRM to Gmail, eliminating manual follow-up tracking for sales and investor relations teams. The agent evaluates pipeline contacts against configurable rules, drafts personalized emails using AI, and delivers daily summaries to Slack.

**Nothing is sent automatically.** All emails land in the Gmail Drafts folder for human review before sending.

---

## System Architecture

![Architecture Diagram](docs/architecture_diagram.png)

### Pipeline Flow

The agent executes a five-step pipeline on a configurable schedule (default: 7 AM weekdays):

| Step | What Happens |
|---|---|
| **1. Fetch Contacts** | Pulls active contacts from Pipedrive via REST API v2 (persons with open deals, enriched with pipeline stage and activity data) |
| **2. Check Gmail Activity** | Cross-references each contact against Gmail history to find the actual last email exchange date |
| **3. Evaluate Rules** | Applies configurable follow-up rules: days since last contact, pipeline stage thresholds, priority multipliers, exclusion tags |
| **4. Draft Emails** | Renders personalized emails from Handlebars templates, then optionally polishes each draft with Claude AI for natural tone |
| **5. Slack Summary** | Posts a structured summary with stage breakdown, high-priority flags, and draft count |

### Key Design Decisions

- **Draft-only model**: The agent never sends emails directly. Drafts appear in Gmail for human review, maintaining full control over outreach.
- **CRM as source of truth**: Pipeline stage and contact data come from Pipedrive. Gmail is a secondary signal for last-contact timing.
- **Configurable rules engine**: Follow-up thresholds, priority multipliers, and exclusion criteria are defined in JSON config files, not hardcoded.
- **AI enhancement is optional**: Works without an Anthropic API key using template-based emails. AI personalization is an additive layer.

---

## Technical Stack

| Component | Technology |
|---|---|
| Runtime | Node.js (>= 20) |
| CRM Integration | Pipedrive REST API v2 |
| Email | Gmail API (OAuth 2.0) |
| Templates | Handlebars (.hbs) |
| AI Personalization | Anthropic Claude API |
| Notifications | Slack Incoming Webhooks |
| Scheduling | macOS launchd (Launch Agent) |
| Config | dotenv + JSON config files |

---

## Data Flow

```
Pipedrive API                 Agent                          Gmail
┌──────────────┐    ┌────────────────────────┐    ┌──────────────────┐
│ Persons      │───▶│ Normalize contacts     │    │                  │
│ Deals        │───▶│ Map pipeline stages    │    │                  │
│ Stages       │───▶│ Resolve stage names    │    │                  │
└──────────────┘    │                        │    │                  │
                    │ ┌────────────────────┐ │    │                  │
                    │ │ Rules Engine       │ │◀───│ Last email dates │
                    │ │ - Stage thresholds │ │    │                  │
                    │ │ - Priority scoring │ │    │                  │
                    │ │ - Exclusion tags   │ │    │                  │
                    │ └────────────────────┘ │    │                  │
                    │          │              │    │                  │
                    │ ┌────────────────────┐ │    │                  │
                    │ │ Template Engine    │ │───▶│ Draft emails     │
                    │ │ + AI Polish (opt)  │ │    │ (human review)   │
                    │ └────────────────────┘ │    │                  │
                    └────────────────────────┘    └──────────────────┘
                              │
                    ┌─────────────────┐
                    │ Slack           │
                    │ Daily summary   │
                    └─────────────────┘
```

---

## Follow-Up Rules Engine

Rules are defined in a JSON configuration file and applied per pipeline stage:

| Parameter | Description | Example |
|---|---|---|
| Follow-up threshold | Days since last contact before flagging | 3 days for outreach, 5 for due diligence |
| Priority multiplier | Adjusts threshold by contact priority | High priority = 0.5x (faster follow-up) |
| Max attempts | Limits follow-up attempts per contact | 3 attempts for initial outreach |
| Exclusion tags | Skips contacts with specific CRM tags | "do-not-contact", "unsubscribed" |
| Stage mapping | Maps CRM stage names to rule keys | Configurable per deployment |

Urgency scoring (0-10) combines days overdue, priority level, and stage context to rank which contacts need attention first.

---

## Deployment Model

The agent runs locally on a Mac. Setup involves:

1. Install Node.js and dependencies (~2 minutes)
2. Connect Pipedrive API token (~2 minutes)
3. Authorize Gmail via OAuth (~10 minutes, one-time)
4. Configure follow-up rules and templates (~15 minutes)
5. Install the macOS Launch Agent (`npm run setup-schedule`)

No cloud infrastructure, databases, or ongoing DevOps required. The agent runs as a single-shot Node.js process triggered by macOS `launchd` on schedule. Unlike in-process schedulers, `launchd` fires missed jobs after sleep/wake, so the pipeline runs reliably even if the Mac was asleep at the scheduled time.

---

## Customization Points

| What | How | Effort |
|---|---|---|
| Follow-up timing | Edit `config/rules.json` | 5 min |
| Pipeline stage mapping | Edit `config/stage-map.json` | 5 min |
| Email templates | Edit `.hbs` files in `config/templates/` | 15-30 min |
| CRM source | Swap `src/pipedrive/client.js` for another CRM | 2-4 hours |
| Add CRM fields | Update `normalizeContact()` in client | 30 min |
| Schedule | Set `CRON_SCHEDULE` in `.env`, then re-run `npm run setup-schedule` | 2 min |

---

## Security & Privacy

- OAuth 2.0 for Gmail access (no password storage)
- API tokens stored in local `.env` file (gitignored)
- No data leaves the local machine except API calls to Pipedrive, Gmail, Slack, and optionally Anthropic
- All email content stays in the user's own Gmail account
- No third-party analytics or telemetry

---

*Built with Node.js. Source code available on request.*
