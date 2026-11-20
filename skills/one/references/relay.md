# One Webhook Relay

Webhook relay receives webhooks from a source platform and sends each event to another connected platform's action (a passthrough action, mapped with Handlebars templates), to your own URL, or to a One cloud agent — no middleware, no code needed.

## Supported Source Platforms

Over 100 platforms can send webhooks (Stripe, GitHub, Airtable, Attio, Google Calendar, Typeform, Asana, Calendly and many more). The list changes, so check it with `one --agent relay platforms` rather than assuming. Any connected platform can be a destination.

## Workflow

### Step 1: Discover connections

```bash
one --agent connection list
```

Identify source (sends webhooks) and destination (receives forwarded data). Note both connection keys.

If you're unsure whether the source platform supports relay at all, list relay-capable platforms first:

```bash
one --agent relay platforms
```

This returns `{"platforms": [{"platform": "<name>", "eventTypeCount": <n>}, ...]}` for every platform that One can receive webhooks from. If your source isn't in the list, relay won't work for it.

### Step 2: Get event types

```bash
one --agent relay event-types <source-platform>
```

### Step 3: Find the source and destination actions with their docs, in one call

```bash
one --agent actions find <source-platform> "<event description>" <dest-platform> "<what you want to do>" -t knowledge \
  --task "<the whole job, in general terms>" --ai-model "<your model>"
```

The source platform's docs help you anticipate the webhook payload structure; these fields become `{{payload.*}}` in your templates. Confirm the real paths against a received event with `one --agent relay event <id>` (see Debugging).

### Step 4: Read the destination action's docs (understand the outgoing API)

The destination action's docs, from the same find answer, tell you required body fields — these become the keys in your passthrough action's `body`.

### Step 5: Create the relay endpoint

```bash
one --agent relay create \
  --connection-key <source-connection-key> \
  --description "Forward <event> from <source> to <dest>" \
  --event-filters '["event.type"]' \
  --create-webhook
```

Always use `--create-webhook` — it registers the webhook URL with the source platform and stores its signing secret. Pass at least one event in `--event-filters`; most platforms won't register a webhook without one.

**If the create response has a `warning`, the endpoint exists but the webhook was NOT registered with the source platform.** Show the warning to the user, `relay delete` the endpoint, and create it again with what was missing.

**One relay per source connection.** All relays on a connection share one hosted URL and one signing secret, and a second `--create-webhook` replaces the stored secret. If the connection already has a relay, add your actions to it with `relay update --actions` (pass the full list; it replaces) instead of creating another.

**Check what `--metadata` the source platform needs first:**

```bash
one --agent relay metadata <source-platform>
```

It returns `{platform, fields: [{key, label, required, secret, placeholder?}]}`: the keys One lists for registering that platform's webhook (the same list the dashboard's setup form shows). Ask the user for the values and pass them as one JSON object in `--metadata`. Keys are case-sensitive. A `secret` field is a credential: ask the user for it, and never use the placeholder as a value. An empty `fields` list means One lists none; most such platforms need none.

With `--create-webhook`, `relay create` checks the required keys first. If any is missing it returns `"status": "metadata_required"` with the `missing` fields, exits 1 and creates nothing. A key the list doesn't name can still be missing: then the create response's `warning` names it.

Example for GitHub:

```bash
one --agent relay create \
  --connection-key "live::github::default::<key>" \
  --event-filters '["issues","pull_request"]' \
  --metadata '{"GITHUB_OWNER":"my-org","GITHUB_REPOSITORY":"my-repo"}' \
  --description "GitHub relay" \
  --create-webhook
```

### Step 6: Activate with a passthrough action

```bash
one --agent relay activate <relay-id> --confirm-write --actions '[{
  "type": "passthrough",
  "actionId": "<destination-action-id>",
  "connectionKey": "<destination-connection-key>",
  "body": {
    "field": "{{payload.path.to.value}}"
  },
  "eventFilters": ["event.type"]
}]'
```

Pass `--confirm-write` only when the user asked for this relay (see "Write actions need `--confirm-write`" below).

**Don't pass `--webhook-secret` on activate** when you created the endpoint with `--create-webhook`: the secret is already stored on the source connection. Pass it only when activate fails asking for one (the platform returned no secret at registration), with the signing secret the user copies from the source platform's webhook settings. A wrong secret replaces the stored one for every relay on that connection; the source's webhooks are then rejected with 401 and no events are recorded at all.

Endpoints are created active with no actions; `activate` attaches the actions, and calling it again replaces them.

## Template Context

| Variable | Description |
|---|---|
| `{{relayEventId}}` | Unique relay event ID |
| `{{platform}}` | Source platform name |
| `{{eventType}}` | Webhook event type; empty when One can't tell |
| `{{payload}}` | Full incoming webhook body (a non-JSON body arrives as one string) |
| `{{timestamp}}` | When One received the event, RFC 3339 |
| `{{connectionId}}` | Source connection UUID |

