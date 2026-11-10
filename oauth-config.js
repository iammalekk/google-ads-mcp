/**
 * Shared constants.
 *
 * Each user supplies their own Google Cloud OAuth Desktop client + Google Ads
 * developer token. The auth flow saves everything to a single config file
 * under the user's home directory.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

// The single Google Ads scope covers both reading and mutating.
export const SCOPES = ['https://www.googleapis.com/auth/adwords'];

export const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v26';
export const API_BASE = `https://googleads.googleapis.com/${API_VERSION}`;

export const CONFIG_DIR = join(homedir(), '.google-ads-mcp');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
