import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STATE_FILE = resolve(ROOT, 'data/deal-states.json');

// Set up env before importing modules that depend on config
process.env.SENDER_NAME = 'Test Sender';
process.env.SENDER_EMAIL = 'test@example.com';
process.env.FUND_NAME = 'Test Fund';

const { loadPreviousDealStates, saveDealStates, detectDealChanges } = await import('../src/rules/deal-state.js');

// Backup and restore the state file around tests
let originalState = null;

describe('Deal State Tracking', () => {
  beforeEach(() => {
    if (existsSync(STATE_FILE)) {
      originalState = readFileSync(STATE_FILE, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore original state file
    if (originalState !== null) {
      writeFileSync(STATE_FILE, originalState);
    } else if (existsSync(STATE_FILE)) {
      unlinkSync(STATE_FILE);
    }
    originalState = null;
  });

  it('loadPreviousDealStates returns empty map when file does not exist', () => {
    // Remove state file if it exists
    if (existsSync(STATE_FILE)) {
      unlinkSync(STATE_FILE);
    }
    const states = loadPreviousDealStates();
    assert.ok(states instanceof Map);
    assert.equal(states.size, 0);
  });

  it('saveDealStates writes state file and loadPreviousDealStates reads it', () => {
    const contacts = [
      makeContact({ id: '100', stage: 'follow_up_1', email: 'a@test.com', meta: { dealId: 501 } }),
      makeContact({ id: '200', stage: 'engaged', email: 'b@test.com', meta: { dealId: 502 } }),
    ];

    saveDealStates(contacts);
    assert.ok(existsSync(STATE_FILE));

    const loaded = loadPreviousDealStates();
    assert.equal(loaded.size, 2);
    assert.equal(loaded.get('501').stageKey, 'follow_up_1');
    assert.equal(loaded.get('502').stageKey, 'engaged');
  });

  it('detectDealChanges identifies new deals', () => {
    const previous = new Map();
    const contacts = [
      makeContact({ stage: 'follow_up_1', meta: { dealId: 601 } }),
    ];

    const { newDeals, stageChanges } = detectDealChanges(contacts, previous);
    assert.equal(newDeals.length, 1);
    assert.equal(stageChanges.length, 0);
    assert.equal(newDeals[0].meta.dealId, 601);
  });

  it('detectDealChanges identifies stage changes', () => {
    const previous = new Map([
      ['701', { stageKey: 'follow_up_1', email: 'c@test.com' }],
    ]);
    const contacts = [
      makeContact({ stage: 'engaged', email: 'c@test.com', meta: { dealId: 701 } }),
    ];

    const { newDeals, stageChanges } = detectDealChanges(contacts, previous);
    assert.equal(newDeals.length, 0);
    assert.equal(stageChanges.length, 1);
    assert.equal(stageChanges[0].fromStage, 'follow_up_1');
    assert.equal(stageChanges[0].toStage, 'engaged');
  });

  it('detectDealChanges returns no changes when state matches', () => {
    const previous = new Map([
      ['801', { stageKey: 'engaged', email: 'd@test.com' }],
    ]);
    const contacts = [
      makeContact({ stage: 'engaged', email: 'd@test.com', meta: { dealId: 801 } }),
    ];

    const { newDeals, stageChanges } = detectDealChanges(contacts, previous);
    assert.equal(newDeals.length, 0);
    assert.equal(stageChanges.length, 0);
  });

  it('skips contacts without a dealId', () => {
    const previous = new Map();
    const contacts = [
      makeContact({ stage: 'follow_up_1', meta: {} }),
    ];

    const { newDeals, stageChanges } = detectDealChanges(contacts, previous);
    assert.equal(newDeals.length, 0);
    assert.equal(stageChanges.length, 0);
  });
});

// ── Helpers ─────────────────────────────────────────

function makeContact(overrides = {}) {
  return {
    id: overrides.id || String(Math.random()).slice(2, 8),
    firstName: overrides.firstName || 'Test',
    lastName: overrides.lastName || 'User',
    email: overrides.email || 'test@example.com',
    company: overrides.company || 'Test Corp',
    stage: overrides.stage || 'follow_up_1',
    priority: overrides.priority || 'medium',
    tags: overrides.tags || [],
    lastContactDate: overrides.lastContactDate || null,
    notes: overrides.notes || '',
    leadSource: overrides.leadSource || null,
    introducerPersonId: overrides.introducerPersonId || null,
    lastOutboundDate: overrides.lastOutboundDate || null,
    lastInboundDate: overrides.lastInboundDate || null,
    outreachAttempts: overrides.outreachAttempts || 0,
    investorType: overrides.investorType || null,
    dataRoomAccess: overrides.dataRoomAccess || null,
    emailBounced: overrides.emailBounced || false,
    meta: overrides.meta || {},
  };
}
