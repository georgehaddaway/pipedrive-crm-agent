import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import config from '../config/index.js';

/** @type {import('googleapis').gmail_v1.Gmail | null} */
let gmailClient = null;

/**
 * Build an OAuth2 client from config.
 * @returns {import('googleapis').Auth.OAuth2Client}
 */
function createOAuth2Client() {
  return new google.auth.OAuth2(
    config.gmail.clientId,
    config.gmail.clientSecret,
    config.gmail.redirectUri
  );
}

/**
 * Get an authenticated Gmail API client.
 * Loads stored refresh token and auto-refreshes access token.
 * @returns {Promise<import('googleapis').gmail_v1.Gmail>}
 */
async function getGmailClient() {
  if (gmailClient) return gmailClient;

  if (!config.gmail.clientId || !config.gmail.clientSecret) {
    throw new Error(
      'Gmail OAuth credentials not configured. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env'
    );
  }

  if (!existsSync(config.gmail.tokenPath)) {
    throw new Error(
      `Gmail token not found at ${config.gmail.tokenPath}.\n` +
      `Run 'npm run auth' to complete the OAuth flow first.`
    );
  }

  const tokenData = JSON.parse(readFileSync(config.gmail.tokenPath, 'utf-8'));
  const oauth2 = createOAuth2Client();
  oauth2.setCredentials(tokenData);

  // Auto-persist refreshed tokens
  oauth2.on('tokens', (tokens) => {
    const existing = JSON.parse(readFileSync(config.gmail.tokenPath, 'utf-8'));
    const updated = { ...existing, ...tokens };
    writeFileSync(config.gmail.tokenPath, JSON.stringify(updated, null, 2));
  });

  gmailClient = google.gmail({ version: 'v1', auth: oauth2 });
  return gmailClient;
}

/**
 * Search Gmail for the most recent email thread with a contact.
 * Returns the date of the most recent message, or null if none found.
 * @param {string} email - Contact's email address
 * @returns {Promise<string|null>} ISO date string or null
 */
export async function getLastEmailDate(email) {
  const gmail = await getGmailClient();

  const query = `from:${email} OR to:${email}`;
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 1,
  });

  const messages = res.data.messages;
  if (!messages || messages.length === 0) return null;

  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messages[0].id,
    format: 'metadata',
    metadataHeaders: ['Date'],
  });

  const dateHeader = msg.data.payload?.headers?.find(h => h.name === 'Date');
  if (!dateHeader) return null;

  return new Date(dateHeader.value).toISOString();
}

/**
 * Batch lookup of last email dates for multiple contacts.
 * Processes in parallel with concurrency limit to avoid rate limits.
 * @param {string[]} emails
 * @param {number} [concurrency=5]
 * @returns {Promise<Map<string, string|null>>} Map of email -> ISO date
 */
export async function batchGetLastEmailDates(emails, concurrency = 5) {
  const results = new Map();
  const queue = [...emails];

  async function worker() {
    while (queue.length > 0) {
      const email = queue.shift();
      try {
        const date = await getLastEmailDate(email);
        results.set(email, date);
      } catch (err) {
        console.warn(`Failed to fetch Gmail activity for ${email}: ${err.message}`);
        results.set(email, null);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, emails.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Create a draft email in the user's Gmail drafts folder.
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} body - Email body (plain text)
 * @returns {Promise<string>} Draft ID
 */
export async function createDraft(to, subject, body) {
  const gmail = await getGmailClient();

  const senderLine = config.sender.email
    ? `${config.sender.name} <${config.sender.email}>`
    : config.sender.name;

  // Construct RFC 2822 message
  const messageParts = [
    `From: ${senderLine}`,
    `To: ${to}`,
    `Bcc: satoriir@pipedrivemail.com`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ];
  const rawMessage = messageParts.join('\n');

  // Base64url encode
  const encoded = Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw: encoded },
    },
  });

  return res.data.id;
}

// Export for auth module
export { createOAuth2Client };
