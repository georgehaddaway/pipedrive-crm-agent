import { readFileSync, existsSync } from 'fs';
import config from '../config/index.js';

// ── Rate Limiter ─────────────────────────────────────

let requestTimestamps = [];
const RATE_WINDOW_MS = 1000; // 1 second window

/**
 * Wait if necessary to respect rate limits.
 */
async function rateLimit() {
  const now = Date.now();
  const maxPerSecond = config.pipedrive.rateLimits.requests_per_second || 10;

  // Remove timestamps older than 1 second
  requestTimestamps = requestTimestamps.filter(t => now - t < RATE_WINDOW_MS);

  if (requestTimestamps.length >= maxPerSecond) {
    const oldestInWindow = requestTimestamps[0];
    const waitMs = RATE_WINDOW_MS - (now - oldestInWindow) + 50; // 50ms buffer
    await new Promise(r => setTimeout(r, waitMs));
  }

  requestTimestamps.push(Date.now());
}

// ── API Helpers ──────────────────────────────────────

/**
 * Make an authenticated request to the Pipedrive API v2.
 * Includes rate limiting and retry on 429.
 * @param {string} endpoint - e.g. "/persons"
 * @param {Object} [options]
 * @param {string} [options.method='GET']
 * @param {Record<string, string>} [options.params] - Query parameters
 * @param {Object} [options.body] - Request body for POST/PUT/PATCH
 * @returns {Promise<Object>}
 */