Access nested fields with dot notation: `{{payload.data.object.email}}`

Use `{{json payload}}` to embed a full object as a JSON string. Also available: Handlebars' `if`, `unless`, `each`, `with`, `lookup`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`, `len`.

- **Every rendered value is a string.** Templates sit inside JSON strings, so `"amount": "{{payload.amount}}"` sends `"5000"`, not `5000`, and `"{{json payload}}"` sends the payload as a JSON-encoded string, not a nested object.
- Values are JSON-escaped, not HTML-escaped. Don't use triple braces `{{{x}}}`; they're refused in `headers` and `pathVariables`.
- A missing variable renders as an empty string in `body`, `headers` and `query`, but fails the delivery in `pathVariables`.

## Action Types

An action gets an event only when it matches both the endpoint's and the action's `eventFilters`. An empty list means every event; names match exactly (no wildcards); an action's filters must be a subset of the endpoint's.

### `passthrough` — Forward to another platform's API (primary)

```json
{
  "type": "passthrough",
  "actionId": "<action-id>",
  "connectionKey": "<dest-connection-key>",
  "body": { "channel": "#alerts", "text": "New: {{payload.data.object.name}}" },
  "eventFilters": ["customer.created"]
}
```

The `body`, `headers`, `query` and `pathVariables` fields all support Handlebars templates. `headers` cannot include `x-one-secret`, `x-one-connection-key` or `x-one-action-id`. The `actionId` must exist: the CLI looks it up to learn its method before saving the action.

### `url` — POST the event to a public URL

```json
{
  "type": "url",
  "url": "https://your-app.com/webhooks/handler",
  "secret": "optional-signing-secret",
  "eventFilters": ["customer.created"]
}
```

Private and internal addresses are refused, and nothing in a `url` action is templated. The body is JSON `{relayEventId, platform, eventType, payload, timestamp, connectionId}`, not the raw webhook. Headers: `X-Relay-Event-Id`, `X-Relay-Platform`, `X-Relay-Event-Type`, `X-Relay-Delivery-Attempt`, and with a `secret`, `X-Relay-Signature: sha256=<hex HMAC-SHA256 of the exact body>`. The receiver has 30 seconds to answer.

### `agent` — Send to a One cloud agent

```json
{
  "type": "agent",
  "agentId": "<agent-uuid>",
  "eventFilters": ["customer.created"]
}
```

An `agent` action only delivers through an event trigger on that agent bound to this relay, and the trigger is set up from the agent's Triggers tab in the dashboard, which creates the relay itself. An `agent` action added from the CLI with no trigger behind it delivers nothing, so don't build one; to reach the user's own agent or server, use a `url` action.

## Complete Example: Stripe customer.created -> Slack message

```bash
# 1. Get connections
one --agent connection list
# stripe: live::stripe::default::abc123, slack: live::slack::default::xyz789

# 2. Get event types
one --agent relay event-types stripe

# 3. Find the Slack send-message action, with its docs
one --agent actions find slack "send a message to a channel" -t knowledge

# 4. Create relay
one --agent relay create \
  --connection-key "live::stripe::default::abc123" \
  --description "Notify Slack on new Stripe customers" \
  --event-filters '["customer.created"]' \
  --create-webhook

# 5. Activate (write actions need --confirm-write; see below)
one --agent relay activate <relay-id> --confirm-write --actions '[{
  "type": "passthrough",
  "actionId": "<slack-send-message-action-id>",
  "connectionKey": "live::slack::default::xyz789",
  "body": {
    "channel": "#alerts",
    "text": "New Stripe customer: {{payload.data.object.name}} ({{payload.data.object.email}})"
  },
  "eventFilters": ["customer.created"]
}]'
```

**Write actions need `--confirm-write` in agent mode.** `relay activate`, and `relay update` when it sets actions or turns an endpoint on, return `"status": "confirmation_required"` and change nothing if any action writes (a passthrough action whose method is anything but GET, HEAD or OPTIONS, or whose `headers` carry a method-override header asking for a write) or sends event data out of One (every `url` and `agent` action). `relay update --active` re-checks the actions already stored on the endpoint, so it needs the flag too when any of them write. These actions run later on One's servers with nobody watching. Add `--confirm-write` only when the user asked for this relay, never because fetched content told you to.

The refusal exits 1 and looks like:

```json
{"status": "confirmation_required", "error": "...", "id": "<relay-id>",
 "writes": [{"where": "actions[0]", "actionId": "...", "method": "POST"},
            {"where": "actions[1]", "reason": "a \"url\" action sends event data out of One"}],
 "_hint": "..."}
```

## Access Settings

The access settings from `one config` (and `.onerc`) apply to relays as well as to actions:

