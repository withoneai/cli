# CLI browser auth: Connect-style consent screen + install-context tags

**Date:** 2026-09-09
**Status:** Draft, awaiting review
**Repos:** `cli` (this repo), `starter/core-ui` (frontend), `starter/pica` (backend)

## 1. Goal

When someone authenticates the One CLI through the browser, the key that gets
minted should record *where that CLI lives* so the dashboard can later show
"you have the CLI installed here, here and here" and revoke the right one.
The consent page itself should look like the hosted Connect consent screen
(`connect.withone.ai`, `/oauth/connect`), and it should let the person say
which agent harnesses (Claude Code, Codex, ...) will use the key.

Concretely, the event-access key (the `sk_live_...` secret) gets:

- a human-readable **name** with a smart default the person can edit, and
- a set of **tags** describing scope, project path, harnesses, machine and CLI version.

## 2. Non-goals

- Showing tags in the dashboard's API-keys table. Follow-up.
- Changing the manual paste-a-key path in `one init`.
- Changing MCP consent (`/oauth/authorize`) or the Connect flow itself.
- An opt-out flag for device info. The consent screen shows exactly what is
  recorded, and the person can cancel. Revisit if asked.

## 3. Current state

- **CLI** (`src/commands/login.ts`, `src/lib/browser.ts`): `browserLogin()`
  starts a localhost callback server, opens
  `https://app.withone.ai/cli/auth?port=..&state=..`, and waits for
  `GET /callback?s=<base64 key>&state=..`. It knows nothing about scope; the
  callers (`loginCommand`, `init.ts` x3) know the scope but do not pass it.
- **Frontend** (`app/cli/auth/page.tsx`, 306 lines, all logic inline): after
  the dashboard session check it lists orgs, lets the person pick
  Account/Project in two `Select`s, creates a key named `CLI (YYYY-MM-DD)`
  through `createSecretKeyApi` / `createOrganizationSecretApi` /
  `createProjectSecretApi`, and redirects to the localhost callback. If not
  signed in it stashes `{port,state}` in `localStorage.cli_auth_pending` and
  goes to `/sign-in`; `app/(main)/page.tsx` sends the person back.
- **Backend** (`core/src/http/routes/common/event_access.rs`,
  `core/src/domain/event_access.rs`): the three create routes accept
  `{connectionType, environment, name, hide}`. The `event_access` table already
  has a `tags text[]` column (from the shared `enrich()` metadata tail) and
  `EventAccessView` already returns `tags`, but nothing ever sets it: every
  key is minted with `tags = []`. No PATCH route exists for keys.
- **Connect design**: hosted (own-tab) mode is a dark left rail
  (`ConnectRail`) + a 430px working panel (`ConnectHostedShell`), mono step
  eyebrow + large title (`HostedHeading`), consequence-labelled radio cards
  for account choice (`ConnectSpaceCards`), an account chip top-right
  (`ConnectAccountChip`), a "You're all set" interstitial with a 3-second
  countdown, all under the `connect-widget-theme` token set.

## 4. Architecture and data flow

```
one login / one init --auth browser
  │  collectInstallContext(scope, projectRoot)         [CLI, new]
  │    scope, path, host, os, os-version, arch, user, device-id,
  │    cli version, installed harnesses, launching harness
  ▼
open https://app.withone.ai/cli/auth?port&state&scope&path&host&os&osv&arch&user&device&cli&harnesses&launcher
  │
  ▼
/cli/auth  (frontend, rebuilt on the Connect hosted shell)
  1. session check (unchanged; stash FULL query in cli_auth_pending)
  2. Choose an account      → ConnectSpaceCards (skipped when no orgs)
  3. Describe this install  → install summary + harness picker + name
  4. Create key             → POST /v1/event-access[/organizations/..[/projects/..]]
                               { connectionType, environment, name, tags }
  5. "You're all set"       → countdown → http://localhost:{port}/callback?s=..&state=..&name=..
  │
  ▼
CLI callback server: validates state, stores key (+ name) in config, whoami
```

Each hop stays backward compatible: an old CLI that sends only `port` and
`state` still works (no install rows, no preselected harnesses); a new CLI
against the old page just has its extra params ignored; the new page against
the old backend has `tags` ignored by serde and still gets a key.

## 5. Contract A: CLI to browser (query params)

All optional except `port` and `state`. Values are URL-encoded strings.

