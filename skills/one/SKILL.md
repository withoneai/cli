---
name: one
description: |
  Use the One CLI (`one`) to interact with 250+ third-party platforms — Gmail, Slack, Shopify, HubSpot, Stripe, GitHub, Notion, Salesforce, and more — through their APIs. One handles authentication, request building, and execution through a single unified interface.

  TRIGGER when the user wants to:
  - Interact with ANY third-party platform or external service (e.g., "send an email", "create a Shopify order", "look up a HubSpot contact", "post to Slack")
  - List their connected platforms or check what integrations are available
  - Search for what they can do on a platform (e.g., "what can I do with Gmail")
  - Execute any API call against a connected platform
  - Set up webhook-driven automations between platforms (e.g., "when a Stripe payment comes in, notify Slack")
  - Build multi-step workflows that chain actions across platforms (e.g., "fetch Stripe customers and email each one")
  - Anything involving third-party APIs, integrations, or connected apps — even if they don't mention "One" by name

  DO NOT TRIGGER for:
  - Setting up One or installing MCP (that's `one init`)
  - Adding new connections (that's `one add <platform>`)
  - Configuring access control (that's `one config`)
---

# One CLI

You have access to the One CLI which lets you interact with 250+ third-party platforms through their APIs. Always include the `--agent` flag right after `one` for structured JSON output.

If the user wants a separate API key / connections for a specific project (vs. their default), walk them through running `one init` from that project folder and picking the "project" scope — see `references/scoping.md`.

## Core Workflow: search -> knowledge -> execute

Always follow this sequence when the user wants to do something on a connected platform:

### 1. List connections

```bash
one --agent connection list
```

Returns connected platforms with their connection keys (needed for execution) and platform names in kebab-case (needed for searching).

### 1b. Delete a connection

```bash
one --agent connection delete <connection-key>
```

Removes a connection. Returns `{"deleted": true, "platform": "...", "key": "..."}` on success. Use the connection key from `one --agent connection list`.

### 2. Search for the right action

```bash
one --agent actions search <platform> "<query>" -t execute
```

- Platform names are always kebab-case: `gmail`, `hub-spot`, `ship-station`
- Use `-t execute` when performing actions, `-t knowledge` when researching or writing code
- If no results, broaden the query (e.g., `"list"` instead of `"list active premium customers"`)

### 3. Get the action's knowledge (REQUIRED before executing)

```bash
one --agent actions knowledge <platform> <actionId>
```

This tells you exactly what parameters are required, how to structure the request, and which flags to use. Never skip this step — without it you'll guess wrong on parameters.

### 4. Execute

```bash
one --agent actions execute <platform> <actionId> <connectionKey> [options]
```

Options:
- `-d, --data <json>` — Request body (POST, PUT, PATCH)
- `--path-vars <json>` — Path variables for URLs with `{id}` placeholders
- `--query-params <json>` — Query parameters
- `--headers <json>` — Additional headers
- `--form-data` — Send as multipart/form-data
- `--form-url-encoded` — Send as application/x-www-form-urlencoded
- `--dry-run` — Preview the request without executing

Examples:
```bash
# Simple GET
one --agent actions execute shopify <actionId> <connectionKey>

# POST with body data
one --agent actions execute hub-spot <actionId> <connectionKey> \
  -d '{"properties": {"email": "jane@example.com", "firstname": "Jane"}}'

# Path variables + query params
one --agent actions execute shopify <actionId> <connectionKey> \
  --path-vars '{"order_id": "12345"}' \
  --query-params '{"limit": "10"}'

# Array query params (expand to repeated keys)
one --agent actions execute gmail <actionId> <connectionKey> \
  --path-vars '{"userId": "me", "id": "msg123"}' \
  --query-params '{"format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]}'
```

## Error Handling

All errors return JSON: `{"error": "message"}`. Parse output as JSON and check for the `error` key.

## Important Rules

- Always use `--agent` flag for structured JSON output
- Platform names are always kebab-case (`hub-spot` not `HubSpot`)
- Always use the exact action ID from search results — never guess or construct them
- Always read knowledge before executing — it has required params, validation rules, and caveats
- JSON values passed to `-d`, `--path-vars`, `--query-params` must be valid JSON (use single quotes around JSON to avoid shell escaping)
- Do NOT pass path or query parameters inside the `-d` body flag

## Caching

Knowledge and search responses are cached locally (`~/.one/cache/`). Subsequent calls for the same action serve instantly from disk.

- Cache is automatic — no setup required
- Default TTL: 1 hour (configurable via `ONE_CACHE_TTL` env var)
- In `--agent` mode, responses include a `_cache` field: `{"hit": true, "age": 1423, "fresh": true}`
- Use `--no-cache` to force a fresh fetch: `one --agent actions knowledge <platform> <actionId> --no-cache`
- Use `--cache-status` to check cache state without fetching
- Manage cache: `one cache list`, `one cache clear`, `one cache update-all`
- `actions execute` is NEVER cached — always fresh

## Local Data Sync

Sync platform data into local SQLite for instant queries, full-text search, and change-driven automation. Requires one-time `one sync install`.

### Setup: init → run

```bash
# 1. Install engine (once per machine)
one sync install && one sync doctor

# 2. Discover models + create profile (one command does everything)
one --agent sync models stripe
one --agent sync init stripe balanceTransactions
# Init auto-resolves connectionKey (if one connection), infers all fields,
# and runs sync test automatically. Check _complete and _test in response.
# If multiple connections exist, patch just the key:
one --agent sync init stripe balanceTransactions --config '{"connectionKey":"<from one list>"}'

# 3. Sync
one --agent sync run stripe --models balanceTransactions --since 90d
```

### Querying
```bash
one --agent sync query stripe/balanceTransactions --where "status=available" --limit 20
one --agent sync search "refund" --platform stripe          # FTS across all text fields
one --agent sync sql stripe "SELECT count(*) FROM balanceTransactions"
one --agent sync query stripe/balanceTransactions --refresh  # sync first, then query
one --agent sync list stripe                                 # check freshness
```

### Scheduled syncs
```bash
one sync schedule add stripe --every 1h
one --agent sync schedule list       # works from any directory
one --agent sync schedule status     # drift detection + log tails
one sync schedule remove <id>        # by id from anywhere
```

### Record enrichment
When a list endpoint returns lightweight records (just IDs), enrich with a detail endpoint:
```bash
one --agent sync init gmail messages --config '{
  "enrich": {
    "actionId": "<get-message-action-id>",
    "pathVars": {"messageId": "{{id}}"},
    "concurrency": 3
  }
}'
```
Uses `{{field}}` interpolation from the list record. Rate-limit-aware: honors Retry-After, exponential backoff, adaptive concurrency reduction on 429s. Enrichment runs before hooks — `onInsert` gets the full data.

### Exclude fields
Strip large/unwanted fields before storing (e.g. base64 attachments):
```bash
one --agent sync init gmail gmailThreads --config '{"exclude": ["messages[].body", "messages[].attachments[].data"]}'
```

### Monitoring progress
`sync list` is your progress monitor — state updates after every page:
```bash
one --agent sync list gmail
# While syncing: {"status":"syncing","totalRecords":400,"pagesProcessed":8,...}
# When done:     {"status":"idle","totalRecords":1200,"pagesProcessed":24,...}
```

### Record transform
Pipe records through any shell command before storing — flatten nested fields, filter, reshape:
```bash
one --agent sync init notion search --config '{
  "transform": "jq '\''[.[] | . + {flat_title: (.properties.title.title[0].plain_text // null)}]'\''",
}'
```
Receives JSON array on stdin, returns JSON array on stdout. Supports `jq`, `python3`, bash scripts, or `one flow execute <key>`. Falls back to original records on failure.

### Change hooks (CDC)
Add hooks to a sync profile to trigger automation on new/changed records:
```bash
one --agent sync init stripe balanceTransactions --config '{
  "onInsert": "one flow execute process-new-transaction",
  "onUpdate": "log"
}'
```
- **Shell command**: record events piped as NDJSON to stdin
- **`"log"`**: appends to `.one/sync/events/<platform>_<model>.jsonl`
- **Flow execution**: `one flow execute <key>` with record as input

Events fire per-page (real-time). Format: `{"type":"insert|update","record":{...},"timestamp":"..."}`

### Deletion detection
```bash
one --agent sync run stripe --full-refresh   # fetch ALL, delete stale local rows
```

### Key points
- `sync init` is a single command: resolves action ID, infers all profile fields, auto-resolves connectionKey when there's one connection, and auto-runs `sync test` when the profile is complete — check `_complete`, `_test`, and `_inferred` in the response
- If `_complete: true` and `_test.ok: true`, go straight to `sync run` — no manual steps needed
- Path variables (calendarId, userId) are auto-extracted with smart defaults; internal keys (INTERNAL_SIGNING_KEY) are stripped automatically
- Every record has `_synced_at` — use it to track processing state
- `--full-refresh` handles source-side deletions by diffing local vs remote IDs
- Queries include `lastSync` and `syncAge` for freshness judgment
- `sync remove --dry-run` previews deletions before committing
- Read `one guide sync` for the full reference including pagination types and profile schema

## Beyond Single Actions

One also supports more advanced patterns. Read the relevant reference file before using these:

- **Webhook Relay** — Receive webhooks from a platform and forward to another (e.g., Stripe event -> Slack message). Read `references/relay.md` in this skill's directory for the full workflow.
- **Multi-step Workflows** — Chain actions across platforms as JSON workflow files (like n8n/Zapier but file-based). Read `references/flows.md` in this skill's directory for the schema and examples.

## Adding New Connections

If the user needs a platform that isn't connected yet, tell them to run:
```bash
one add <platform>
```
This is interactive and opens the browser for OAuth. After connecting, the platform will appear in `one --agent connection list`.

## Removing Connections

To delete a connection that is no longer needed:
```bash
one --agent connection delete <connection-key>
```
The connection key comes from `one --agent connection list`. Returns `{"deleted": true, "platform": "...", "key": "..."}` on success.
