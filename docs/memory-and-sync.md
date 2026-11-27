# Memory and sync

The local memory store, and syncing platform data into it. Part of the [One CLI reference](./README.md).

## `one mem` — unified memory store

One ships a local memory store (a real Postgres process bootstrapped on demand via the bundled `embedded-postgres` plugin, with a `postgres` plugin for remote/self-hosted) that backs both user-authored notes and synced platform data. **Zero-config** — the first `one mem` call on a fresh machine auto-initializes the cluster at `~/.one/pg/cluster/` and writes a daemon PID file so subsequent CLI invocations reuse it. The daemon listens on port 5434, moving to the next free port if another program already holds it; pin a port with `one mem config set embedded-postgres.port <n>`. Every connection to it needs a password: one is generated per install and kept in `~/.one/pg/.pgserve-auth.json`, readable only by you.

```bash
# User memories — works immediately on a new install
one mem add note '{"content":"Design review is Thursday"}' --tags work --weight 7
one mem update <id> '{"status":"done"}'              # merges into data; refreshes searchable_text
one mem search "design review"                       # FTS; hybrid with an OpenAI key + pgvector
one mem search "design review" --deep                # hybrid or an error naming what's missing (no FTS fallback)
one mem list note --limit 20

# Merge keys (`keys[]`) are a first-class column (unique across ACTIVE records;
# archiving frees them). Manage them after creation with `mem key` — NOT `mem update`.
one mem key <id> --add email:x@y.com                 # also --remove / --set <csv>

# Find every record tied to a person/company, grouped by type. Spans BOTH columns:
# `keys[]` (this record IS the entity — drives merge) and `identity_keys[]` (this
# record INVOLVES the entity — Gmail thread participants, calendar attendees; never merges).
one mem find-by-key email:jane@acme.com              # every record carrying the key
one mem find-by-key email:jane@acme.com --type gmail/gmailThreads
one mem find-by-key email:jane@acme.com email:bob@acme.com   # intersection — records with BOTH

# Backfill searchable_text for rows that landed NULL (add --all to also rewrite
# stale or noisy text). Uses the generic text builder (drops ids/timestamps, leads
# with name/title/email), not the profile's memory.searchable. No embedding provider needed.
one mem reindex --searchable --type attio/attioPeople

# Listing synced platform rows — type is positional and namespaced as <platform>/<model>;
# there is NO --platform flag and NO platform column in the schema.
one mem list "gmail/gmailThreads"
one mem list "attio/attioPeople" --limit 5

# Enable semantic search (optional): needs an OpenAI key AND pgvector.
# The bundled Postgres has no pgvector: `brew install pgvector`, or use a postgres
# backend with the `vector` extension. `searchMode` in search output says which ran.
one init                                             # first-time setup prompts for it; on a re-run pick "Add OpenAI key"
# OR
one mem config set embedding.apiKey sk-...           # writes top-level openaiApiKey
# OR
export OPENAI_API_KEY=sk-...                         # no persistence

# Status + diagnostics
one mem status                                       # backend, provider, _upgrade hint
one mem doctor                                       # 7-check health report
```

Key surfaces: `status`, `init`, `config`, `doctor`, `add`, `get`, `update`, `archive`, `weight`, `list`, `search`, `context`, `link`/`linked`/`unlink`, `key`, `sources`, `find-by-source`, `find-by-key`, `sql`, `export`, `import`, `migrate`, `vacuum`, `reindex`, and `sync` (alias of `one sync`). `flush` exists but is not implemented yet. There is no `unarchive`. Run `one guide memory` for the full reference.

`mem sql "<query>"` runs one read-only `SELECT`/`WITH`/`EXPLAIN` in a read-only transaction (on the embedded store as a read-only role). Its keyword guard also refuses words like `start`, `do` or `set local` inside string literals and JSON paths.

**Your own Postgres.** `one mem config set backend postgres`, then `one mem config set postgres.connectionString <url>` (or set `MEM_DATABASE_URL`, read only when the backend is `postgres`). Data doesn't move with the switch: `one mem export backup.jsonl`, switch, `one mem import backup.jsonl`. Import skips records without `keys[]`, brings archived rows back active, and copies neither links nor embeddings.

`find-by-key` is the cross-platform join: lookups are lowercased and trimmed (sync writes keys that way), with one retry using the exact string you typed for hand-written mixed-case keys, `--type` narrows to one record type, and `--limit` (default 10) caps how many records are *shown per type* while the reported per-type `count` and overall `total` stay full match counts. Above 2000 matches the response flags `truncated` and the counts become floors — re-run with `--type` for an exact answer. Populate `identity_keys[]` from a sync profile's `identityKeys` field (see `one guide sync`), which ships pre-wired for `gmail/gmailThreads`, `google-calendar/events`, and `fathom/meetings`.

## `one sync` (and `one mem sync` alias)

Sync platform data into the unified memory store for instant queries, hybrid FTS + semantic search, scheduled refresh, and change-driven automation. Memory is always written; pass `--no-memory` to skip (rare).

