import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We need to set up env before importing modules that depend on config
process.env.SENDER_NAME = 'Test Sender';
process.env.SENDER_EMAIL = 'test@example.com';
process.env.FUND_NAME = 'Test Fund';

const { evaluateContacts } = await import('../src/engine/rules.js');

describe('Rules Engine', () => {
  /** @type {Map<string, string|null>} */
  let emptyGmail;

  beforeEach(() => {
    emptyGmail = new Map();
  });

  it('flags a contact overdue by stage threshold', () => {
    const contacts = [
      makeContact({
        email: 'overdue@test.com',
        stage: 'initial_outreach',
        priority: 'medium',
        lastContactDate: daysAgo(6), // threshold is 3, clearly overdue
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 1);
    assert.equal(result[0].contact.email, 'overdue@test.com');
    assert.ok(result[0].daysSinceLastContact >= 4);
  });

  it('does NOT flag a contact within threshold', () => {
    const contacts = [
      makeContact({
        email: 'recent@test.com',
        stage: 'initial_outreach',
        priority: 'medium',
        lastContactDate: daysAgo(1), // threshold is 3
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('applies high priority multiplier (halves threshold)', () => {
    const contacts = [
      makeContact({
        email: 'high-pri@test.com',
        stage: 'meeting_scheduled', // threshold 7, high = 7 * 0.5 = 3.5 -> 4
        priority: 'high',
        lastContactDate: daysAgo(6), // 6 days clearly exceeds adjusted threshold of ~4
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 1);
  });

  it('applies low priority multiplier (doubles threshold)', () => {
    const contacts = [
      makeContact({
        email: 'low-pri@test.com',
        stage: 'initial_outreach', // threshold 3, low = 3 * 2 = 6
        priority: 'low',
        lastContactDate: daysAgo(4), // 4 < 6 -> not overdue
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('skips contacts in closed stage', () => {
    const contacts = [
      makeContact({
        email: 'closed@test.com',
        stage: 'closed',
        priority: 'high',
        lastContactDate: daysAgo(100),
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('skips contacts with do-not-contact tag', () => {
    const contacts = [
      makeContact({
        email: 'dnc@test.com',
        stage: 'initial_outreach',
        priority: 'high',
        lastContactDate: daysAgo(30),
        tags: ['do-not-contact'],
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('flags contacts with no last contact date', () => {
    const contacts = [
      makeContact({
        email: 'never@test.com',
        stage: 'initial_outreach',
        priority: 'medium',
        lastContactDate: null,
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 1);
    assert.ok(result[0].reason.includes('Never contacted'));
  });

  it('prefers Gmail date over CRM date', () => {
    const contacts = [
      makeContact({
        email: 'gmail-pref@test.com',
        stage: 'initial_outreach',
        priority: 'medium',
        lastContactDate: daysAgo(10), // CRM says 10 days ago (overdue)
      }),
    ];

    // Gmail says we emailed them yesterday (not overdue)
    const gmailActivity = new Map([['gmail-pref@test.com', daysAgo(1)]]);

    const result = evaluateContacts(contacts, gmailActivity);
    assert.equal(result.length, 0);
  });

  it('sorts results by urgency score descending', () => {
    const contacts = [
      makeContact({
        email: 'low-urgency@test.com',
        stage: 'initial_outreach',
        priority: 'low',
        lastContactDate: daysAgo(10),
      }),
      makeContact({
        email: 'high-urgency@test.com',
        stage: 'initial_outreach',
        priority: 'high',
        lastContactDate: daysAgo(10),
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 2);
    assert.ok(result[0].urgencyScore >= result[1].urgencyScore);
    assert.equal(result[0].contact.email, 'high-urgency@test.com');
  });
});

// ── Helpers ─────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function makeContact(overrides = {}) {
  return {
    id: overrides.id || String(Math.random()).slice(2, 8),
    firstName: overrides.firstName || 'Test',
    lastName: overrides.lastName || 'User',
    email: overrides.email || 'test@example.com',
    company: overrides.company || 'Test Corp',
    stage: overrides.stage || 'initial_outreach',
    priority: overrides.priority || 'medium',
    tags: overrides.tags || [],
    lastContactDate: overrides.lastContactDate || null,
    notes: overrides.notes || '',
    meta: overrides.meta || {},
  };
}
