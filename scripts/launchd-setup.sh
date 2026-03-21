#!/bin/bash
# ──────────────────────────────────────────────────────────
# Pipedrive CRM Agent — macOS Launch Agent Setup
#
# Usage:
#   bash scripts/launchd-setup.sh install    # Install & load the scheduled agent
#   bash scripts/launchd-setup.sh uninstall  # Unload & remove the scheduled agent
#   bash scripts/launchd-setup.sh status     # Check if the agent is loaded
# ──────────────────────────────────────────────────────────

set -euo pipefail

LABEL="com.pipedrive-crm.agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/data/logs"

# ── Detect Node.js ───────────────────────────────────────
detect_node() {
  if command -v node &>/dev/null; then
    NODE_PATH="$(command -v node)"
  elif [ -x "/usr/local/bin/node" ]; then
    NODE_PATH="/usr/local/bin/node"
  elif [ -x "$HOME/.nvm/versions/node/"*"/bin/node" ] 2>/dev/null; then
    NODE_PATH=$(ls "$HOME/.nvm/versions/node/"*/bin/node 2>/dev/null | tail -1)
  else
    echo "Error: Node.js not found. Install Node.js >= 20 first."
    exit 1
  fi
  echo "Using Node.js: ${NODE_PATH} ($(${NODE_PATH} --version))"
}