```bash
# Discover → init (seeds from built-in, auto-tests) → declare searchable → preview → run
one sync models stripe
one sync init stripe balanceTransactions

# Optional: declare clean fields for embedding, then preview
# (--config merges into the existing profile. Without it, init refuses when a
# profile already exists; --force replaces it with the built-in)
one sync init stripe balanceTransactions --config '{
  "memory": {
    "embed": true,
    "searchable": ["description","type","amount","currency"]
  }
}'
one sync test stripe/balanceTransactions --show-searchable

# Run — every row lands in memory (enriching profiles also keep a project-local
# SQLite mirror). Rows are embedded when the profile's memory.embed says so (else
# defaults.embedOnSync); --embed / --no-embed override it for one run.
# --since only applies to profiles with a dateFilter (Stripe has none).
one sync run stripe
one mem sync run stripe                              # identical (alias)
# Profiles with `enrich` run a second detail pass. It enriches each record ONCE;
# the list pass thereafter merges rather than replaces, so the enriched payload
# survives (reported as `memPreserved`). `--full-refresh` reconciles deletions,
# it does not refresh detail content. To refresh detail:
one sync run gmail --re-enrich                       # re-fetch every detail endpoint
# ...or set `enrich.invalidateOn` in the profile (e.g. "historyId", "updated_at")
# so only records that actually changed upstream are re-enriched, automatically.

# Query + search (reads from memory)
one sync query stripe/balanceTransactions --where "status=available" --limit 20
one sync query stripe/customers --where 'address.city=SF'   # dotted paths supported
one sync search "refund"                             # this project's synced models

# Schedule unattended syncs + change hooks
one sync schedule add stripe --every 1h
one sync init stripe balanceTransactions --config '{"onInsert":"one flow execute handle-new-txn"}'

# Deletion detection: archives memory rows whose source is gone
one sync run stripe --full-refresh
```

`--where` takes `field<op>value` conditions joined by commas (AND); ops are `=`, `!=`, `>`, `<`, `>=`, `<=` and `like` with `%`. `sync search` covers only the models with a profile in this project; `one mem search "..." --type <p>/<m>` works from anywhere. A first `sync run` fetches the last 90 days for profiles with a `dateFilter` and later runs are incremental; `--since` takes `<n>d`, `<n>h`, `<n>m` (months) or a date. `sync run` never imports a project's old sync data (`.one/sync/data/*.db`); preview `one mem migrate --dry-run` before migrating.

> **Sync uses passthrough actions only.** Profiles referencing a custom/composer action are rejected at runtime. `sync models` already filters to passthrough-only; if a model has no passthrough list endpoint, compose a flow instead of syncing.

> **Connections are late-bound.** Profiles use `"connection": { "platform": "<name>", "tag"?: "..." }` instead of literal `connectionKey` strings. The key is resolved at sync time, so `one add <platform>` (re-auth) doesn't break the profile. `tag` only needed for multi-account platforms (e.g. two Gmail accounts).

> **`memory.searchable` paths.** Drives what gets embedded + FTS-indexed. Supports numeric indexes (`values.name[0].full_name`) and `[]` wildcards (`messages[].snippet`, `messages[].payload.parts[].body.data`). Without declared paths the default walker concatenates every string — correct but noisy for hierarchical APIs. Always declare when `embed: true`.

| Subcommand | What it does |
|------------|-------------|
| `install` | Install the optional `better-sqlite3` module (needed by enriching profiles, `delete`, `remove`, `mem migrate`) |
| `profiles [platform]` | List built-in pre-validated profiles |
| `doctor` | Verify sync engine health (exits non-zero when not ready) |
| `models <platform>` | Discover available data models |
| `init <platform> <model>` | Create a profile from the built-in or inference. If one exists it refuses unless you pass `--config` (merges into it) or `--force` (replaces it). Auto-tests |
| `test <platform>/<model>` | Validate profile. `--show-searchable` previews embedded text |
| `suggest-searchable <platform>/<model>` | Rank candidate `memory.searchable` paths from a live sample |
| `approve <platform>` | Approve the shell commands (`transform`, hooks) in profiles you didn't create |
| `run <platform>` | Sync data (`--models`, `--force`, `--max-pages`, `--full-refresh`, `--since`, `--dry-run`, `--embed`/`--no-embed`, `--no-memory`, `--re-enrich`) |
| `query <platform>/<model>` | Query memory with `--where` (dotted paths), `--after/before`, `--order-by`, `--limit` (default 50) |
| `schema <platform>/<model>` | Field paths, types and examples of synced records |
| `sql <platform>/<model> "<sql>"` | Read-only SQL against the memory store (add `WHERE type = '<p>/<m>'` yourself) |
| `search <query>` | Hybrid FTS + semantic across this project's synced models |
| `list [platform]` | Show profiles, record counts, freshness (alias `ls`) |
| `schedule add/list/status/remove/repair` | Cron-backed scheduled syncs with drift detection |
| `delete <platform>/<model>` | Delete rows from the SQLite mirror only (`--id`, `--where`); memory is untouched |
| `remove <platform>` | Delete the platform's SQLite mirror and sync state; keeps profiles and memory records (`--dry-run` to preview) |

Change hooks (`onInsert`, `onUpdate`, `onChange`) fire per-page during sync — run a shell command (events as NDJSON on stdin; to start a flow, use a script that calls `one flow execute`) or append to an event log (`"log"`). Shell commands in a profile (`transform` and hooks other than `"log"`) only run once approved for that project: commands you pass in `sync init --config` are approved automatically, and commands that arrive in a profile on disk (for example from a cloned repo) need `one sync approve <platform>`. A change to an approved command needs approving again. Root-array responses (e.g. Hacker News `/v0/topstories.json` → `[9129911, 9129199, ...]`) are supported by setting `resultsPath` to `""`, `"$"`, or `"."`; primitive elements are auto-wrapped as `{ [idField]: value }`. Run `one guide sync` or `one guide memory` for the full reference.
