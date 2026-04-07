// Guide content — concise overview that routes agents to skill docs for details.
import { generateFlowGuide } from './flow-schema.js';

export const GUIDE_OVERVIEW = `# One CLI — Agent Guide

## Setup

1. Run \`one init\` to configure your API key
2. Run \`one add <platform>\` to connect platforms via OAuth
3. Run \`one --agent connection list\` to verify connections

## The --agent Flag

Always use \`--agent\` for machine-readable JSON output. It disables colors, spinners, and interactive prompts.

\`\`\`bash
one --agent <command>
\`\`\`

All commands return JSON. If an \`error\` key is present, the command failed.

## IMPORTANT: Read the guide before you act

Before using any feature, read its guide section first: \`one guide actions\`, \`one guide flows\`, or \`one guide relay\`. The guide teaches you the correct workflow, required fields, and common mistakes. Never guess — read the guide, then act.

## Features

### 1. Actions — Execute API calls on 250+ platforms
Search for actions, read their docs, and execute them. This is the core workflow.

**Quick start:**
\`\`\`bash
one --agent connection list                                    # See connected platforms
one --agent actions search <platform> "<query>" -t execute     # Find an action
one --agent actions knowledge <platform> <actionId>            # Read docs (REQUIRED)
one --agent actions execute <platform> <actionId> <key> -d '{}'  # Execute it
\`\`\`

**Parameter flags:**
- \`-d <json>\` — Request body (POST/PUT/PATCH)
- \`--path-vars <json>\` — URL path variables (e.g., \`{"userId": "me"}\`)
- \`--query-params <json>\` — Query parameters (arrays expand to repeated params)
- \`--form-url-encoded\` — Send as form data instead of JSON
- \`--dry-run\` — Preview request without executing

Do NOT pass path or query parameters in \`-d\` — use the correct flags.

### 2. Flows — Multi-step API workflows
Chain actions across platforms as JSON workflow files with conditions, loops, parallel execution, transforms, and AI analysis via bash steps.

**Quick start:**
\`\`\`bash
one --agent flow create <key> --definition '<json>'   # Create a workflow
one --agent flow validate <key>                       # Validate it
one --agent flow execute <key> -i param=value         # Execute it
one --agent flow list                                 # List all workflows
\`\`\`

**Key concepts:**
- Workflows are JSON files at \`.one/flows/<key>.flow.json\`
- 12 step types: action, transform, code, condition, loop, parallel, file-read, file-write, while, flow, paginate, bash
- Data wiring via selectors: \`$.input.param\`, \`$.steps.stepId.response\`, \`$.loop.item\`
- AI analysis via bash steps: \`claude --print\` with \`parseJson: true\`
- Use \`--allow-bash\` to enable bash steps, \`--mock\` for dry-run with mock responses

### 3. Relay — Webhook event forwarding between platforms
Receive webhooks from platforms (Stripe, GitHub, Airtable, Attio, Google Calendar) and forward event data to any connected platform using passthrough actions with Handlebars templates. No middleware, no code.

**Quick start:**
\`\`\`bash
one --agent relay event-types <platform>                        # See available events
one --agent relay create --connection-key <key> --create-webhook --event-filters '["event.type"]'
one --agent relay activate <id> --actions '[{"type":"passthrough","actionId":"...","connectionKey":"...","body":{...}}]'
one --agent relay list                                          # List endpoints
one --agent relay events --platform <p>                         # List received events
one --agent relay deliveries --endpoint-id <id>                 # Check delivery status
\`\`\`

**Key concepts:**
- \`passthrough\` actions map webhook fields to another platform's API using Handlebars: \`{{payload.data.object.email}}\`
- Template context: \`{{relayEventId}}\`, \`{{platform}}\`, \`{{eventType}}\`, \`{{payload}}\`, \`{{timestamp}}\`, \`{{connectionId}}\`
- \`--create-webhook\` auto-registers the webhook URL with the source platform
- Use \`actions knowledge\` to learn both the incoming payload shape AND the destination API shape before building templates

### 4. Sync — Local data sync for instant offline queries
Sync data from any connected platform into local SQLite. Query instantly without network calls.

**Quick start:**
\`\`\`bash
one --agent sync models shopify                                   # Discover models
one --agent sync init shopify orders --config '{...}'             # Create sync profile
one --agent sync run shopify --models orders --since 90d          # Sync data
one --agent sync query shopify/orders --where "status=unfulfilled"  # Query locally
one --agent sync search "refund"                                  # Full-text search (all platforms)
\`\`\`

## Topics

Request specific sections:
- \`one guide overview\` — This section
- \`one guide actions\` — Actions reference (search, knowledge, execute)
- \`one guide flows\` — Workflow engine reference (step types, selectors, examples)
- \`one guide relay\` — Webhook relay reference (templates, passthrough actions)
- \`one guide cache\` — Cache management (TTL, flags, commands)
- \`one guide sync\` — Data sync reference (profiles, pagination, queries)
- \`one guide all\` — Everything

## Important Notes

- **Always use \`--agent\` flag** for structured JSON output
- Platform names are always **kebab-case** (e.g., \`hub-spot\`, \`google-calendar\`)
- Always use the **exact action ID** from search results — don't guess
- Always read **knowledge** before executing any action
- Connection keys come from \`one connection list\` — don't hardcode them
`;

