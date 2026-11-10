# Google Ads MCP

An MCP server that lets an AI assistant (Devin, Claude Desktop, Cursor, …) **read and change** your Google Ads account: run reports, create and edit campaigns, budgets, ad groups, keywords, ads and conversion actions.

It uses the Google Ads REST API (v26) with **your own** Google OAuth client and developer token. Credentials stay on your machine in `~/.google-ads-mcp/config.json`.

## Safety defaults

- New **campaigns and ads are created `PAUSED`**, so nothing spends money until you enable it.
- Every tool that makes changes accepts `validateOnly: true`, which checks the change without applying it.
- Budgets and bids are entered in **account currency** (e.g. `20` = 20.00/day) and converted to micros for you.

## Tools

| Tool | Actions |
|---|---|
| `gads_customer` | `list_accessible`, `get`, `list_clients` (MCC child accounts) |
| `gads_query` | Run any GAQL query (auto-paginated) |
| `gads_report` | Performance at `account` / `campaign` / `ad_group` / `keyword` / `search_term` / `ad` level |
| `gads_budget` | `list`, `create`, `update`, `remove` |
| `gads_campaign` | `list`, `create` (Search campaign + budget in one step), `update`, `pause`, `enable`, `remove` |
| `gads_ad_group` | `list`, `create`, `update`, `pause`, `enable`, `remove` |
| `gads_keyword` | `list`, `add`, `add_negative`, `remove_negative`, `update`, `pause`, `enable`, `remove` |
| `gads_ad` | `list`, `create_rsa` (Responsive Search Ad), `update`, `pause`, `enable`, `remove` |
| `gads_conversion_action` | `list`, `create`, `update`, `remove`, `gtm_tag` (Conversion ID + Label for a GTM Google Ads conversion tag) |
| `gads_keyword_ideas` | Keyword Planner ideas: search volume, competition, bid ranges |
| `gads_mutate` | Any combination of GoogleAdsService MutateOperations, applied atomically |
| `gads_raw` | Call any Google Ads REST endpoint directly |

## Setup

### 1. Google Cloud OAuth client (one-time)

1. Enable the **Google Ads API**: https://console.cloud.google.com/apis/library/googleads.googleapis.com
2. **OAuth consent screen**: https://console.cloud.google.com/apis/credentials/consent — User type *External*, then add your Google email under **Test users**.
3. **Credentials**: https://console.cloud.google.com/apis/credentials, then *Create credentials → OAuth client ID → Desktop app*. Copy the Client ID and Client secret.

### 2. Google Ads developer token

In a Google Ads **manager (MCC) account**: *Tools → API Center*. A new token starts at *Test* access, which only works with test accounts. Apply for **Basic access** to use it on real accounts.

### 3. Sign in

```bash
npx -y github:iammalekk/google-ads-mcp auth
```

Paste the client ID, client secret and developer token. Optionally add your MCC customer ID (if you reach accounts through a manager) and a default customer ID. A browser window opens for Google sign-in.

### 4. Add it to your MCP client

```json
{
  "mcpServers": {
    "Google Ads MCP": {
      "command": "npx",
      "args": ["-y", "github:iammalekk/google-ads-mcp"]
    }
  }
}
```

Restart the client, then ask: *"List my Google Ads accounts"*.

## Other commands

```bash
npx -y github:iammalekk/google-ads-mcp status   # show saved config
npx -y github:iammalekk/google-ads-mcp logout   # delete saved credentials
```

## Environment overrides

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_API_VERSION` (default `v26`).

## License

MIT