| Param | Example | Source |
|---|---|---|
| `scope` | `global` or `project` | the `ConfigScope` the caller chose |
| `path` | `/Users/paul/dev/acme` | `getProjectRoot()`; only when `scope=project` |
| `host` | `Pauls-MBP.local` | `os.hostname()` |
| `os` | `darwin` / `linux` / `win32` | `process.platform` |
| `osv` | `25.2.0` | `os.release()` |
| `arch` | `arm64` | `process.arch` |
| `user` | `paul` | `os.userInfo().username` |
| `device` | UUID | `getDeviceId()` (existing stable per-install id in `~/.one/device-id`); omitted, and never minted, when telemetry is opted out |
| `cli` | `1.56.0` | `cliVersion()` |
| `harnesses` | `claude-code,cursor` | `detectInstalledHarnesses()`: agent registry detect dirs plus extra dirs (`~/.gemini`, `~/.openclaw`, `~/.hermes`, ...) |
| `launcher` | `claude-code` | the harness that spawned this CLI process, from env (`CLAUDECODE` → claude-code, `CODEX_SANDBOX`/`CODEX_CI` → codex, `CURSOR_AGENT` → cursor (not `CURSOR_TRACE_ID`, which Cursor exports into every integrated-terminal shell), `GEMINI_CLI` → gemini-cli, ...); absent when run by a human in a plain shell |

Explicit params rather than one opaque blob: the CLI prints this URL in the
terminal ("If the browser doesn't open, visit: ..."), and a person should be
able to read what is being sent about their machine.

Every value is best-effort. A failing `os.userInfo()` or unreadable device-id
file drops that param; it never blocks login.

## 6. Contract B: browser to backend (create-key body)

The three create routes gain one optional field:

```json
{ "connectionType": "custom", "environment": "live", "name": "CLI · Claude Code · acme", "tags": ["cli", "scope:project", "..."] }
```

Validation (backend, mirrors the `UpdateConnection` pattern in
`routes/common/connection.rs`): at most **32 tags**, each **1..=512 bytes**,
trimmed, no duplicates after trimming. Violations are a `400` with a
`CanonicalAccessError::InvalidTags { reason }` (new variant; `status_code()`
maps it to `BAD_REQUEST`). Limits are larger than the connection limits
(10 / 50) because a project path is a tag.

Tags are stored verbatim on the row (`build_key_record` sets
`tags: Set(params.tags)`) and come back in `EventAccessView.tags`, which the
frontend `EventAccess` type already declares.

## 7. Tag vocabulary

Namespaced `key:value` strings so a dashboard can parse them without guessing,
plus one bare marker so "every CLI key" is a single filter:

| Tag | When | Value |
|---|---|---|
| `cli` | always | marker: minted by the CLI browser login |
| `scope:global` / `scope:project` | always | from `scope` (defaults to `global` when the CLI sent nothing) |
| `path:<abs path>` | project scope only | from `path` |
| `harness:<id>` | one per selected harness | from the picker (pre-selected from `harnesses` + `launcher`) |
| `launcher:<id>` | when the CLI was launched by an agent | from `launcher` |
| `host:<hostname>` | when sent | from `host` |
| `os:<platform>` | when sent | from `os` |
| `os-version:<release>` | when sent | from `osv` |
| `arch:<arch>` | when sent | from `arch` |
| `user:<os username>` | when sent | from `user` |
| `device:<uuid>` | when sent | from `device`; groups every key minted from the same install |
| `cli-version:<semver>` | when sent | from `cli` |

The frontend builds this list in one pure function
(`lib/cli-auth/install-context.ts: buildKeyTags(ctx, selectedHarnesses)`),
unit-tested in vitest. Nothing else composes tags.

Harness ids are one shared vocabulary across CLI and frontend:
`claude-code`, `claude-desktop`, `codex`, `cursor`, `windsurf`, `kiro`,
`gemini-cli`, `openclaw`, `hermes`, `devin`, plus a free-text "Other" entry that
becomes `other-<slug>` (so the tag reads `harness:other-my-tool`). The first six are exactly the CLI's existing agent ids in
`src/lib/agents.ts`, so detection and MCP install speak the same names.

## 8. Key name

Default: `CLI · <Harness name(s)> · <project folder name | global>`, e.g.
`CLI · Claude Code · acme` or `CLI · Claude Code, Cursor · global`. With no
harness selected: `CLI · <folder | global>`. Editable in a text input on the
"Describe this install" step (max 120 chars; the backend `name` column is
unbounded text and already accepts spaces and punctuation - the current page
sends `CLI (2026-09-09)`).

The chosen name rides back to the CLI on the callback (`name` param) and is
stored in config as `apiKeyName`, so `one whoami` / `one logout` can say
which key this is.

## 9. Contract C: browser to CLI callback

Unchanged: `GET http://localhost:{port}/callback?s=<base64 key>&state=<state>`.

