#!/usr/bin/env node

/**
 * Backfill Last Outbound Date from Gmail.
 *
 * For each contact in Pipedrive, searches Gmail for the most recent
 * sent email and updates the Last Outbound Date field.
 *
 * Usage: node scripts/backfill-dates.js [--dry-run]
 */

import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
loadEnv({ path: resolve(ROOT, '.env') });

// Set required env vars with fallbacks for non-email features
process.env.SENDER_NAME = process.env.SENDER_NAME || 'Team';
process.env.SENDER_EMAIL = process.env.SENDER_EMAIL || '';
process.env.FUND_NAME = process.env.FUND_NAME || '';

const dryRun = process.argv.includes('--dry-run');

async function run() {
  const { getContacts, pipedriveWriter } = await import('../src/api/pipedrive.js');
  const { batchGetLastEmailDates } = await import('../src/gmail/client.js');
  const config = (await import('../src/config/index.js')).default;

  console.log(`\n${'='.repeat(55)}`);
  console.log(`  Backfill Last Outbound Date from Gmail ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`${'='.repeat(55)}\n`);

  // Step 1: Fetch contacts
  console.log('Step 1: Fetching contacts from Pipedrive...');
  const contacts = await getContacts();
  console.log(`  Found ${contacts.length} contacts.\n`);

  // Step 2: Check Gmail for each contact
  console.log('Step 2: Checking Gmail for sent emails...');
  const emails = contacts.map(c => c.email).filter(Boolean);
  const gmailDates = await batchGetLastEmailDates(emails);
  const withHistory = [...gmailDates.entries()].filter(([_, date]) => date);
  console.log(`  Found Gmail history for ${withHistory.length} of ${emails.length} contacts.\n`);

  // Step 3: Update Pipedrive
  console.log('Step 3: Updating Last Outbound Date in Pipedrive...');
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const contact of contacts) {
    const gmailDate = gmailDates.get(contact.email);
    if (!gmailDate) {
      console.log(`  ○ ${contact.firstName} ${contact.lastName} (${contact.email}) - no Gmail history`);
      skipped++;
      continue;
    }

    // Format date as YYYY-MM-DD
    const d = new Date(gmailDate);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    if (dryRun) {
      console.log(`  → ${contact.firstName} ${contact.lastName} (${contact.email}) - would set to ${dateStr}`);
      updated++;
      continue;
    }

    try {
      await pipedriveWriter.updatePersonField(contact.id, 'Last Outbound Date', dateStr);
      console.log(`  ✓ ${contact.firstName} ${contact.lastName} (${contact.email}) - set to ${dateStr}`);
      updated++;
    } catch (err) {
      console.error(`  ✗ ${contact.firstName} ${contact.lastName}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(55)}`);
  console.log(`  Done. ${updated} updated, ${skipped} no history, ${failed} failed.`);
  console.log(`${'='.repeat(55)}\n`);
}

run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
