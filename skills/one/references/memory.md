# One memory and sync

The local memory store (`one mem`) and syncing platform data into it (`one sync`). `SKILL.md` has the short version; read this before any command beyond it.

## The store

One ships a local memory store (a real Postgres process bootstrapped on demand via the bundled `embedded-postgres` plugin, with a `postgres` plugin available for remote/self-hosted Postgres) that backs both user-authored notes and synced platform data. `one mem <cmd>` is the primary surface. `one sync` writes synced rows into the same store; `one mem sync ...` is an alias with identical handlers.

**Zero-config.** The first `one mem` call on a new machine auto-initializes — no separate `mem init` step required. `mem status` and `mem doctor` don't initialize: before any record command has run they report `configured: false` or a failed first check. Run a record command first, not `mem init`. `mem` commands need a config file: with only `ONE_SECRET` set they fail with `No One config found. Run one init first.` The `embedded-postgres` plugin downloads its Postgres binaries on first run and writes a daemon PID/port file at `~/.one/pg/.pgserve.json` so subsequent CLI invocations reuse the running cluster. The daemon listens on 5434, or the next free port if another program holds it; pin one with `one --agent mem config set embedded-postgres.port <n>` (a conflict on a pinned port is an error, not a silent move). Connections need the per-install password in `~/.one/pg/.pgserve-auth.json` (owner-only); never delete it. If an OpenAI key is already resolvable (env, `.onerc`, or `config.openaiApiKey`), the embedding provider is set to `openai`, but **semantic search also needs pgvector**, which the bundled Postgres doesn't ship (`brew install pgvector`, or a `postgres` backend with the `vector` extension). Without both you get FTS-only, and responses carry a structured `_upgrade` hint telling the user how to upgrade; `searchMode` in search output says which mode ran.

**Listing synced rows.** `mem list <type>` takes a positional namespaced type — there is no `--platform` flag. Synced rows live under `<platform>/<model>` types:

```bash
one --agent mem list "gmail/gmailThreads"
one --agent mem list "attio/attioPeople" --limit 5
one --agent mem list "google-calendar/events"
```

Underneath, the store has no `platform` column — `type` is the only platform-scoping mechanism. If you need raw SQL via `mem sql` (read-only: one `SELECT`/`WITH`/`EXPLAIN`), filter with `WHERE type LIKE 'platform/%'` (not `WHERE platform = ...`). Its keyword guard also refuses words like `start` or `do` inside strings and JSON paths. `mem sql` reads the table `mem_records` (`id, type, data, tags, keys, identity_keys, sources, searchable_text, weight, status, created_at, updated_at, …`) and returns `{columns, rows, rowCount}`.

```bash
# User memories
one --agent mem add note '{"content":"..."}' --tags work --weight 7
one --agent mem update <id> '{"status":"done"}'         # merges into data; refreshes searchable_text
one --agent mem search "deadline"                       # hybrid with key + pgvector, else FTS
one --agent mem search "deadline" --deep                # hybrid, or an error listing what's missing (no FTS fallback)
one --agent mem list note --limit 20
one --agent mem link <from-id> <to-id> relates_to --bi

# Merge keys — the `keys[]` column (first-class, NOT data). Unique across ACTIVE
# records; archiving a record frees its keys. `mem update '{"keys":[...]}'` is rejected.
one --agent mem key <id> --add email:x@y.com            # add/--remove/--set — EDITS keys[]
one --agent mem find-by-source attio/attioPeople:abc-1  # ONE record (prefers the active owner)

# Identity keys — cross-platform lookup. READ-ONLY query, does not edit anything.
# Spans BOTH `keys[]` (record IS the entity) and `identity_keys[]` (record INVOLVES
# the entity: Gmail thread From/To/Cc, calendar attendees — never merges).
one --agent mem find-by-key email:jane@acme.com                # every record involving this person
one --agent mem find-by-key email:jane@acme.com --type gmail/gmailThreads
one --agent mem find-by-key email:a@x.com email:b@y.com        # intersection — records with BOTH

# Backfill searchable_text (no embedding provider needed) — NULL or empty rows only; --all also rewrites stale text
one --agent mem reindex --searchable --type attio/attioPeople

# Status + diagnostics
one --agent mem status                                  # backend, provider, _upgrade hint
one --agent mem doctor                                  # full health report
```