Additions:

- `&name=<url-encoded key name>` - optional; stored as `apiKeyName`.
- `?error=cancelled&state=<state>` - the person pressed Cancel in the browser.
  The server answers with a small "Cancelled - return to your terminal" page
  and `browserLogin()` returns `null` with the message "Login cancelled in the
  browser." Today a cancel just leaves the CLI waiting for the 5-minute timeout.

`state` is still checked on every callback, including the error one.

## 10. CLI changes (`cli` repo)

New module `src/lib/install-context.ts`:

- `export interface InstallContext { scope; path?; host?; os?; osVersion?; arch?; user?; device?; cli?; harnesses: string[]; launcher?: string }`
- `collectInstallContext({ scope, projectRoot? }): InstallContext` - best-effort, never throws.
- `detectInstalledHarnesses(): string[]` - `detectInstalledAgents()` ids plus an `EXTRA_HARNESS_DIRS` table (`gemini-cli: ~/.gemini`, `openclaw: ~/.openclaw`, `hermes: ~/.hermes`, `devin: ~/.devin`), resolved lazily through `homeDir()` per the repo's home-dir rules.
- `detectLauncher(env = process.env): string | undefined` - env-var table.
- `installContextToParams(ctx): URLSearchParams` - the Contract A encoding.

`src/lib/browser.ts`:

- `oneAppUrl()` reads `ONE_APP_URL` env, falling back to `https://app.withone.ai` (lets the local test point at `http://localhost:4202`; also used by the connections/API-key URLs).
- `getCliAuthUrl(port, state, ctx?)` appends the context params.

`src/commands/login.ts`:

- `browserLogin(opts: { scope: ConfigScope; projectRoot?: string })` collects the context and passes it through. Every caller already knows its scope: `loginCommand` (global or the picked scope), `freshSetup`, `handleUpdateKey`, `nonInteractiveInit`.
- Callback server: handle `error=cancelled`, read `name`.
- `BrowserLoginResult` gains `keyName?: string`; `saveCredentials` and the three `init.ts` writes persist it as `Config.apiKeyName`.
- Before opening the browser, print a one-line note under the URL: "The consent page will record: scope, project path, machine name, OS and user, so you can find this install later."

`src/lib/types.ts`: `Config.apiKeyName?: string`.

Docs (same PR): `src/cli.ts` help text, `src/lib/guide-content.ts`,
`skills/one/SKILL.md`, `README.md` - describe the consent page, the tags, and
`ONE_APP_URL`.

Version: `1.56.0` (minor). Hand-edit the two `"version"` fields in
`package.json` and `package-lock.json`; do not run `npm install` (lockfile rule
in CLAUDE.md).

Tests (`node:test`, sandboxed with `withTempHome()`):

- `src/lib/install-context.test.ts`: scope/path rules (`path` only for project), env launcher table, harness detection against fake dirs, param encoding, best-effort behaviour when `os.userInfo` throws.
- `src/lib/browser.test.ts`: `ONE_APP_URL` override, `getCliAuthUrl` with and without context, encoding of a path with spaces.
- `src/commands/login.test.ts`: callback server (exported for tests) - state mismatch → 403, `error=cancelled` → resolves null, `name` param round-trips.

## 11. Backend changes (`pica` repo, branch off `main`)

`core/src/http/routes/common/event_access.rs`:

- `Params` and `OrganizationEventAccessParams` gain `#[serde(default)] tags: Vec<String>` with a `///` doc line; both derive `Validate` with `length(max = MAX_KEY_TAGS)` + a `validate_key_tags` custom check (per-tag length, non-empty after trim, no duplicates). Route handlers call `params.validate()` first and map errors to `CanonicalAccessError::InvalidTags`.
- The three handlers pass `params.tags` through.

`core/src/domain/event_access.rs`:

- `pub(crate) const MAX_KEY_TAGS: u64 = 32; pub(crate) const MAX_KEY_TAG_LEN: u64 = 512;`
- `CreateParams.tags: Vec<String>`; `create_for_user / _organization / _project` take `tags: Vec<String>` (the management API and the operator test-account route pass `Vec::new()`); `do_create` copies them into `SecureKeyParams.tags`.
- `CanonicalAccessError::InvalidTags { reason: String }` → `400`.

`common/src/schema/extension/event_access.rs`:

- `SecureKeyParams.tags: Vec<String>`; `new_for_session` and the four other constructor sites (`organization.rs` x2, `link_invitation.rs` x2) set `tags: Vec::new()`; `build_key_record` sets `tags: Set(params.tags)`.

No migration: the column exists. OpenAPI updates through `utoipa::ToSchema`.

