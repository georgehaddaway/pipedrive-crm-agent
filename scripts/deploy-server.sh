#!/bin/bash
# ──────────────────────────────────────────────────────
# Pipedrive CRM Agent — DigitalOcean Server Setup
#
# Provisions a fresh Ubuntu 24.04 Droplet for running
# the CRM agent via cron. Supports multiple clients.
#
# Usage (from your local Mac):
#   ssh root@<droplet-ip> 'bash -s' < scripts/deploy-server.sh
#
# After running, copy credentials:
#   scp .env root@<IP>:/opt/pipedrive-agents/clients/james/.env
#   scp data/gmail-token.json root@<IP>:/opt/pipedrive-agents/clients/james/data/gmail-token.json
# ──────────────────────────────────────────────────────

set -euo pipefail

AGENT_DIR="/opt/pipedrive-agents"
CLIENT_NAME="james"
CLIENT_DIR="${AGENT_DIR}/clients/${CLIENT_NAME}"
REPO_URL="https://github.com/georgehaddaway/pipedrive-crm-agent.git"
TIMEZONE="America/Denver"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Pipedrive CRM Agent — Server Setup"
echo "═══════════════════════════════════════════════════"
echo ""

# ── 1. Set timezone ─────────────────────────────────
echo "[1/8] Setting timezone to ${TIMEZONE}..."
timedatectl set-timezone "${TIMEZONE}"
echo "  Done. Current time: $(date)"

# ── 2. Install Node.js 20 LTS ──────────────────────
echo "[2/8] Installing Node.js 20 LTS..."
if command -v node &>/dev/null && [[ "$(node --version | cut -d. -f1 | tr -d v)" -ge 20 ]]; then
  echo "  Node.js $(node --version) already installed."
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y nodejs > /dev/null 2>&1
  echo "  Installed Node.js $(node --version)"
fi

# ── 3. Create system user ──────────────────────────
echo "[3/8] Creating system user 'pipedrive'..."
if id "pipedrive" &>/dev/null; then
  echo "  User 'pipedrive' already exists."
else
  useradd --system --shell /bin/bash --home-dir "${AGENT_DIR}" --create-home pipedrive
  echo "  Created user 'pipedrive'."
fi

# ── 4. Create directory structure ──────────────────
echo "[4/8] Creating directory structure..."
mkdir -p "${AGENT_DIR}/clients"
mkdir -p "${AGENT_DIR}/scripts"
mkdir -p "/var/log/pipedrive"
chown -R pipedrive:pipedrive "${AGENT_DIR}"
chown -R pipedrive:pipedrive /var/log/pipedrive

# ── 5. Clone repo ─────────────────────────────────
echo "[5/8] Cloning repository..."
if [ -d "${CLIENT_DIR}/.git" ]; then
  echo "  Repo already exists, pulling latest..."
  sudo -u pipedrive git -C "${CLIENT_DIR}" pull --ff-only
else
  sudo -u pipedrive git clone "${REPO_URL}" "${CLIENT_DIR}"
  echo "  Cloned to ${CLIENT_DIR}"
fi

# ── 6. Install dependencies ───────────────────────
echo "[6/8] Installing npm dependencies..."
cd "${CLIENT_DIR}"
sudo -u pipedrive npm ci --production > /dev/null 2>&1
echo "  Dependencies installed."

# Create data directories
sudo -u pipedrive mkdir -p data/runs data/logs

# ── 7. Set up cron ────────────────────────────────
echo "[7/8] Setting up cron jobs..."
cat > /etc/cron.d/pipedrive <<CRON
# Pipedrive CRM Agent - Automated Schedule
# Timezone: ${TIMEZONE} (set via timedatectl)
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin

# Daily agent: weekdays at 7:00 AM
0 7 * * 1-5 pipedrive cd ${CLIENT_DIR} && /usr/bin/node src/index.js >> data/logs/agent.log 2>> data/logs/agent-error.log

# Voice refresh: Sundays at 6:00 AM
0 6 * * 0 pipedrive cd ${CLIENT_DIR} && /usr/bin/node scripts/refresh-voice.js >> data/logs/voice-refresh.log 2>&1

