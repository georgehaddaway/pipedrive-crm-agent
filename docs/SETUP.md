# Installation Guide

Step-by-step setup for installing the Pipedrive CRM agent on a Mac.

**Time needed:** ~20 minutes

---

## Prerequisites

- macOS computer
- Admin access
- A web browser
- Your Pipedrive and Gmail accounts

---

## Step 1: Install Node.js

1. Open **Terminal** (search "Terminal" in Spotlight, or find it in Applications → Utilities)
2. Check if Node.js is installed:
   ```bash
   node --version
   ```
3. If you see a version number >= 20, skip to Step 2. Otherwise:
   - Go to [nodejs.org](https://nodejs.org)
   - Download the **LTS** version (the big green button)
   - Run the installer and follow the prompts
   - Close and reopen Terminal, then verify with `node --version`

---

## Step 2: Clone the Repository

In Terminal, run:

```bash
cd ~/Desktop
git clone https://github.com/georgehaddaway/pipedrive-crm-agent.git
cd pipedrive-crm-agent
npm install
```

This downloads the agent and installs all dependencies.

---

## Step 3: Get Your Pipedrive API Token

1. Log in to [Pipedrive](https://app.pipedrive.com)
2. Click your **profile icon** (top right) → **Personal Preferences**
3. Go to the **API** tab
4. Copy your **Personal API token**
5. Note your company domain (the part before `.pipedrive.com` in the URL, e.g. `satoricapital`)

---

## Step 4: Set Up Gmail OAuth

You need a Google Cloud project with the Gmail API enabled:

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or use an existing one)
3. Go to **APIs & Services → Library** → search "Gmail API" → **Enable**
4. Go to **APIs & Services → Credentials** → **Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URIs: add `http://localhost:3000/oauth2callback`
5. Copy the **Client ID** and **Client Secret**

---

## Step 5: Create an Anthropic API Key (for AI Email Polish)

This enables the AI to rewrite template drafts in James's actual writing voice.

1. Go to [console.anthropic.com](https://console.anthropic.com)
2. **Create an account** if you don't have one (use your email, verify it)
3. Go to **Settings → Billing** and add a payment method
   - Estimated cost: $5-10/month depending on volume
4. Go to **Settings → API Keys** → **Create Key**
5. Name it something like "Pipedrive Agent"
6. Copy the key (starts with `sk-ant-...`)

> If you skip this step, the agent still works but emails use raw templates instead of AI-polished versions.

---

## Step 6: Configure the Environment

1. In Terminal, make sure you're in the project directory:
   ```bash
   cd ~/Desktop/pipedrive-crm-agent
   ```

2. Create your config file:
   ```bash
   cp .env.example .env
   ```

3. Open it in a text editor:
   ```bash
   open -a TextEdit .env
   ```

4. Fill in these values with your info from Steps 3-5:

   ```
   PIPEDRIVE_API_TOKEN=your_pipedrive_token_here
   PIPEDRIVE_COMPANY_DOMAIN=your_subdomain_here

   GMAIL_CLIENT_ID=your_client_id_here
   GMAIL_CLIENT_SECRET=your_client_secret_here

   SENDER_NAME=James
   SENDER_EMAIL=james@satoricapital.com
   FUND_NAME=Satori Power

   ANTHROPIC_API_KEY=sk-ant-your_key_here

   SLACK_WEBHOOK_URL=your_slack_url_here
   ```

5. Save and close the file.

---

## Step 7: Authorize Gmail

This is a one-time step that gives the agent permission to create drafts in your Gmail:

```bash
npm run auth
```

1. A URL will appear in Terminal. Copy and paste it into your browser.
2. Sign in with the Gmail account the agent should create drafts in.
3. Click **Allow** when prompted.
4. You'll be redirected and see "Authorization successful!"
5. Return to Terminal. It should say "Gmail auth setup complete."

---

## Step 8: Test the Agent

Run a dry run to verify everything is connected:

```bash
npm run dry-run
```

You should see:
- Config loaded with 9 stages
- Contacts fetched from Pipedrive
- Follow-ups evaluated
- Email drafts previewed (not actually created)

If you see errors, check your `.env` values.

---

## Step 9: Schedule Daily Runs

Install the macOS Launch Agent so the agent runs automatically at 7 AM on weekdays:

```bash
npm run setup-schedule
```

That's it. The agent will now:
1. Wake up at 7 AM Monday through Friday
2. Evaluate your pipeline contacts
3. Create drafts in your Gmail
4. Post a summary to Slack (if configured)

You review and send the drafts from Gmail at your convenience.

---

## Useful Commands

| Command | What It Does |
|---|---|
| `npm run dry-run` | Preview without creating drafts |
| `npm run run` | Full run: drafts + Slack summary |
| `npm run setup-schedule` | Install daily schedule |
| `npm run remove-schedule` | Remove daily schedule |
| `npm run schedule-status` | Check if schedule is active |
| `npm test` | Run tests |

---

## Troubleshooting

**"Gmail token not found"** → Run `npm run auth` again.

**"No contacts found"** → Make sure there are open deals in the Business Development pipeline in Pipedrive.

**Agent didn't run this morning** → Check `npm run schedule-status`. If it shows "not loaded", run `npm run setup-schedule` again.

**Want to change the schedule** → Edit `CRON_SCHEDULE` in `.env` (default: `0 7 * * 1-5` = 7 AM weekdays), then run `npm run setup-schedule` again.
