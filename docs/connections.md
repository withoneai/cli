# Connections

Connecting apps, listing them with the access you have on each, and removing them. Part of the [One CLI reference](./README.md).

## `one add [platform]`

Connect a new platform via OAuth. Shortcut for `one connection add` (alias `one connection a`).

```bash
one add shopify
one add hubspot
one add gmail
one add gmail --tag work        # tag the connection
```

Opens your browser, you authorize, done. The CLI polls until the connection is live (up to 5 minutes). Without a platform it asks you to pick one. It is interactive only: with `--agent` it refuses with an error, so an agent should ask the user to run it. Platform names are lowercase (with dashes for multi-word names) - run `one platforms` to see them all.

| Flag | What it does |
|------|-------------|
| `--tag <name>` | Tag the new connection once it's created. Lets sync/flow profiles target a specific connection via `"connection": { "platform": "gmail", "tag": "work" }` when you have several connections for one platform (e.g. personal vs work Gmail). |

## `one list`

List your active connections with their status, connection keys, and the access this key has on each. Shortcut for `one connection list`; aliases `one ls`, `one connection ls`.

```bash
one list
one list --search gmail      # filter by platform name
```

```
     Platform  Status       Connection Key                  Access
  ─  ────────  ───────────  ──────────────────────────────  ───────────
  ●  gmail     operational  live::gmail::default::abc123    Full access
  ●  slack     operational  live::slack::default::def456    Read only
  ●  shopify   operational  live::shopify::default::ghi789  Read & write
```

You need the connection key when executing actions. A Tags column appears when any connection is tagged, and a Your level column when your share holds you below Full access (see below).

| Option | What it does |
|--------|-------------|
| `-s, --search <query>` | Filter connections by platform name (case-insensitive substring) |
| `-l, --limit <n>` | Max connections to return. In agent mode the default is 20: `total` is the full count, `showing` how many are listed, and a `hint` appears when some were left out |

**Access reporting.** Every connection carries an `access` field: what this key may run there. The CLI reads it from One (`GET /v1/access/me`, the access chosen on the consent page or later in the dashboard) and narrows it by any limits you set with [`one config`](./configuration.md#one-config) — the server's answer is the ceiling, local settings can only lower it.

| Policy | Means | `level` |
|--------|-------|---------|
| `{"policy": "full"}` | Every action on the connection | `full` (Full access) |
| `{"policy": "methods", "methods": ["GET"], "access": ["read"]}` | Only actions at the levels in `access` (GET is `read`, POST/PUT/PATCH `write`, DELETE `delete`); One judges an action by its level, not its method | `read-only`, `write-only`, `read-write`, `full` (all three levels), or `custom` |
| `{"policy": "actions", "actions": [{"actionId": "...", "title": "...", "method": "..."}]}` | Only these specific actions | `custom`, or `none` when empty |

A connection the key does not reach is not listed. When the policy is `actions`, those actions are exactly what may run — `actions load <actionId>` reads their docs, no find needed.

```jsonc
// one --agent list
{
  "total": 2,
  "showing": 2,
  "connections": [
    {
      "platform": "gmail",
      "state": "operational",
      "key": "live::gmail::default::abc123",
      "access": { "policy": "full", "level": "full" },
      "viewerAccessLevel": "read",
      "effectiveLevel": "read-only"
    }
  ],
  "accessSource": "server"
}
```

**Your own level.** In an organization, an admin may share an app with you at a lower level, or cap it with App Controls. The CLI reads that level from `GET /v1/connections` and reports it as `viewerAccessLevel` (`none`, `read`, `write`, `read_write`, `full`, `custom`). One holds every call to both it and `access`; `effectiveLevel` names what the two leave together. The human table adds a "Your level" column, in the dashboard's words, when any connection holds you below Full access. An older API sends no level, and the listing stays as it was.

`accessSource` is `"server"` when One reported the key's access and `"local"` when it could not (an older API); then `access` shows only the CLI's own settings, the human table labels the column "Access (CLI settings only)", and `accessHint` says One may allow less. `knowledgeOnly: true` appears when knowledge-only mode is on (execution disabled), and `unresolvedActionIds` lists action ids that could not be looked up.

This mirrors the `access` field on the One MCP server's `list_one_integrations` tool, so both surfaces report access the same way.

## `one connection delete <connection-key>`

Remove a connection by its key.

```bash
one connection delete live::gmail::default::abc123
one connection rm live::gmail::default::abc123      # alias
```

Shows the connection details and asks for confirmation before deleting. Use `--force` to skip the confirmation prompt. In agent mode (`--agent` or `ONE_AGENT=1`) there is no prompt, so `--force` is required; without it the command returns `confirmation_required` and deletes nothing. On success agent mode returns `{"deleted": true, "platform": "...", "key": "..."}`. Deleting needs the `admin` permission level in [`one config`](./configuration.md#one-config), and knowledge-only mode refuses it.

| Option | What it does |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

## `one platforms`

Browse all 1000+ available platforms. Alias: `one p`.

```bash
one platforms                      # all platforms
one platforms -c "Sales & CRM"     # filter by category
one platforms --json               # machine-readable output
```

`-c, --category` is an exact, case-sensitive match on the category name (for example `Sales & CRM`, `Communication`, `Developer Tools`); an unknown category lists the valid ones and exits 1. `--json` prints a bare array; `one --agent platforms` prints `{"platforms": [...]}`.