export const GUIDE_ACTIONS = `# One Actions — Reference

## Workflow: search → knowledge → execute

Always follow this sequence. Never skip the knowledge step.

### 1. List Connections

\`\`\`bash
one --agent connection list
\`\`\`

Returns platforms, status, connection keys, and tags.

### 2. Search Actions

\`\`\`bash
one --agent actions search <platform> "<query>" -t execute
\`\`\`

- Use \`-t execute\` when the user wants to perform an action
- Use \`-t knowledge\` (default) for documentation/code generation
- Returns up to 5 matching actions with IDs, methods, and paths

### 3. Get Knowledge

\`\`\`bash
one --agent actions knowledge <platform> <actionId>
\`\`\`

Returns full API docs: required fields, validation rules, request structure. **REQUIRED before execute.** The output includes a CLI PARAMETER MAPPING section showing which flags to use.

### 4. Execute

\`\`\`bash
one --agent actions execute <platform> <actionId> <connectionKey> [options]
\`\`\`

**Flags:**
- \`-d, --data <json>\` — Request body (POST/PUT/PATCH)
- \`--path-vars <json>\` — Path variables: \`{"userId": "me"}\`
- \`--query-params <json>\` — Query params: \`{"limit": "10"}\`
  - Arrays expand to repeated params: \`{"metadataHeaders": ["From", "Subject"]}\`
- \`--headers <json>\` — Additional headers
- \`--form-data\` / \`--form-url-encoded\` — Alternative content types
- \`--dry-run\` — Preview without executing

**Do NOT** pass path or query parameters in \`-d\`. Use the correct flags.

## Error Handling

All errors return JSON: \`{"error": "message"}\`. Check the \`error\` key.

## Notes

- Platform names are **kebab-case** (e.g., \`hub-spot\`)
- JSON flags use single quotes around the JSON to avoid shell escaping
- If search returns no results, try broader queries
- Access control settings from \`one config\` may restrict execution
`;

// Flow guide is generated from the schema descriptor in flow-schema.ts.
// This ensures documentation always matches the actual type definitions.
export const GUIDE_FLOWS = generateFlowGuide();

export const GUIDE_RELAY = `# One Relay — Reference

## Overview

Webhook relay receives events from platforms (Stripe, GitHub, Airtable, Attio, Google Calendar) and forwards them to any connected platform using passthrough actions with Handlebars templates.

## Commands

\`\`\`bash
one --agent relay event-types <platform>          # List available events
one --agent relay create --connection-key <key> --create-webhook --event-filters '["event.type"]'
one --agent relay activate <id> --actions '<json>' # Add forwarding actions
one --agent relay list                             # List endpoints
one --agent relay get <id>                         # Get endpoint details
one --agent relay update <id> --actions '<json>'   # Update endpoint
one --agent relay delete <id>                      # Delete endpoint
one --agent relay events --platform <p>            # List received events
one --agent relay event <id>                       # Get event with payload
one --agent relay deliveries --endpoint-id <id>    # Check delivery status
\`\`\`

## Building a Relay

1. **Discover connections** — identify source and destination platforms
2. **Get event types** — \`one --agent relay event-types <platform>\`
3. **Get source knowledge** — understand the incoming webhook payload shape (\`{{payload.*}}\` paths)
4. **Get destination knowledge** — understand the outgoing API body shape
5. **Create endpoint** — with \`--create-webhook\` and \`--event-filters\`
6. **Activate** — with passthrough action mapping source fields to destination fields

## Template Context

| Variable | Description |
|----------|-------------|
| \`{{relayEventId}}\` | Unique event UUID |
| \`{{platform}}\` | Source platform (e.g., \`stripe\`) |
| \`{{eventType}}\` | Event type (e.g., \`customer.created\`) |
| \`{{payload}}\` | Full incoming webhook body |
| \`{{timestamp}}\` | When the event was received |
| \`{{connectionId}}\` | Source connection UUID |
| \`{{json payload}}\` | Embed full payload as JSON string |

Access nested fields: \`{{payload.data.object.email}}\`

## Action Types

**passthrough** (primary) — forward to another platform's API:
\`\`\`json
{
  "type": "passthrough",
  "actionId": "<action-id>",
  "connectionKey": "<dest-connection-key>",
  "body": { "channel": "#alerts", "text": "New customer: {{payload.data.object.name}}" },
  "eventFilters": ["customer.created"]
}
\`\`\`

**url** — forward raw event to a URL:
\`\`\`json
{"type": "url", "url": "https://your-app.com/webhook", "eventFilters": ["customer.created"]}
\`\`\`

**agent** — send to an agent:
\`\`\`json
{"type": "agent", "agentId": "<uuid>", "eventFilters": ["customer.created"]}
\`\`\`

## Supported Source Platforms

Airtable, Attio, GitHub, Google Calendar, Stripe

Any connected platform can be a destination via passthrough actions.

## Debugging

1. \`relay get <id>\` — verify endpoint is active with actions configured
2. \`relay events --platform <p>\` — check events are arriving
3. \`relay deliveries --event-id <id>\` — check delivery status and errors
4. \`relay event <id>\` — inspect full payload to verify template paths
`;