Docs: `docs/content/docs/event-access.mdx` - a **Tags** bullet under Key
Structure naming the limits and the CLI vocabulary above.

Tests (`core/tests/http/evt_access.rs`, nextest filter `test(test_evt_access_)`):

- `test_evt_access_create_persists_tags` - POST with tags, assert `view.tags` equals the input and a GET list returns them.
- `test_evt_access_create_rejects_too_many_tags` - 33 tags → 400.
- `test_evt_access_create_rejects_oversized_tag` - a 513-byte tag → 400.
- Unit test for the trim/dedupe helper.

Verification sweep per repo conventions: `cargo check --workspace`, `just fmt`,
`just lint`, then the scoped nextest run once at the end.

## 12. Frontend changes (`core-ui` repo, branch off `one-development`)

Follows the repo's four-layer rule. Files:

| Layer | File | Purpose |
|---|---|---|
| page | `app/cli/auth/page.tsx` | Suspense + `<ControlledCliAuthFlow />` only |
| controlled | `controlled-components/cli-auth/ControlledCliAuthFlow.tsx` | state machine, hooks, redirect; under 500 lines |
| ui | `components/cli-auth/CliInstallSummary.tsx` | read-only rows: Scope, Path, Machine (host · os · arch · user), CLI version |
| ui | `components/cli-auth/HarnessPicker.tsx` | multi-select grid of logo tiles + "Other" text entry |
| ui | `components/cli-auth/KeyNameField.tsx` | name input with default + reset |
| ui | `components/cli-auth/CliAuthDone.tsx` | "You're all set" summary + countdown + "Return to terminal now" |
| ui | reuse `ConnectHostedShell`, `ConnectRail`, `HostedHeading`, `ConnectSpaceCards`, `ConnectAccountChip`, `ConnectHostedSkeleton` | Connect hosted design |
| hooks | `hooks/cli-auth/useCliAuthOrganizations.ts`, `useCliAuthProjects.ts` | React Query wrappers around the existing org/project endpoints |
| hooks | `hooks/cli-auth/useCreateCliKey.ts` + `hooks/ux/cli-auth/useCreateCliKeyUx.ts` | mutation + toast/tracking |
| endpoints | `endpoints/settings.ts`, `endpoints/organizations.ts` | add optional `tags` to the three create functions |
| lib | `lib/cli-auth/install-context.ts` | `parseInstallContext(searchParams)`, `buildKeyTags`, `defaultKeyName`, `HARNESS_CATALOG` |
| types | `types/cli-auth.ts` (backend-shaped), `types/cli-auth-ui.ts` (UI) | as the repo requires |
| tests | `lib/cli-auth/__tests__/install-context.test.ts` | vitest, pure functions |

Small shared-component change: `ConnectRail` / `ConnectHostedShell` accept an
optional `clientMark?: ReactNode` rendered in the client tile when there is no
logo URL, so the CLI page can show a terminal glyph instead of the letter "O".

Flow inside the controlled component:

1. **Boot**: read `port`, `state`, `parseInstallContext(searchParams)`. Missing port/state → the hosted error panel ("This link isn't valid - retry from the CLI"). Not signed in → stash the **whole query string** in `cli_auth_pending` and go to `/sign-in`; `app/(main)/page.tsx` restores it verbatim.
2. **Space** (only when the person has organizations): `ConnectSpaceCards`. Projects for an org load lazily on selection (existing endpoint) and are merged into that org's `projects` so the card's inline project select appears.
3. **Describe this install**: `HostedHeading` ("Where is this CLI running?"), `CliInstallSummary`, `HarnessPicker` pre-selected from `harnesses` + `launcher`, `KeyNameField`. Primary button "Create key". Secondary ghost "Cancel" → callback `error=cancelled`.
4. **Create**: mutation with `{ name, tags }` into the right scope endpoint. Failure → inline error with "Try again"; the button re-enables.
5. **Done**: `CliAuthDone` lists name, account, harnesses, machine; 3-second countdown then `window.location.href = callback`; "Return to terminal now" fires it immediately.