`mem doctor` exits 1 on a stock install because of the pgvector check. That alone does not mean the store is broken.

**Don't confuse `mem key` with `mem find-by-key`.** `mem key` WRITES the merge column (`keys[]`) on one record — adding a key another active record already owns is an error, and `--set` replaces the whole array. `mem find-by-key` only READS, across both key columns. If you want "show me everything about this person", you always want `find-by-key`.

`find-by-key` agent output is grouped by record type:

```json
{
  "keys": ["email:jane@acme.com"],
  "total": 13,
  "truncated": false,
  "fetchCap": 2000,
  "perTypeLimit": 10,
  "byType": {
    "attio/attioPeople": { "count": 1,  "items": [ {"id": "...", "type": "...", "data": {}, "keys": ["attio/attioPeople:J1", "email:jane@acme.com"], "updated_at": "..."} ] },
    "gmail/gmailThreads": { "count": 12, "items": [] }
  }
}
```

`items` are whole mem records. `keys` and `identity_keys` are OMITTED, not `[]`, when the record has none — the contact above matched on `keys[]` and so carries no `identity_keys` field at all. Always read them as `(item.identity_keys ?? [])`.

Read it in this order:

1. **`truncated`** — if `true`, more than `fetchCap` (2000) records matched. `total` and every `count` are then floors, and because rows come back ordered by type, whole types sorting after the cut are MISSING from `byType` entirely. Re-run with `--type <type>` to get an accurate answer; do not report the counts as-is.
2. **`total` / `count`** — ungrouped and per-type match counts (accurate when `truncated` is `false`).
3. **`items`** — whole mem records, same fields as `mem get`, capped at `perTypeLimit` (`--limit`, default 10). `count > items.length` just means display truncation — raise `--limit`.
4. **`keys`** — the key form that actually matched. Lookups are lowercased/trimmed first (matching how sync writes them), with a one-shot verbatim retry for hand-written mixed-case keys, so `email:Jane@Acme.com` finds `email:jane@acme.com`.

## Adding OpenAI for semantic search

Stored as top-level `openaiApiKey` in the config in effect (the project config when there is one, else `~/.one/config.json`), same precedence as `ONE_SECRET` (env > `.onerc OPENAI_API_KEY=...` > project > global). Three equivalent ways to set:

```bash
# Via one init (first-time setup prompts for it; on a re-run pick "Add OpenAI key")
one init

# Via config set (writes to top-level, not the memory block)
one --agent mem config set embedding.apiKey sk-...

# Via env var (no persistence)
export OPENAI_API_KEY=sk-...
```

## Syncing platforms into memory

```bash
# Check built-in profiles (pre-validated configs for common platforms)
one --agent sync profiles

# Setup — seeds from the built-in. If a profile already exists, init refuses
# (status: "exists"); --config merges into it, --force replaces it.
one --agent sync init stripe balanceTransactions
# If _complete: true and _test.ok: true → ready to run

# Preview what gets embedded BEFORE paying embedding cost (agent declares paths)
one --agent sync init attio attioPeople --config '{
  "memory": {
    "embed": true,
    "searchable": [
      "values.name[0].full_name",
      "values.job_title[0].value",
      "values.description[0].value",
      "values.email_addresses[0].email_address"
    ]
  }
}'
# Skip the "pick paths by reading the docs" step — let the CLI rank them from a live sample
one --agent sync suggest-searchable attio/attioPeople
# → { suggestions: [{path, score, hitRate, avgLength, noiseFraction, sampleValue}], configPatch: {...paste-ready...} }

one --agent sync test attio/attioPeople --show-searchable
# → Previews across 5 samples. Each path has { hits, total, sample }:
#     5/5 = path resolves on every record (clean)
#     1/5 = field is real but sparse on this page
#     0/5 = typo, or field never populated in sampled records
# Iterate until the numbers match intent.

# Run. Memory is always written. Never pass --no-memory: for a profile without enrich it stores
# nothing yet still advances lastSync, so later runs skip those records (recover with --force or --full-refresh).
# Embeds when the profile's memory.embed says so (else defaults.embedOnSync);
# --embed / --no-embed override it for one run.
one --agent sync run stripe
one --agent sync schema stripe/customers         # inspect field paths/types before querying
one --agent sync query stripe/balanceTransactions --where "status=available" --limit 20
one --agent sync search "refund"                 # this project's synced models (mem search works anywhere)
one --agent sync list stripe                     # progress + freshness

# Schedule unattended syncs
one sync schedule add stripe --every 1h
```

