#!/usr/bin/env node
/**
 * Google Ads MCP — stdio server
 *
 * Read AND act on Google Ads from any MCP-capable client. Talks to the Google Ads
 * REST API directly. Tools: customers, GAQL query, performance reports, budgets,
 * campaigns, ad groups, keywords (+ negatives), responsive search ads, conversion
 * actions (with GTM-ready conversion ID / label), keyword ideas, a generic
 * GoogleAdsService.mutate, and a universal `gads_raw` escape hatch.
 *
 * Every mutating tool accepts `validateOnly: true` to dry-run the change.
 * New campaigns and ads are created PAUSED by default so nothing spends money
 * until you explicitly enable it.
 *
 * Auth: ~/.google-ads-mcp/config.json, created by `google-ads-mcp auth`.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { OAuth2Client } from 'google-auth-library';
import { readFileSync } from 'node:fs';
import { CONFIG_FILE, API_BASE, API_VERSION } from './oauth-config.js';

// ─── credentials ──────────────────────────────────────────────────────────────

let saved = {};
try {
  saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
} catch {
  // config file missing — handled below
}

const cleanId = (v) => String(v ?? '').replace(/-/g, '').trim();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || saved.client_id;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || saved.client_secret;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || saved.refresh_token;
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || saved.developer_token;
const LOGIN_CUSTOMER_ID = cleanId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || saved.login_customer_id);
const DEFAULT_CUSTOMER_ID = cleanId(process.env.GOOGLE_ADS_CUSTOMER_ID || saved.default_customer_id);

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !DEVELOPER_TOKEN) {
  console.error(
    'Google Ads MCP — not configured yet.\n\n' +
    'First-time setup: open a terminal and run\n\n' +
    '    npx -y github:iammalekk/google-ads-mcp auth\n\n' +
    'Credentials will be saved to ' + CONFIG_FILE + '.'
  );
  process.exit(1);
}

const oauth2 = new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
oauth2.setCredentials({ refresh_token: REFRESH_TOKEN });

// ─── HTTP layer ───────────────────────────────────────────────────────────────

class AdsApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(method, path, body, loginCustomerId) {
  const { token } = await oauth2.getAccessToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': DEVELOPER_TOKEN,
    'Content-Type': 'application/json',
  };
  const login = cleanId(loginCustomerId) || LOGIN_CUSTOMER_ID;
  if (login) headers['login-customer-id'] = login;
  const res = await fetch(`${API_BASE}/${path.replace(/^\/+/, '')}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new AdsApiError(res.status, data);
  return data;
}

const cid = (a) => {
  const id = cleanId(a.customerId) || DEFAULT_CUSTOMER_ID;
  if (!id) throw new Error('customerId is required (no default customer configured).');
  return id;
};

async function search(customerId, query, maxRows = 1000) {
  const rows = [];
  let pageToken;
  do {
    const r = await api('POST', `customers/${customerId}/googleAds:search`, { query, pageToken });
    rows.push(...(r.results || []));
    pageToken = r.nextPageToken;
  } while (pageToken && rows.length < maxRows);
  return { rowCount: rows.length, truncated: Boolean(pageToken), rows: rows.slice(0, maxRows) };
}

const mutate = (customerId, mutateOperations, a = {}) =>
  api('POST', `customers/${customerId}/googleAds:mutate`, {
    mutateOperations,
    validateOnly: Boolean(a.validateOnly),
    partialFailure: Boolean(a.partialFailure),
  });

// ─── operation builders ───────────────────────────────────────────────────────

const KINDS = {
  budget: { op: 'campaignBudgetOperation', coll: 'campaignBudgets' },
  campaign: { op: 'campaignOperation', coll: 'campaigns' },
  adGroup: { op: 'adGroupOperation', coll: 'adGroups' },
  adGroupCriterion: { op: 'adGroupCriterionOperation', coll: 'adGroupCriteria' },
  campaignCriterion: { op: 'campaignCriterionOperation', coll: 'campaignCriteria' },
  adGroupAd: { op: 'adGroupAdOperation', coll: 'adGroupAds' },
  conversionAction: { op: 'conversionActionOperation', coll: 'conversionActions' },
};

const rn = (customerId, kind, ...ids) => `customers/${customerId}/${KINDS[kind].coll}/${ids.map(cleanId).join('~')}`;

// Leaf field paths for an update mask. Empty objects / arrays count as leaves.
function fieldMask(obj, prefix = '') {
  return Object.entries(obj).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    const isObj = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length;
    return isObj ? fieldMask(v, p) : [p];
  });
}

const opCreate = (kind, create) => ({ [KINDS[kind].op]: { create } });
const opRemove = (kind, resourceName) => ({ [KINDS[kind].op]: { remove: resourceName } });
function opUpdate(kind, resourceName, fields) {
  if (!fields || !Object.keys(fields).length) throw new Error('Nothing to update — provide fields to change.');
  return { [KINDS[kind].op]: { update: { resourceName, ...fields }, updateMask: fieldMask(fields).join(',') } };
}

const micros = (amount) => (amount === undefined || amount === null ? undefined : String(Math.round(Number(amount) * 1e6)));
const prune = (o) => JSON.parse(JSON.stringify(o));
const dateTime = (d, end) => (d ? (d.length === 10 ? `${d} ${end ? '23:59:59' : '00:00:00'}` : d) : undefined);
const STATUS = { pause: 'PAUSED', enable: 'ENABLED' };

// Shared handler for status changes / removal on any entity.
function lifecycle(kind, action, customerId, resourceName, a) {
  if (STATUS[action]) return mutate(customerId, [opUpdate(kind, resourceName, { status: STATUS[action] })], a);
  if (action === 'remove') return mutate(customerId, [opRemove(kind, resourceName)], a);
  if (action === 'update') return mutate(customerId, [opUpdate(kind, resourceName, a.payload)], a);
  return null;
}

function bidding(a) {
  switch ((a.biddingStrategy || 'MANUAL_CPC').toUpperCase()) {
    case 'MANUAL_CPC': return { manualCpc: { enhancedCpcEnabled: false } };
    case 'MAXIMIZE_CLICKS': return { targetSpend: prune({ cpcBidCeilingMicros: micros(a.maxCpcBid) }) };
    case 'MAXIMIZE_CONVERSIONS': return { maximizeConversions: prune({ targetCpaMicros: micros(a.targetCpa) }) };
    case 'TARGET_CPA': return { maximizeConversions: { targetCpaMicros: micros(a.targetCpa) } };
    case 'MAXIMIZE_CONVERSION_VALUE': return { maximizeConversionValue: prune({ targetRoas: a.targetRoas }) };
    case 'TARGET_ROAS': return { maximizeConversionValue: { targetRoas: a.targetRoas } };
    default: throw new Error(`Unsupported biddingStrategy: ${a.biddingStrategy}`);
  }
}

const DATE_RANGES = ['TODAY', 'YESTERDAY', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'THIS_MONTH', 'LAST_MONTH', 'THIS_WEEK_SUN_TODAY', 'LAST_WEEK_SUN_SAT'];

function dateClause(a) {
  if (a.startDate && a.endDate) return `segments.date BETWEEN '${a.startDate}' AND '${a.endDate}'`;
  const r = (a.dateRange || 'LAST_30_DAYS').toUpperCase();
  if (!DATE_RANGES.includes(r)) throw new Error(`Invalid dateRange: ${r}`);
  return `segments.date DURING ${r}`;
}

const METRICS = 'metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion';

const REPORTS = {
  account: { from: 'customer', fields: 'customer.id, customer.descriptive_name' },
  campaign: { from: 'campaign', fields: 'campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type' },
  ad_group: { from: 'ad_group', fields: 'campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status' },
  keyword: { from: 'keyword_view', fields: 'campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status' },
  search_term: { from: 'search_term_view', fields: 'campaign.name, ad_group.name, search_term_view.search_term, search_term_view.status' },
  ad: { from: 'ad_group_ad', fields: 'campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status' },
};

// ─── response wrappers ────────────────────────────────────────────────────────

function ok(data) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const MAX = 60000;
  return { content: [{ type: 'text', text: text.length > MAX ? text.slice(0, MAX) + `\n\n... [truncated ${text.length - MAX} chars]` : text }] };
}

function bad(err) {
  const body = err?.body?.error;
  return {
    isError: true,
    content: [{
      type: 'text',
      text: 'Google Ads API error:\n' + JSON.stringify({
        message: err?.message || String(err),
        status: err?.status,
        details: body?.details?.flatMap((d) => d.errors || []) || body?.details,
        requestId: body?.details?.find((d) => d.requestId)?.requestId,
      }, null, 2),
    }],
  };
}

// ─── tool definitions ─────────────────────────────────────────────────────────

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const common = {
  customerId: S('string', 'Google Ads customer ID (dashes optional). Defaults to the configured default customer.'),
  validateOnly: S('boolean', 'Dry run: validate the change without applying it.'),
};
const lifecycleActions = ['update', 'pause', 'enable', 'remove'];
const tool = (name, description, properties, required = ['action']) => ({
  name, description, inputSchema: { type: 'object', properties: { ...common, ...properties }, required },
});
const action = (values) => S('string', `One of: ${values.join(' | ')}`, { enum: values });
const payload = S('object', 'Fields to set (Google Ads REST JSON, camelCase). Update mask is computed automatically.');

const tools = [
  tool('gads_customer', 'Accounts. list_accessible: accounts your login can reach. get: details of one account. list_clients: child accounts under a manager (MCC).', {
    action: action(['list_accessible', 'get', 'list_clients']),
  }),
  tool('gads_query', 'Run any GAQL query (read-only), e.g. "SELECT campaign.id, campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_7_DAYS". Auto-paginates.', {
    query: S('string', 'GAQL query'),
    maxRows: S('number', 'Max rows to return (default 1000).'),
  }, ['query']),
  tool('gads_report', 'Performance report with standard metrics (impressions, clicks, ctr, avg cpc, cost, conversions, value). cost_micros / 1,000,000 = account currency.', {
    level: action(Object.keys(REPORTS)),
    dateRange: S('string', `Predefined range: ${DATE_RANGES.join(', ')} (default LAST_30_DAYS).`),
    startDate: S('string', 'YYYY-MM-DD (use with endDate instead of dateRange)'),
    endDate: S('string', 'YYYY-MM-DD'),
    campaignId: S('string', 'Filter to one campaign'),
    adGroupId: S('string', 'Filter to one ad group'),
    orderBy: S('string', 'GAQL field to sort DESC by (default metrics.cost_micros)'),
    limit: S('number', 'Row limit (default 100)'),
  }, ['level']),
  tool('gads_budget', 'Campaign budgets. Amounts are in account currency per day (e.g. 20 = 20.00).', {
    action: action(['list', 'create', ...lifecycleActions.filter((x) => !STATUS[x])]),
    budgetId: S('string', 'Budget ID (update/remove)'),
    name: S('string', 'Budget name (create)'),
    amount: S('number', 'Daily amount in account currency (create/update)'),
    shared: S('boolean', 'Shared budget usable by multiple campaigns (create, default false)'),
    payload,
  }),
  tool('gads_campaign', 'Campaigns. create builds a Search campaign + its budget atomically, PAUSED by default. update/pause/enable/remove by campaignId.', {
    action: action(['list', 'create', ...lifecycleActions]),
    campaignId: S('string', 'Campaign ID'),
    name: S('string', 'Campaign name (create)'),
    budgetAmount: S('number', 'Daily budget in account currency — creates a new budget (create)'),
    budgetId: S('string', 'Use an existing budget instead of budgetAmount (create)'),
    channelType: S('string', 'SEARCH (default) | DISPLAY | ...'),
    biddingStrategy: S('string', 'MANUAL_CPC (default) | MAXIMIZE_CLICKS | MAXIMIZE_CONVERSIONS | TARGET_CPA | MAXIMIZE_CONVERSION_VALUE | TARGET_ROAS'),
    targetCpa: S('number', 'Target CPA in account currency'),
    targetRoas: S('number', 'Target ROAS as a ratio (e.g. 4 = 400%)'),
    maxCpcBid: S('number', 'Max CPC ceiling for MAXIMIZE_CLICKS'),
    status: S('string', 'PAUSED (default) | ENABLED'),
    startDate: S('string', 'YYYY-MM-DD'),
    endDate: S('string', 'YYYY-MM-DD'),
    searchPartners: S('boolean', 'Include Search partners (default false)'),
    displayNetwork: S('boolean', 'Include Display network for Search campaigns (default false)'),
    payload,
  }),
  tool('gads_ad_group', 'Ad groups. create/update/pause/enable/remove; list optionally filtered by campaignId.', {
    action: action(['list', 'create', ...lifecycleActions]),
    campaignId: S('string', 'Campaign ID (create / list filter)'),
    adGroupId: S('string', 'Ad group ID'),
    name: S('string', 'Ad group name (create)'),
    cpcBid: S('number', 'Default max CPC in account currency'),
    status: S('string', 'ENABLED (default) | PAUSED'),
    payload,
  }),
  tool('gads_keyword', 'Keywords. add: many keywords to an ad group. add_negative: negatives at campaign (campaignId) or ad group (adGroupId) level. update/pause/enable/remove need adGroupId + criterionId; remove_negative needs campaignId + criterionId.', {
    action: action(['list', 'add', 'add_negative', 'remove_negative', ...lifecycleActions]),
    campaignId: S('string', 'Campaign ID'),
    adGroupId: S('string', 'Ad group ID'),
    criterionId: S('string', 'Keyword criterion ID'),
    keywords: S('array', 'Keywords: strings or {text, matchType: EXACT|PHRASE|BROAD}', { items: {} }),
    matchType: S('string', 'Default match type for plain strings (default PHRASE for add, EXACT for negatives)'),
    cpcBid: S('number', 'Keyword-level max CPC in account currency'),
    payload,
  }),
  tool('gads_ad', 'Ads. create_rsa: Responsive Search Ad (3–15 headlines ≤30 chars, 2–4 descriptions ≤90 chars), PAUSED by default. pause/enable/remove need adGroupId + adId.', {
    action: action(['list', 'create_rsa', ...lifecycleActions]),
    adGroupId: S('string', 'Ad group ID'),
    adId: S('string', 'Ad ID'),
    campaignId: S('string', 'Campaign ID (list filter)'),
    headlines: S('array', 'Strings or {text, pinnedField: HEADLINE_1|HEADLINE_2|HEADLINE_3}', { items: {} }),
    descriptions: S('array', 'Strings or {text, pinnedField: DESCRIPTION_1|DESCRIPTION_2}', { items: {} }),
    finalUrls: S('array', 'Landing page URLs', { items: { type: 'string' } }),
    path1: S('string', 'Display URL path 1 (≤15 chars)'),
    path2: S('string', 'Display URL path 2 (≤15 chars)'),
    status: S('string', 'PAUSED (default) | ENABLED'),
    payload,
  }),
  tool('gads_conversion_action', 'Conversion actions. gtm_tag: returns the Conversion ID (AW-…) and Conversion Label to use in a GTM "Google Ads Conversion Tracking" tag (awct).', {
    action: action(['list', 'create', 'gtm_tag', 'update', 'remove']),
    conversionActionId: S('string', 'Conversion action ID'),
    name: S('string', 'Name (create)'),
    category: S('string', 'PURCHASE | SUBMIT_LEAD_FORM | SIGNUP | CONTACT | PAGE_VIEW | ADD_TO_CART | BEGIN_CHECKOUT | DEFAULT (default)'),
    type: S('string', 'WEBPAGE (default) | UPLOAD_CLICKS | ...'),
    countingType: S('string', 'ONE_PER_CLICK | MANY_PER_CLICK (default)'),
    value: S('number', 'Default conversion value'),
    currencyCode: S('string', 'e.g. USD'),
    payload,
  }),
  tool('gads_keyword_ideas', 'Keyword Planner ideas with avg monthly searches, competition and bid ranges.', {
    keywords: S('array', 'Seed keywords', { items: { type: 'string' } }),
    url: S('string', 'Seed URL'),
    languageId: S('string', 'Language constant ID (default 1000 = English)'),
    geoTargetIds: S('array', 'Geo target constant IDs (default ["2840"] = United States)', { items: { type: 'string' } }),
    limit: S('number', 'Max ideas (default 50)'),
  }, []),
  tool('gads_mutate', 'Generic GoogleAdsService.mutate — any combination of MutateOperations atomically (e.g. [{"campaignOperation":{"update":{...},"updateMask":"..."}}]). Temporary IDs (negative numbers) can link new resources.', {
    operations: S('array', 'MutateOperation objects (REST JSON)', { items: { type: 'object' } }),
    partialFailure: S('boolean', 'Apply valid operations even if some fail'),
  }, ['operations']),
  tool('gads_raw', `UNIVERSAL escape hatch — call any Google Ads REST ${API_VERSION} endpoint. path is relative to ${API_BASE}/ (e.g. "customers/1234567890/campaignBudgets:mutate").`, {
    method: S('string', 'GET | POST (default POST)'),
    path: S('string', 'Endpoint path'),
    body: S('object', 'JSON body'),
    loginCustomerId: S('string', 'Override login-customer-id header'),
  }, ['path']),
];

// ─── tool handlers ────────────────────────────────────────────────────────────

const kw = (k, matchType) => (typeof k === 'string' ? { text: k, matchType } : { text: k.text, matchType: (k.matchType || matchType).toUpperCase() });
const assetText = (x) => (typeof x === 'string' ? { text: x } : prune({ text: x.text, pinnedField: x.pinnedField }));
const where = (...conds) => (conds.filter(Boolean).length ? ` WHERE ${conds.filter(Boolean).join(' AND ')}` : '');

async function handleCall(name, a) {
  switch (name) {
    case 'gads_customer': {
      if (a.action === 'list_accessible') return ok(await api('GET', 'customers:listAccessibleCustomers'));
      const c = cid(a);
      if (a.action === 'get') return ok(await search(c, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account, customer.status, customer.auto_tagging_enabled FROM customer'));
      if (a.action === 'list_clients') return ok(await search(c, 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level, customer_client.status, customer_client.currency_code FROM customer_client WHERE customer_client.level <= 1'));
      break;
    }
    case 'gads_query':
      return ok(await search(cid(a), a.query, a.maxRows || 1000));

    case 'gads_report': {
      const r = REPORTS[a.level];
      if (!r) throw new Error(`Invalid level: ${a.level}`);
      const filters = [dateClause(a), a.campaignId && `campaign.id = ${cleanId(a.campaignId)}`, a.adGroupId && `ad_group.id = ${cleanId(a.adGroupId)}`];
      const q = `SELECT ${r.fields}, ${METRICS} FROM ${r.from}${where(...filters)} ORDER BY ${a.orderBy || 'metrics.cost_micros'} DESC LIMIT ${a.limit || 100}`;
      return ok(await search(cid(a), q, a.limit || 100));
    }

    case 'gads_budget': {
      const c = cid(a);
      if (a.action === 'list') return ok(await search(c, 'SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros, campaign_budget.delivery_method, campaign_budget.explicitly_shared, campaign_budget.status, campaign_budget.reference_count FROM campaign_budget WHERE campaign_budget.status != REMOVED'));
      if (a.action === 'create') {
        return ok(await mutate(c, [opCreate('budget', prune({
          name: a.name, amountMicros: micros(a.amount), deliveryMethod: 'STANDARD', explicitlyShared: Boolean(a.shared), ...a.payload,
        }))], a));
      }
      if (a.action === 'update') a.payload = prune({ name: a.name, amountMicros: micros(a.amount), ...a.payload });
      const r = await lifecycle('budget', a.action, c, rn(c, 'budget', a.budgetId), a);
      if (r) return ok(r);
      break;
    }

    case 'gads_campaign': {
      const c = cid(a);
      if (a.action === 'list') {
        return ok(await search(c, 'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.start_date_time, campaign.end_date_time, campaign_budget.id, campaign_budget.amount_micros FROM campaign WHERE campaign.status != REMOVED ORDER BY campaign.name'));
      }
      if (a.action === 'create') {
        if (!a.budgetId && a.budgetAmount === undefined) throw new Error('Provide budgetAmount (new budget) or budgetId (existing).');
        const ops = [];
        let budget = a.budgetId && rn(c, 'budget', a.budgetId);
        if (!budget) {
          budget = `customers/${c}/campaignBudgets/-1`;
          ops.push(opCreate('budget', { resourceName: budget, name: `${a.name} budget ${Date.now()}`, amountMicros: micros(a.budgetAmount), deliveryMethod: 'STANDARD', explicitlyShared: false }));
        }
        const channel = (a.channelType || 'SEARCH').toUpperCase();
        ops.push(opCreate('campaign', prune({
          name: a.name,
          status: (a.status || 'PAUSED').toUpperCase(),
          advertisingChannelType: channel,
          campaignBudget: budget,
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          ...(channel === 'SEARCH' && {
            networkSettings: { targetGoogleSearch: true, targetSearchNetwork: Boolean(a.searchPartners), targetContentNetwork: Boolean(a.displayNetwork), targetPartnerSearchNetwork: false },
          }),
          startDateTime: dateTime(a.startDate),
          endDateTime: dateTime(a.endDate, true),
          ...bidding(a),
          ...a.payload,
        })));
        return ok(await mutate(c, ops, a));
      }
      const r = await lifecycle('campaign', a.action, c, rn(c, 'campaign', a.campaignId), a);
      if (r) return ok(r);
      break;
    }

    case 'gads_ad_group': {
      const c = cid(a);
      if (a.action === 'list') {
        return ok(await search(c, `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.cpc_bid_micros FROM ad_group${where('ad_group.status != REMOVED', a.campaignId && `campaign.id = ${cleanId(a.campaignId)}`)}`));
      }
      if (a.action === 'create') {
        return ok(await mutate(c, [opCreate('adGroup', prune({
          name: a.name, campaign: rn(c, 'campaign', a.campaignId), status: (a.status || 'ENABLED').toUpperCase(), type: 'SEARCH_STANDARD', cpcBidMicros: micros(a.cpcBid), ...a.payload,
        }))], a));
      }
      if (a.action === 'update') a.payload = prune({ name: a.name, cpcBidMicros: micros(a.cpcBid), ...a.payload });
      const r = await lifecycle('adGroup', a.action, c, rn(c, 'adGroup', a.adGroupId), a);
      if (r) return ok(r);
      break;
    }

    case 'gads_keyword': {
      const c = cid(a);
      if (a.action === 'list') {
        const filters = ["ad_group_criterion.type = KEYWORD", 'ad_group_criterion.status != REMOVED', a.adGroupId && `ad_group.id = ${cleanId(a.adGroupId)}`, a.campaignId && `campaign.id = ${cleanId(a.campaignId)}`];
        return ok(await search(c, `SELECT campaign.name, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.cpc_bid_micros FROM ad_group_criterion${where(...filters)}`));
      }
      if (a.action === 'add') {
        const ops = (a.keywords || []).map((k) => opCreate('adGroupCriterion', prune({
          adGroup: rn(c, 'adGroup', a.adGroupId), status: 'ENABLED', keyword: kw(k, (a.matchType || 'PHRASE').toUpperCase()), cpcBidMicros: micros(a.cpcBid),
        })));
        if (!ops.length) throw new Error('keywords is required.');
        return ok(await mutate(c, ops, a));
      }
      if (a.action === 'add_negative') {
        const mt = (a.matchType || 'EXACT').toUpperCase();
        const ops = (a.keywords || []).map((k) => (a.adGroupId
          ? opCreate('adGroupCriterion', { adGroup: rn(c, 'adGroup', a.adGroupId), negative: true, keyword: kw(k, mt) })
          : opCreate('campaignCriterion', { campaign: rn(c, 'campaign', a.campaignId), negative: true, keyword: kw(k, mt) })));
        if (!ops.length) throw new Error('keywords is required.');
        return ok(await mutate(c, ops, a));
      }
      if (a.action === 'remove_negative') return ok(await mutate(c, [opRemove('campaignCriterion', rn(c, 'campaignCriterion', a.campaignId, a.criterionId))], a));
      if (a.action === 'update') a.payload = prune({ cpcBidMicros: micros(a.cpcBid), ...a.payload });
      const r = await lifecycle('adGroupCriterion', a.action, c, rn(c, 'adGroupCriterion', a.adGroupId, a.criterionId), a);
      if (r) return ok(r);
      break;
    }

    case 'gads_ad': {
      const c = cid(a);
      if (a.action === 'list') {
        const filters = ['ad_group_ad.status != REMOVED', a.adGroupId && `ad_group.id = ${cleanId(a.adGroupId)}`, a.campaignId && `campaign.id = ${cleanId(a.campaignId)}`];
        return ok(await search(c, `SELECT campaign.name, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad${where(...filters)}`));
      }
      if (a.action === 'create_rsa') {
        return ok(await mutate(c, [opCreate('adGroupAd', {
          adGroup: rn(c, 'adGroup', a.adGroupId),
          status: (a.status || 'PAUSED').toUpperCase(),
          ad: prune({
            finalUrls: a.finalUrls,
            responsiveSearchAd: { headlines: (a.headlines || []).map(assetText), descriptions: (a.descriptions || []).map(assetText), path1: a.path1, path2: a.path2 },
            ...a.payload,
          }),
        })], a));
      }
      const r = await lifecycle('adGroupAd', a.action, c, rn(c, 'adGroupAd', a.adGroupId, a.adId), a);
      if (r) return ok(r);
      break;
    }

    case 'gads_conversion_action': {
      const c = cid(a);
      if (a.action === 'list') {
        return ok(await search(c, 'SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.counting_type, conversion_action.primary_for_goal, conversion_action.value_settings.default_value FROM conversion_action WHERE conversion_action.status != REMOVED'));
      }
      if (a.action === 'gtm_tag') {
        const res = await search(c, `SELECT conversion_action.id, conversion_action.name, conversion_action.tag_snippets FROM conversion_action${where(a.conversionActionId && `conversion_action.id = ${cleanId(a.conversionActionId)}`, 'conversion_action.status != REMOVED', 'conversion_action.type = WEBPAGE')}`);
        return ok(res.rows.map(({ conversionAction: ca }) => {
          const sendTo = (ca.tagSnippets || []).map((s) => s.eventSnippet?.match(/'send_to':\s*'(AW-\d+)\/([^']+)'/)).find(Boolean);
          return { id: ca.id, name: ca.name, conversionId: sendTo?.[1]?.replace('AW-', ''), conversionLabel: sendTo?.[2], sendTo: sendTo && `${sendTo[1]}/${sendTo[2]}` };
        }));
      }
      if (a.action === 'create') {
        return ok(await mutate(c, [opCreate('conversionAction', prune({
          name: a.name,
          type: (a.type || 'WEBPAGE').toUpperCase(),
          category: (a.category || 'DEFAULT').toUpperCase(),
          status: 'ENABLED',
          countingType: a.countingType && a.countingType.toUpperCase(),
          valueSettings: (a.value !== undefined || a.currencyCode) ? { defaultValue: a.value, defaultCurrencyCode: a.currencyCode, alwaysUseDefaultValue: false } : undefined,
          ...a.payload,
        }))], a));
      }
      const r = await lifecycle('conversionAction', a.action, c, rn(c, 'conversionAction', a.conversionActionId), a);
      if (r) return ok(r);
      break;
    }

    case 'gads_keyword_ideas': {
      if (!a.keywords?.length && !a.url) throw new Error('Provide keywords and/or url.');
      const seed = a.keywords?.length && a.url ? { keywordAndUrlSeed: { keywords: a.keywords, url: a.url } }
        : a.keywords?.length ? { keywordSeed: { keywords: a.keywords } } : { urlSeed: { url: a.url } };
      const r = await api('POST', `customers/${cid(a)}:generateKeywordIdeas`, {
        language: `languageConstants/${a.languageId || '1000'}`,
        geoTargetConstants: (a.geoTargetIds || ['2840']).map((g) => `geoTargetConstants/${g}`),
        keywordPlanNetwork: 'GOOGLE_SEARCH',
        pageSize: a.limit || 50,
        ...seed,
      });
      return ok((r.results || []).map((x) => ({ keyword: x.text, ...x.keywordIdeaMetrics, monthlySearchVolumes: undefined })));
    }

    case 'gads_mutate':
      return ok(await mutate(cid(a), a.operations, a));

    case 'gads_raw':
      return ok(await api((a.method || 'POST').toUpperCase(), a.path, (a.method || 'POST').toUpperCase() === 'GET' ? undefined : (a.body || {}), a.loginCustomerId));
  }
  throw new Error(`Invalid action "${a.action}" for ${name}`);
}

// ─── server wiring ────────────────────────────────────────────────────────────

const server = new Server({ name: 'google-ads-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await handleCall(req.params.name, req.params.arguments || {});
  } catch (err) {
    return bad(err);
  }
});

await server.connect(new StdioServerTransport());
console.error(`Google Ads MCP ready (API ${API_VERSION}, ${tools.length} tools).`);