export const GUIDE_CACHE = `# One Cache — Reference

## Overview

The One CLI caches \`actions knowledge\` and \`actions search\` responses locally so repeated calls serve instantly from disk instead of hitting the API. This is the single biggest latency win for agents who call knowledge for the same actions repeatedly.

Cache location: \`~/.one/cache/knowledge/\` and \`~/.one/cache/search/\`

## How It Works

- **First call**: fetches from the API, writes to cache, serves the response
- **Subsequent calls (within TTL)**: serves from cache instantly, no API call
- **After TTL expires**: makes a conditional request (ETag). If content unchanged, refreshes the cache timestamp. If changed, writes fresh data.
- **Network failure with stale cache**: serves the stale cache with a warning — never fails hard when a cache exists

Default TTL: 3600 seconds (1 hour). Configure via \`ONE_CACHE_TTL\` env var or \`cacheTtl\` in \`~/.one/config.json\`.

## What Gets Cached

| Cached | Not Cached |
|--------|-----------|
| \`actions knowledge\` (API docs, change infrequently) | \`actions execute\` (live data, always fresh) |
| \`actions search\` results | \`connection list\` (changes with add/remove) |

## Agent Mode \`_cache\` Metadata

In \`--agent\` mode, knowledge and search responses include a \`_cache\` field:

\`\`\`json
{
  "knowledge": "...",
  "method": "POST",
  "_cache": {
    "hit": true,
    "age": 1423,
    "fresh": true
  }
}
\`\`\`

Use this to programmatically decide whether to force-refresh.

## Cache Flags

\`\`\`bash
# Skip cache, fetch fresh (result still gets cached for next time)
one --agent actions knowledge <platform> <actionId> --no-cache

# Check cache status without fetching
one --agent actions knowledge <platform> <actionId> --cache-status

# Same for search
one --agent actions search <platform> "<query>" --no-cache
\`\`\`

## Cache Management Commands

\`\`\`bash
one cache list                    # List all cached entries with age and status
one cache list --expired          # List only expired entries
one cache clear                   # Delete all cached knowledge and search data
one cache clear <actionId>        # Delete one specific entry
one cache update-all              # Re-fetch fresh data for all cached entries
\`\`\`

All cache commands respect \`--agent\` for JSON output.

## When to Force-Refresh

- After a platform updates its API docs (rare)
- If you suspect stale data is causing issues
- Use \`one cache update-all\` to proactively warm the entire cache

## Configuration

| Setting | Source | Example |
|---------|--------|---------|
| TTL (seconds) | \`ONE_CACHE_TTL\` env var | \`ONE_CACHE_TTL=7200\` |
| TTL (seconds) | \`cacheTtl\` in \`~/.one/config.json\` | \`"cacheTtl": 7200\` |
| Default | — | 3600 (1 hour) |
`;

