import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Set up env before importing modules that depend on config
process.env.SENDER_NAME = 'Test Sender';
process.env.SENDER_EMAIL = 'test@example.com';
process.env.FUND_NAME = 'Test Fund';

const { evaluateContacts, detectStaleContacts } = await import('../src/rules/engine.js');

describe('Rules Engine (9-stage)', () => {
  /** @type {Map<string, string|null>} */
  let emptyGmail;

  beforeEach(() => {
    emptyGmail = new Map();
  });

  it('flags a contact overdue by stage threshold (initial_outreach = 4 days)', () => {
    const contacts = [
      makeContact({
        email: 'overdue@test.com',
        stage: 'initial_outreach',
        priority: 'medium',
        lastContactDate: daysAgo(15),
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 1);
    assert.equal(result[0].contact.email, 'overdue@test.com');
  });

  it('does NOT flag a contact within threshold', () => {
    const contacts = [
      makeContact({
        email: 'recent@test.com',
        stage: 'initial_outreach',
        priority: 'medium',
        lastContactDate: daysAgo(2),
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('skips contacts in committed stage (excluded stage)', () => {
    const contacts = [
      makeContact({
        email: 'committed@test.com',
        stage: 'committed',
        priority: 'high',
        lastContactDate: daysAgo(100),
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('skips contacts with excluded tags', () => {
    const contacts = [
      makeContact({
        email: 'dnc@test.com',
        stage: 'initial_outreach',
        lastContactDate: daysAgo(30),
        tags: ['do-not-contact'],
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('skips contacts with legal-hold tag', () => {
    const contacts = [
      makeContact({
        email: 'legal@test.com',
        stage: 'follow_up',
        lastContactDate: daysAgo(30),
        tags: ['legal-hold'],
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('flags contacts with no last contact date (never contacted)', () => {
    const contacts = [
      makeContact({
        email: 'never@test.com',
        stage: 'engaged',
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
        lastContactDate: daysAgo(10),
      }),
    ];

    const gmailActivity = new Map([['gmail-pref@test.com', daysAgo(1)]]);

    const result = evaluateContacts(contacts, gmailActivity);
    assert.equal(result.length, 0);
  });

  it('sorts results by urgency score descending', () => {
    const contacts = [
      makeContact({
        email: 'low-urgency@test.com',
        stage: 'post_meeting',
        priority: 'low',
        lastContactDate: daysAgo(15),
      }),
      makeContact({
        email: 'high-urgency@test.com',
        stage: 'post_meeting',
        priority: 'high',
        lastContactDate: daysAgo(15),
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 2);
    assert.ok(result[0].urgencyScore >= result[1].urgencyScore);
    assert.equal(result[0].contact.email, 'high-urgency@test.com');
  });

  it('respects max_drafts_per_run cap', () => {
    // Create more contacts than the cap (15)
    const contacts = [];
    for (let i = 0; i < 20; i++) {
      contacts.push(makeContact({
        email: `contact${i}@test.com`,
        stage: 'follow_up',
        priority: 'high',
        lastContactDate: daysAgo(10),
      }));
    }

    const result = evaluateContacts(contacts, emptyGmail);
    assert.ok(result.length <= 15, `Expected <= 15 drafts, got ${result.length}`);
  });

  it('skips contacts who have exhausted attempt limits', () => {
    const contacts = [
      makeContact({
        email: 'maxed@test.com',
        stage: 'initial_outreach',
        lastContactDate: daysAgo(10),
        outreachAttempts: 1, // limit for initial_outreach is 1
      }),
    ];

    const result = evaluateContacts(contacts, emptyGmail);
    assert.equal(result.length, 0);
  });

  it('scores warm_intro higher than cold_email at the same stage', () => {
    const warm = makeContact({
      email: 'warm@test.com',
      stage: 'follow_up',
      leadSource: 'warm_intro',
      lastContactDate: daysAgo(20),
    });
    const cold = makeContact({
      email: 'cold@test.com',
      stage: 'follow_up',
      leadSource: 'cold_email',
      lastContactDate: daysAgo(20),
    });

    const result = evaluateContacts([warm, cold], emptyGmail);
    assert.equal(result.length, 2);

    const warmResult = result.find(r => r.contact.email === 'warm@test.com');
    const coldResult = result.find(r => r.contact.email === 'cold@test.com');
    assert.ok(warmResult.urgencyScore > coldResult.urgencyScore,
      `warm_intro (${warmResult.urgencyScore}) should score higher than cold_email (${coldResult.urgencyScore})`);
  });

  it('weights due_diligence stage higher than initial_outreach', () => {
    const dd = makeContact({
      email: 'dd@test.com',
      stage: 'due_diligence',
      lastContactDate: daysAgo(15),
    });
    const initial = makeContact({
      email: 'initial@test.com',
      stage: 'initial_outreach',
      lastContactDate: daysAgo(15),
    });

    const result = evaluateContacts([dd, initial], emptyGmail);
    assert.equal(result.length, 2);

    const ddResult = result.find(r => r.contact.email === 'dd@test.com');
    const initialResult = result.find(r => r.contact.email === 'initial@test.com');
    assert.ok(ddResult.urgencyScore > initialResult.urgencyScore,
      `due_diligence (${ddResult.urgencyScore}) should score higher than initial_outreach (${initialResult.urgencyScore})`);
  });

  it('handles all 9 stages without error', () => {
    const stages = [
      'initial_outreach', 'follow_up', 'breakup', 'engaged',
      'post_meeting', 'due_diligence', 'committed', 'on_hold', 'declined_cold'
    ];

    const contacts = stages.map(stage => makeContact({
      email: `${stage}@test.com`,
      stage,
      lastContactDate: daysAgo(400), // very overdue for all
    }));

    // Should not throw
    const result = evaluateContacts(contacts, emptyGmail);
    assert.ok(Array.isArray(result));
    // committed is excluded, all others should appear if overdue
    assert.ok(!result.find(r => r.contact.stage === 'committed'));
  });
});

describe('Stale Contact Detection', () => {
  it('flags contacts with no activity in 180+ days in active stages', () => {
    const contacts = [
      makeContact({
        email: 'stale@test.com',
        stage: 'engaged',
        lastContactDate: daysAgo(200),
      }),
    ];

    const flags = detectStaleContacts(contacts);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].flag.id, 'stale_contact');
  });

  it('does not flag contacts in non-active stages', () => {
    const contacts = [
      makeContact({
        email: 'committed@test.com',
        stage: 'committed',
        lastContactDate: daysAgo(200),
      }),
    ];

    const flags = detectStaleContacts(contacts);
    assert.equal(flags.length, 0);
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
