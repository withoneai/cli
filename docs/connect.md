# Connect

Optional skills, creating a Connect app, and running the CLI for one of its users. Part of the [One CLI reference](./README.md).

## `one skills`

Optional skills for your coding agent, installed on request. The One skill itself still comes from `one init` (and `one config skills sync|status`); these commands never touch it.

```bash
one skills list                          # the One skill and each optional skill, with where it is installed
one skills add connect                   # the One Connect skill, into this project
one skills add connect --global          # ...or for every project on this machine
one skills add connect --agents claude-code,windsurf   # link exactly these agents
one skills update [connect]              # re-copy after upgrading @withone/connect (all installed ones when no name)
one skills remove connect                # remove it and the agent folders that point at it (alias: rm)
```

`update` and `remove` take `-g, --global` to act on the global install; `update --agents <ids>` changes which agents are linked (otherwise the existing links are kept). `add` outside a project (a folder with `package.json` or `.git`) errors unless you pass `--global`, which installs to `~/.agents/skills/one-connect` and links the agents whose home folder exists on this machine.

What `one skills add connect` does:

1. **Finds the skill** in the `@withone/connect` package your project installed (`node_modules/@withone/connect/skills/one-connect`), so your agent reads the docs for the exact SDK version your code calls. If the package isn't installed yet, it downloads the latest published package from npm and checks it against the registry's integrity hash first.
2. **Installs it** into `.agents/skills/one-connect` (read by Codex, Cursor, Amp and OpenCode) and links `.claude/skills/one-connect` for Claude Code. Windsurf, Kiro, Goose and Roo get a link when the project already has their folder (`.windsurf`, `.kiro`, `.goose`, `.roo`). Where links aren't allowed (Windows without developer mode), it uses a junction, then a copy.
3. **Stamps** the install with the package version in `.one-skill.json`.
4. **Keeps it fresh**: any `one` command run in the project re-copies the skill when the installed `@withone/connect` version changes. Local files only; no network. This applies to a project install taken from the project's own `node_modules`; a skill fetched from npm, or a `--global` one, is refreshed only by `one skills update`.

Commit `.agents/skills/one-connect` and the agent links so your team's agents share the skill. Agent mode (`--agent`) returns JSON for every subcommand.

## `one connect`

Create and update a [One Connect](https://www.npmjs.com/package/@withone/connect) app from `one.connect.ts`, typed by `defineConnectApp` from `@withone/connect/config` (0.20.0 or later).

```bash
one connect types     # writes one-connect-env.d.ts: tool slugs and action names autocomplete
one connect create    # approve the app in the browser; re-run to review and apply changes
```

`one connect create` opens a setup page in your signed-in browser, where you review the app (or, on a re-run, its new version) and approve it; nothing is created or changed with your API key. A new app's client secret and connect key are made there and shown once, so they never pass through the terminal. The CLI waits up to 10 minutes (with `--agent`, the setup link goes to stderr at once). Once you approve, it writes `ONE_CLIENT_ID`, `ONE_REDIRECT_URI` and, for a list of tools, `ONE_PERMISSION_SET` to `.env.local` (or `.env`); for a new app it also adds empty `ONE_CLIENT_SECRET=` and `ONE_CONNECT_KEY=` lines for you to fill in from the page. `ask` is required: either the tools, where each takes `access` (`read-only`, `read-write`, `full-access`, or `custom` with `actions`, named as `one connect types` wrote them or by id from `one actions find <platform> "<what it does>" --no-knowledge`), or `"everything"`, where users see every connection they have and can connect any other app. An app switched to `"everything"` loses its ask, and the CLI removes `ONE_PERMISSION_SET` from the env file. Options: `--config <file>` (default `one.connect.ts`, `.mts`, `.mjs` or `.js` in this directory), `--env-file <file>`, `--no-open` (print the link instead of opening it); `connect types` takes `--config` too. Both need a configured API key. Install `@withone/connect` (0.20.0 or later) in the project first. A `.ts` config needs Node 22.18 or later; on older Node use `one.connect.mjs`.

## Acting for a Connect user

An app built on `@withone/connect` can run the CLI as one of its users. Set `ONE_SECRET` to the app's Connect key and `ONE_CONNECT_USER_ID` to the value the SDK stored for the user, in the environment or `.onerc`. That value is the user's `cu_…` id, followed by `;org=<id>;project=<id>` when they granted from an organization or project. Every request then carries the user and that space, and One holds it to the grant that user gave the app, as it does for the SDK.

- `whoami` shows the connected user.
- `list` shows the connections the grant reaches, with the access it gives on each.
- `actions find` offers only actions inside the grant, and `actions execute` refuses one outside it with a 403. Plan from `list` and `find`: `actions load` reads an action's docs by id whether or not the grant reaches it.
- Adding or removing connections and managing relays need an ordinary key. One refuses them under a grant.

One refuses a Connect key without `ONE_CONNECT_USER_ID`, and an ordinary key with it, so setting one by mistake can't widen what a key reaches.