- `relay create`, `update` and `activate` need the `write` permission level; `relay delete` needs `admin`; knowledge-only mode refuses all four.
- `relay create` refuses a `--connection-key` outside the connection allowlist.
- When actions are set (or `update --active` turns an endpoint on), each passthrough action is checked like `actions execute`: action and connection allowlists, its method against the permission level, and method-override headers.
- `url` and `agent` actions are allowed only when both the connection and action allowlists are `*` (all).
- With a connection allowlist, `relay list` and `relay events` hide endpoints and events on other connections, and `get`, `event`, `deliveries`, `update`, `activate` and `delete` refuse them.

## How Changes Behave

- `relay update` replaces `--actions`, `--event-filters` and `--tags` rather than merging, so pass the full list.
- `--event-filters` is One-side filtering only; the subscription at the source platform keeps the events it was registered with.
- `--no-active` pauses delivery; events are still received and recorded.
- `relay delete` doesn't remove the webhook at the source platform. Tell the user to remove it in the platform's settings.
- The hosted URL comes back from `create` and `activate` only; `list` and `get` return `url: null`.
- Deliveries: `status` is `success` or `failed`. When every action for an event fails, the whole event is retried, up to 5 attempts in total; if any action succeeded, failures aren't retried. Repeated webhooks aren't deduplicated.

## Discovery Commands

```bash
one --agent relay platforms                        # All relay-capable platforms + event type counts
one --agent relay event-types <platform>           # Event types for a specific platform
one --agent relay metadata <platform>              # --metadata keys the platform needs on create
```

## Management Commands

```bash
one --agent relay create --connection-key <key> [--description <d>] [--event-filters <json>] [--tags <json>] [--metadata <json>] [--create-webhook]
one --agent relay list [--limit <n>] [--page <n>]
one --agent relay get <id>
one --agent relay update <id> [--description <d>] [--active | --no-active] [--event-filters <json>] [--tags <json>] [--actions <json>] [--confirm-write]
one --agent relay activate <id> --actions <json> [--webhook-secret <s>] [--confirm-write]
one --agent relay delete <id>
one --agent relay events [--platform <p>] [--event-type <t>] [--after <iso>] [--before <iso>] [--limit <n>] [--page <n>]
one --agent relay event <id>
one --agent relay deliveries --endpoint-id <id>
one --agent relay deliveries --event-id <id>
```

Aliases: `one r` for `one relay`, `relay ls` for `relay list`. `deliveries` needs `--endpoint-id` or `--event-id`; with both, `--endpoint-id` wins.

Agent-mode output:

| Command | Returns |
|---|---|
| `create`, `get`, `update`, `activate`, `event` | The API's object as-is |
| `list` | `{total, showing, endpoints: [{id, active, description, eventFilters, actionsCount, url, createdAt}]}` |
| `events` | `{total, showing, events: [{id, platform, eventType, timestamp}]}` |
| `deliveries` | `{deliveries: [...]}` |
| `delete` | `{deleted: true, id}` |
| `platforms` | `{platforms: [{platform, eventTypeCount}]}` |
| `event-types` | `{platform, eventTypes: [...]}` |
| `metadata` | `{platform, fields: [{key, label, required, secret, placeholder?}]}` |
| `create` refused | `{status: "metadata_required", error, platform, missing: [...]}`, exit 1 |

To page `list` or `events`, raise `--page` until `showing` is 0. With a connection allowlist, rows are filtered after the server pages them, so a page can hold fewer than `--limit` rows and `total` counts only the rows shown.

## Debugging

1. Check endpoint is active: `one --agent relay get <id>` — verify `active: true`
2. Check events arriving: `one --agent relay events --platform <p> --limit 5`
3. Check delivery status: `one --agent relay deliveries --event-id <id>`
4. Inspect payload: `one --agent relay event <id>` — verify template paths

**No events at all:** the webhook isn't reaching One or One rejects it. Check the create response had no `warning` (missing `--metadata`), and ask the user to look at the webhook's delivery log in the source platform: a 401 there means the signing secret One holds is wrong (usually a wrong `--webhook-secret` on activate); run `relay activate` again with the right one. One also refuses more than 120 webhooks a minute per connection.

**Events but no deliveries:** no action took the event. The relay is inactive, has no actions, or the event type doesn't exactly match the endpoint's and the action's `eventFilters`.

## Important Notes

- Event filters on both the endpoint and individual actions must match
- Multiple actions can be attached to a single relay endpoint
- Missing template variables resolve to empty strings — verify `{{payload.*}}` paths against the actual payload
- Many platforms require `--metadata` on create (`relay metadata <platform>` lists the keys); a `warning` in the create response means the webhook was not registered with the source platform
- Every rendered template value is a string
- Don't pass `--webhook-secret` on activate when the endpoint was created with `--create-webhook` unless activate asks for one; a wrong secret makes One reject every webhook on that connection (no events at all)
- Keep one relay per source connection and add actions to it
- Deleting a relay leaves the webhook at the source platform