export const GUIDE_SYNC = `# One Sync — Reference

## Overview

Sync data from any connected platform into a local SQLite database. Query instantly without network calls, pagination, or rate limits.

## Concepts

- **Model**: A data type on a platform (e.g., shopify/orders, attio/people, gmail/messages)
- **Sync profile**: JSON config telling the CLI how to paginate and store a model's data
- **Sync run**: The CLI pages through all results and writes them to local SQLite
- **Sync state**: Checkpoint tracking so runs are incremental by default

## Setup Workflow: models → knowledge → init → run → query

\`\`\`bash
# 1. Discover available models
one --agent sync models shopify

# 2. Read knowledge for the list action to understand pagination/response shape
one --agent actions knowledge shopify "<actionId from step 1>"

# 3. Create sync profile based on what you learned
one --agent sync init shopify orders --config '{
  "platform": "shopify",
  "model": "orders",
  "connectionKey": "<from one list>",
  "actionId": "<from step 1>",
  "resultsPath": "orders",
  "idField": "id",
  "pagination": {
    "type": "link",
    "nextPath": "link.next.page_info",
    "passAs": "query:page_info"
  },
  "dateFilter": { "param": "created_at_min", "format": "iso8601" },
  "defaultLimit": 250,
  "limitParam": "limit"
}'

# 4. Run initial sync
one --agent sync run shopify --models orders --since 90d

# 5. Query local data
one --agent sync query shopify/orders --where "status=unfulfilled" --limit 20
\`\`\`

## Commands

### Discover Models
\`\`\`bash
one --agent sync models <platform>
\`\`\`
Lists data models with their list action IDs. Use these action IDs in sync profiles.

### Initialize Sync Profile
\`\`\`bash
# Get a template (pre-populated with action ID if found)
one --agent sync init <platform> <model>

# Save a complete profile
one --agent sync init <platform> <model> --config '<json>'
\`\`\`

### Run Sync
\`\`\`bash
one --agent sync run <platform> [--models m1,m2] [--since 90d] [--force] [--max-pages 10] [--dry-run]
\`\`\`
- Omit \`--models\` to sync all configured models for the platform
- \`--since\`: Duration (90d, 30d, 7d) or ISO date. Default: last sync or 90 days
- \`--force\`: Ignore checkpoints, start fresh
- \`--dry-run\`: Fetch first page only, don't persist
- State is saved after each page — interrupted syncs resume automatically

### Query Local Data
\`\`\`bash
one --agent sync query <platform>/<model> [--where "field=value"] [--after date] [--before date] [--limit n] [--order-by field] [--order asc|desc]
\`\`\`
- \`--where\`: Comma-separated conditions: \`"status=active,plan=pro"\`
- Operators: =, !=, >, <, >=, <=, like
- \`--refresh\`: Trigger incremental sync before querying
- \`--refresh-force\`: Full re-sync before querying
- Response includes \`lastSync\` and \`syncAge\` so you can judge freshness

### Full-Text Search
\`\`\`bash
one --agent sync search "<query>" [--platform <platform>] [--models m1,m2] [--limit 20]
\`\`\`
Uses SQLite FTS5 across all text fields. Searches all synced platforms by default, or filter with \`--platform\`. Results include rank scores.

### Raw SQL
\`\`\`bash
one --agent sync sql <platform> "SELECT count(*) FROM orders WHERE status = 'unfulfilled'"
\`\`\`
SELECT only — sync databases are read-only.

### List Syncs
\`\`\`bash
one --agent sync list [platform]
\`\`\`

### Remove Sync Data
\`\`\`bash
one --agent sync remove <platform> [--models m1,m2] [--yes]
\`\`\`

## Sync Profile Fields

| Field | Required | Description |
|-------|----------|-------------|
| platform | yes | Platform slug |
| model | yes | Model name |
| connectionKey | yes | Connection key for API calls |
| actionId | yes | The list action ID from sync models |
| resultsPath | yes | Dot-path to results array (e.g., "orders", "data.items") |
| idField | yes | Unique ID field on each record |
| pagination | yes | Pagination config (see below) |
| dateFilter | no | Date filter param and format |
| defaultLimit | no | Page size (default: 100) |
| limitParam | no | Query param for page size (default: "limit") |
| pathVars | no | Static path variables (e.g., {"userId": "me"}) |
| queryParams | no | Additional static query params |

## Pagination Types

**cursor** — cursor string at a response path:
\`{"type": "cursor", "nextPath": "pagination.next_cursor", "passAs": "query:cursor"}\`

**token** — Google-style nextPageToken:
\`{"type": "token", "nextPath": "nextPageToken", "passAs": "query:pageToken"}\`

**offset** — numeric offset incremented by page size:
\`{"type": "offset", "passAs": "query:offset", "totalPath": "total"}\`

**id** — Stripe-style starting_after:
\`{"type": "id", "idField": "id", "passAs": "query:starting_after", "hasMorePath": "has_more"}\`

**link** — cursor from Link header or response:
\`{"type": "link", "nextPath": "link.next.page_info", "passAs": "query:page_info"}\`

**none** — single request, no pagination:
\`{"type": "none"}\`

## File Layout

\`\`\`
.one/sync/
  profiles/{platform}_{model}.json    # sync profiles
  data/{platform}.db                  # SQLite databases
  sync_state.json                     # checkpoint tracking
\`\`\`

Sync data is stored in the project directory (\`.one/sync/\`), not globally. This keeps data scoped per project.

## Tips

- Always read \`actions knowledge\` before creating a sync profile — it tells you the response shape and pagination
- Use \`--dry-run\` first to verify your profile is correct
- Incremental sync is automatic — just run \`sync run\` again
- Use \`--refresh\` on queries to ensure fresh data without a separate sync command
- FTS search works across all text fields — great for finding specific records
`;

