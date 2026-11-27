# Setup

Installing the CLI, signing in, updating, telemetry and where the CLI keeps its state. Part of the [One CLI reference](./README.md).

## Install

```bash
npx @withone/cli@latest init
```

Or install globally:

```bash
npm install -g @withone/cli
one init
```

`one init` walks you through setup: choose global or project scope, sign in through the browser or paste your [API key](https://app.withone.ai/settings/api-keys), optionally add an OpenAI key for semantic memory search, install the One skill into the AI agents you pick, and optionally connect your first app.

Or authenticate directly:

```bash
one login              # Opens the browser to sign in and create a key
one logout             # Clear local credentials
```

The first `one login` writes the global config; once a key exists it asks whether the new one applies globally or to this directory. For a project key from the start, use `one init -p`. `one logout` asks which config to clear when both a project and a global config exist, and deletes the whole file (API key, OpenAI key, access control and memory settings). With `--agent` there's no prompt: it needs `--force` (without it, it returns `confirmation_required` and the config it would clear), and it clears only the config in effect (the project config if there is one) unless you pass `--scope global` or `--scope both`. The API key itself stays active until you revoke it in the dashboard.

The browser consent page names the key and tags it with where this CLI is installed (scope, project path, machine, OS user, CLI version, chosen harnesses, and the per-install device id unless telemetry is off) so you can find and revoke it from Settings → API keys. The terminal prints exactly what will be sent before the browser opens.

Requires Node.js 22.23.4+, 24.22.1+ or 26.12.1+. Older Node versions trust the
compromised eMudhra intermediate CA certificates (October 2026), so a network
attacker could intercept the CLI's traffic and your API key. On them the CLI
refuses to run and prints the command that updates Node for how you installed
it. Node 18, 20, 23 and 25 are end-of-life and never got the fix.

If you can't update Node yet, `ONE_ALLOW_UNPATCHED_NODE=1` runs the CLI anyway,
with a security warning on every run (silent in `--agent` mode). You remain exposed while it is set.

## `one init`

Set up your API key and install the One skill into your AI agents.

```bash
one init
```

Steps: choose the scope, sign in (browser or API key), optionally add an OpenAI key for [`one mem`](./memory-and-sync.md#one-mem--unified-memory-store) semantic search, install the skill, and optionally connect a first app. The skill is copied to `~/.agents/skills/one/` and linked into each agent you pick: Claude Code, Claude Desktop and Codex by default, plus Cursor, Windsurf, Kiro, Goose, Amp, OpenCode and Roo. `one init` no longer writes MCP server entries; see [MCP server configs](./configuration.md#mcp-server-configs).

**Global vs. project scope.** `one init` is interactive and asks where the setup should live:

- **Global** (`~/.one/config.json`) — applies to every folder. Best when you only need one workspace / API key.
- **Project** (`~/.one/projects/<slug>/config.json`) — scoped to the current project, stored under your home directory so secrets never land in git. Use this when different projects need different API keys, connections, or access control.

When you run `one` in a project, it uses the project config if one exists and falls back to the global config otherwise. Use `one config path` to see which config is active and the full resolution order.

In a monorepo, the project root is the nearest ancestor with `.one/`, `.git`, or `package.json` — checked in that order. Run `mkdir .one` in a nested subproject to make it its own project root (so the config is keyed by the nested dir's slug instead of the monorepo's). Your home directory itself is never treated as a project root — `~/.one` is the CLI's own config directory, and a dotfiles `.git` or stray `package.json` in `$HOME` shouldn't turn everything under home into one project. Scope that applies to all of home is the global config.

If you've already set up, `one init` shows your current status for the active scope and a menu: install or update the skill, show the agent onboarding prompt, connect a platform, update the API key, add or update the OpenAI key, configure access control, or start fresh.

After a browser sign-in the CLI prints what the key was granted (for example `Access: Gmail (Read only), Slack (Full access)`). A key granted **Knowledge only** also turns on the CLI's knowledge-only mode; a later sign-in that grants more turns it off again, unless you turned it on yourself with `one config`.

**Agent-driven setup (no prompts).** Pass `--auth` and `one init` runs end-to-end without any terminal interaction — handy when an AI agent is onboarding you. It saves the key, installs the One skill for Claude Code, Claude Desktop and Codex, and skips the connect step (`one add` later). Without `--auth`, `one init` is interactive and refuses `--agent`.

```bash
one init --auth browser            # opens a login window; you authenticate, the window closes — done
one init --auth manual --api-key sk_live_...   # headless / CI, no browser
```

| Flag | What it does |
|------|-------------|
| `-g, --global` | Use the global config (`~/.one/config.json`) and skip the scope question. Other prompts still run unless you pass `--auth` |
| `-p, --project` | Use this project's config (`~/.one/projects/<slug>/config.json`) and skip the scope question. If both are passed, global wins |
| `--auth <browser\|manual>` | Run setup with **no prompts**. `browser` opens a login window; `manual` uses `--api-key`. Scope from `-g`/`-p` (default global). |
| `--api-key <key>` | API key for `--auth manual` (`sk_live_…` / `sk_test_…`) |
| `--openai-key <key>` | Optional OpenAI key for `one mem` semantic search, with `--auth` (interactive init prompts for it instead) |
| `ONE_APP_URL` (env) | Dashboard origin the browser flows open (default `https://app.withone.ai`); use `http://localhost:4202` against a local frontend. |
| `ONE_API_BASE` (env) | API origin, overriding `apiBase` in config (default `https://api.withone.ai`); use `http://localhost:5005` against a local backend. |

Both overrides apply to the current process only and are never written to config, so a key minted against a local backend lands in your normal config and a cron job or MCP server without the variable would send it to the hosted API. Pair them with `ONE_HOME` (see below) to keep a local stack's credentials in a separate profile.

## `one whoami`

Show the user, organization, project, environment (live/test) and key name for the current API key, plus the active config scope and API base. Under a Connect grant it shows the connected user and their `cu_…` id ([Acting for a Connect user](./connect.md#acting-for-a-connect-user)).

```bash
one whoami
one --agent whoami     # {user, organization, project, env, configScope, apiBase, keyName, connectUserId?}
```

## `one update`

Updates the CLI to the latest version (`npm install -g @withone/cli@latest`).

The CLI also **auto-updates in the background**: it checks npm for a new version at most every 4 hours, and when a newer version has been published for more than 30 minutes, the next `one` command silently kicks off a global install. This is hardened against concurrent runs — a lock file in `~/.one/` ensures at most one install runs at a time (so parallel agent invocations can't collide and wedge npm), and the lock self-heals after 10 minutes if an install ever crashes or hangs.

**Scheduled runs update too.** `one sync schedule` installs a crontab entry, and cron runs jobs with a bare `PATH=/usr/bin:/bin` — where an nvm, Volta, fnm, or Homebrew `npm` does not appear. The updater therefore resolves `npm` next to the running `node` binary rather than through `PATH`, and prepends node's own directory to the install's environment. Without this a scheduled install can never upgrade itself and stays pinned to the version that created it, forever.

If an install still doesn't land — a read-only prefix, a permissions problem, a node with no npm alongside it — the CLI **says so instead of retrying invisibly**. npm's own output is appended to `~/.one/auto-update.log`, and after three consecutive failed attempts a warning goes to **stderr** (never stdout, so it can't corrupt `--agent` JSON or a piped command) telling you to run the install by hand. That notice repeats at most once a day.

To disable background auto-updates entirely (e.g. on CI or a shared agent host), set:

```bash
export ONE_NO_AUTO_UPDATE=1     # ONE_DISABLE_AUTO_UPDATE=1 (or =true) also works
```

That stops the install, not the version check. Run `one update` manually whenever you want to upgrade.

## Telemetry

Every call to a connected app (`actions execute`, flow steps, sync) and every `actions find` also tells One which surface and harness made it (`x-one-source: cli`, and `x-one-agent: claude-code` or whichever agent launched the CLI), so the dashboard's Logs page can show which agent ran each action. `actions find` also sends the `--ai-model` value, when given, as `x-one-agent-model`. This is the call's own record in your account, not analytics, and it is sent whether or not telemetry is on. No CLI version or arguments ride with it.

The CLI collects **usage analytics** — which command was run, the CLI version, OS/arch, Node version, live/test environment, whether you're signed in, and whether it ran in `--agent` mode — to help us prioritize improvements. Events are linked to your One account (user id, email, name, org) so they line up with your dashboard activity. **Command arguments, inputs, connection data, and secrets are never collected** (only the command name, e.g. `actions execute`). A one-time notice is shown on first run. Commands are aggregated locally and sent as periodic, batched roll-ups in the background, so telemetry never slows down or blocks a command (and stays lightweight even under heavy automation).

To opt out, set any of:

```bash
export ONE_NO_TELEMETRY=1     # also accepted: ONE_DISABLE_TELEMETRY=1, or the cross-tool standard DO_NOT_TRACK=1
```

Each accepts `1` or `true`. Telemetry is also disabled automatically when `CI=1`. You can persist the choice by adding `"telemetry": "off"` to the active config (`~/.one/config.json`, or the project config when one is active).

## Relocating the CLI's state (`ONE_HOME`)

Everything the CLI stores — `~/.one/config.json`, the knowledge cache, memory
databases, sync schedules, and the installed skill files — is rooted at your
home directory. Set `ONE_HOME` to put it somewhere else:

```bash
export ONE_HOME=/srv/one-state
one whoami          # now reads /srv/one-state/.one/config.json
```

Useful for containers, CI runners, and shared/multi-tenant shells where the
account's home directory isn't the right place for per-workspace state. It
works identically on every platform — unlike `HOME`, which `os.homedir()`
ignores on Windows.

Agent config and skill paths move too (`~/.claude.json`, `~/.claude/skills/`,
`~/.agents/skills/`, ...), so `one init` with `ONE_HOME` set installs the skill
under that directory, where your real agents won't look.
