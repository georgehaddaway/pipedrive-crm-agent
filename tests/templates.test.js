import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENDER_NAME = 'Test Sender';
process.env.SENDER_EMAIL = 'test@example.com';
process.env.FUND_NAME = 'Apex Growth Fund';

const { renderEmail } = await import('../src/engine/templates.js');

describe('Template Engine', () => {
  it('renders initial_outreach template with all fields', async () => {
    const followUp = makeFollowUp({
      templateName: 'initial_outreach',
      contact: {
        firstName: 'Sarah',
        lastName: 'Chen',
        email: 'sarah@test.com',
        company: 'Meridian Capital',
        stage: 'initial_outreach',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(subject.includes('Apex Growth Fund'));
    assert.ok(body.includes('Sarah'));
    assert.ok(body.includes('Meridian Capital'));
    assert.ok(body.includes('Test Sender'));
  });

  it('renders meeting_followup template with meeting date', async () => {
    const followUp = makeFollowUp({
      templateName: 'meeting_followup',
      contact: {
        firstName: 'James',
        lastName: 'R',
        email: 'james@test.com',
        stage: 'meeting_scheduled',
        meta: { meetingDate: 'March 15, 2026' },
      },
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('James'));
    assert.ok(body.includes('March 15, 2026'));
  });

  it('renders due_diligence template with pending documents', async () => {
    const followUp = makeFollowUp({
      templateName: 'due_diligence',
      contact: {
        firstName: 'Priya',
        lastName: 'Patel',
        email: 'priya@test.com',
        stage: 'due_diligence',
        meta: { pendingDocuments: ['Track record report', 'Audited financials'] },
      },
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('Priya'));
    assert.ok(body.includes('Track record report'));
    assert.ok(body.includes('Audited financials'));
  });

  it('renders negotiation template with deadline', async () => {
    const followUp = makeFollowUp({
      templateName: 'negotiation',
      contact: {
        firstName: 'Michael',
        lastName: "O'Brien",
        email: 'michael@test.com',
        company: 'Lakefront Wealth',
        stage: 'negotiation',
        meta: {
          lastDiscussionPoint: 'allocation size',
          deadline: 'March 20, 2026',
        },
      },
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('Michael'));
    assert.ok(body.includes('allocation size'));
    assert.ok(body.includes('March 20, 2026'));
  });

  it('handles missing optional fields gracefully', async () => {
    const followUp = makeFollowUp({
      templateName: 'initial_outreach',
      contact: {
        firstName: 'Test',
        lastName: 'User',
        email: 'test@test.com',
        company: '', // no company
        stage: 'initial_outreach',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(subject);
    assert.ok(body);
    assert.ok(!body.includes('undefined'));
    assert.ok(!body.includes('null'));
  });

  it('throws on unknown template name', async () => {
    const followUp = makeFollowUp({
      templateName: 'nonexistent_template',
      contact: {
        firstName: 'Test',
        email: 'test@test.com',
        stage: 'initial_outreach',
      },
    });

    await assert.rejects(() => renderEmail(followUp), /not found/);
  });
});

// ── Helpers ─────────────────────────────────────────

function makeFollowUp(overrides = {}) {
  const contact = {
    id: '1',
    firstName: 'Test',
    lastName: 'User',
    email: 'test@example.com',
    company: '',
    stage: 'initial_outreach',
    priority: 'medium',
    tags: [],
    lastContactDate: null,
    notes: '',
    meta: {},
    ...(overrides.contact || {}),
  };

  return {
    contact,
    reason: 'Test follow-up',
    daysSinceLastContact: 5,
    urgencyScore: 5,
    templateName: overrides.templateName || 'initial_outreach',
    attemptNumber: 1,
  };
}
