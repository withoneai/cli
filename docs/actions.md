# Actions

Finding an action with its documentation, loading more of it, running it, and the local cache. Part of the [One CLI reference](./README.md).

## `one actions find <platform> <intent> [<platform> <intent> ...]`

Aliases: `one a f`. Find the action for every operation a task needs, across platforms, **with its documentation**, in one call: parameters, validation rules, request/response structure, and platform-specific quirks. One's decision model picks the action for each intent.

```bash
one actions find gmail "send an email"
one actions find hubspot "find a contact by email" gmail "send an email" --task "email a follow-up to a CRM contact"
one actions find shopify "list products" -t knowledge
```

- Each **intent** names the operation alone, in a few words (`"send a message to a channel"`), without its data: IDs, names and message text make the search miss. Up to 10 pairs. Name the platform before every intent, even when they share one (`stripe "list charges" stripe "list refunds"`); a "platform" containing a space is refused as an intent that slipped out of its pair.
- **`--task`** describes the whole job in one line, in general terms. Agents are asked to send it with every find, since it helps tell similar actions apart.
- **`-t knowledge`** searches the catalog for writing code and building flows and relays, which includes the platform's own (passthrough) endpoints; the default is the catalog for running actions now.
- **`--ai-model`** names the model running the CLI (e.g. `claude-sonnet-5`), recorded with the find beside the CLI and the harness that launched it, so the account's usage can report which model asked. Agents are asked to send it with every find.
- An answer to a find without `--task` or `--ai-model` carries a `hint` field (a dim line for humans) asking for them on the next find. Both stay optional.
- **`--no-knowledge`** lists the chosen actions (actionId, title, method, path) without fetching their documentation; load it later with `one actions load <actionId>`.

Each intent's answer gives the action(s) to use with their docs, any actions also needed beside them, a **substitute** when the model was unsure (use one or the other, never both), and a few alternatives, then says once how to execute. Always read the docs before executing. The access settings from `one config` apply: an action they refuse is never offered.

A platform name no active platform has (`clickup` for `click-up`) is answered with `selector: "unknown_platform"` and a `suggestions` list of the platforms it may have meant, closest first, instead of being searched. Find again with the right name; `one platforms` lists them all.

Large documents (over about 8,000 characters) come back as a **digest**: request-building sections in full (method/URL, headers, description, enforcement rules, required parameters, sample request, gotchas, error handling, plus optional parameters when they fit), then a notice naming what was left out with the exact command to load it. In knowledge-only mode the first pick of each intent comes back whole, with how to call it from code; other chosen actions are listed in `alsoSelected` to load.

## `one actions load <actionId...>`

More of an action's documentation: the digest by default (how to read an alternative from a find answer), or a section a digest left out, the whole document, or its table of contents. Up to 10 action ids. Alias: `one a l`.

```bash
one --agent actions load <actionId> --section "Response Fields"  # one section, by heading or id
one --agent actions load <actionId> --section response,examples  # several, by alias
one --agent actions load <actionId> --full                       # whole document
one --agent actions load <actionId> --toc                        # every section id, no document
```

Loads are served from the local cache once a doc is cached. `--section all` returns the whole document. When several flags are given, `--section` wins over `--toc`, which wins over `--full`. In knowledge-only mode `load` always returns the whole document with how to call it from code. Agent output: `{"loaded": [{"actionId", "title", "method", "path", "knowledge", "truncated"} | {"actionId", "error"}], "guide": "..."}`.

## `one actions execute <platform> <actionId> <connectionKey>`

Execute an API action on a connected platform. Alias: `one a x`.

```bash
# Simple GET
one actions execute shopify <actionId> <connectionKey>

# POST with data
one actions execute hubspot <actionId> <connectionKey> \
  -d '{"properties": {"email": "jane@example.com", "firstname": "Jane"}}'

# With path variables
one actions execute shopify <actionId> <connectionKey> \
  --path-vars '{"order_id": "12345"}'

# With query params
one actions execute stripe <actionId> <connectionKey> \
  --query-params '{"limit": "10"}'
```