**What a run returns.** `sync run` returns `{platform, results: [{model, recordsSynced, pagesProcessed, duration, status: "complete"|"failed"|"dry-run", error?, …}], profileDrift?}` and exits 0 even when a model failed, so check every `results[].status`.

**How much a run fetches.** A first run fetches the last 90 days when the profile has a `dateFilter`; without one, every run pulls the whole collection. Flags: `--since 30d|12h|3m|2026-01-01` (`m` is months), `--force`, `--max-pages <n>`, `--models a,b`, `--dry-run`. `--full-refresh` archives rows that did not come back and cannot be combined with `--since`.

**Access settings apply.** Sync calls the platform under the same access settings as `actions execute`: knowledge-only mode blocks it, allowlists apply, and local `read` allows only GET, so a profile whose list action is a POST is refused. Sync needs no `--confirm-write`.

**One folder.** Run every `sync` command from the same folder: profiles, state and approvals are keyed to the current directory.

**No built-in profile?** `one --agent sync models <platform>` lists syncable models; a bare `sync init` then infers a draft (`_draft: true`). Fill any `FILL_IN` value with `--config`, then run `sync test`.

**Commands that change or delete without asking.** `sync delete`, `sync remove`, `mem archive`, `mem vacuum` and `mem import` run without confirmation under `--agent`. Run them only when the user asked. Prefer `mem config set` to `mem init`.

## memory.searchable paths

Declared on the profile, drives what gets embedded + FTS-indexed. Supports numeric indexes AND `[]` wildcards for array fan-out:

```
values.name[0].full_name              # numeric index (first element)
messages[].snippet                    # wildcard — every element's .snippet
messages[].payload.parts[].body.data  # nested wildcards
```

Without declared paths a generic builder is used (drops ids and timestamps, leads with name, title and email fields, capped at 4000 characters). It is still noisy for hierarchical APIs (Attio, HubSpot). **Always declare paths for any profile with `embed: true`.**

**Sync rejects custom actions** — profiles must use passthrough. `sync init` only surfaces passthrough models; `sync run` aborts if the list or enrich action is tagged `custom`. If no passthrough exists, compose a flow instead.

**Connections are late-bound** — profiles use `"connection": { "platform": "<name>" }`, not literal `connectionKey` strings. The key is resolved at sync time, so `one add <platform>` (re-auth) doesn't break the profile. For multi-account platforms, add `"tag": "<connection-tag>"` to disambiguate, and create the tagged connection with `one add <platform> --tag <name>`. Don't hardcode connection keys in profiles.

**Extracting a flat field? Use `derive`, not `transform`.** `derive` computes top-level fields from paths already in the record (`"derive": { "from_email": { "path": "messages[0].payload.headers[name=From].value", "extract": "email" } }`), using the same path syntax as `identityKeys`. `transform` spawns `sh -c`, so it needs `jq` on PATH and silently does nothing on Windows — never put one in a profile you intend to share. Shell commands in a profile you didn't create with `sync init --config` (e.g. one from a cloned repo) are refused until approved: `one --agent sync approve <platform>` returns the commands; show them to the user and re-run with `--yes` only if they agree. A path that resolves to nothing omits the field rather than writing null. A `transform` or hook you pass in `sync init --config` is approved on the spot and runs on every sync. Add one only when the user asked.

