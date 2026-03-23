/**
 * Refresh the voice profile by reading James's emails and using Claude
 * to update the voice profile JSON.
 *
 * Usage:
 *   npm run update-voice                         # Refresh from Pipedrive (last 20)
 *   npm run update-voice -- --gmail              # Refresh from Gmail "Satori Power" label
 *   npm run update-voice -- --gmail --count 65   # All 65 emails
 *   npm run update-voice -- --dry-run            # Preview without writing
 *   npm run update-voice -- --analysis           # Also output writing style analysis
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
const useGmail = args.includes('--gmail');
const outputAnalysis = args.includes('--analysis');
const countIdx = args.indexOf('--count');
const emailCount = countIdx !== -1 ? parseInt(args[countIdx + 1], 10) : (useGmail ? 65 : 20);
const labelIdx = args.indexOf('--label');
const gmailLabel = labelIdx !== -1 ? args[labelIdx + 1] : 'Satori Power';

if (!useGmail && (!domain || !token)) {
  console.error('Error: PIPEDRIVE_API_TOKEN and PIPEDRIVE_COMPANY_DOMAIN must be set in .env');
  process.exit(1);
}

if (!anthropicKey) {
  console.error('Error: ANTHROPIC_API_KEY must be set in .env for voice refresh.');
  process.exit(1);
}

// ── Gmail Email Fetching ────────────────────────────

async function fetchGmailEmails(count, label) {
  console.log(`Fetching up to ${count} sent emails from Gmail label "${label}"...`);

  // Dynamic imports
  const { google } = await import('googleapis');
  const config = (await import('../src/config/index.js')).default;

  const oauth2 = new google.auth.OAuth2(
    config.gmail.clientId, config.gmail.clientSecret, config.gmail.redirectUri
  );
  const tokenData = JSON.parse(readFileSync(config.gmail.tokenPath, 'utf-8'));
  oauth2.setCredentials(tokenData);

  // Auto-persist refreshed tokens
  oauth2.on('tokens', (tokens) => {
    const existing = JSON.parse(readFileSync(config.gmail.tokenPath, 'utf-8'));
    writeFileSync(config.gmail.tokenPath, JSON.stringify({ ...existing, ...tokens }, null, 2));
  });

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  // Use label name with hyphens for the search query
  const labelQuery = label.replace(/\s+/g, '-');
  const query = `in:sent label:${labelQuery}`;

  // Fetch message IDs (paginate if needed)
  let allMessageIds = [];
  let pageToken = undefined;
  while (allMessageIds.length < count) {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: Math.min(100, count - allMessageIds.length),
      pageToken,
    });
    const msgs = res.data.messages || [];
    allMessageIds.push(...msgs);
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }

  console.log(`  Found ${allMessageIds.length} sent messages. Reading content...`);

  // Fetch each message body (concurrency limited)
  const emails = [];
  const batchSize = 5;
  for (let i = 0; i < allMessageIds.length; i += batchSize) {
    const batch = allMessageIds.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async ({ id }) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });

      const headers = msg.data.payload?.headers || [];
      const subject = headers.find(h => h.name === 'Subject')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      // Extract body from message parts
      const body = extractBody(msg.data.payload);
      return { subject, body: cleanEmailBody(body), date };
    }));

    emails.push(...results.filter(e => e.body.length > 50));
    process.stdout.write(`  Read ${Math.min(i + batchSize, allMessageIds.length)}/${allMessageIds.length}\r`);
  }

  console.log(`\n  ${emails.length} emails with meaningful content.`);
  return emails;
}

/**
 * Extract plain text body from a Gmail message payload.
 */
function extractBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart - look for text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
      // Nested multipart
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
    // Fallback to text/html if no plain text
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return stripHtml(Buffer.from(part.body.data, 'base64url').toString('utf-8'));
      }
    }
  }

  return '';
}

/**
 * Clean an email body: strip quoted replies, signatures, and excess whitespace.
 * We only want James's original writing.
 */
