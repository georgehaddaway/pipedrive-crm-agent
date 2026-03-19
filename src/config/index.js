import { config as loadEnv } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

loadEnv({ path: resolve(ROOT, '.env') });

// ── JSON Loader ──────────────────────────────────────

/**
 * Load and parse a JSON config file relative to project root.
 * @param {string} relativePath
 * @returns {Object}
 */
function loadJSON(relativePath) {
  const fullPath = resolve(ROOT, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Config file not found: ${relativePath} (looked at ${fullPath})`);
  }
  const raw = readFileSync(fullPath, 'utf-8');
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

// ── Load All Configs ─────────────────────────────────

const pipelineStages = loadJSON('config/pipeline-stages.json');
const followUpRules = loadJSON('config/follow-up-rules.json');
const pipedriveIds = loadJSON('config/pipedrive-ids.json');
const templateMapping = loadJSON('config/template-mapping.json');

let pipedriveFields;
try {
  pipedriveFields = loadJSON('config/pipedrive-fields.json');
} catch {
  console.warn('Warning: config/pipedrive-fields.json not found. Custom field validation disabled.');
  pipedriveFields = { person_fields: {}, deal_fields: {}, api: { rate_limit: {} } };
}

// ── Stage Helpers ────────────────────────────────────

/** @type {Map<string, Object>} stage key -> full stage config object */
const stagesByKey = new Map();
for (const stage of pipelineStages.stages) {
  stagesByKey.set(stage.key, stage);
}

/** @type {Map<number, string>} Pipedrive stage ID -> stage key */
const pipedriveIdToKey = new Map();
for (const [key, id] of Object.entries(pipedriveIds.stages)) {
  pipedriveIdToKey.set(id, key);
}

/**
 * Get a full stage config object by its key.
 * @param {string} key - Stage key, e.g. "engaged"
 * @returns {Object|null} Stage object with follow_up, auto_advance, etc.
 */
function getStageByKey(key) {
  return stagesByKey.get(key) || null;
}

/**
 * Get a stage key from a Pipedrive stage ID.
 * @param {number} pipedriveStageId
 * @returns {string|null}
 */
function getStageKeyByPipedriveId(pipedriveStageId) {
  return pipedriveIdToKey.get(pipedriveStageId) || null;
}

/**
 * Get the Pipedrive stage ID for a stage key.
 * @param {string} key
 * @returns {number|null}
 */
function getPipedriveStageId(key) {
  return pipedriveIds.stages[key] || null;
}

/**
 * Get all stage keys in pipeline order.
 * @returns {string[]}
 */
function getStageKeysInOrder() {
  return pipelineStages.stages
    .sort((a, b) => a.order - b.order)
    .map(s => s.key);
}

/**
 * Check if a stage key is valid.
 * @param {string} key
 * @returns {boolean}
 */
function isValidStageKey(key) {
  return stagesByKey.has(key);
}

// ── Startup Validation ───────────────────────────────

function validateConfigs() {
  const errors = [];

  // Validate pipeline stages
  if (!pipelineStages.stages || pipelineStages.stages.length === 0) {
    errors.push('pipeline-stages.json: No stages defined');
  }

  // Validate each stage has required fields
  for (const stage of pipelineStages.stages) {
    if (!stage.key) errors.push(`pipeline-stages.json: Stage missing 'key': ${JSON.stringify(stage)}`);
    if (!stage.name) errors.push(`pipeline-stages.json: Stage '${stage.key}' missing 'name'`);
    if (stage.follow_up === undefined) errors.push(`pipeline-stages.json: Stage '${stage.key}' missing 'follow_up'`);
  }

  // Validate pipedrive-ids has all stage keys
  for (const stage of pipelineStages.stages) {
    if (!pipedriveIds.stages[stage.key]) {
      errors.push(`pipedrive-ids.json: Missing Pipedrive ID for stage '${stage.key}'`);
    }
  }

  // Validate overdue thresholds match stage keys
  for (const key of Object.keys(followUpRules.overdue_thresholds)) {
    if (!stagesByKey.has(key)) {
      errors.push(`follow-up-rules.json: Overdue threshold for unknown stage '${key}'`);
    }
  }

  // Validate template mapping has entries for active stages
  for (const stage of pipelineStages.stages) {
    if (stage.follow_up.threshold_days !== null && !templateMapping.stages[stage.key]) {
      errors.push(`template-mapping.json: No template mapping for active stage '${stage.key}'`);
    }
  }

  if (errors.length > 0) {
    console.error('\n=== CONFIG VALIDATION ERRORS ===');
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    console.error('================================\n');
    throw new Error(`Config validation failed with ${errors.length} error(s). See above for details.`);
  }

  console.log(`Config loaded: ${pipelineStages.stages.length} stages, ${Object.keys(followUpRules.overdue_thresholds).length} thresholds, pipeline ID ${pipedriveIds.pipeline_id}`);
}

// Run validation on import
validateConfigs();

// ── Export Config Object ─────────────────────────────

const config = {
  // ── Pipedrive ────────────────────────────────────
  pipedrive: {
    apiToken: process.env.PIPEDRIVE_API_TOKEN || null,
    companyDomain: process.env.PIPEDRIVE_COMPANY_DOMAIN || null,
    get useApi() {
      return Boolean(this.apiToken && this.companyDomain);
    },
    csvPath: resolve(ROOT, 'data/pipedrive-export.csv'),
    pipelineId: pipedriveIds.pipeline_id,
    ids: pipedriveIds,
    fields: pipedriveFields,
    rateLimits: pipedriveFields.api?.rate_limit || {
      requests_per_second: 10,
      retry_delay_ms: 2000,
      max_retries: 3,
    },
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

  // ── Pipeline & Rules ─────────────────────────────
  pipeline: pipelineStages,
  rules: followUpRules,
  templateMapping,
  pipedriveFields,

  // ── Stage Helpers ────────────────────────────────
  getStageByKey,
  getStageKeyByPipedriveId,
  getPipedriveStageId,
  getStageKeysInOrder,
  isValidStageKey,

  // ── Paths ────────────────────────────────────────
  paths: {
    root: ROOT,
    templates: resolve(ROOT, templateMapping.template_dir || 'src/templates/emails'),
    runsDir: resolve(ROOT, 'data/runs'),
  },
};

export default config;