# Watchdog: weekdays at 8:00 AM (checks if agent ran)
0 8 * * 1-5 pipedrive ${AGENT_DIR}/scripts/watchdog.sh ${CLIENT_DIR}
CRON

chmod 644 /etc/cron.d/pipedrive
echo "  Cron jobs installed."

# ── 8. Install watchdog ───────────────────────────
echo "[8/8] Installing watchdog..."
cat > "${AGENT_DIR}/scripts/watchdog.sh" <<'WATCHDOG'
#!/bin/bash
# Watchdog: check if today's run report exists. Alert Slack if not.
set -euo pipefail

CLIENT_DIR="${1:?Usage: watchdog.sh /path/to/client}"
TODAY=$(date +%Y-%m-%d)
RUN_FILE="${CLIENT_DIR}/data/runs/${TODAY}.json"
ENV_FILE="${CLIENT_DIR}/.env"

# Only check on weekdays (cron handles this, but double-check)
DOW=$(date +%u)
if [ "$DOW" -gt 5 ]; then
  exit 0
fi

if [ -f "$RUN_FILE" ]; then
  # Run report exists - agent ran successfully
  exit 0
fi

# Agent didn't run. Try to alert via Slack.
if [ -f "$ENV_FILE" ]; then
  WEBHOOK_URL=$(grep '^SLACK_WEBHOOK_URL=' "$ENV_FILE" | cut -d'=' -f2-)
  if [ -n "$WEBHOOK_URL" ]; then
    HOSTNAME=$(hostname)
    curl -s -X POST "$WEBHOOK_URL" \
      -H 'Content-Type: application/json' \
      -d "{\"blocks\":[{\"type\":\"section\",\"text\":{\"type\":\"mrkdwn\",\"text\":\":rotating_light: *[WATCHDOG]* CRM agent did not produce a run report today (${TODAY}).\\nServer: ${HOSTNAME}\\nClient dir: ${CLIENT_DIR}\\n\\nCheck logs: \\\`cat ${CLIENT_DIR}/data/logs/agent-error.log | tail -20\\\`\"}}]}" \
      > /dev/null 2>&1
  fi
fi

echo "[$(date)] WATCHDOG: No run report for ${TODAY}" >> "${CLIENT_DIR}/data/logs/watchdog.log"
exit 1
WATCHDOG

chmod +x "${AGENT_DIR}/scripts/watchdog.sh"
chown pipedrive:pipedrive "${AGENT_DIR}/scripts/watchdog.sh"
echo "  Watchdog installed."

# ── 9. Set up log rotation ────────────────────────
cat > /etc/logrotate.d/pipedrive <<LOGROTATE
${CLIENT_DIR}/data/logs/*.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    create 644 pipedrive pipedrive
}
LOGROTATE

# ── Done ──────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  Server setup complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo ""
echo "  1. Copy credentials from your Mac:"
echo "     scp .env root@<IP>:${CLIENT_DIR}/.env"
echo "     scp data/gmail-token.json root@<IP>:${CLIENT_DIR}/data/gmail-token.json"
echo ""
echo "  2. Fix ownership:"
echo "     chown pipedrive:pipedrive ${CLIENT_DIR}/.env"
echo "     chown pipedrive:pipedrive ${CLIENT_DIR}/data/gmail-token.json"
echo ""
echo "  3. Test:"
echo "     sudo -u pipedrive bash -c 'cd ${CLIENT_DIR} && node scripts/healthcheck.js'"
echo "     sudo -u pipedrive bash -c 'cd ${CLIENT_DIR} && node src/index.js --dry-run'"
echo ""
echo "  4. After confirming it works, remove launchd on James' Mac:"
echo "     bash scripts/launchd-setup.sh uninstall"
echo ""
echo "  Schedule:"
echo "    Agent:   weekdays 7:00 AM ${TIMEZONE}"
echo "    Voice:   Sundays  6:00 AM ${TIMEZONE}"
echo "    Watchdog: weekdays 8:00 AM ${TIMEZONE}"
echo ""
