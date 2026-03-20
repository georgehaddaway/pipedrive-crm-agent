/**
 * Delete specific Gmail drafts by ID and remove today's run file
 * so the agent can regenerate drafts with the new templates.
 *
 * Usage: node scripts/delete-drafts.js
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load today's run file to get draft IDs
const today = new Date().toISOString().split('T')[0];
const runFilePath = resolve(ROOT, `data/runs/${today}.json`);

if (!existsSync(runFilePath)) {
  console.error(`No run file found for ${today}`);
  process.exit(1);
}

const runData = JSON.parse(readFileSync(runFilePath, 'utf-8'));
const draftIds = runData.drafts
  .filter(d => d.created && d.draftId)
  .map(d => d.draftId);

console.log(`Found ${draftIds.length} drafts to delete from run ${today}`);

// Set up Gmail client
const tokenPath = resolve(ROOT, 'data/gmail-token.json');
if (!existsSync(tokenPath)) {
  console.error('Gmail token not found. Cannot delete drafts.');
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

// Delete each draft
let deleted = 0;
let failed = 0;

for (const draftId of draftIds) {
  try {
    await gmail.users.drafts.delete({
      userId: 'me',
      id: draftId,
    });
    deleted++;
    console.log(`  Deleted draft ${draftId}`);
  } catch (err) {
    // Draft may have already been sent or deleted manually
    console.warn(`  Failed to delete draft ${draftId}: ${err.message}`);
    failed++;
  }
}

console.log(`\nDeleted ${deleted}/${draftIds.length} drafts (${failed} failed/already gone).`);

// Remove today's run file so the agent can re-run
unlinkSync(runFilePath);
console.log(`Removed run file: ${runFilePath}`);
console.log('\nReady to regenerate. Run: node src/index.js');