function cleanEmailBody(text) {
  const lines = text.split('\n');
  const cleanLines = [];

  for (const line of lines) {
    // Stop at quoted reply indicators
    if (line.match(/^On .+ wrote:$/)) break;
    if (line.match(/^>+ /)) continue; // Skip quoted lines
    if (line.match(/^-{3,}\s*Forwarded message/)) break;
    if (line.match(/^_{3,}$/)) break; // Outlook separator
    cleanLines.push(line);
  }

  return cleanLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Pipedrive Mail API ──────────────────────────────

async function fetchRecentSentEmails(count) {
  console.log(`Fetching last ${count} sent emails from Pipedrive...`);

  const res = await fetch(
    `https://${domain}.pipedrive.com/api/v1/mailbox/mailMessages?api_token=${token}&folder=sent&limit=${count}`
  );
  const data = await res.json();

  if (!data.success || !data.data) {
    console.log('  Mail API unavailable, falling back to email activities...');
    return fetchEmailActivities(count);
  }

  const emails = [];
  for (const msg of data.data) {
    const body = msg.body || msg.snippet || '';
    const subject = msg.subject || '';
    if (body.length > 50) {
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
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514',
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

// ── Writing Analysis ────────────────────────────────

async function generateWritingAnalysis(emails, updatedProfile) {
  console.log('Generating writing style analysis and sample email...');

  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic({ apiKey: anthropicKey });

  const emailSamples = emails
    .slice(0, 30) // Use up to 30 emails for analysis
    .map((e, i) => `--- Email ${i + 1} ---\nSubject: ${e.subject}\n${e.body}`)
    .join('\n\n');

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || 'claude-3-opus-20240229',
    max_tokens: 6000,
    messages: [
      {
        role: 'user',
        content: `You are analyzing investor outreach emails written by James at Satori Capital (an energy/power infrastructure hedge fund).

Here are ${Math.min(emails.length, 30)} of his actual emails:

${emailSamples}

Please provide:

## 1. WRITING STYLE ANALYSIS
A detailed breakdown of James's writing style:
- Tone and formality level
- Sentence structure patterns
- How he opens emails
- How he closes emails
- Signature phrases and verbal tics
- How he references data/performance
- How he handles follow-ups vs cold outreach
- What he avoids (words, phrases, approaches)
- Length patterns (short vs long emails)
- His approach to CTAs (calls to action)

## 2. VOICE DNA
The 5-10 most distinctive elements that make James's emails sound like James and not a generic salesperson.

## 3. SAMPLE EMAIL
Write a sample follow-up email to a fictional investor "Sarah Kim" at "Apex Capital" who James met at a conference 3 weeks ago and hasn't replied to his initial email. Write this EXACTLY as James would write it based on his real emails. This is for James to review to see if the AI has captured his voice.

Format your response in clean markdown.`,
      },
    ],
  });

  return response.content[0]?.text || '';
}

// ── Main ────────────────────────────────────────────

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log(`  Voice Profile Refresh ${dryRun ? '(DRY RUN)' : ''} ${useGmail ? '(Gmail)' : '(Pipedrive)'}`);
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

  // Fetch emails from selected source
  const emails = useGmail
    ? await fetchGmailEmails(emailCount, gmailLabel)
    : await fetchRecentSentEmails(emailCount);

  if (emails.length < 3) {
    console.log('\nNot enough emails found to update the profile (minimum 3). Skipping.');
    process.exit(0);
  }

  // Analyze and update voice profile
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

  // Generate writing analysis if requested
  if (outputAnalysis) {
    const analysis = await generateWritingAnalysis(emails, updatedProfile);
    const analysisPath = resolve(ROOT, 'data', `voice-analysis-${new Date().toISOString().split('T')[0]}.md`);
    writeFileSync(analysisPath, analysis);
    console.log(`\n  Writing analysis saved to ${analysisPath}`);
    console.log('\n' + analysis);
  }

  console.log('\n' + '='.repeat(60));
  console.log('  Done.');
  console.log('='.repeat(60) + '\n');
}

main().catch(err => {
  console.error('Voice refresh failed:', err.message);
  process.exit(1);
});