| Option | What it does |
|--------|-------------|
| `-d, --data <json>` | Request body (POST, PUT, PATCH) |
| `--path-vars <json>` | Replace `{variables}` in the URL path |
| `--query-params <json>` | Query string parameters; arrays expand to repeated keys (`{"ids":["a","b"]}` → `?ids=a&ids=b`) |
| `--headers <json>` | Additional request headers |
| `--form-data` | Send as multipart/form-data (text fields; object values are JSON-encoded; no file upload) |
| `--form-url-encoded` | Send as application/x-www-form-urlencoded |
| `--dry-run` | Show the request without executing it |
| `--mock` | Return example response without making an API call |
| `--skip-validation` | Skip input validation against the action schema |
| `--confirm-write` | Required in agent mode for an action that writes (POST, PUT, PATCH, DELETE). Without it the command returns `confirmation_required` and sends nothing. It marks the write for the user's approval prompt and doesn't check anything itself, so an agent should pass it only for a change the user asked for. Not needed with `--dry-run` or `--mock`. A GET carrying a method-override header counts as a write |
| `--output <path>` | Save a binary response to a file (PDFs, images). Text and JSON responses (text/plain, HTML, CSV, XML) always print inline and are not saved. |
| `--no-cache` | Bypass the cached action details and re-fetch them; the fresh details still refresh the cache (execution itself is never cached) |

The CLI validates required parameters (path variables, query params, body fields) against the action schema before executing, including before `--mock`. Missing params return a clear error with the flag name and description. Pass `--skip-validation` to bypass.

Agent-mode output: `{"dryRun": false, "request": {"method", "url"}, "response": ..., "_preflight": {"cache": "hit"|"miss"}}` (with `--dry-run` the request also shows `headers` and `data`, the key redacted). `--mock` returns `{"mock": true, "request", "response", "_preflight"}`. A write refused for lack of `--confirm-write` returns `{"status": "confirmation_required", "error", "request": {...}, "_hint"}` and exits 1.

### Parallel execution

Execute multiple actions concurrently with `--parallel`, separating each action with `--`:

```bash
one --agent actions execute --parallel --confirm-write \
  gmail send-email conn123 -d '{"to":"a@b.com","subject":"Hi","body":"Hello"}' \
  -- slack post-message conn456 -d '{"channel":"#general","text":"Done"}' \
  -- google-sheets append-row conn789 -d '{"values":["x","y"]}'
```

Each segment follows the same format: `<platform> <actionId> <connectionKey> [-d ...] [--path-vars ...] [--query-params ...] [--headers ...] [--form-data | --form-url-encoded]` (`--output` isn't supported per segment). The global flags `--dry-run`, `--mock`, `--skip-validation`, `--no-cache`, `--confirm-write` and `--max-concurrency <n>` (space-separated, not `=`) apply to every segment; in agent mode one `--confirm-write` covers the batch, and a batch with an unconfirmed write runs nothing. All segments are validated upfront before any execution starts; a bad segment returns `{"error": "Validation failed", "segments": [...]}`. Results are collected via `Promise.allSettled` — if one fails, the rest still complete, and the command exits 1 when any segment failed.

| Option | What it does |
|--------|-------------|
| `--parallel` | Enable parallel mode |
| `--max-concurrency <n>` | Max concurrent actions per batch (default: 5) |

Agent-mode output includes `parallel: true`, per-action `segment`/`platform`/`actionId`/`status`/`durationMs`/`response` (or `error`)/`_preflight` (`{"cache":"hit"|"miss"}`), plus `totalDurationMs`, `succeeded`, and `failed` counts.

## `one cache`

Manage the local cache of action documentation. `actions find` and `actions load` read each action's details (docs, method, path, validation schema) through the cache, so repeated reads serve instantly from disk, and `actions execute` reuses them for its preflight lookup, so a find followed by execute costs a single API round trip for the execute.

```bash
one cache list                    # List all cached entries with age and status (alias: cache ls)
one cache list --expired          # Show only expired entries
one cache clear                   # Clear all cached data
one cache clear <actionId>        # Clear a specific entry
one cache update-all              # Re-fetch fresh data for all cached entries
```

Find, load and execute also support cache flags:

```bash
one actions find gmail "send an email" --no-cache       # Fetch the docs fresh
one actions load <actionId> --no-cache                  # Skip cache, fetch fresh
one actions load <actionId> --cache-status              # Check cache status
one actions load <actionId> --section response          # Served from the cached doc, no fetch
one actions execute gmail <actionId> <key> --no-cache   # Fresh action-details lookup
```

Default TTL is 1 hour. Configure via `ONE_CACHE_TTL` environment variable (seconds) or `cacheTtl` in `~/.one/config.json`.

`--cache-status` prints a JSON array, one entry per action id, even without `--agent`. Agent output: `cache list` → `{"entries": [{type, key, cachedAt, age, ttl, fresh, etag, path}]}`; `cache clear` → `{"cleared": true, "count": N}`; `cache update-all` → `{"updated", "failed", "errors"?}`.

Note: execution responses are never cached — the action always runs live. Only action metadata (docs, method, path, schema) is cached, and agent-mode execute output reports it via `"_preflight": {"cache": "hit"|"miss"}`.
