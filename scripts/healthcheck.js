#!/usr/bin/env node

/**
 * Healthcheck - Quick pass/fail connectivity check for all integrations.
 *
 * Usage: node scripts/healthcheck.js
 *        npm run healthcheck
 *
 * Does NOT create drafts, update Pipedrive, or post to Slack.
 * Safe to run at any time.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load env
import { config as loadEnv } from 'dotenv';
loadEnv({ path: resolve(ROOT, '.env') });

const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

function pass(name) {
  return `  \x1b[32m✓\x1b[0m ${name}`;
}
function fail(name, err) {
  return `  \x1b[31m✗\x1b[0m ${name}: ${err}`;
}
function skip(name, reason) {
  return `  \x1b[33m-\x1b[0m ${name}: ${reason}`;
}

// ── Checks ──────────────────────────────────────────

check('Node.js >= 20', async () => {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) throw new Error(`Node ${process.versions.node} (need >= 20)`);
});

check('.env loaded', async () => {
  if (!process.env.PIPEDRIVE_API_TOKEN) throw new Error('PIPEDRIVE_API_TOKEN not set');
  if (!process.env.SENDER_EMAIL) throw new Error('SENDER_EMAIL not set');
});

check('Config files', async () => {
  const files = [
    'config/follow-up-rules.json',
    'config/pipedrive-fields.json',
    'config/pipedrive-ids.json',
    'config/pipeline-stages.json',
    'config/template-mapping.json',
  ];
  for (const f of files) {
    const p = resolve(ROOT, f);
    if (!existsSync(p)) throw new Error(`Missing: ${f}`);
    JSON.parse(readFileSync(p, 'utf-8'));
  }
});

check('Templates', async () => {
  const { readdirSync } = await import('fs');
  const dir = resolve(ROOT, 'src/templates/emails');
  const templates = readdirSync(dir).filter(f => f.endsWith('.hbs'));
  if (templates.length === 0) throw new Error('No .hbs templates found');
});

check('Voice profile', async () => {
  const vpPath = resolve(ROOT, 'config/voice-profile.json');
  if (!existsSync(vpPath)) throw new Error('Not found (optional, voice polish disabled)');
  const vp = JSON.parse(readFileSync(vpPath, 'utf-8'));
  if (!vp.sender) throw new Error('Missing "sender" field');
});

check('Pipedrive API', async () => {
  const token = process.env.PIPEDRIVE_API_TOKEN;
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  const res = await fetch(`https://${domain}.pipedrive.com/api/v1/users/me?api_token=${token}`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.data?.name) throw new Error('Invalid response');
});

check('Gmail OAuth', async () => {
  const tokenPath = resolve(ROOT, 'data/gmail-token.json');
  if (!existsSync(tokenPath)) throw new Error('Token file missing');

  const { google } = await import('googleapis');
  const tokenData = JSON.parse(readFileSync(tokenPath, 'utf-8'));
  if (!tokenData.refresh_token) throw new Error('Missing refresh_token');

  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
  );
  oauth2.setCredentials(tokenData);

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  if (profile.status !== 200) throw new Error(`HTTP ${profile.status}`);
});

check('Anthropic API', async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set (optional)');

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
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Reply OK' }],
    }),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} (model: ${model}) - ${body.slice(0, 100)}`);
  }
});

check('Slack webhook', async () => {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) throw new Error('SLACK_WEBHOOK_URL not set (optional)');
  // Validate URL format without posting
  try {
    new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }
  // HEAD request to verify endpoint exists
  const res = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  // Slack returns 400 for empty payload but that still proves the endpoint is reachable
  if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
});

// ── Run all checks ──────────────────────────────────

async function run() {
  console.log('\n  Pipedrive CRM Agent - Healthcheck\n');

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const { name, fn } of checks) {
    try {
      await fn();
      results.push(pass(name));
      passed++;
    } catch (err) {
      results.push(fail(name, err.message));
      failed++;
    }
  }

  for (const r of results) console.log(r);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Healthcheck crashed:', err.message);
  process.exit(1);
});