type GuideTopic = 'overview' | 'actions' | 'flows' | 'relay' | 'cache' | 'sync' | 'all';

const TOPICS: { topic: GuideTopic; description: string }[] = [
  { topic: 'overview', description: 'Setup, features, and quick start for each' },
  { topic: 'actions', description: 'Search, read docs, and execute platform actions' },
  { topic: 'flows', description: 'Build and execute multi-step workflows' },
  { topic: 'relay', description: 'Receive webhooks and forward to other platforms' },
  { topic: 'cache', description: 'Local caching for knowledge and search responses' },
  { topic: 'sync', description: 'Sync platform data locally for instant offline queries' },
  { topic: 'all', description: 'Complete guide (all topics combined)' },
];

export function getGuideContent(topic: GuideTopic): { title: string; content: string } {
  switch (topic) {
    case 'overview':
      return { title: 'One CLI — Agent Guide: Overview', content: GUIDE_OVERVIEW };
    case 'actions':
      return { title: 'One CLI — Agent Guide: Actions', content: GUIDE_ACTIONS };
    case 'flows':
      return { title: 'One CLI — Agent Guide: Workflows', content: GUIDE_FLOWS };
    case 'relay':
      return { title: 'One CLI — Agent Guide: Relay', content: GUIDE_RELAY };
    case 'cache':
      return { title: 'One CLI — Agent Guide: Cache', content: GUIDE_CACHE };
    case 'sync':
      return { title: 'One CLI — Agent Guide: Sync', content: GUIDE_SYNC };
    case 'all':
      return {
        title: 'One CLI — Agent Guide: Complete',
        content: [GUIDE_OVERVIEW, GUIDE_ACTIONS, GUIDE_FLOWS, GUIDE_RELAY, GUIDE_CACHE, GUIDE_SYNC].join('\n---\n\n'),
      };
  }
}

export function getAvailableTopics(): { topic: string; description: string }[] {
  return TOPICS;
}

// Platform demo actions (used by onboard)
export const PLATFORM_DEMO_ACTIONS: Record<string, { description: string; query: string }> = {
  'gmail': { description: 'List recent emails', query: 'list messages' },
  'google-calendar': { description: 'List upcoming events', query: 'list events' },
  'slack': { description: 'List channels', query: 'list channels' },
  'shopify': { description: 'List products', query: 'list products' },
  'hub-spot': { description: 'List contacts', query: 'list contacts' },
  'github': { description: 'List repositories', query: 'list repos' },
  'stripe': { description: 'List customers', query: 'list customers' },
  'notion': { description: 'Search pages', query: 'search' },
  'airtable': { description: 'List bases', query: 'list bases' },
  'linear': { description: 'List issues', query: 'list issues' },
};

export function getWorkflowExamples(connectedPlatforms: string[]): string[] {
  const examples: string[] = [];
  const has = (p: string) => connectedPlatforms.includes(p);

  if (has('gmail') && has('slack')) examples.push('Gmail → Slack: Forward important emails to a channel');
  if (has('stripe') && has('slack')) examples.push('Stripe → Slack: Notify on new payments');
  if (has('shopify') && has('gmail')) examples.push('Shopify → Gmail: Send order confirmation emails');
  if (has('hub-spot') && has('gmail')) examples.push('HubSpot → Gmail: Auto-email new leads');
  if (has('github') && has('slack')) examples.push('GitHub → Slack: Notify on new issues/PRs');

  if (examples.length === 0) {
    examples.push('Connect 2+ platforms to unlock cross-platform workflows');
    examples.push('Example: Stripe + Slack → Notify on new payments');
    examples.push('Example: Gmail + HubSpot → Auto-create contacts from emails');
  }

  return examples;
}
