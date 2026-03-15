import { readFileSync, existsSync } from 'fs';
import config from '../config.js';

// ── Pipedrive API helpers ───────────────────────────

/**
 * Make an authenticated GET request to the Pipedrive API v2.
 * @param {string} endpoint - e.g. "/persons"
 * @param {Record<string, string>} [params] - Query parameters
 * @returns {Promise<Object>}
 */
async function apiGet(endpoint, params = {}) {
  const url = new URL(`https://${config.pipedrive.companyDomain}.pipedrive.com/api/v2${endpoint}`);
  url.searchParams.set('api_token', config.pipedrive.apiToken);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Pipedrive API error: ${res.status} ${res.statusText} (${endpoint})`);
  }

  return res.json();
}

/**
 * Fetch all pages of a paginated Pipedrive v2 endpoint.
 * @param {string} endpoint
 * @param {Record<string, string>} [params]
 * @returns {Promise<Object[]>}
 */
async function apiGetAll(endpoint, params = {}) {
  const results = [];
  let cursor = null;

  do {
    const queryParams = { ...params, limit: '100' };
    if (cursor) queryParams.cursor = cursor;

    const data = await apiGet(endpoint, queryParams);
    const items = data.data || [];
    results.push(...items);

    cursor = data.additional_data?.next_cursor || null;
  } while (cursor);

  return results;
}

// ── CSV parsing ─────────────────────────────────────

/**
 * Parse a CSV string into an array of objects using the header row as keys.
 * Handles quoted fields containing commas.
 * @param {string} csv
 * @returns {Object[]}
 */
function parseCSV(csv) {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseCsvLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h.trim()] = (vals[idx] || '').trim();
    });
    rows.push(obj);
  }
  return rows;
}

/**
 * Parse a single CSV line respecting quoted fields.
 * @param {string} line
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Normalization ───────────────────────────────────

/**
 * Normalize a Pipedrive person + deal data into a standard Contact shape.
 * @param {Object} raw
 * @returns {import('./types.js').Contact}
 */
function normalizeContact(raw) {
  return {
    id: String(raw.id || raw.person_id || Math.random().toString().slice(2, 10)),
    firstName: raw.firstName || raw.first_name || raw['First Name'] || extractFirstName(raw.name || raw.person_name || ''),
    lastName: raw.lastName || raw.last_name || raw['Last Name'] || extractLastName(raw.name || raw.person_name || ''),
    email: extractEmail(raw),
    company: raw.company || raw.org_name || raw.organization || raw['Organization'] || '',
    stage: normalizeStage(raw.stage || raw.deal_stage || raw.pipeline_stage || raw.Stage || 'initial_outreach'),
    priority: normalizePriority(raw.priority || raw.Priority || raw.label || 'medium'),
    tags: parseTags(raw.tags || raw.Tags || raw.label || ''),
    lastContactDate: raw.lastContactDate || raw.last_contact_date || raw.last_activity_date || raw['Last Contact'] || null,
    notes: raw.notes || raw.Notes || '',
    meta: {
      meetingDate: raw.meetingDate || raw.meeting_date || raw.next_activity_date || null,
      agenda: raw.agenda || raw.Agenda || null,
      pendingDocuments: parseTags(raw.pendingDocuments || raw.pending_documents || ''),
      lastDiscussionPoint: raw.lastDiscussionPoint || raw.last_discussion_point || null,
      deadline: raw.deadline || raw.Deadline || null,
      dealId: raw.deal_id || raw.dealId || null,
      dealValue: raw.deal_value || raw.dealValue || null,
    },
  };
}

/**
 * Extract first name from a full name string.
 * @param {string} fullName
 * @returns {string}
 */
function extractFirstName(fullName) {
  return fullName.split(/\s+/)[0] || '';
}

/**
 * Extract last name from a full name string.
 * @param {string} fullName
 * @returns {string}
 */
function extractLastName(fullName) {
  const parts = fullName.split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

/**
 * Extract primary email - handles Pipedrive's email array format and flat strings.
 * @param {Object} raw
 * @returns {string}
 */
function extractEmail(raw) {
  // Pipedrive API returns emails as an array of {value, primary, label}
  if (Array.isArray(raw.emails)) {
    const primary = raw.emails.find(e => e.primary) || raw.emails[0];
    return primary?.value || '';
  }
  // CSV / flat format
  return raw.email || raw.Email || raw.email_address || '';
}

/**
 * Normalize a stage string to a rules.json key.
 * Uses config.pipedrive.stageMap if defined, otherwise normalizes the string directly.
 * @param {string} stage
 * @returns {string}
 */
function normalizeStage(stage) {
  // Check explicit stage map first
  const stageMap = config.pipedrive.stageMap;
  if (stageMap) {
    const mapped = stageMap[stage] || stageMap[stage.toLowerCase()];
    if (mapped) return mapped;
  }

  // Fallback: normalize string to match rules.json keys
  const key = stage.toLowerCase().replace(/[\s-]+/g, '_');
  const validStages = Object.keys(config.rules.stages);
  if (validStages.includes(key)) return key;

  // Fuzzy match
  const match = validStages.find(s => s.includes(key) || key.includes(s));
  return match || 'initial_outreach';
}

/**
 * @param {string} priority
 * @returns {string}
 */
function normalizePriority(priority) {
  const p = priority.toLowerCase().trim();
  if (['high', 'medium', 'low'].includes(p)) return p;
  // Map Pipedrive label colors to priority if needed
  if (p === 'hot') return 'high';
  if (p === 'warm') return 'medium';
  if (p === 'cold') return 'low';
  return 'medium';
}

/**
 * @param {string|string[]} tags
 * @returns {string[]}
 */
function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (!tags) return [];
  return tags.split(/[,;|]/).map(t => t.trim()).filter(Boolean);
}

// ── API Client ──────────────────────────────────────

/**
 * Fetch contacts from the Pipedrive API v2.
 * Fetches persons, then enriches each with deal stage and last activity date.
 * @returns {Promise<import('./types.js').Contact[]>}
 */
async function fetchContactsFromAPI() {
  // 1. Fetch all persons
  const persons = await apiGetAll('/persons');

  if (!Array.isArray(persons) || persons.length === 0) {
    return [];
  }

  // 2. Fetch all open deals to map person -> deal stage
  const deals = await apiGetAll('/deals', { status: 'open' });

  // Build a map of person_id -> most recently updated deal
  /** @type {Map<number, Object>} */
  const personDealMap = new Map();
  for (const deal of deals) {
    const personId = deal.person_id;
    if (!personId) continue;
    const existing = personDealMap.get(personId);
    if (!existing || new Date(deal.update_time) > new Date(existing.update_time)) {
      personDealMap.set(personId, deal);
    }
  }

  // 3. Fetch all pipeline stages to resolve stage IDs to names
  const pipelinesData = await apiGet('/pipelines');
  const pipelines = pipelinesData.data || [];
  /** @type {Map<number, string>} */
  const stageIdToName = new Map();

  for (const pipeline of pipelines) {
    const stagesData = await apiGet(`/stages`, { pipeline_id: String(pipeline.id) });
    const stages = stagesData.data || [];
    for (const stage of stages) {
      stageIdToName.set(stage.id, stage.name);
    }
  }

  // 4. Build contacts
  return persons.map(person => {
    const deal = personDealMap.get(person.id);
    const stageName = deal ? (stageIdToName.get(deal.stage_id) || 'initial_outreach') : 'initial_outreach';

    return normalizeContact({
      id: person.id,
      name: person.name,
      emails: person.emails || [],
      org_name: person.org_name || '',
      label: person.label || '',
      notes: person.notes || '',
      last_activity_date: person.last_activity_date || null,
      next_activity_date: person.next_activity_date || null,
      stage: stageName,
      deal_id: deal?.id || null,
      deal_value: deal?.value || null,
    });
  }).filter(c => c.email);
}

// ── CSV Fallback ────────────────────────────────────

/**
 * Load contacts from a CSV export file.
 * @returns {import('./types.js').Contact[]}
 */
function loadContactsFromCSV() {
  const csvPath = config.pipedrive.csvPath;
  if (!existsSync(csvPath)) {
    throw new Error(
      `No Pipedrive API configured and CSV file not found at ${csvPath}.\n` +
      `Either set PIPEDRIVE_API_TOKEN + PIPEDRIVE_COMPANY_DOMAIN in .env, or export ` +
      `contacts from Pipedrive and save to data/pipedrive-export.csv`
    );
  }

  const raw = readFileSync(csvPath, 'utf-8');
  const rows = parseCSV(raw);

  if (rows.length === 0) {
    console.warn('Warning: CSV file is empty or has no data rows.');
    return [];
  }

  return rows.map(normalizeContact).filter(c => c.email);
}

// ── Public API ──────────────────────────────────────

/**
 * Get all contacts from Pipedrive (API or CSV fallback).
 * @returns {Promise<import('./types.js').Contact[]>}
 */
export async function getContacts() {
  if (config.pipedrive.useApi) {
    console.log('Fetching contacts from Pipedrive API...');
    return fetchContactsFromAPI();
  }
  console.log('Loading contacts from CSV fallback...');
  return loadContactsFromCSV();
}

/**
 * Get the data source being used.
 * @returns {string}
 */
export function getDataSource() {
  return config.pipedrive.useApi ? 'pipedrive-api' : 'csv-fallback';
}
