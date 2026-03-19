/**
 * Refresh the voice profile by reading James's recent sent emails from Pipedrive
 * and using Claude to update the voice profile JSON.
 *
 * Usage:
 *   npm run update-voice            # Refresh from last 20 emails
 *   npm run update-voice -- --count 30  # Custom email count
 *   npm run update-voice -- --dry-run   # Preview without writing
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VOICE_PROFILE_PATH = resolve(ROOT, 'config/voice-profile.json');

const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
const token = process.env.PIPEDRIVE_API_TOKEN;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const countIdx = args.indexOf('--count');
const emailCount = countIdx !== -1 ? parseInt(args[countIdx + 1], 10) : 20;

if (!domain || !token) {
  console.error('Error: PIPEDRIVE_API_TOKEN and PIPEDRIVE_COMPANY_DOMAIN must be set in .env');
  process.exit(1);
}

if (!anthropicKey) {
  console.error('Error: ANTHROPIC_API_KEY must be set in .env for voice refresh.');
  process.exit(1);
}

// ── Pipedrive Mail API ──────────────────────────────

async function fetchRecentSentEmails(count) {
  console.log(`Fetching last ${count} sent emails from Pipedrive...`);

  // Fetch mail messages sent by the user
  const res = await fetch(
    `https://${domain}.pipedrive.com/api/v1/mailbox/mailMessages?api_token=${token}&folder=sent&limit=${count}`
  );
  const data = await res.json();

  if (!data.success || !data.data) {
    // Fallback: try activities with type=email
    console.log('  Mail API unavailable, falling back to email activities...');
    return fetchEmailActivities(count);
  }

  const emails = [];
  for (const msg of data.data) {
    const body = msg.body || msg.snippet || '';
    const subject = msg.subject || '';
    if (body.length > 50) { // Skip empty/trivial messages
      emails.push({ subject, body: stripHtml(body), date: msg.write_flag ? msg.update_time : msg.add_time });
    }
  }

  console.log(`  Found ${emails.length} emails with content.`);
  return emails;
}

async function fetchEmailActivities(count) {
  console.log('  Fetching email activities...');

  const res = await fetch(
    `https://${domain}.pipedrive.com/api/v1/activities?api_token=${token}&type=email&done=1&limit=${count}&sort=update_time DESC`
  );
  const data = await res.json();

  if (!data.success || !data.data) {
    console.error('  No email data found in Pipedrive.');
    return [];
  }

  const emails = [];
  for (const activity of data.data) {
    const body = activity.note || activity.public_description || '';
    const subject = activity.subject || '';
    if (body.length > 50) {
      emails.push({ subject, body: stripHtml(body), date: activity.update_time });
    }
  }

  console.log(`  Found ${emails.length} email activities with content.`);
  return emails;
}

function stripHtml(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Claude Analysis ─────────────────────────────────

async function analyzeEmailsAndUpdateProfile(emails, currentProfile) {
  console.log('Sending emails to Claude for voice analysis...');

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: anthropicKey });

  const emailSamples = emails
    .slice(0, emailCount)
    .map((e, i) => `--- Email ${i + 1} ---\nSubject: ${e.subject}\n${e.body}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are analyzing a collection of real investor outreach emails written by James at Satori Capital. Your job is to update a voice profile JSON that an email automation agent uses to generate drafts in James's voice.

Here is the CURRENT voice profile:
${JSON.stringify(currentProfile, null, 2)}

Here are the ${emails.length} MOST RECENT emails James has sent:

${emailSamples}

Analyze these emails and return an UPDATED voice profile JSON. Specifically:
1. Update "signature_phrases" to reflect any new phrases or retired ones
2. Update "data_points_to_include" with the latest figures (fund performance, valuations, etc.)
3. Update "tone" fields if the tone has shifted
4. Update "stage_voice_notes" if you see patterns by email type
5. Update "do" and "dont" lists if new patterns emerge
6. Keep "sender", "role", "firm", "fund", "internal_contacts" unchanged unless the emails clearly indicate changes
7. Keep "structure_patterns" consistent but adjust if the email structure has evolved
8. Update "example_subject_lines" with any new subject patterns

IMPORTANT:
- Preserve the exact JSON structure and all field names
- Base changes only on evidence from the emails, not assumptions
- If something hasn't changed, keep the current value
- Return ONLY valid JSON, no markdown formatting or explanation

Return the complete updated voice profile JSON:`,
      },
    ],
  });

  const aiText = response.content[0]?.text || '';

  // Parse the JSON response
  try {
    // Strip any markdown code fences if present
    const jsonStr = aiText.replace(/^```json?\s*/i, '').replace(/```\s*$/i, '').trim();
    const updated = JSON.parse(jsonStr);
    console.log('  Voice profile analysis complete.');
    return updated;
  } catch (err) {
    console.error('  Failed to parse Claude response as JSON:', err.message);
    console.error('  Raw response (first 500 chars):', aiText.slice(0, 500));
    return null;
  }
}

// ── Main ────────────────────────────────────────────

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log(`  Voice Profile Refresh ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60) + '\n');

  // Load current profile
  let currentProfile;
  try {
    currentProfile = JSON.parse(readFileSync(VOICE_PROFILE_PATH, 'utf-8'));
    console.log('Loaded current voice profile.');
  } catch {
    console.error('Error: config/voice-profile.json not found.');
    process.exit(1);
  }

  // Fetch recent emails
  const emails = await fetchRecentSentEmails(emailCount);

  if (emails.length < 3) {
    console.log('\nNot enough emails found to update the profile (minimum 3). Skipping.');
    process.exit(0);
  }

  // Analyze and update
  const updatedProfile = await analyzeEmailsAndUpdateProfile(emails, currentProfile);

  if (!updatedProfile) {
    console.error('\nFailed to generate updated profile. Current profile unchanged.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] Would update voice profile with:');
    console.log(JSON.stringify(updatedProfile, null, 2));
  } else {
    // Backup current profile
    const backupPath = VOICE_PROFILE_PATH.replace('.json', `.backup-${new Date().toISOString().split('T')[0]}.json`);
    writeFileSync(backupPath, readFileSync(VOICE_PROFILE_PATH));
    console.log(`  Backed up current profile to ${backupPath}`);

    // Write updated profile
    writeFileSync(VOICE_PROFILE_PATH, JSON.stringify(updatedProfile, null, 2) + '\n');
    console.log('  Voice profile updated successfully.');
  }

  console.log('\n' + '='.repeat(60));
  console.log('  Done.');
  console.log('='.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Voice refresh failed:', err.message);
  process.exit(1);
});
