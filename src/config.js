import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

loadEnv({ path: resolve(ROOT, '.env') });

/**
 * Load and parse JSON config file.
 * @param {string} relativePath - Path relative to project root
 */
function loadJSON(relativePath) {
  const raw = readFileSync(resolve(ROOT, relativePath), 'utf-8');
  return JSON.parse(raw);
}

/**
 * Require an env var or throw with a clear message.
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
function requireEnv(key, fallback) {
  const val = process.env[key] || fallback;
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}. See .env.example`);
  }
  return val;
}

const rules = loadJSON('config/rules.json');

/**
 * Load optional stage mapping from config/stage-map.json.
 * Maps Pipedrive stage names to rules.json keys.
 * @returns {Object|null}
 */
function loadStageMap() {
  try {
    return loadJSON('config/stage-map.json');
  } catch {
    return null;
  }
}

const config = {
  // ── Pipedrive ────────────────────────────────────
  pipedrive: {
    apiToken: process.env.PIPEDRIVE_API_TOKEN || null,
    companyDomain: process.env.PIPEDRIVE_COMPANY_DOMAIN || null,
    get useApi() {
      return Boolean(this.apiToken && this.companyDomain);
    },
    csvPath: resolve(ROOT, 'data/pipedrive-export.csv'),
    stageMap: loadStageMap(),
  },

  // ── Gmail ────────────────────────────────────────
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID || null,
    clientSecret: process.env.GMAIL_CLIENT_SECRET || null,
    redirectUri: process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback',
    tokenPath: resolve(ROOT, 'data/gmail-token.json'),
  },

  // ── Slack ────────────────────────────────────────
  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL || null,
    get enabled() {
      return Boolean(this.webhookUrl);
    },
  },

  // ── Anthropic (optional) ─────────────────────────
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    get enabled() {
      return Boolean(this.apiKey);
    },
  },

  // ── Schedule ─────────────────────────────────────
  cron: process.env.CRON_SCHEDULE || '0 7 * * 1-5',

  // ── Sender Info ──────────────────────────────────
  sender: {
    name: process.env.SENDER_NAME || 'Team',
    email: process.env.SENDER_EMAIL || '',
    fundName: process.env.FUND_NAME || 'Our Fund',
  },

  // ── Rules ────────────────────────────────────────
  rules,

  // ── Paths ────────────────────────────────────────
  paths: {
    root: ROOT,
    templates: resolve(ROOT, 'config/templates'),
    runsDir: resolve(ROOT, 'data/runs'),
  },
};

export default config;
