import { readFileSync, existsSync } from 'fs';
import config from '../config.js';

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

/**
 * Normalize a raw CSV/API row into a standard Contact shape.
 * Handles common CSV column name variations.
 * @param {Object} raw
 * @returns {import('./types.js').Contact}
 */
function normalizeContact(raw) {
  return {
    id: raw.id || raw.contact_id || raw.ID || String(Math.random()).slice(2, 10),
    firstName: raw.firstName || raw.first_name || raw['First Name'] || '',
    lastName: raw.lastName || raw.last_name || raw['Last Name'] || '',
    email: raw.email || raw.Email || raw.email_address || '',
    company: raw.company || raw.Company || raw.organization || '',
    stage: normalizeStage(raw.stage || raw.Stage || raw.pipeline_stage || 'initial_outreach'),
    priority: normalizePriority(raw.priority || raw.Priority || 'medium'),
    tags: parseTags(raw.tags || raw.Tags || ''),
    lastContactDate: raw.lastContactDate || raw.last_contact_date || raw['Last Contact'] || null,
    notes: raw.notes || raw.Notes || '',
    meta: {
      meetingDate: raw.meetingDate || raw.meeting_date || raw['Meeting Date'] || null,
      agenda: raw.agenda || raw.Agenda || null,
      pendingDocuments: parseTags(raw.pendingDocuments || raw.pending_documents || ''),
      lastDiscussionPoint: raw.lastDiscussionPoint || raw.last_discussion_point || null,
      deadline: raw.deadline || raw.Deadline || null,
    },
  };
}

/**
 * @param {string} stage
 * @returns {string}
 */
function normalizeStage(stage) {
  const key = stage.toLowerCase().replace(/[\s-]+/g, '_');
  const validStages = Object.keys(config.rules.stages);
  if (validStages.includes(key)) return key;
  // Fuzzy match: find a stage that starts with or contains the key
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
 * Fetch contacts from JSQ REST API.
 * Placeholder implementation - fill in actual endpoints once API docs are available.
 * @returns {Promise<import('./types.js').Contact[]>}
 */
async function fetchContactsFromAPI() {
  const { apiBaseUrl, apiKey } = config.jsq;

  const res = await fetch(`${apiBaseUrl}/contacts`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`JSQ API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  // Adapt this based on actual API response shape
  const rawContacts = data.results || data.contacts || data.data || data;
  if (!Array.isArray(rawContacts)) {
    throw new Error(`Unexpected JSQ API response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }

  return rawContacts.map(normalizeContact);
}

// ── CSV Fallback ────────────────────────────────────

/**
 * Load contacts from a CSV export file.
 * @returns {import('./types.js').Contact[]}
 */
function loadContactsFromCSV() {
  const csvPath = config.jsq.csvPath;
  if (!existsSync(csvPath)) {
    throw new Error(
      `No JSQ API configured and CSV file not found at ${csvPath}.\n` +
      `Either set JSQ_API_BASE_URL + JSQ_API_KEY in .env, or export contacts ` +
      `from Juniper Square and save to data/jsq-export.csv`
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
 * Get all contacts from JSQ (API or CSV fallback).
 * @returns {Promise<import('./types.js').Contact[]>}
 */
export async function getContacts() {
  if (config.jsq.useApi) {
    console.log('Fetching contacts from JSQ API...');
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
  return config.jsq.useApi ? 'jsq-api' : 'csv-fallback';
}
