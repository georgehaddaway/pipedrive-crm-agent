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
 * Search Gmail for the most recent SENT email to a contact.
 * Only matches actually sent mail (excludes drafts).
 * @param {string} email - Contact's email address
 * @param {Object} [opts]
 * @param {number} [opts.monthsBack=3] - How many months back to search
 * @returns {Promise<string|null>} ISO date string or null
 */
export async function getLastEmailDate(email, { monthsBack = 3 } = {}) {
  const gmail = await getGmailClient();

  // Calculate the date cutoff
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  const afterDate = `${cutoff.getFullYear()}/${String(cutoff.getMonth() + 1).padStart(2, '0')}/${String(cutoff.getDate()).padStart(2, '0')}`;

  // Search only sent mail, exclude drafts
  const query = `in:sent to:${email} -in:draft after:${afterDate}`;
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
 * Fetch recent email messages (sent and received) with a given contact.
 * Returns an array of snippet objects in reverse chronological order.
 *
 * @param {string} email - Contact's email address
 * @param {Object} [opts]
 * @param {number} [opts.maxMessages=5] - Max messages to return
 * @param {number} [opts.monthsBack=3] - How far back to search
 * @param {number} [opts.snippetLength=500] - Max chars per body snippet
 * @returns {Promise<Array<{ direction: string, date: string, subject: string, snippet: string }>>}
 */
export async function getRecentThreadSnippets(email, { maxMessages = 5, monthsBack = 3, snippetLength = 500 } = {}) {
  const gmail = await getGmailClient();

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - monthsBack);
  const afterDate = `${cutoff.getFullYear()}/${String(cutoff.getMonth() + 1).padStart(2, '0')}/${String(cutoff.getDate()).padStart(2, '0')}`;

  // Search for all mail with this contact (sent or received), excluding drafts
  const query = `(from:${email} OR to:${email}) -in:draft after:${afterDate}`;
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: maxMessages,
  });

  const messages = listRes.data.messages;
  if (!messages || messages.length === 0) return [];

  const snippets = [];

  for (const msgRef of messages) {
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: msgRef.id,
        format: 'full',
      });

      const headers = msg.data.payload?.headers || [];
      const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
      const dateHeader = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '(no subject)';

      // Determine direction: if the From header contains the contact's email, it's inbound
      const isInbound = fromHeader.toLowerCase().includes(email.toLowerCase());

      // Extract plaintext body
      const bodyText = extractPlainText(msg.data.payload);
      const truncated = bodyText.length > snippetLength
        ? bodyText.slice(0, snippetLength) + '...'
        : bodyText;

      snippets.push({
        direction: isInbound ? 'received' : 'sent',
        date: dateHeader ? new Date(dateHeader).toISOString() : '',
        subject: subjectHeader,
        snippet: truncated,
      });
    } catch (err) {
      // Skip individual message errors
      console.warn(`  Failed to read message ${msgRef.id}: ${err.message}`);
    }
  }

  return snippets;
}

/**
 * Extract plaintext from a Gmail message payload.
 * Walks the MIME tree looking for text/plain parts.
 *
 * @param {Object} payload - Gmail message payload
 * @returns {string} Plaintext body
 */
function extractPlainText(payload) {
  if (!payload) return '';

  // Single-part message
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Multipart: recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
      // Recurse for nested multipart
      if (part.parts) {
        const nested = extractPlainText(part);
        if (nested) return nested;
      }
    }
  }

  // Fallback: use the API snippet field
  return payload.snippet || '';
}

/**
 * Batch lookup of recent email threads for multiple contacts.
 * Processes in parallel with concurrency limit.
 *
 * @param {string[]} emails
 * @param {Object} [opts]
 * @param {number} [opts.concurrency=3] - Parallel requests (lower than date lookups to avoid quota)
 * @param {number} [opts.maxMessages=5]
 * @returns {Promise<Map<string, Array<{ direction: string, date: string, subject: string, snippet: string }>>>}
 */
export async function batchGetRecentThreads(emails, { concurrency = 3, maxMessages = 5 } = {}) {
  const results = new Map();
  const queue = [...emails];

  async function worker() {
    while (queue.length > 0) {
      const email = queue.shift();
      try {
        const snippets = await getRecentThreadSnippets(email, { maxMessages });
        results.set(email, snippets);
      } catch (err) {
        console.warn(`  Failed to fetch thread history for ${email}: ${err.message}`);
        results.set(email, []);
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
