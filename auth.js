/**
 * Browser-based OAuth flow with the user's own OAuth Desktop client.
 *
 *   1. Prompt for client id/secret, developer token, optional login (MCC) customer id
 *      and default customer id (or read them from env).
 *   2. Spawn a local HTTP listener on a random loopback port.
 *   3. Open the default browser to Google sign-in.
 *   4. Capture the redirect, exchange the code for a refresh token.
 *   5. Save everything to ~/.google-ads-mcp/config.json (0600).
 */

import { createServer } from 'node:http';
import { mkdir, writeFile, chmod, readFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { OAuth2Client } from 'google-auth-library';
import { SCOPES, CONFIG_DIR, CONFIG_FILE } from './oauth-config.js';

const cleanId = (v) => (v || '').replace(/-/g, '').trim();

function openBrowser(url) {
  const cmds = {
    darwin: { cmd: 'open', args: [url] },
    linux: { cmd: 'xdg-open', args: [url] },
    win32: { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
  };
  const c = cmds[process.platform];
  if (!c) {
    console.error(`Unsupported platform: ${process.platform}. Open this URL manually:\n${url}`);
    return;
  }
  try {
    spawn(c.cmd, c.args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    console.error(`Couldn't auto-open browser (${err.message}). Open this URL manually:\n${url}`);
  }
}

const page = (title, body, color) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Google Ads MCP — ${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:0 24px;color:#1a1a1a;line-height:1.6}
h1{font-size:24px;margin:0 0 16px;color:${color}}.box{border:1px solid #ddd;border-radius:10px;padding:24px}</style></head>
<body><div class="box"><h1>${title}</h1>${body}</div></body></html>`;

const SUCCESS_HTML = page('Connected to Google Ads', '<p>Credentials saved locally. You can close this tab and return to your terminal.</p>', '#0a7f3f');
const ERROR_HTML = (msg) => page('Authorization failed', `<p>${msg}</p><p>Return to the terminal and try again.</p>`, '#b03030');

export async function runAuthFlow() {
  console.log('\n=== Google Ads MCP — Browser sign-in ===\n');

  const existing = (await readConfigFile()) || {};
  let clientId = process.env.GOOGLE_CLIENT_ID || existing.client_id;
  let clientSecret = process.env.GOOGLE_CLIENT_SECRET || existing.client_secret;
  let developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || existing.developer_token;
  let loginCustomerId = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? existing.login_customer_id;
  let defaultCustomerId = process.env.GOOGLE_ADS_CUSTOMER_ID ?? existing.default_customer_id;

  const rl = readline.createInterface({ input, output });
  if (!clientId || !clientSecret) {
    console.log('You need a Google Cloud OAuth client first (one-time):');
    console.log('  1. Enable the Google Ads API: https://console.cloud.google.com/apis/library/googleads.googleapis.com');
    console.log('  2. OAuth consent screen: https://console.cloud.google.com/apis/credentials/consent');
    console.log('     User type: External -> add your own Google email under Test users.');
    console.log('  3. Credentials: https://console.cloud.google.com/apis/credentials');
    console.log('     Create credentials -> OAuth client ID -> Desktop app -> copy ID + secret.\n');
    if (!clientId) clientId = (await rl.question('Paste your GOOGLE_CLIENT_ID: ')).trim();
    if (!clientSecret) clientSecret = (await rl.question('Paste your GOOGLE_CLIENT_SECRET: ')).trim();
  }
  if (!developerToken) {
    console.log('\nDeveloper token: Google Ads (manager account) -> Tools -> API Center.');
    developerToken = (await rl.question('Paste your GOOGLE_ADS_DEVELOPER_TOKEN: ')).trim();
  }
  if (loginCustomerId === undefined) {
    loginCustomerId = cleanId(await rl.question('Manager (MCC) customer ID if you access accounts through one (blank = none): '));
  }
  if (defaultCustomerId === undefined) {
    defaultCustomerId = cleanId(await rl.question('Default Google Ads customer ID to work on (blank = none): '));
  }
  rl.close();

  if (!clientId || !clientSecret || !developerToken) {
    throw new Error('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_ADS_DEVELOPER_TOKEN are all required.');
  }

  const state = randomBytes(16).toString('hex');
  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const fail = (msg, err) => {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ERROR_HTML(msg));
      rejectCode(new Error(err));
    };
    const error = u.searchParams.get('error');
    const code = u.searchParams.get('code');
    if (error) return fail(`Google reported: ${error}`, `OAuth error: ${error}`);
    if (u.searchParams.get('state') !== state) return fail('State mismatch — please re-run auth.', 'State mismatch');
    if (!code) return fail('No code returned by Google.', 'No code');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(SUCCESS_HTML);
    resolveCode(code);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

  const oauth2 = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });

  console.log('\nOpening your browser to Google sign-in...');
  console.log('If it does not open automatically, copy and paste this URL:\n');
  console.log(authUrl + '\n');
  console.log('Waiting for you to approve in the browser...');
  openBrowser(authUrl);

  let code;
  try {
    code = await Promise.race([
      codePromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out waiting for browser sign-in (5 min).')), 5 * 60 * 1000)),
    ]);
  } finally {
    server.close();
  }

  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Revoke access at https://myaccount.google.com/permissions and re-run auth.',
    );
  }

  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const payload = {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    developer_token: developerToken,
    login_customer_id: cleanId(loginCustomerId) || '',
    default_customer_id: cleanId(defaultCustomerId) || '',
    scope: tokens.scope,
    saved_at: new Date().toISOString(),
  };
  await writeFile(CONFIG_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try { await chmod(CONFIG_FILE, 0o600); } catch {}

  console.log(`\nSaved credentials to ${CONFIG_FILE}`);
  console.log('\nLast step — add this to your MCP client config and restart it:\n');
  console.log(JSON.stringify({
    mcpServers: { 'Google Ads MCP': { command: 'npx', args: ['-y', 'github:iammalekk/google-ads-mcp'] } },
  }, null, 2));
  console.log('\nThen ask: "List my Google Ads accounts".\n');
}

export async function readConfigFile() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function deleteConfigFile() {
  try {
    await unlink(CONFIG_FILE);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
