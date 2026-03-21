#!/usr/bin/env node

/**
 * Provision missing Pipedrive custom fields.
 *
 * Reads config/pipedrive-fields.json, checks which fields already exist
 * in Pipedrive, and creates any that are missing.
 *
 * Usage: node scripts/setup-fields.js [--dry-run]
 */

import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
loadEnv({ path: resolve(ROOT, '.env') });

const dryRun = process.argv.includes('--dry-run');
const apiToken = process.env.PIPEDRIVE_API_TOKEN;
const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;

if (!apiToken || !domain) {
  console.error('Missing PIPEDRIVE_API_TOKEN or PIPEDRIVE_COMPANY_DOMAIN in .env');
  process.exit(1);
}

const fieldsConfig = JSON.parse(readFileSync(resolve(ROOT, 'config/pipedrive-fields.json'), 'utf-8'));
const baseUrl = `https://${domain}.pipedrive.com/api/v1`;

async function apiGet(endpoint) {
  const res = await fetch(`${baseUrl}${endpoint}?api_token=${apiToken}`);
  if (!res.ok) throw new Error(`GET ${endpoint}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function apiPost(endpoint, body) {
  const res = await fetch(`${baseUrl}${endpoint}?api_token=${apiToken}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${endpoint}: ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

async function run() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Pipedrive Field Provisioning ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(50)}\n`);

  // ── Person Fields ──────────────────────────────
  console.log('Checking person fields...');
  const personData = await apiGet('/personFields');
  const existingPersonFields = new Map();
  for (const f of personData.data || []) {
    existingPersonFields.set(f.name, f);
  }

  let created = 0;
  let skipped = 0;

  for (const [key, fieldDef] of Object.entries(fieldsConfig.person_fields)) {
    const existing = existingPersonFields.get(fieldDef.name);
    if (existing) {
      console.log(`  ✓ ${fieldDef.name} (key: ${existing.key}, type: ${existing.field_type})`);
      skipped++;
      continue;
    }

    console.log(`  ✗ ${fieldDef.name} - MISSING`);

    if (dryRun) {
      console.log(`    [DRY RUN] Would create: type=${fieldDef.field_type}`);
      continue;
    }

    const body = {
      name: fieldDef.name,
      field_type: fieldDef.field_type,
    };

    // Add options for enum/set fields
    if (fieldDef.options && (fieldDef.field_type === 'enum' || fieldDef.field_type === 'set')) {
      body.options = fieldDef.options.map(opt => ({ label: opt }));
    }

    try {
      const result = await apiPost('/personFields', body);
      console.log(`    ✓ Created (key: ${result.data?.key})`);
      created++;
    } catch (err) {
      console.error(`    ✗ Failed: ${err.message}`);
    }
  }

  // ── Deal Fields ────────────────────────────────
  console.log('\nChecking deal fields...');
  const dealData = await apiGet('/dealFields');
  const existingDealFields = new Map();
  for (const f of dealData.data || []) {
    existingDealFields.set(f.name, f);
  }

  for (const [key, fieldDef] of Object.entries(fieldsConfig.deal_fields)) {
    const existing = existingDealFields.get(fieldDef.name);
    if (existing) {
      console.log(`  ✓ ${fieldDef.name} (key: ${existing.key}, type: ${existing.field_type})`);
      skipped++;
      continue;
    }

    console.log(`  ✗ ${fieldDef.name} - MISSING`);

    if (dryRun) {
      console.log(`    [DRY RUN] Would create: type=${fieldDef.field_type}`);
      continue;
    }

    const body = {
      name: fieldDef.name,
      field_type: fieldDef.field_type,
    };

    if (fieldDef.options && (fieldDef.field_type === 'enum' || fieldDef.field_type === 'set')) {
      body.options = fieldDef.options.map(opt => ({ label: opt }));
    }

    try {
      const result = await apiPost('/dealFields', body);
      console.log(`    ✓ Created (key: ${result.data?.key})`);
      created++;
    } catch (err) {
      console.error(`    ✗ Failed: ${err.message}`);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  Done. ${created} created, ${skipped} already existed.`);
  console.log(`${'='.repeat(50)}\n`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
