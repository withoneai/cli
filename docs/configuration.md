# Configuration

Access control, the `.onerc` file and the MCP server entries the CLI keeps in step. Part of the [One CLI reference](./README.md).

## `one config`

Configure what this CLI may do: permission level, connection and action allowlists, knowledge-only mode, and the API base URL. Optional - full access is the default. The CLI enforces these on every call itself, and copies them into any existing `one` MCP server entries in your agent configs.

```bash
one config
```

| Setting | Options | Default |
|---------|---------|---------|
| Permission level | `admin` / `write` / `read` | `admin` |
| Connection scope | All or specific connections | All |
| Action scope | All or specific action IDs | All |
| Knowledge-only mode | Enable/disable execution | Off |
| API base URL | Default (`https://api.withone.ai`) or a custom base, which asks for a key | Default |

Settings are written to the active scope (the project config if one exists, else global). `admin` allows every method, `write` allows GET, POST, PUT and PATCH, `read` allows GET only. These are local to this install and can only narrow what the key itself was granted on One (chosen on the consent page or in the dashboard).

Run [`one list`](./connections.md#one-list) to see the effect: each connection reports an `access` field describing exactly what these settings let you run on it.

### `one config path` / `one config reset`

```bash
one config path            # active config, its scope, and the project → global resolution order
one config reset           # remove the project config for this directory (falls back to global)
one config reset --global  # remove ~/.one/config.json instead
```

`reset` removes the nearest project config that applies to this directory, which can belong to a parent folder, and says what will be used next. It asks for confirmation; `--agent` skips the prompt.

### `one config skills status` / `one config skills sync`

`one init` copies the packaged skill files (`SKILL.md`, `references/`) into `~/.agents/skills/one/` and symlinks per-agent paths to that canonical directory. When the CLI self-updates, the skill files in the canonical dir would normally stay frozen at the version that was installed. To prevent stale docs, every CLI command checks a `.one-cli-version` marker in the canonical dir and silently refreshes the skill files if they don't match the running CLI version. No user action required.

| Command | What it does |
|---------|--------------|
| `one config skills status` | Show installed skill version, current CLI version, and path |
| `one config skills sync` | Force a re-copy of packaged skill files (for troubleshooting) |

Auto-sync refuses to resurrect skills if you opted out of skill installation during `one init` — the canonical dir has to already exist.

## `.onerc` file

Drop a `.onerc` file in your project root to override settings per-project (separate from the project config under `~/.one/projects/`). Simple `KEY=VALUE` format; `#` for comments. Read from the current working directory (no parent lookup).

| Key | Purpose |
|-----|---------|
| `ONE_SECRET` | API key (also honored as env var) |
| `ONE_CONNECT_USER_ID` | The user a Connect key acts for, as the SDK stored it (also honored as env var); see [Acting for a Connect user](./connect.md#acting-for-a-connect-user) |
| `ONE_API_BASE` | API base URL, `https://api.withone.ai` or `https://development-api.withone.ai` only (the env var accepts any origin) |
| `OPENAI_API_KEY` | OpenAI key for `one mem` semantic search (also honored as env var) |
| `ONE_PERMISSIONS` | `admin` / `write` / `read`, can only lower the configured level |
| `ONE_CONNECTION_KEYS` | Comma-separated connection-key allowlist, intersected with the configured one |
| `ONE_ACTION_IDS` | Comma-separated action-ID allowlist, intersected with the configured one |
| `ONE_KNOWLEDGE_AGENT` | `true` turns knowledge-only mode on; it cannot turn it off |

Precedence: env var > `.onerc` > project config > global config. The access keys are the exception: they are not read from the environment, and a `.onerc` can only narrow the access settings in your config, never widen them, because it can arrive with a cloned repository. A value that would widen them is ignored with a warning; use `one config` instead.

The access settings are enforced on every call to a connected app, whatever the command: `actions execute`, flows, sync and its validation runs. Headers named `x-one-secret`, `x-one-connect-user-id`, `x-one-organization-id`, `x-one-project-id`, `x-one-connection-key` or `x-one-action-id` cannot be passed with `--headers`, method-override headers are judged against the permission level, and a path variable cannot be `.` or `..`. `--dry-run` is checked too. API requests never carry your key to another origin: a redirect to a different origin fails instead of being followed.

They also apply to commands that change One's own resources. Creating, updating or activating a relay needs the `write` level and deleting one needs `admin`; `connection delete` needs `admin`; knowledge-only refuses all of them. A relay's `passthrough` actions are checked like `actions execute` when they are set, because they run later on One's servers. `url` and `agent` relay actions are allowed only when the connection and action allowlists are both `*`. With a connection allowlist, relay endpoints, events and deliveries on other connections are hidden or refused.

```bash
# .onerc
ONE_SECRET=sk_live_xxx
ONE_API_BASE=https://development-api.withone.ai
ONE_PERMISSIONS=read
```

> ⚠️ **Add `.onerc` to your `.gitignore`.** If you put `ONE_SECRET` in it, committing the file will leak your API key. Treat `.onerc` like `.env` — never check it in.

## MCP server configs

`one init` no longer installs an MCP server. Most clients can use One's [remote MCP server](https://withone.ai/docs/mcp) instead, with no local install and no API key in a config file. If an agent config already has a `one` entry for the local `@withone/mcp` server, the CLI keeps it in step when you run `one config` (access control) or update your key in `one init`. It reads and writes these files:

| Agent | Global | Project |
|-------|--------|---------|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Claude Desktop | Platform-specific app support dir | - |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | - |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` |
| Kiro | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` |

These files contain your One API key. Project configs are written readable by you only and added to `.gitignore`: don't commit or share them.
