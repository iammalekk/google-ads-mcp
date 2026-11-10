#!/usr/bin/env node
/**
 * Google Ads MCP — CLI router
 *
 *   google-ads-mcp           Start the MCP server (stdio).
 *   google-ads-mcp auth      Connect with your Google OAuth client + browser sign-in.
 *   google-ads-mcp logout    Delete the saved credentials.
 *   google-ads-mcp status    Show whether credentials are saved and when.
 *   google-ads-mcp help      Show usage.
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG_FILE } from './oauth-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cmd = (process.argv[2] || '').toLowerCase();
const load = (f) => import(pathToFileURL(join(__dirname, f)).href);

if (cmd === 'auth') {
  const { runAuthFlow } = await load('auth.js');
  try {
    await runAuthFlow();
    process.exit(0);
  } catch (err) {
    console.error('\nAuth failed:', err?.message || err);
    process.exit(1);
  }
} else if (cmd === 'logout') {
  const { deleteConfigFile } = await load('auth.js');
  console.log((await deleteConfigFile()) ? `Removed ${CONFIG_FILE}` : 'No saved credentials to remove.');
  process.exit(0);
} else if (cmd === 'status') {
  const { readConfigFile } = await load('auth.js');
  const cfg = await readConfigFile();
  if (!cfg) {
    console.log('Not configured. Run `npx -y github:iammalekk/google-ads-mcp auth` to connect.');
  } else {
    console.log(`Config:            ${CONFIG_FILE}`);
    console.log(`Saved:             ${cfg.saved_at || '(unknown)'}`);
    console.log(`Client:            ${cfg.client_id || '(unknown)'}`);
    console.log(`Developer token:   ${cfg.developer_token ? 'set' : 'MISSING'}`);
    console.log(`Login customer:    ${cfg.login_customer_id || '(none)'}`);
    console.log(`Default customer:  ${cfg.default_customer_id || '(none)'}`);
  }
  process.exit(0);
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(`
google-ads-mcp — Google Ads MCP server (read + write)

Usage:
  google-ads-mcp           Start the MCP server (stdio)
  google-ads-mcp auth      Connect with your Google OAuth client + browser sign-in
  google-ads-mcp logout    Delete the saved credentials
  google-ads-mcp status    Show config status
  google-ads-mcp help      This message

Quick start:
  1. Create a Google Cloud OAuth Desktop client and get a Google Ads developer token (see README).
  2. Run:   npx -y github:iammalekk/google-ads-mcp auth
  3. Add to your MCP client config:
       { "mcpServers": { "Google Ads MCP": { "command": "npx", "args": ["-y", "github:iammalekk/google-ads-mcp"] } } }

Docs:  https://github.com/iammalekk/google-ads-mcp
`);
  process.exit(0);
} else if (!cmd) {
  await load('server.js');
} else {
  console.error(`Unknown command: "${cmd}"\nRun "google-ads-mcp help" for usage.`);
  process.exit(1);
}
