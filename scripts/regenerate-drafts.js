/**
 * Regenerate drafts for specific contacts.
 * Deletes existing drafts created earlier today and creates new ones
 * using the updated templates and AI polish.
 *
 * Usage: node scripts/regenerate-drafts.js
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// The draft IDs from this morning's run (captured from the original run log)
const oldDraftIds = [
  'r4827311366954147713',
  'r-5012621428254465515',
  'r-479202800994792879',
  'r-2895529816889519119',
  'r3174167776781148845',
  'r-8930958571244116738',
  'r-479479126676712232',
  'r2594677870763682154',
  'r2511571648563600096',
  'r-5086784755343056544',
];

// Set up Gmail client
const tokenPath = resolve(ROOT, 'data/gmail-token.json');
if (!existsSync(tokenPath)) {
  console.error('Gmail token not found.');
  process.exit(1);
}

const tokenData = JSON.parse(readFileSync(tokenPath, 'utf-8'));
const oauth2 = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
);
oauth2.setCredentials(tokenData);
const gmail = google.gmail({ version: 'v1', auth: oauth2 });

// Step 1: Delete old drafts
console.log('Step 1: Deleting old drafts from this morning...');
for (const draftId of oldDraftIds) {
  try {
    await gmail.users.drafts.delete({ userId: 'me', id: draftId });
    console.log(`  Deleted: ${draftId}`);
  } catch (err) {
    console.warn(`  Skip (already gone): ${draftId}`);
  }
}

// Step 2: Import the agent modules and regenerate
console.log('\nStep 2: Regenerating drafts with updated templates...');

const config = (await import('../src/config/index.js')).default;
const { getContacts } = await import('../src/api/pipedrive.js');
const { renderEmail } = await import('../src/templates/router.js');
const { createDraft } = await import('../src/gmail/client.js');

// Fetch all contacts
const contacts = await getContacts();
console.log(`  Found ${contacts.length} contacts.`);

// These are the contacts from this morning's run
const targetEmails = [
  'dademeter@davidson.edu',
  'Ahmed.Deria@blackstone.com',
  'peter.kellner@rglobal.com',
  'Aadigun@dumac.duke.edu',
  'mklein@aetos.com',
  'fcua@aetos.com',
  'kiran.patel@krisdan.com',
  'theresa.nardone@therockcreekgroup.com',
  'bruno.caram@mercurygestao.com.br',
  'gary@arietcapital.com',
];

const targetContacts = contacts.filter(c => targetEmails.includes(c.email));
console.log(`  Matched ${targetContacts.length} contacts for regeneration.\n`);

let created = 0;
for (const contact of targetContacts) {
  const followUp = {
    contact,
    reason: 'Regenerated draft',
    daysSinceLastContact: 0,
    urgencyScore: 1,
    templateName: contact.stage,
    attemptNumber: (contact.outreachAttempts || 0) + 1,
    stageConfig: config.getStageByKey(contact.stage),
  };

  try {
    const { subject, body } = await renderEmail(followUp);
    const draftId = await createDraft(contact.email, subject, body);
    console.log(`  Created draft for ${contact.firstName} ${contact.lastName} (${contact.email})`);
    console.log(`    Subject: ${subject}`);
    created++;
  } catch (err) {
    console.error(`  FAILED for ${contact.email}: ${err.message}`);
  }
}

console.log(`\nDone. Created ${created}/${targetContacts.length} new drafts.`);
