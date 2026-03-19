import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENDER_NAME = 'Test Sender';
process.env.SENDER_EMAIL = 'test@example.com';
process.env.FUND_NAME = 'Apex Growth Fund';

const { renderEmail } = await import('../src/templates/router.js');

describe('Template Router', () => {
  it('renders initial-cold template by default', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Sarah',
        lastName: 'Chen',
        email: 'sarah@test.com',
        company: 'Meridian Capital',
        stage: 'initial_outreach',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(subject, 'Subject should not be empty');
    assert.ok(body.includes('Sarah'));
    assert.ok(body.includes('Test Sender'));
  });

  it('renders initial-warm-intro when lead source is warm_intro', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'James',
        lastName: 'R',
        email: 'james@test.com',
        stage: 'initial_outreach',
        leadSource: 'warm_intro',
      },
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('James'));
    assert.ok(body.includes('mutual connection'));
  });

  it('renders initial-conference when lead source is conference_meeting', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Priya',
        email: 'priya@test.com',
        stage: 'initial_outreach',
        leadSource: 'conference_meeting',
      },
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('Priya'));
    assert.ok(body.includes('conference'));
  });

  it('renders followup-performance-hook for attempt 1', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Test',
        email: 'test@test.com',
        stage: 'follow_up',
      },
      attemptNumber: 1,
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('performance') || body.includes('returns') || body.includes('data point'));
  });

  it('renders followup-comparison-hook for attempt 2', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Test',
        email: 'test@test.com',
        stage: 'follow_up',
      },
      attemptNumber: 2,
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('compare') || body.includes('Compare') || body.includes('differentiation'));
  });

  it('renders breakup template', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'David',
        email: 'david@test.com',
        stage: 'breakup',
      },
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('David'));
    assert.ok(body.includes('close') || body.includes('closing'));
  });

  it('renders engaged-nudge as default engaged template', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Lisa',
        email: 'lisa@test.com',
        stage: 'engaged',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(subject);
    assert.ok(body.includes('Lisa'));
  });

  it('renders dd-data-room template for due diligence', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Mark',
        email: 'mark@test.com',
        stage: 'due_diligence',
      },
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('Mark'));
    assert.ok(body.includes('data room') || body.includes('Data Room'));
  });

  it('renders on-hold-quarterly template', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Anne',
        email: 'anne@test.com',
        stage: 'on_hold',
      },
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('Anne'));
    assert.ok(body.includes('quarter') || body.includes('update') || body.includes('while'));
  });

  it('renders post-meeting-feedback for attempt 1', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Tom',
        email: 'tom@test.com',
        stage: 'post_meeting',
        meta: { meetingDate: 'March 15, 2026' },
      },
      attemptNumber: 1,
    });

    const { body } = await renderEmail(followUp);
    assert.ok(body.includes('Tom'));
    assert.ok(body.includes('feedback') || body.includes('thoughts'));
  });

  it('handles missing optional fields gracefully', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Test',
        lastName: 'User',
        email: 'test@test.com',
        company: '',
        stage: 'initial_outreach',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(subject);
    assert.ok(body);
    assert.ok(!body.includes('undefined'));
    assert.ok(!body.includes('null'));
  });

  it('throws on unknown stage with no template', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Test',
        email: 'test@test.com',
        stage: 'nonexistent_stage',
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
    leadSource: null,
    introducerPersonId: null,
    outreachAttempts: 0,
    investorType: null,
    dataRoomAccess: null,
    meta: {},
    ...(overrides.contact || {}),
  };

  return {
    contact,
    reason: 'Test follow-up',
    daysSinceLastContact: 5,
    urgencyScore: 0.5,
    templateName: contact.stage,
    attemptNumber: overrides.attemptNumber || 1,
    stageConfig: null,
  };
}
