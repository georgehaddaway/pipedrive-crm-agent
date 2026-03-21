import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.SENDER_NAME = 'James';
process.env.SENDER_EMAIL = 'test@example.com';
process.env.FUND_NAME = 'Satori Power';
process.env.ANTHROPIC_API_KEY = '';

const { renderEmail } = await import('../src/templates/router.js');

describe('Template Router', () => {
  it('renders initial-cold template with data hooks', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Sarah',
        lastName: 'Chen',
        email: 'sarah@test.com',
        company: 'Meridian Capital',
        stage: 'follow_up_2',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(subject, 'Subject should not be empty');
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('Sarah'));
    assert.ok(body.includes('Take care'));
    assert.ok(!body.includes('Best,'));
    assert.ok(body.includes('Paul'));
  });

  it('renders initial-warm-intro when lead source is warm_intro', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Alex',
        lastName: 'R',
        email: 'alex@test.com',
        stage: 'follow_up_2',
        leadSource: 'warm_intro',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('Alex'));
    assert.ok(body.includes('Take care'));
  });

  it('renders followup template when lead source is conference_meeting', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Priya',
        email: 'priya@test.com',
        stage: 'follow_up_2',
        leadSource: 'conference_meeting',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('Priya'));
    assert.ok(body.includes('Take care'));
  });

  it('renders followup-performance-hook for attempt 1', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Test',
        email: 'test@test.com',
        stage: 'follow_up_2',
      },
      attemptNumber: 1,
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('EBITDA') || body.includes('returns') || body.includes('performance'));
    assert.ok(body.includes('Take care'));
  });

  it('renders followup-comparison-hook for attempt 2', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Test',
        email: 'test@test.com',
        stage: 'follow_up_2',
      },
      attemptNumber: 2,
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('Nvidia') || body.includes('valuation') || body.includes('dislocation'));
    assert.ok(body.includes('Take care'));
  });

  it('renders breakup template', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'David',
        email: 'david@test.com',
        stage: 'breakup',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('David'));
    assert.ok(body.includes('stop reaching out') || body.includes('update my notes'));
    assert.ok(body.includes('Take care'));
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
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('Lisa'));
    assert.ok(body.includes('Paul'));
    assert.ok(body.includes('Take care'));
  });

  it('renders dd-data-room template for due diligence', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Mark',
        email: 'mark@test.com',
        stage: 'due_diligence',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('Mark'));
    assert.ok(body.includes('data room') || body.includes('Nicole'));
    assert.ok(body.includes('Take care'));
  });

  it('renders on-hold-quarterly template', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Anne',
        email: 'anne@test.com',
        stage: 'on_hold',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('Anne'));
    assert.ok(body.includes('EBITDA') || body.includes('update') || body.includes('perform'));
    assert.ok(body.includes('Take care'));
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

    const { subject, body } = await renderEmail(followUp);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body.includes('Tom'));
    assert.ok(body.includes('feedback') || body.includes('honest'));
    assert.ok(body.includes('Take care'));
  });

  it('handles missing optional fields gracefully', async () => {
    const followUp = makeFollowUp({
      contact: {
        firstName: 'Test',
        lastName: 'User',
        email: 'test@test.com',
        company: '',
        stage: 'follow_up_2',
      },
    });

    const { subject, body } = await renderEmail(followUp);
    assert.ok(subject);
    assert.ok(!subject.includes('\u2014'), 'Subject should not contain em-dash');
    assert.ok(body);
    assert.ok(!body.includes('undefined'));
    assert.ok(!body.includes('null'));
    assert.ok(body.includes('Take care'));
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

  it('never produces em-dash in any subject line', async () => {
    const stages = [
      'follow_up_2', 'breakup', 'engaged',
      'post_meeting', 'due_diligence', 'on_hold', 'declined_cold',
    ];

    for (const stage of stages) {
      const followUp = makeFollowUp({
        contact: { firstName: 'Test', email: 'test@test.com', stage },
      });
      const { subject } = await renderEmail(followUp);
      assert.ok(!subject.includes('\u2014'), `Stage ${stage} subject contains em-dash: "${subject}"`);
      assert.ok(!subject.includes('\u2013'), `Stage ${stage} subject contains en-dash: "${subject}"`);
      assert.ok(!subject.includes('\u00E2'), `Stage ${stage} subject contains mojibake: "${subject}"`);
    }
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
    stage: 'follow_up_2',
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