# ── Parse CRON_SCHEDULE from .env ────────────────────────
parse_schedule() {
  local env_file="${PROJECT_DIR}/.env"
  if [ ! -f "$env_file" ]; then
    echo "Error: .env file not found at ${env_file}"
    exit 1
  fi

  local cron_expr
  cron_expr=$(grep -E '^CRON_SCHEDULE=' "$env_file" | cut -d'=' -f2 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')

  if [ -z "$cron_expr" ]; then
    # Default: 7 AM weekdays (0 7 * * 1-5)
    cron_expr="0 7 * * 1-5"
  fi

  # Parse the 5-field cron expression: minute hour dom month dow
  CRON_MINUTE=$(echo "$cron_expr" | awk '{print $1}')
  CRON_HOUR=$(echo "$cron_expr" | awk '{print $2}')
  CRON_DOW=$(echo "$cron_expr" | awk '{print $5}')

  echo "Schedule: minute=${CRON_MINUTE} hour=${CRON_HOUR} weekdays=${CRON_DOW}"
}

# ── Build StartCalendarInterval XML ─────────────────────
build_calendar_intervals() {
  # Convert cron day-of-week (0-7, 0/7=Sun) to launchd (0=Sun, 1=Mon, ..., 6=Sat)
  # Cron: 1-5 means Mon-Fri. launchd uses same numbering (1=Mon).
  # Handle ranges like "1-5" and lists like "1,3,5"

  local intervals=""

  if [ "$CRON_DOW" = "*" ]; then
    # Every day — single entry without Weekday
    intervals="      <dict>
        <key>Hour</key>
        <integer>${CRON_HOUR}</integer>
        <key>Minute</key>
        <integer>${CRON_MINUTE}</integer>
      </dict>"
  elif echo "$CRON_DOW" | grep -qE '^[0-9]-[0-9]$'; then
    # Range like 1-5
    local start end
    start=$(echo "$CRON_DOW" | cut -d'-' -f1)
    end=$(echo "$CRON_DOW" | cut -d'-' -f2)
    for day in $(seq "$start" "$end"); do
      intervals="${intervals}
      <dict>
        <key>Weekday</key>
        <integer>${day}</integer>
        <key>Hour</key>
        <integer>${CRON_HOUR}</integer>
        <key>Minute</key>
        <integer>${CRON_MINUTE}</integer>
      </dict>"
    done
  else
    # Comma-separated or single number
    for day in $(echo "$CRON_DOW" | tr ',' ' '); do
      intervals="${intervals}
      <dict>
        <key>Weekday</key>
        <integer>${day}</integer>
        <key>Hour</key>
        <integer>${CRON_HOUR}</integer>
        <key>Minute</key>
        <integer>${CRON_MINUTE}</integer>
      </dict>"
    done
  fi

  echo "$intervals"
}

# ── Install ──────────────────────────────────────────────
cmd_install() {
  detect_node
  parse_schedule

  # Ensure log directory exists
  mkdir -p "$LOG_DIR"

  local calendar_intervals
  calendar_intervals=$(build_calendar_intervals)

  # Unload existing if present
  if launchctl list "$LABEL" &>/dev/null; then
    echo "Unloading existing Launch Agent..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  # The Node.js wrapper (scripts/run-wrapper.js) is idempotent:
  #   - Skips if outside business hours (before 7 AM or after 9 PM)
  #   - Skips weekends
  #   - Skips if today's run file already exists
  #   - Auto-pulls from git and installs deps before running
  #
  # Using StartInterval (every 10 minutes) instead of StartCalendarInterval
  # ensures the agent fires shortly after wake from sleep. The wrapper's
  # built-in guards prevent unnecessary work. Using Node.js directly
  # avoids macOS TCC permission issues with /bin/bash.
  echo "Using wrapper: ${PROJECT_DIR}/scripts/run-wrapper.js"
  echo "Schedule: every 10 minutes (wrapper handles time-of-day + weekend + idempotency)"

  # Write plist
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${PROJECT_DIR}/scripts/run-wrapper.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>StartInterval</key>
  <integer>600</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/agent.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/agent-error.log</string>

  <key>KeepAlive</key>
  <false/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:$(dirname "${NODE_PATH}")</string>
  </dict>
</dict>
</plist>
PLIST

  echo "Plist written to: ${PLIST_PATH}"

  # ── Voice Refresh (weekly, Sundays at 6 AM) ──────────
  local VOICE_LABEL="com.pipedrive-crm.voice-refresh"
  local VOICE_PLIST_PATH="$HOME/Library/LaunchAgents/${VOICE_LABEL}.plist"

  # Unload existing voice refresh if present
  if launchctl list "$VOICE_LABEL" &>/dev/null; then
    launchctl unload "$VOICE_PLIST_PATH" 2>/dev/null || true
  fi

  cat > "$VOICE_PLIST_PATH" <<VPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${VOICE_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${PROJECT_DIR}/scripts/refresh-voice.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>6</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/voice-refresh.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/voice-refresh-error.log</string>

  <key>RunAtLoad</key>
  <false/>

  <key>KeepAlive</key>
  <false/>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:$(dirname "${NODE_PATH}")</string>
  </dict>
</dict>
</plist>
VPLIST

  launchctl load "$VOICE_PLIST_PATH"
  echo "Voice refresh plist written to: ${VOICE_PLIST_PATH}"

  # Load daily agent
  launchctl load "$PLIST_PATH"
  echo ""
  echo "Launch Agents installed and loaded."
  echo "  Daily agent:   7 AM weekdays (follow-up drafts)"
  echo "  Voice refresh: 6 AM Sundays (update writing style from recent emails)"
  echo ""
  echo "Useful commands:"
  echo "  Check status:   launchctl list ${LABEL}"
  echo "  View logs:      tail -f ${LOG_DIR}/agent.log"
  echo "  View errors:    tail -f ${LOG_DIR}/agent-error.log"
  echo "  Manual trigger: launchctl start ${LABEL}"
  echo "  Voice refresh:  npm run update-voice"
  echo "  Uninstall:      bash scripts/launchd-setup.sh uninstall"
}

# ── Uninstall ────────────────────────────────────────────
cmd_uninstall() {
  # Remove daily agent
  if [ -f "$PLIST_PATH" ]; then
    echo "Unloading daily agent..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "Removed ${PLIST_PATH}"
  fi

  # Remove voice refresh
  local VOICE_LABEL="com.pipedrive-crm.voice-refresh"
  local VOICE_PLIST_PATH="$HOME/Library/LaunchAgents/${VOICE_LABEL}.plist"
  if [ -f "$VOICE_PLIST_PATH" ]; then
    echo "Unloading voice refresh..."
    launchctl unload "$VOICE_PLIST_PATH" 2>/dev/null || true
    rm -f "$VOICE_PLIST_PATH"
    echo "Removed ${VOICE_PLIST_PATH}"
  fi

  if [ ! -f "$PLIST_PATH" ] && [ ! -f "$VOICE_PLIST_PATH" ]; then
    echo "No Launch Agents found. Nothing to uninstall."
  else
    echo "Launch Agents uninstalled. Logs in ${LOG_DIR}/ have been preserved."
  fi
}

# ── Status ───────────────────────────────────────────────
cmd_status() {
  if launchctl list "$LABEL" &>/dev/null; then
    echo "Launch Agent is loaded."
    launchctl list "$LABEL"
    echo ""
    if [ -f "$PLIST_PATH" ]; then
      echo "Plist: ${PLIST_PATH}"
    fi
    if [ -f "${LOG_DIR}/agent.log" ]; then
      echo ""
      echo "Last 5 lines of agent.log:"
      tail -5 "${LOG_DIR}/agent.log" 2>/dev/null || echo "  (empty)"
    fi
  else
    echo "Launch Agent is NOT loaded."
    if [ -f "$PLIST_PATH" ]; then
      echo "Plist exists at ${PLIST_PATH} but is not loaded."
      echo "Run: bash scripts/launchd-setup.sh install"
    else
      echo "No plist found. Run: bash scripts/launchd-setup.sh install"
    fi
  fi
}

# ── Main ─────────────────────────────────────────────────
case "${1:-help}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  *)
    echo "Pipedrive CRM Agent — macOS Launch Agent Setup"
    echo ""
    echo "Usage:"
    echo "  bash scripts/launchd-setup.sh install    Install & load the scheduled agent"
    echo "  bash scripts/launchd-setup.sh uninstall  Unload & remove the agent"
    echo "  bash scripts/launchd-setup.sh status     Check if the agent is loaded"
    ;;
esac
