import { createServer } from 'http';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createOAuth2Client } from './client.js';
import config from '../config/index.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

/**
 * Run the one-time OAuth2 consent flow.
 * Opens a browser and starts a local server to capture the auth code.
 */
async function authenticate() {
  if (!config.gmail.clientId || !config.gmail.clientSecret) {
    console.error('Error: GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env');
    console.error('Create OAuth credentials at https://console.cloud.google.com/apis/credentials');
    process.exit(1);
  }

  const oauth2 = createOAuth2Client();

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n=== Gmail OAuth Setup ===\n');
  console.log('1. Open this URL in your browser:\n');
  console.log(`   ${authUrl}\n`);
  console.log('2. Authorize access and you will be redirected back.\n');

  // Start temporary server to capture the OAuth callback
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:3000`);

    if (url.pathname === '/oauth2callback') {
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h2>Authorization failed</h2><p>${error}</p>`);
        console.error(`Authorization error: ${error}`);
        server.close();
        process.exit(1);
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h2>No authorization code received</h2>');
        server.close();
        process.exit(1);
      }

      try {
        const { tokens } = await oauth2.getToken(code);

        // Persist token
        mkdirSync(dirname(config.gmail.tokenPath), { recursive: true });
        writeFileSync(config.gmail.tokenPath, JSON.stringify(tokens, null, 2));

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<h2>Authorization successful!</h2>' +
          '<p>You can close this window and return to the terminal.</p>'
        );

        console.log(`Token saved to ${config.gmail.tokenPath}`);
        console.log('Gmail auth setup complete.\n');

        server.close();
        process.exit(0);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Token exchange failed</h2><p>${err.message}</p>`);
        console.error('Token exchange error:', err.message);
        server.close();
        process.exit(1);
      }
    }
  });

  const port = new URL(config.gmail.redirectUri).port || 3000;
  server.listen(port, () => {
    console.log(`Waiting for OAuth callback on port ${port}...`);
  });
}

authenticate();
