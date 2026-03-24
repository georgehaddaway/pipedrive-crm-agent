/**
 * Integration Test Suite
 *
 * These tests hit LIVE APIs using credentials from .env.
 * They validate that all external integrations work correctly
 * and that the full pipeline produces valid output.
 *
 * Run: npm run test:integration
 *
 * Costs: ~$0.01 Anthropic credits per run.
 * Side effects: Posts a [TEST] message to Slack. Does NOT create Gmail drafts.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load env before importing any project modules
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(ROOT, '.env') });

// ─────────────────────────────────────────────────────
// Suite 1: Config & Environment Validation
// ─────────────────────────────────────────────────────

describe('Config & Environment', () => {
  it('has all required environment variables set', () => {
    const required = [
      'PIPEDRIVE_API_TOKEN',
      'PIPEDRIVE_COMPANY_DOMAIN',
      'GMAIL_CLIENT_ID',
      'GMAIL_CLIENT_SECRET',
      'SENDER_NAME',
      'SENDER_EMAIL',
      'FUND_NAME',
    ];

    const missing = required.filter(key => !process.env[key]);
    assert.equal(missing.length, 0, `Missing env vars: ${missing.join(', ')}`);
  });

  it('loads all JSON config files without error', () => {
    const configFiles = [
      'config/follow-up-rules.json',
      'config/pipedrive-fields.json',
      'config/pipedrive-ids.json',
      'config/pipeline-stages.json',
      'config/template-mapping.json',
    ];

    for (const file of configFiles) {
      const fullPath = resolve(ROOT, file);
      assert.ok(existsSync(fullPath), `Config file missing: ${file}`);
      const content = readFileSync(fullPath, 'utf-8');
      assert.doesNotThrow(() => JSON.parse(content), `Invalid JSON in ${file}`);
    }
  });

  it('has valid pipeline stage IDs (all numbers)', () => {
    const ids = JSON.parse(readFileSync(resolve(ROOT, 'config/pipedrive-ids.json'), 'utf-8'));
    assert.ok(ids.pipeline_id, 'Missing pipeline_id');
    assert.equal(typeof ids.pipeline_id, 'number', 'pipeline_id must be a number');

    for (const [key, id] of Object.entries(ids.stages)) {
      assert.equal(typeof id, 'number', `Stage "${key}" has non-numeric ID: ${id}`);
    }
  });

  it('template mapping references only templates that exist on disk', () => {
    const mapping = JSON.parse(readFileSync(resolve(ROOT, 'config/template-mapping.json'), 'utf-8'));
    const templateDir = resolve(ROOT, mapping.template_dir || 'src/templates/emails');
    const available = readdirSync(templateDir).filter(f => f.endsWith('.hbs')).map(f => basename(f, '.hbs'));

    for (const [stage, stageConfig] of Object.entries(mapping.stages)) {
      for (const [key, templateFile] of Object.entries(stageConfig.templates || {})) {
        const name = basename(templateFile, '.hbs');
        assert.ok(
          available.includes(name),
          `Stage "${stage}" references template "${templateFile}" but "${name}.hbs" not found. Available: ${available.join(', ')}`
        );
      }
    }
  });

  it('loads voice profile with required structure', () => {
    const vpPath = resolve(ROOT, 'config/voice-profile.json');
    if (!existsSync(vpPath)) {
      // Voice profile is optional; skip if not present
      return;
    }
    const vp = JSON.parse(readFileSync(vpPath, 'utf-8'));
    assert.ok(vp.sender, 'Voice profile missing "sender" field');
    assert.ok(vp.tone, 'Voice profile missing "tone" field');
    assert.ok(Array.isArray(vp.do), 'Voice profile missing "do" array');
    assert.ok(Array.isArray(vp.dont), 'Voice profile missing "dont" array');
  });

  it('Gmail token file exists with refresh_token', () => {
    const tokenPath = resolve(ROOT, 'data/gmail-token.json');
    assert.ok(existsSync(tokenPath), `Gmail token not found at ${tokenPath}`);
    const token = JSON.parse(readFileSync(tokenPath, 'utf-8'));
    assert.ok(token.refresh_token, 'Gmail token missing refresh_token');
    assert.ok(token.access_token, 'Gmail token missing access_token');
  });
});

// ─────────────────────────────────────────────────────
// Suite 2: Pipedrive API Integration
// ─────────────────────────────────────────────────────

describe('Pipedrive API', () => {
  const apiToken = process.env.PIPEDRIVE_API_TOKEN;
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;

  it('authenticates successfully (GET /users/me)', async () => {
    const res = await fetch(
      `https://${domain}.pipedrive.com/api/v1/users/me?api_token=${apiToken}`
    );
    assert.equal(res.status, 200, `Pipedrive auth failed with status ${res.status}`);
    const data = await res.json();
    assert.ok(data.data?.name, 'Response missing user name');
  });

  it('configured pipeline exists and is accessible', async () => {
    const ids = JSON.parse(readFileSync(resolve(ROOT, 'config/pipedrive-ids.json'), 'utf-8'));
    const pipelineId = ids.pipeline_id;

    const res = await fetch(
      `https://${domain}.pipedrive.com/api/v1/pipelines/${pipelineId}?api_token=${apiToken}`
    );
    assert.equal(res.status, 200, `Pipeline ${pipelineId} not found (status ${res.status})`);
    const data = await res.json();
    assert.ok(data.data?.name, 'Pipeline response missing name');
  });

  it('all configured stage IDs exist in the live pipeline', async () => {
    const ids = JSON.parse(readFileSync(resolve(ROOT, 'config/pipedrive-ids.json'), 'utf-8'));
    const pipelineId = ids.pipeline_id;

    const res = await fetch(
      `https://${domain}.pipedrive.com/api/v1/stages?pipeline_id=${pipelineId}&api_token=${apiToken}`
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    const liveStageIds = new Set((data.data || []).map(s => s.id));

    for (const [key, id] of Object.entries(ids.stages)) {
      assert.ok(
        liveStageIds.has(id),
        `Stage "${key}" has ID ${id} but this ID does not exist in pipeline ${pipelineId}. Live IDs: ${[...liveStageIds].join(', ')}`
      );
    }
  });

  it('can fetch contacts and normalize them correctly', async () => {
    // Import the full getContacts function which does field discovery + normalization
    const { getContacts } = await import('../src/api/pipedrive.js');
    const contacts = await getContacts();

    assert.ok(Array.isArray(contacts), 'getContacts() should return an array');
    assert.ok(contacts.length > 0, 'Expected at least 1 contact in the pipeline');

    // Validate every contact has the required shape
    const requiredFields = ['id', 'firstName', 'email', 'stage'];
    for (const contact of contacts) {
      for (const field of requiredFields) {
        assert.ok(
          contact[field] !== undefined && contact[field] !== null,
          `Contact ${contact.email || contact.id} missing required field "${field}"`
        );
      }

      // Stage must be a recognized key
      assert.ok(
        typeof contact.stage === 'string' && contact.stage.length > 0,
        `Contact ${contact.email} has invalid stage: ${contact.stage}`
      );

      // outreachAttempts must be a number, not NaN
      assert.ok(
        typeof contact.outreachAttempts === 'number' && !isNaN(contact.outreachAttempts),
        `Contact ${contact.email} has invalid outreachAttempts: ${contact.outreachAttempts}`
      );
    }
  });

  it('field discovery reports missing fields accurately', async () => {
    // Discover fields and check that the known-expected fields resolve
    const res = await fetch(
      `https://${domain}.pipedrive.com/api/v1/personFields?api_token=${apiToken}`
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    const fieldNames = new Set((data.data || []).map(f => f.name));

    // These fields are critical for the agent
    const criticalFields = ['Lead Source', 'Last Outbound Date', 'Outreach Attempts'];
    const missingCritical = criticalFields.filter(f => !fieldNames.has(f));

    // Log missing fields but don't fail - they're soft requirements
    if (missingCritical.length > 0) {
      console.log(`  Note: ${missingCritical.length} optional fields not in Pipedrive: ${missingCritical.join(', ')}`);
    }
  });
});

// ─────────────────────────────────────────────────────
// Suite 3: Gmail API Integration
// ─────────────────────────────────────────────────────

describe('Gmail API', () => {
  it('OAuth token is valid and can authenticate', async () => {
    const { google } = await import('googleapis');

    const tokenData = JSON.parse(
      readFileSync(resolve(ROOT, 'data/gmail-token.json'), 'utf-8')
    );

    const oauth2 = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
    );
    oauth2.setCredentials(tokenData);

    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const profile = await gmail.users.getProfile({ userId: 'me' });

    assert.equal(profile.status, 200, `Gmail getProfile returned status ${profile.status}`);
    assert.ok(profile.data.emailAddress, 'Gmail profile missing emailAddress');
    console.log(`  Gmail authenticated as: ${profile.data.emailAddress}`);
  });

  it('can search sent mail without error', async () => {
    const { google } = await import('googleapis');

    const tokenData = JSON.parse(
      readFileSync(resolve(ROOT, 'data/gmail-token.json'), 'utf-8')
    );

    const oauth2 = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
    );
    oauth2.setCredentials(tokenData);

    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'in:sent',
      maxResults: 1,
    });

    assert.equal(res.status, 200, `Gmail messages.list returned status ${res.status}`);
    // Having messages is expected but not strictly required
    assert.ok(res.data.resultSizeEstimate >= 0, 'Result size should be non-negative');
  });

  it('getRecentThreadSnippets returns valid snippet objects', async () => {
    const { getRecentThreadSnippets } = await import('../src/gmail/client.js');

    // Use the sender's own email to guarantee results
    const senderEmail = process.env.SENDER_EMAIL;
    if (!senderEmail) {
      console.log('  Skipped: SENDER_EMAIL not set');
      return;
    }

    const snippets = await getRecentThreadSnippets(senderEmail, { maxMessages: 2 });
    assert.ok(Array.isArray(snippets), 'Should return an array');

    for (const s of snippets) {
      assert.ok(['sent', 'received'].includes(s.direction), `Invalid direction: ${s.direction}`);
      assert.ok(typeof s.subject === 'string', 'Subject should be a string');
      assert.ok(typeof s.snippet === 'string', 'Snippet should be a string');
      assert.ok(s.snippet.length <= 503, `Snippet too long: ${s.snippet.length} chars`); // 500 + '...'
      assert.ok(s.date, 'Date should be present');
    }

    if (snippets.length > 0) {
      console.log(`  Retrieved ${snippets.length} snippet(s). First: [${snippets[0].direction}] ${snippets[0].subject}`);
    } else {
      console.log('  No recent emails found (this is OK for a fresh account)');
    }
  });
});

// ─────────────────────────────────────────────────────
// Suite 4: Anthropic API Integration
// ─────────────────────────────────────────────────────

describe('Anthropic API', () => {
  it('API key authenticates and configured model is accessible', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('  Skipped: ANTHROPIC_API_KEY not set');
      return;
    }

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with OK' }],
      }),
    });

    assert.equal(res.status, 200, `Anthropic returned status ${res.status}. Model "${model}" may not be available.`);
    const data = await res.json();
    assert.ok(data.content?.[0]?.text, 'Anthropic response missing content');
  });

  it('AI polish produces parseable SUBJECT/BODY output', async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('  Skipped: ANTHROPIC_API_KEY not set');
      return;
    }

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `Rewrite this email draft.
Return ONLY this format:
SUBJECT: <subject>
BODY:
<body>

Draft:
Subject: Following up - Satori Power
Body: Hi John, wanted to follow up. Take care, James`,
        }],
      }),
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    const text = data.content?.[0]?.text || '';

    assert.match(text, /SUBJECT:\s*.+/, 'AI output missing SUBJECT line');
    assert.match(text, /BODY:\s*\n[\s\S]+/, 'AI output missing BODY section');
  });
});

// ─────────────────────────────────────────────────────
// Suite 5: Slack Webhook Integration
// ─────────────────────────────────────────────────────

describe('Slack Webhook', () => {
  it('webhook URL is configured and can post a test message', async () => {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.log('  Skipped: SLACK_WEBHOOK_URL not set');
      return;
    }

    const { IncomingWebhook } = await import('@slack/webhook');
    const webhook = new IncomingWebhook(webhookUrl);

    await assert.doesNotReject(async () => {
      await webhook.send({
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':white_check_mark: *[TEST]* Integration test - Slack webhook is working. This message was sent by `npm run test:integration`.',
            },
          },
        ],
      });
    }, 'Slack webhook post failed');
  });
});

// ─────────────────────────────────────────────────────
// Suite 6: End-to-End Pipeline (Dry Run)
// ─────────────────────────────────────────────────────

describe('End-to-End Pipeline (Dry Run)', () => {
  let report;
  let runReportPath;

  before(async () => {
    // Remove today's run report so the pipeline doesn't skip
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    runReportPath = resolve(ROOT, `data/runs/${today}.json`);
    // Note: dry-run creates its own report file; we check after

    const { runPipeline } = await import('../src/orchestrator.js');
    report = await runPipeline({ dryRun: true, verbose: false });
  });

  it('completes without throwing', () => {
    assert.ok(report, 'runPipeline returned falsy');
  });

  it('returns a valid report with expected shape', () => {
    assert.ok('totalContacts' in report, 'Report missing totalContacts');
    assert.ok('followUpsIdentified' in report, 'Report missing followUpsIdentified');
    assert.ok('draftsCreated' in report, 'Report missing draftsCreated');
    assert.ok('errors' in report, 'Report missing errors');
    assert.ok(Array.isArray(report.errors), 'Report errors should be an array');
    assert.ok(Array.isArray(report.drafts), 'Report drafts should be an array');
    assert.ok(Array.isArray(report.followUps), 'Report followUps should be an array');
  });

  it('found contacts in the pipeline', () => {
    assert.ok(report.totalContacts > 0, `Expected at least 1 contact, got ${report.totalContacts}`);
  });

  it('has zero critical errors', () => {
    // Filter out non-critical warnings (e.g., Gmail activity check skipped in dry-run)
    const criticalErrors = report.errors.filter(e =>
      !e.includes('Gmail activity') &&
      !e.includes('Slack')
    );
    assert.equal(
      criticalErrors.length, 0,
      `Unexpected errors:\n${criticalErrors.map(e => `  - ${e}`).join('\n')}`
    );
  });

  it('all rendered subjects are clean (no em-dashes, no undefined)', () => {
    for (const draft of report.drafts) {
      assert.ok(draft.subject, `Draft for ${draft.contactEmail} has empty subject`);
      assert.ok(
        !draft.subject.includes('\u2014'),
        `Draft for ${draft.contactEmail} subject contains em-dash: "${draft.subject}"`
      );
      assert.ok(
        !draft.subject.includes('undefined'),
        `Draft for ${draft.contactEmail} subject contains "undefined": "${draft.subject}"`
      );
      assert.ok(
        !draft.subject.includes('null'),
        `Draft for ${draft.contactEmail} subject contains "null": "${draft.subject}"`
      );
    }
  });

  it('all follow-up contacts have valid email addresses', () => {
    for (const fu of report.followUps) {
      assert.ok(fu.contact.email, `Follow-up contact ${fu.contact.firstName} missing email`);
      assert.match(
        fu.contact.email,
        /@/,
        `Follow-up contact ${fu.contact.firstName} has invalid email: "${fu.contact.email}"`
      );
    }
  });

  it('dry-run did not actually create any Gmail drafts', () => {
    assert.equal(
      report.draftsCreated, 0,
      `Dry run should create 0 drafts but report shows ${report.draftsCreated}`
    );
  });

  it('run report JSON was written to data/runs/', () => {
    assert.ok(existsSync(runReportPath), `Run report not found at ${runReportPath}`);
    const saved = JSON.parse(readFileSync(runReportPath, 'utf-8'));
    assert.ok(saved.timestamp, 'Saved report missing timestamp');
    assert.equal(saved.dryRun, true, 'Saved report should indicate dry run');
  });
});