async function apiRequest(endpoint, options = {}) {
  const { method = 'GET', params = {}, body = null } = options;
  const maxRetries = config.pipedrive.rateLimits.max_retries || 3;
  const retryDelay = config.pipedrive.rateLimits.retry_delay_ms || 2000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await rateLimit();

    const url = new URL(`https://${config.pipedrive.companyDomain}.pipedrive.com/api/v2${endpoint}`);
    url.searchParams.set('api_token', config.pipedrive.apiToken);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const fetchOptions = {
      method,
      headers: { 'Accept': 'application/json' },
    };

    if (body && method !== 'GET') {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetch(url.toString(), fetchOptions);

    if (res.status === 429 && attempt < maxRetries) {
      console.warn(`  Rate limited (429), retrying in ${retryDelay}ms... (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(r => setTimeout(r, retryDelay));
      continue;
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(`Pipedrive API error: ${res.status} ${res.statusText} (${method} ${endpoint}): ${errorBody}`);
    }

    return res.json();
  }
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

    const data = await apiRequest(endpoint, { params: queryParams });
    const items = data.data || [];
    results.push(...items);

    cursor = data.additional_data?.next_cursor || null;
  } while (cursor);

  return results;
}

// ── CSV Parsing ──────────────────────────────────────

/**
 * Parse a CSV string into an array of objects using the header row as keys.
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

// ── Field Discovery ──────────────────────────────────

/** @type {Map<string, string>} human name -> Pipedrive field key hash */
let personFieldKeys = null;
let dealFieldKeys = null;

/**
 * Discover custom field key hashes from Pipedrive.
 * Uses v1 API since it reliably returns field names + keys.
 * Maps human-readable names (e.g. "Lead Source") to Pipedrive hash keys.
 */
async function discoverFieldKeys() {
  if (personFieldKeys) return; // Already discovered

  personFieldKeys = new Map();
  dealFieldKeys = new Map();

  try {
    await rateLimit();

    // Person fields (v1 - more reliable for custom field discovery)
    const personRes = await fetch(
      `https://${config.pipedrive.companyDomain}.pipedrive.com/api/v1/personFields?api_token=${config.pipedrive.apiToken}`
    );
    const personData = await personRes.json();
    for (const field of personData.data || []) {
      personFieldKeys.set(field.name, field.key);
    }

    await rateLimit();

    // Deal fields (v1)
    const dealRes = await fetch(
      `https://${config.pipedrive.companyDomain}.pipedrive.com/api/v1/dealFields?api_token=${config.pipedrive.apiToken}`
    );
    const dealData = await dealRes.json();
    for (const field of dealData.data || []) {
      dealFieldKeys.set(field.name, field.key);
    }

    // Log discovered custom fields
    const expectedPersonFields = Object.values(config.pipedriveFields.person_fields || {});
    const missing = [];
    for (const fieldDef of expectedPersonFields) {
      if (!personFieldKeys.has(fieldDef.name)) {
        missing.push(fieldDef.name);
      }
    }

    if (missing.length > 0) {
      console.warn(`  Warning: ${missing.length} expected Pipedrive person fields not found: ${missing.join(', ')}`);
      console.warn('  The agent will work without these fields but some features will be limited.');
    } else {
      console.log(`  All expected person fields discovered.`);
    }
  } catch (err) {
    console.warn(`  Field discovery failed: ${err.message}. Custom field features disabled.`);
  }
}

/**
 * Get the Pipedrive hash key for a person field by its human-readable name.
 * @param {string} fieldName
 * @returns {string|null}
 */
function getPersonFieldKey(fieldName) {
  return personFieldKeys?.get(fieldName) || null;
}

/**
 * Get the Pipedrive hash key for a deal field by its human-readable name.
 * @param {string} fieldName
 * @returns {string|null}
 */
function getDealFieldKey(fieldName) {
  return dealFieldKeys?.get(fieldName) || null;
}

// ── Normalization ────────────────────────────────────

/**
 * Normalize a Pipedrive person + deal data into a standard Contact shape.
 * @param {Object} raw
 * @returns {Object}
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
    // New fields for the upgraded pipeline
    leadSource: raw.leadSource || raw.lead_source || extractCustomField(raw, 'Lead Source') || null,
    introducerPersonId: raw.introducerPersonId || raw.introducer_person_id || extractCustomField(raw, 'Introducer') || null,
    lastOutboundDate: raw.lastOutboundDate || raw.last_outbound_date || extractCustomField(raw, 'Last Outbound Date') || null,
    lastInboundDate: raw.lastInboundDate || raw.last_inbound_date || extractCustomField(raw, 'Last Inbound Date') || null,
    outreachAttempts: Number(raw.outreachAttempts || raw.outreach_attempts || extractCustomField(raw, 'Outreach Attempts') || 0),
    investorType: raw.investorType || raw.investor_type || extractCustomField(raw, 'Investor Type') || null,
    dataRoomAccess: raw.dataRoomAccess || raw.data_room_access || null,
    emailBounced: raw.emailBounced || false,
    meta: {
      meetingDate: raw.meetingDate || raw.meeting_date || raw.next_activity_date || null,
      paulMeetingDate: raw.paulMeetingDate || raw.paul_meeting_date || null,
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
 * Extract a custom field value from raw Pipedrive data using the discovered field key.
 * @param {Object} raw
 * @param {string} fieldName
 * @returns {*}
 */
function extractCustomField(raw, fieldName) {
  const key = getPersonFieldKey(fieldName) || getDealFieldKey(fieldName);
  if (!key) return null;
  return raw[key] || null;
}

function extractFirstName(fullName) {
  return fullName.split(/\s+/)[0] || '';
}

function extractLastName(fullName) {
  const parts = fullName.split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : '';
}

function extractEmail(raw) {
  if (Array.isArray(raw.emails)) {
    const primary = raw.emails.find(e => e.primary) || raw.emails[0];
    return primary?.value || '';
  }
  return raw.email || raw.Email || raw.email_address || '';
}

/**
 * Normalize a stage string to a pipeline-stages.json key.
 * Uses pipedrive-ids.json for ID-based resolution, then string matching.
 * @param {string|number} stage
 * @returns {string}
 */
function normalizeStage(stage) {
  // If it's a numeric ID, resolve via pipedrive-ids
  if (typeof stage === 'number' || /^\d+$/.test(stage)) {
    const key = config.getStageKeyByPipedriveId(Number(stage));
    if (key) return key;
  }

  // Check if it's already a valid key
  if (config.isValidStageKey(stage)) return stage;

  // Normalize string to match keys
  const key = String(stage).toLowerCase().replace(/[\s-]+/g, '_').replace(/[()]/g, '');
  if (config.isValidStageKey(key)) return key;

  // Fuzzy match against stage names
  const stageKeys = config.getStageKeysInOrder();
  const match = stageKeys.find(k => {
    const stageObj = config.getStageByKey(k);
    const normalized = stageObj.name.toLowerCase().replace(/[\s-]+/g, '_').replace(/[()]/g, '');
    return normalized === key || k.includes(key) || key.includes(k);
  });

  return match || 'initial_outreach';
}

function normalizePriority(priority) {
  const p = priority.toLowerCase().trim();
  if (['high', 'medium', 'low'].includes(p)) return p;
  if (p === 'hot') return 'high';
  if (p === 'warm') return 'medium';
  if (p === 'cold') return 'low';
  return 'medium';
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (!tags) return [];
  return tags.split(/[,;|]/).map(t => t.trim()).filter(Boolean);
}

// ── API Client ───────────────────────────────────────

/**
 * Fetch contacts from the Pipedrive API v2.
 * Scoped to the configured pipeline only.
 * @returns {Promise<Object[]>}
 */
async function fetchContactsFromAPI() {
  // Discover field keys for custom field resolution
  await discoverFieldKeys();

  const pipelineId = config.pipedrive.pipelineId;

  // 1. Fetch all open deals in the target pipeline
  const deals = await apiGetAll('/deals', {
    status: 'open',
    pipeline_id: String(pipelineId),
  });

  if (deals.length === 0) {
    console.log('  No open deals in pipeline.');
    return [];
  }

  // Build map of person_id -> most recently updated deal
  const personDealMap = new Map();
  for (const deal of deals) {
    const personId = deal.person_id;
    if (!personId) continue;
    const existing = personDealMap.get(personId);
    if (!existing || new Date(deal.update_time) > new Date(existing.update_time)) {
      personDealMap.set(personId, deal);
    }
  }

  // 2. Fetch persons who have deals
  const personIds = [...personDealMap.keys()];
  const persons = [];

  // Fetch in batches to avoid URL length limits
  for (const id of personIds) {
    const data = await apiRequest(`/persons/${id}`);
    if (data.data) persons.push(data.data);
  }

  // 3. Build contacts with stage resolution via pipedrive-ids
  return persons.map(person => {
    const deal = personDealMap.get(person.id);
    const stageKey = config.getStageKeyByPipedriveId(deal?.stage_id) || 'initial_outreach';

    // Extract custom deal fields
    const dataRoomAccessKey = getDealFieldKey('Data Room Access');
    const paulMeetingDateKey = getDealFieldKey('Paul Meeting Date');

    return normalizeContact({
      id: person.id,
      name: person.name,
      emails: person.emails || [],
      org_name: person.org_name || '',
      label: person.label || '',
      notes: person.notes || '',
      last_activity_date: person.last_activity_date || null,
      next_activity_date: person.next_activity_date || null,
      stage: stageKey,
      deal_id: deal?.id || null,
      deal_value: deal?.value || null,
      // Pass through all raw fields for custom field extraction
      ...person,
      dataRoomAccess: dataRoomAccessKey && deal ? deal[dataRoomAccessKey] : null,
      paulMeetingDate: paulMeetingDateKey && deal ? deal[paulMeetingDateKey] : null,
    });
  }).filter(c => c.email);
}

/**
 * Load contacts from a CSV export file.
 * @returns {Object[]}
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
  return rows.map(normalizeContact).filter(c => c.email);
}

// ── Write Operations ─────────────────────────────────

/**
 * Update a deal's stage in Pipedrive.
 * @param {number} dealId
 * @param {number} stageId - Pipedrive stage ID
 * @returns {Promise<void>}
 */
async function updateDealStage(dealId, stageId) {
  await apiRequest(`/deals/${dealId}`, {
    method: 'PATCH',
    body: { stage_id: stageId },
  });
}

/**
 * Update a custom field on a person record.
 * @param {string|number} personId
 * @param {string} fieldName - Human-readable field name
 * @param {*} value
 * @returns {Promise<void>}
 */
async function updatePersonField(personId, fieldName, value) {
  const key = getPersonFieldKey(fieldName);
  if (!key) {
    // Field doesn't exist in Pipedrive - this is not an error, just skip silently.
    // The warning is already logged during field discovery.
    return;
  }

  // Use v1 API for person updates - v2 rejects custom field hash keys
  await rateLimit();
  const url = `https://${config.pipedrive.companyDomain}.pipedrive.com/api/v1/persons/${personId}?api_token=${config.pipedrive.apiToken}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    throw new Error(`Pipedrive API error: ${res.status} ${res.statusText} (PUT /persons/${personId}): ${errorBody}`);
  }
}

/**
 * Add an activity note to a deal for audit trail.
 * @param {number} dealId
 * @param {string} text
 * @returns {Promise<void>}
 */
async function addActivityNote(dealId, text) {
  try {
    await apiRequest('/notes', {
      method: 'POST',
      body: {
        content: text,
        deal_id: dealId,
        pinned_to_deal_flag: false,
      },
    });
  } catch (err) {
    console.warn(`  Failed to add note to deal ${dealId}: ${err.message}`);
  }
}

// ── Public API ───────────────────────────────────────

/**
 * Get all contacts from Pipedrive (API or CSV fallback).
 * @returns {Promise<Object[]>}
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

// Bundle write operations for external use
export const pipedriveWriter = {
  updateDealStage,
  updatePersonField,
  addActivityNote,
};