**Installed profiles do not auto-update.** `sync run` reads only `.one/sync/profiles/<platform>_<model>.json` and never merges the shipped built-in, so a profile created before a capability shipped silently lacks it — an old gmail profile writes zero identity keys, forever, with no change in record counts. `sync run` warns when the built-in declares `identityKeys` / `identityKey` / `enrich` / `dateFilter` / `memory` that your copy lacks (agent mode: a `profileDrift` array). **Don't fix it with `one sync init <platform> <model> --force`** (the hint's suggestion): that replaces the profile and loses the user's `connection.tag`, `memory`, hooks and other edits. A bare `sync init` refuses because the profile exists. `sync profiles` lists only names and flags, not field values. To pick up the missing fields without losing the user's edits: read `.one/sync/profiles/<platform>_<model>.json` and note what the user changed (`connection.tag`, `memory`, `derive`, `exclude`, `transform`, hooks). Run `one --agent sync init <platform> <model> --force`, whose output is the current built-in. Then re-apply the user's fields with `one --agent sync init <platform> <model> --config '{...}'`, which merges. Never run `--force` without re-applying.

**Old project sync data is never imported automatically.** `sync run` ignores `.one/sync/data/*.db` and `.one/sync/state/` (a cloned repo can ship them) and prints a hint. Show the user `one --agent mem migrate --dry-run` before running `mem migrate`.

**Cross-platform identity on a profile.** Two separate fields, and picking the wrong one silently mangles data:

- `"identityKey": "properties.email"` — singular. "This record IS this entity." One dot-path; the value lands in `keys[]` and merges re-syncs of the same record. The key is `<prefix>:<value>`, with the prefix taken from the path name (`email`, `phone`, `domain`, otherwise `id`). If another record already holds it, the value goes to `identity_keys[]` and the run reports `memKeptSeparate`. Two upstream records with different ids are never merged, even when they share the value. Records from different platforms for one person (HubSpot + Attio) stay separate records, linked by `mem find-by-key`: sync never updates a record of another type.
- `"identityKeys": [{"prefix": "email", "path": "attendees[].email"}]` — plural. "This record INVOLVES these people." Paths support `[]` wildcards and a `[name=From]` equality filter (Gmail headers). Values land in the separate `identity_keys[]` column, which does NOT merge — a 20-attendee event stays one event, not 20 contacts. Use this for anything with N participants.

Both are queryable with `one --agent mem find-by-key <prefix>:<value>`.

**Enriching profiles** (`gmail/gmailThreads`, `fathom/meetings`) sync in two phases: a list pass, then a detail pass that fetches full bodies/transcripts. Two things follow. Enrichment happens **once per record by default** — phase 2 only visits rows it has never enriched, and `--full-refresh` does *not* reset that (it reconciles deletions, it is not a detail refresh). To refresh detail content, either set `enrich.invalidateOn` in the profile to a list field that moves when the detail changes (`historyId`, `updated_at`) so only genuinely-changed records re-enrich automatically, or run `one sync run <platform> --re-enrich` to re-fetch every detail endpoint. And the list pass never overwrites an enriched record: `data` merges rather than replaces, and `searchable_text` / `identity_keys[]` are left alone. `sync run` reports these as `memPreserved`. So on an enriching profile without `invalidateOn`, a record whose upstream *detail* changed will look stale until you re-enrich — that is expected, not a sync failure. Enriching profiles need the optional `better-sqlite3` module. Check with `one --agent sync doctor`. `one sync install` runs a global npm install, so ask the user first.

**Advanced features** (enrich, transform, exclude, hooks, --full-refresh, alternative backends, embedding tuning): run `one guide memory` or `one guide sync` for the full reference.