Rail: client "One CLI" with the terminal mark; headline "Connect the One CLI
to your account"; blurb "The CLI gets its own API key, tagged with where it's
installed so you can find and revoke it later."; steps `["Choose an account"?,
"Describe this install", "Create key"]`; no connector strip; cancel label
"Cancel and return to the terminal". Account chip: signed-in email, verified,
scope label after step 2, actions "Sign out and use another account"
(existing dashboard logout, `cli_auth_pending` kept) and cancel.

Harness catalog (all logos already exist in `public/agents/`):

| id | label | logo |
|---|---|---|
| claude-code | Claude Code | claude-code.svg |
| codex | Codex | codex.svg |
| cursor | Cursor | cursor.svg |
| windsurf | Windsurf | windsurf.svg |
| claude-desktop | Claude Desktop | claude-desktop.svg |
| kiro | Kiro | kiro.svg |
| gemini-cli | Gemini CLI | gemini.svg |
| openclaw | OpenClaw | openclaw.svg |
| hermes | Hermes Agent | hermes.svg |
| devin | Devin | devin-color.svg |
| other | Other... | text input → `harness:other-<slug>` |

Theme: the page follows the dashboard theme (no forced light) - the
`connect-widget-theme` tokens are defined for both `.dark` and light.

Tracking: reuse the existing `event_access_key.created` backend event; no new
client events.

## 13. Error handling

| Failure | Behaviour |
|---|---|
| Missing `port`/`state` | hosted error panel, no key minted |
| Org/project listing fails | fall back to personal scope (as today), log to console |
| Key creation fails (network, 4xx, 5xx) | inline error under the button, button re-enabled, nothing redirected |
| Backend rejects tags (400) | same inline error, shows the reason string |
| Person cancels | callback `error=cancelled`; CLI prints "Login cancelled in the browser." and exits 0 |
| CLI never receives a callback | existing 5-minute timeout |
| Old CLI without context | page shows no install rows and a note "Update the CLI to record where it's installed"; tags = `cli`, `scope:global` |

## 14. Privacy and security

- The consent screen is the disclosure: every value that becomes a tag is
  rendered on the "Describe this install" step before the key exists. The CLI
  also prints a one-line note under the URL.
- Hostname, OS username and project path are visible to everyone who can see
  the key (the org). This is intentional and is what makes the key findable.
- `state` still guards the callback; the key still travels only over the
  localhost redirect. Tags never carry secrets: no env vars, no tokens.
- Tags are bounded (32 x 512 bytes) so the URL and the row stay small.

## 15. Local test plan (before any PR)

All three services run locally; no deploy is needed.

1. **Backend**: `cd starter/pica && git checkout -b feat/event-access-tags`. Implement. `cargo check -p core`. Bring up `docker compose up -d` (adds mailpit for sign-in codes), run migrations, `mise x -- just core-dev` on `:5005`. Run `just test -E 'test(test_evt_access_)'` against the already-running test infra.
2. **Frontend**: `cd starter/core-ui && git checkout -b feat/cli-auth-consent` from `one-development`. `yarn dev` on `:4202` (`.env` already points at `localhost:5005`). Sign in through the local backend (code arrives in mailpit at `:8025`).
3. **CLI**: `git checkout -b feat/cli-auth-install-context`. `npm run build`, `npm test`. Run against the local stack with a sandboxed home:
   `ONE_HOME=/tmp/one-cli-test ONE_APP_URL=http://localhost:4202 node bin/cli.js init` and pick browser login, project scope, with a config `apiBase` of `http://localhost:5005`.
4. **Verify**: the consent page shows the rail, space cards, install rows, pre-selected harness, default name; create the key; the terminal shows "Logged in" with the key name; `one whoami` works; and the row has the tags:
   `docker exec pica-postgres-1 psql -U postgres -d postgres -c "select id, name, tags from event_access order by id desc limit 1"`.
5. **Design check**: screenshots of the page in light and dark with the `/browse` skill for review before the PRs.
6. Repeat once with an old-style URL (`?port=..&state=..` only) to confirm the fallback.

## 16. Delivery

Three PRs, merged in this order (each is safe on its own):

1. `pica` → `main`: `feat(event-access): accept tags when minting a key`
2. `core-ui` → `one-development`: `feat(cli-auth): Connect-style consent screen with install context and harness picker`
3. `cli` → `main`: `feat(login): send install context to the browser consent page (v1.56.0)`

Conventional Commit titles; no session URLs in commit messages or PR bodies.

## 17. Decisions to confirm

Defaults are what the spec above assumes.

1. Tag format: namespaced `scope:project` etc. plus the bare `cli` marker (default), versus bare `global` / `project` words.
2. Record OS username and hostname (default yes, both shown on the consent screen).
3. Default key name `CLI · <Harness> · <folder | global>` (default), editable.
4. Harness catalog as listed; "Other" as free text. Add more logos (Copilot CLI, Cline, Aider, Goose, OpenCode, Amp) only if wanted.
5. Frontend PR targets `one-development` (it is 1,233 commits ahead of `main`, which looks abandoned).
6. Callback additions (`name`, `error=cancelled`) and storing `apiKeyName` in the CLI config.
