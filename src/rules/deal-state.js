import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const STATE_FILE = resolve(ROOT, 'data/deal-states.json');

/**
 * Load the previous run's deal states.
 * Returns an empty map on first run or if the file is corrupted.
 *
 * @returns {Map<string, { stageKey: string, email: string }>} dealId -> state
 */
export function loadPreviousDealStates() {
  if (!existsSync(STATE_FILE)) {
    return new Map();
  }

  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return new Map(Object.entries(raw));
  } catch (err) {
    console.warn(`  Failed to load deal states: ${err.message}. Treating as first run.`);
    return new Map();
  }
}

/**
 * Save the current run's deal states for comparison on the next run.
 *
 * @param {Object[]} contacts - Normalized contacts with meta.dealId and stage
 */
export function saveDealStates(contacts) {
  const states = {};

  for (const contact of contacts) {
    const dealId = contact.meta?.dealId;
    if (!dealId) continue;

    states[String(dealId)] = {
      stageKey: contact.stage,
      email: contact.email,
    };
  }

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(states, null, 2));
}

/**
 * Detect new deals and stage changes by comparing current contacts
 * against the previous run's saved state.
 *
 * @param {Object[]} contacts - Current normalized contacts
 * @param {Map<string, { stageKey: string, email: string }>} previousStates
 * @returns {{ newDeals: Object[], stageChanges: { contact: Object, fromStage: string, toStage: string }[] }}
 */
export function detectDealChanges(contacts, previousStates) {
  const newDeals = [];
  const stageChanges = [];

  for (const contact of contacts) {
    const dealId = String(contact.meta?.dealId);
    if (!dealId || dealId === 'undefined' || dealId === 'null') continue;

    const previous = previousStates.get(dealId);

    if (!previous) {
      // Deal not in previous state = new deal
      newDeals.push(contact);
    } else if (previous.stageKey !== contact.stage) {
      // Stage differs = stage change
      stageChanges.push({
        contact,
        fromStage: previous.stageKey,
        toStage: contact.stage,
      });
    }
  }

  return { newDeals, stageChanges };
}
