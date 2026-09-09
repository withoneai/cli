# CLI Browser Auth Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mint CLI keys with install-context tags and a smart name from a Connect-style consent page, fed by context the CLI sends in the auth URL.

**Architecture:** Three independent, backward-compatible changes merged backend → frontend → CLI. The backend accepts and validates `tags` on the three create-key routes and stores them on the existing `event_access.tags` column. The frontend rebuilds `/cli/auth` on the Connect hosted shell (rail + panel) with account cards, an install summary, a harness picker and an editable name, and posts `{name, tags}`. The CLI collects scope, path, machine and harness facts and passes them as query params, and learns the key name plus a cancel signal from the callback.

**Tech Stack:** Rust (axum, SeaORM, nextest, rstest) · Next.js 16 / React 19 / TypeScript / React Query / Tailwind / vitest · Node 18+ TypeScript CLI (commander, @clack/prompts, node:test, tsup)

**Spec:** `docs/superpowers/specs/2026-09-09-cli-browser-auth-consent-design.md` (this repo)

## Global Constraints

- Backend limits: at most **32 tags**, each **1..=512 bytes** after trimming, duplicates removed, order preserved. Violations → HTTP 400 `CanonicalAccessError::InvalidTags`.
- Tag vocabulary (exact strings): `cli`, `scope:global`, `scope:project`, `path:<abs path>`, `harness:<id>`, `launcher:<id>`, `host:<hostname>`, `os:<platform>`, `os-version:<release>`, `arch:<arch>`, `user:<os username>`, `device:<uuid>`, `cli-version:<semver>`.
- Harness ids (shared CLI ↔ frontend): `claude-code`, `claude-desktop`, `codex`, `cursor`, `windsurf`, `kiro`, `gemini-cli`, `openclaw`, `hermes`, `devin`; free text becomes `other-<slug>`.
- Query params CLI → page: `port`, `state`, `scope`, `path`, `host`, `os`, `osv`, `arch`, `user`, `device`, `cli`, `harnesses` (comma list), `launcher`.
- Callback page → CLI: `GET /callback?s=<base64 key>&state=..&name=<url-encoded>` or `GET /callback?error=cancelled&state=..`. `state` is always verified.
- Default key name: `CLI · <Harness label(s) joined by ", "> · <project folder | global>`; max 120 chars.
- Backend commit messages are one line (`type(scope): summary`), staged by explicit path, never `git add -A`, never a merge commit. CLI/frontend commits use Conventional Commits. No Claude session URLs anywhere.
- Backend: no inline `//` comments, only `///` doc comments; never `os.homedir()` in CLI `src/`; CLI tests sandbox home with `withTempHome()`.
- Frontend: types live in `types/`, endpoints only called from hooks, controlled component under 500 lines, semantic colour classes only.
- CLI version bump to `1.56.0` by hand-editing `package.json` and both `"version"` fields in `package-lock.json` (no `npm install`).
- Branches: pica `feat/event-access-tags` off `main`; core-ui `feat/cli-auth-consent` off `one-development`; cli `feat/cli-auth-install-context` (exists, holds the spec).

---

# Part A — Backend (`/Users/paulkrishnamurthy/Documents/One-Development/starter/pica`)

Run everything through mise so `just` and the pinned toolchain resolve: `mise x -- just <recipe>` or `cargo <cmd>` directly (cargo is on PATH).

### Task A1: Thread `tags` from the create routes down to the row

**Files:**
- Modify: `common/src/schema/extension/event_access.rs:276-300` (`SecureKeyParams`, `new_for_session`) and the `build_key_record` body (~line 960)
- Modify: `core/src/domain/organization.rs:495-505` and `:875-885`
- Modify: `core/src/domain/link_invitation.rs:469-483` and `:765-777`
- Modify: `core/src/domain/event_access.rs:131-139` (`CreateParams`), `:205-267` (`create_for_*`), `:504-516` (`do_create`)
- Modify: `core/src/http/routes/common/event_access.rs:36-69` (params structs), `:99-107`, `:260-268`, `:390-399` (handlers)
- Modify: `core/src/http/routes/common/management.rs:690-699` and `:1567`
- Modify: `core/src/http/routes/operator/system/account.rs:131-138`

**Interfaces:**
- Produces: `SecureKeyParams.tags: Vec<String>`; `EventAccessDomain::create_for_user(user_id, connection_type, environment, name, tags, origin)`, `create_for_organization(user_id, org_id, connection_type, environment, name, tags, origin)`, `create_for_project(user_id, org_id, project_id, connection_type, environment, name, tags, origin)`; request bodies accept `tags: Vec<String>` (default empty).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/paulkrishnamurthy/Documents/One-Development/starter/pica
git checkout main && git pull --ff-only && git checkout -b feat/event-access-tags
```

- [ ] **Step 2: Add `tags` to `SecureKeyParams` and write it on the row**

In `common/src/schema/extension/event_access.rs`, extend the struct and its constructor:

```rust
#[derive(Debug)]
pub struct SecureKeyParams {
    pub user_id:         Uuid,
    pub organization_id: Option<Uuid>,
    pub project_id:      Option<Uuid>,
    pub connection_type: ConnectionType,
    pub environment:     SecretKeyEnvironment,
    pub name:            Option<String>,
    pub throughput:      Option<i32>,
    pub attributes:      EventAccessAttributes,
    /// Free-form labels stored on the row. The CLI records where it is
    /// installed here; every other minter leaves it empty.
    pub tags:            Vec<String>
}

impl SecureKeyParams {
    pub fn new_for_session(user_id: Uuid, environment: SecretKeyEnvironment) -> Self {
        Self {
            user_id,
            organization_id: None,
            project_id: None,
            connection_type: ConnectionType::Api,
            environment,
            name: Some("Session Key".to_string()),
            throughput: None,
            attributes: EventAccessAttributes::default(),
            tags: Vec::new()
        }
    }
}
```

In `build_key_record`, add one line to the `WEventAccess { .. }` literal, next to `attributes`:

```rust
            attributes: Set(params.attributes),
            tags: Set(params.tags),
```

- [ ] **Step 3: Fix the four other `SecureKeyParams { .. }` literals**

`core/src/domain/organization.rs` (both sites, after `attributes: key_params.attributes`):

```rust
                        attributes: key_params.attributes,
                        tags: Vec::new()
```

`core/src/domain/link_invitation.rs:469` (the invitation mint; after the `attributes: EventAccessAttributes(vec![...])` entry):

```rust
            tags: Vec::new()
```

`core/src/domain/link_invitation.rs:765` (rotation keeps the old key's labels):

```rust
            attributes:      old_event_access.attributes.clone(),
            tags:            old_event_access.tags.clone()
```

- [ ] **Step 4: Thread `tags` through the domain**

In `core/src/domain/event_access.rs`:

```rust
struct CreateParams {
    user_id:         Uuid,
    organization_id: Option<Uuid>,
    project_id:      Option<Uuid>,
    connection_type: ConnectionType,
    environment:     SecretKeyEnvironment,
    name:            Option<String>,
    tags:            Vec<String>,
    source:          &'static str
}
```

Add a `tags: Vec<String>` parameter to each of the three public constructors, placed right after `name`, and forward it:

```rust
    pub async fn create_for_user(
        &self,
        user_id: Uuid,
        connection_type: ConnectionType,
        environment: SecretKeyEnvironment,
        name: Option<String>,
        tags: Vec<String>,
        origin: EventAccessOrigin
    ) -> Result<(EventAccessView, String), CanonicalAccessError> {
        self.do_create(CreateParams {
            user_id,
            organization_id: None,
            project_id: None,
            connection_type,
            environment,
            name,
            tags,
            source: origin.create_user()
        })
        .await
    }
```

(Same shape for `create_for_organization` and `create_for_project`; `create_for_project` already carries `#[allow(clippy::too_many_arguments)]` — add the same attribute to `create_for_organization`, which now has seven.)

In `do_create`, pass them into the store params:

```rust
        let secure_params = SecureKeyParams {
            user_id:         params.user_id,
            organization_id: params.organization_id,
            project_id:      params.project_id,
            connection_type: params.connection_type,
            environment:     params.environment,
            name:            params.name.clone(),
            throughput:      None,
            attributes:      EventAccessAttributes::default(),
            tags:            params.tags
        };
```

- [ ] **Step 5: Accept `tags` on the three HTTP bodies and forward them**

In `core/src/http/routes/common/event_access.rs`, add to **both** `Params` and `OrganizationEventAccessParams` after `hide`:

```rust
    hide:            Option<bool>,
    /// Free-form labels stored on the key: at most 32, each at most 512
    /// bytes once trimmed, duplicates dropped. The CLI records where it is
    /// installed here (`scope:project`, `path:…`, `harness:…`).
    #[serde(default)]
    tags:            Vec<String>
}
```

Then in `add`, `create_organization_key` and `create_project_key`, insert `params.tags,` right after the `origin.label(params.name),` argument.

- [ ] **Step 6: Update the other callers**

`core/src/http/routes/common/management.rs:690` (`create_for_project`): add `Vec::new(),` after `name,`. `:1567` (`create_for_organization`): becomes
```rust
        .create_for_organization(user_id, org_id, ConnectionType::Api, environment, name, Vec::new(), EventAccessOrigin::Management)
```
`core/src/http/routes/operator/system/account.rs:131`: add `Vec::new(),` after the `Some(format!("test-account-{}", user.id)),` line.

- [ ] **Step 7: Compile**

Run: `cargo check -p core`
Expected: clean. If a fixture in another crate constructs `SecureKeyParams`, `cargo check --all-targets -p core -p common` will name it; add `tags: Vec::new()` there too.

- [ ] **Step 8: Commit**

```bash
git add common/src/schema/extension/event_access.rs core/src/domain/event_access.rs core/src/domain/organization.rs core/src/domain/link_invitation.rs core/src/http/routes/common/event_access.rs core/src/http/routes/common/management.rs core/src/http/routes/operator/system/account.rs
git commit -m "feat(event-access): carry tags from the create routes to the key row"
```

### Task A2: Validate tags in the domain and return 400 on bad input

**Files:**
- Modify: `core/src/domain/access.rs` (add `InvalidTags` variant + mappings)
- Modify: `core/src/domain/event_access.rs` (consts, `normalize_key_tags`, call in `do_create`, unit tests)
- Test: `core/src/domain/event_access.rs` `mod tests`

**Interfaces:**
- Produces: `pub(crate) const MAX_KEY_TAGS: usize = 32; pub(crate) const MAX_KEY_TAG_LEN: usize = 512; pub(crate) fn normalize_key_tags(tags: Vec<String>) -> Result<Vec<String>, CanonicalAccessError>`; `CanonicalAccessError::InvalidTags { reason: String }`.

- [ ] **Step 1: Write the failing unit tests**

Append to the existing `mod tests` at the bottom of `core/src/domain/event_access.rs`:

```rust
    use super::{MAX_KEY_TAG_LEN, MAX_KEY_TAGS, normalize_key_tags};
    use crate::domain::access::CanonicalAccessError;

    #[test]
    fn test_event_access_normalize_key_tags_trims_and_dedupes_preserving_order() {
        let tags = vec![" cli ".to_string(), "scope:project".to_string(), "cli".to_string()];
        assert_eq!(normalize_key_tags(tags).unwrap(), vec!["cli", "scope:project"]);
    }

    #[test]
    fn test_event_access_normalize_key_tags_rejects_blank() {
        assert!(matches!(
            normalize_key_tags(vec!["   ".to_string()]),
            Err(CanonicalAccessError::InvalidTags { .. })
        ));
    }

    #[test]
    fn test_event_access_normalize_key_tags_rejects_too_many() {
        let tags = (0..=MAX_KEY_TAGS).map(|i| format!("t{i}")).collect();
        assert!(matches!(normalize_key_tags(tags), Err(CanonicalAccessError::InvalidTags { .. })));
    }

    #[test]
    fn test_event_access_normalize_key_tags_rejects_oversized() {
        let tags = vec!["a".repeat(MAX_KEY_TAG_LEN + 1)];
        assert!(matches!(normalize_key_tags(tags), Err(CanonicalAccessError::InvalidTags { .. })));
    }

    #[test]
    fn test_event_access_normalize_key_tags_accepts_limits_exactly() {
        let tags: Vec<String> = (0..MAX_KEY_TAGS).map(|i| format!("{i}")).collect();
        assert_eq!(normalize_key_tags(tags.clone()).unwrap(), tags);
        assert!(normalize_key_tags(vec!["a".repeat(MAX_KEY_TAG_LEN)]).is_ok());
    }
```

- [ ] **Step 2: Run them to see the compile failure**

Run: `cargo nextest run -p core --lib -E 'test(test_event_access_normalize_key_tags_)'`
Expected: fails to compile (`normalize_key_tags` and `InvalidTags` undefined).

- [ ] **Step 3: Add the error variant**

In `core/src/domain/access.rs`, add a variant to `CanonicalAccessError` after `MissingOrganizationContext`:

```rust
    /// Caller sent a tag set the key cannot carry: more than
    /// `MAX_KEY_TAGS`, a tag longer than `MAX_KEY_TAG_LEN` bytes, or a
    /// blank tag. Wire response 400.
    #[error("Invalid key tags: {reason}")]
    InvalidTags { reason: String },
```

In `user_message`:

```rust
            Self::InvalidTags { reason } => Cow::Owned(format!("Invalid tags: {reason}")),
```

In `status_code`, extend the 400 arm:

```rust
            Self::ConnectionNotInScope { .. }
            | Self::EmptyMethodsAndRules
            | Self::MissingOrganizationContext
            | Self::InvalidTags { .. } => StatusCode::BAD_REQUEST,
```

- [ ] **Step 4: Add the normalizer and call it**

In `core/src/domain/event_access.rs`, near `OAUTH_KEY_MARKER`:

```rust
/// Upper bound on labels a key carries. Wide enough for the CLI's install
/// context (a dozen tags) with room for a person's own labels.
pub(crate) const MAX_KEY_TAGS: usize = 32;
/// Per-tag byte limit. A project path is a tag, so this is generous.
pub(crate) const MAX_KEY_TAG_LEN: usize = 512;

/// Trims, drops duplicates (first occurrence wins) and enforces the tag
/// limits, so every minter stores the same shape whatever the wire sent.
pub(crate) fn normalize_key_tags(tags: Vec<String>) -> Result<Vec<String>, CanonicalAccessError> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(tags.len());
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            return Err(CanonicalAccessError::InvalidTags { reason: "a tag cannot be blank".to_string() });
        }
        if trimmed.len() > MAX_KEY_TAG_LEN {
            return Err(CanonicalAccessError::InvalidTags {
                reason: format!("a tag cannot exceed {MAX_KEY_TAG_LEN} bytes")
            });
        }
        if seen.insert(trimmed.to_string()) {
            out.push(trimmed.to_string());
        }
    }
    if out.len() > MAX_KEY_TAGS {
        return Err(CanonicalAccessError::InvalidTags {
            reason: format!("a key cannot carry more than {MAX_KEY_TAGS} tags; got {}", out.len())
        });
    }
    Ok(out)
}
```

At the top of `do_create`:

```rust
    async fn do_create(&self, params: CreateParams) -> Result<(EventAccessView, String), CanonicalAccessError> {
        let tags = normalize_key_tags(params.tags)?;
        let secure_params = SecureKeyParams {
            ...
            tags
        };
```

- [ ] **Step 5: Run the unit tests**

Run: `cargo nextest run -p core --lib -E 'test(test_event_access_normalize_key_tags_)'`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add core/src/domain/access.rs core/src/domain/event_access.rs
git commit -m "feat(event-access): validate and normalize key tags on mint"
```

### Task A3: HTTP tests, docs, verification sweep

**Files:**
- Test: `core/tests/http/evt_access.rs` (append)
- Modify: `docs/content/docs/event-access.mdx:18`

- [ ] **Step 1: Append the HTTP tests**

Mirror `test_evt_access_create_succeeds_with_valid_permissions` (same server, cookie, headers):

```rust
#[rstest]
#[tokio::test]
pub async fn test_evt_access_create_persists_normalized_tags(#[by_ref] http_client: &reqwest::Client) {
    let server = TestServer::new().await;
    let (user_cookie, _) = server.login(http_client, Role::Common).await;
    let payload = EVENT_ACCESS_PAYLOAD
        .clone()
        .modify("tags", json!(["cli", " scope:project ", "cli", "path:/tmp/acme"]));

    let response = http_client
        .post(format!("http://localhost:{}/v1/event-access", server.port))
        .header("Cookie", user_cookie.clone())
        .header("X-Pica-Action-Environment", "test")
        .json(&payload)
        .send()
        .await
        .expect("Failed to send request");
    assert_eq!(response.status(), StatusCode::OK);
    let created = response.json::<EventAccessView>().await.expect("Failed to parse response");
    assert_eq!(created.tags, vec!["cli", "scope:project", "path:/tmp/acme"]);

    let listed = http_client
        .get(format!("http://localhost:{}/v1/event-access?environment=test", server.port))
        .header("Cookie", user_cookie)
        .header("X-Pica-Action-Environment", "test")
        .send()
        .await
        .expect("Failed to send request")
        .json::<Paginated<EventAccessView>>()
        .await
        .expect("Failed to parse list");
    let row = listed.rows().iter().find(|r| r.id == created.id).expect("created key is listed");
    assert_eq!(row.tags, created.tags);
}

#[rstest]
#[tokio::test]
pub async fn test_evt_access_create_rejects_too_many_tags(#[by_ref] http_client: &reqwest::Client) {
    let server = TestServer::new().await;
    let (user_cookie, _) = server.login(http_client, Role::Common).await;
    let tags: Vec<String> = (0..33).map(|i| format!("tag-{i}")).collect();
    let response = http_client
        .post(format!("http://localhost:{}/v1/event-access", server.port))
        .header("Cookie", user_cookie)
        .header("X-Pica-Action-Environment", "test")
        .json(&EVENT_ACCESS_PAYLOAD.clone().modify("tags", json!(tags)))
        .send()
        .await
        .expect("Failed to send request");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[rstest]
#[tokio::test]
pub async fn test_evt_access_create_rejects_oversized_tag(#[by_ref] http_client: &reqwest::Client) {
    let server = TestServer::new().await;
    let (user_cookie, _) = server.login(http_client, Role::Common).await;
    let response = http_client
        .post(format!("http://localhost:{}/v1/event-access", server.port))
        .header("Cookie", user_cookie)
        .header("X-Pica-Action-Environment", "test")
        .json(&EVENT_ACCESS_PAYLOAD.clone().modify("tags", json!(["a".repeat(513)])))
        .send()
        .await
        .expect("Failed to send request");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
```

If the existing list test at line 109 builds the list URL differently (check its `.get(...)` call), copy that exact form instead of `?environment=test`.

- [ ] **Step 2: Document the field**

In `docs/content/docs/event-access.mdx`, add after the **Throughput** bullet:

```md
- **Tags** are free-form labels set when the key is minted (`tags` on the create body): at most 32, each at most 512 bytes, trimmed and de-duplicated on write. The CLI uses them to record where it is installed — `cli`, `scope:global` or `scope:project`, `path:<directory>`, `harness:<agent>`, `launcher:<agent>`, `host:`, `os:`, `os-version:`, `arch:`, `user:`, `device:` and `cli-version:` — so the dashboard can show which machine and project a key belongs to.
```

- [ ] **Step 3: Verification sweep (once)**

```bash
cargo check --workspace --all-targets
mise x -- just fmt
mise x -- just lint
cargo nextest run -p core -E 'test(test_evt_access_) or test(test_event_access_)'
```
Expected: all green. Test infra (`pica-test-pg`, `pica-test-redis`) is already up; if the suite times out across the board, `mise x -- just test-infra-down && mise x -- just test-infra-up`.

- [ ] **Step 4: Commit**

```bash
git add core/tests/http/evt_access.rs docs/content/docs/event-access.mdx
git commit -m "test(event-access): cover tag persistence and limits on mint"
```
(If `just fmt` touched files from A1/A2, include them in this commit.)

---

# Part B — Frontend (`/Users/paulkrishnamurthy/Documents/One-Development/starter/core-ui`)

Node/yarn come from the repo's `mise.toml`; run commands as `mise x -- yarn <script>` or plain `npx` if node is already on PATH. Typecheck with `NODE_OPTIONS=--max-old-space-size=10240 npx tsc --noEmit`. Lint only the files you touched with `npx eslint <files>` (the repo's `yarn lint` runs `--fix` over the whole tree).

### Task B1: Pure install-context helpers, types, and tests

**Files:**
- Create: `types/cli-auth-ui.ts`, `types/cli-auth.ts`
- Create: `lib/cli-auth/install-context.ts`, `lib/cli-auth/pending.ts`
- Test: `lib/cli-auth/__tests__/install-context.test.ts`, `lib/cli-auth/__tests__/pending.test.ts`

**Interfaces:**
- Produces: `CliInstallContext`, `HarnessOption`, `CliKeyTarget`, `CreateCliKeyInput`; `parseInstallContext`, `HARNESS_CATALOG`, `OTHER_HARNESS_ID`, `initialHarnessSelection`, `resolveHarnessIds`, `harnessLabel`, `buildKeyTags`, `defaultKeyName`, `osLabel`, `cliCallbackUrl`, `cliCancelUrl`, `MAX_KEY_NAME_LENGTH`; `stashPendingCliAuth`, `takePendingCliAuth`, `CLI_AUTH_PENDING_KEY`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/paulkrishnamurthy/Documents/One-Development/starter/core-ui
git checkout one-development && git pull --ff-only && git checkout -b feat/cli-auth-consent
```

- [ ] **Step 2: Write the types**

`types/cli-auth-ui.ts`:

```ts
/**
 * UI-only types for the CLI browser-auth consent page (`/cli/auth`).
 * Backend-shaped types live in types/cli-auth.ts.
 */

export type CliInstallScope = "global" | "project";

/** Everything the CLI said about itself in the /cli/auth query string. */
export interface CliInstallContext {
  port: string | null;
  state: string | null;
  scope: CliInstallScope | null;
  /** Project root; only present for project scope. */
  path: string | null;
  host: string | null;
  /** Node's process.platform: darwin / linux / win32. */
  os: string | null;
  osVersion: string | null;
  arch: string | null;
  /** OS username on the machine. */
  user: string | null;
  /** Stable per-install id from ~/.one/device-id. */
  device: string | null;
  cliVersion: string | null;
  /** Harness ids the CLI found installed on the machine. */
  detectedHarnesses: string[];
  /** Harness id that spawned the CLI process, when an agent ran it. */
  launcher: string | null;
  /** False for an older CLI that only sent port + state. */
  hasInstallContext: boolean;
}

export interface HarnessOption {
  id: string;
  label: string;
  /** Asset path under /public. */
  logo: string;
}

export type CliAuthStep = "loading" | "space" | "describe" | "done" | "error";
```

`types/cli-auth.ts`:

```ts
/** Which create-key route the consent page posts to. */
export interface CliKeyTarget {
  organizationId: string | null;
  projectId: string | null;
}

/** Body of the key mint, as the backend create routes take it. */
export interface CreateCliKeyInput {
  target: CliKeyTarget;
  name: string;
  tags: string[];
}
```

- [ ] **Step 3: Write the failing tests**

`lib/cli-auth/__tests__/install-context.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildKeyTags,
  cliCallbackUrl,
  cliCancelUrl,
  defaultKeyName,
  HARNESS_CATALOG,
  harnessLabel,
  initialHarnessSelection,
  OTHER_HARNESS_ID,
  osLabel,
  parseInstallContext,
  resolveHarnessIds,
  slugifyHarness,
} from "@/lib/cli-auth/install-context";

const FULL_QUERY =
  "?port=51234&state=abc-123&scope=project&path=%2FUsers%2Fpaul%2Fdev%2Facme%20app" +
  "&host=Pauls-MBP.local&os=darwin&osv=25.2.0&arch=arm64&user=paul&device=6f1c0b1e-1111-4222-8333-944444444444" +
  "&cli=1.56.0&harnesses=claude-code%2Ccursor%2Cunknown-tool&launcher=claude-code";

describe("parseInstallContext", () => {
  it("reads every field the CLI sends", () => {
    const ctx = parseInstallContext(new URLSearchParams(FULL_QUERY));
    expect(ctx).toMatchObject({
      port: "51234",
      state: "abc-123",
      scope: "project",
      path: "/Users/paul/dev/acme app",
      host: "Pauls-MBP.local",
      os: "darwin",
      osVersion: "25.2.0",
      arch: "arm64",
      user: "paul",
      device: "6f1c0b1e-1111-4222-8333-944444444444",
      cliVersion: "1.56.0",
      detectedHarnesses: ["claude-code", "cursor", "unknown-tool"],
      launcher: "claude-code",
      hasInstallContext: true,
    });
  });

  it("treats an old CLI's port+state URL as having no install context", () => {
    const ctx = parseInstallContext(new URLSearchParams("?port=1&state=s"));
    expect(ctx.hasInstallContext).toBe(false);
    expect(ctx.scope).toBeNull();
    expect(ctx.detectedHarnesses).toEqual([]);
  });

  it("drops a path when the scope is global and rejects unknown scopes", () => {
    expect(parseInstallContext(new URLSearchParams("?port=1&state=s&scope=global&path=%2Ftmp")).path).toBeNull();
    expect(parseInstallContext(new URLSearchParams("?port=1&state=s&scope=weird")).scope).toBeNull();
  });

  it("survives a null params object", () => {
    expect(parseInstallContext(null).port).toBeNull();
  });
});

describe("harness helpers", () => {
  it("has unique ids and a logo for every catalog entry", () => {
    const ids = HARNESS_CATALOG.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of HARNESS_CATALOG) expect(h.logo).toMatch(/^\/agents\/.+\.svg$/);
    expect(ids).not.toContain(OTHER_HARNESS_ID);
  });

  it("preselects detected harnesses and the launcher, ignoring unknown ids", () => {
    const ctx = parseInstallContext(new URLSearchParams("?port=1&state=s&harnesses=cursor%2Cnope&launcher=codex"));
    expect(initialHarnessSelection(ctx)).toEqual(["codex", "cursor"]);
  });

  it("slugifies and prefixes the free-text entry", () => {
    expect(slugifyHarness("  My Cool Tool! ")).toBe("my-cool-tool");
    expect(resolveHarnessIds(["claude-code", OTHER_HARNESS_ID], "Aider")).toEqual(["claude-code", "other-aider"]);
    expect(resolveHarnessIds([OTHER_HARNESS_ID], "   ")).toEqual([]);
    expect(resolveHarnessIds(["claude-code", "claude-code", "bogus"], "")).toEqual(["claude-code"]);
  });

  it("labels known ids from the catalog and title-cases the rest", () => {
    expect(harnessLabel("claude-code")).toBe("Claude Code");
    expect(harnessLabel("other-my-tool")).toBe("My Tool");
  });
});

describe("buildKeyTags", () => {
  it("emits the documented vocabulary in order", () => {
    const ctx = parseInstallContext(new URLSearchParams(FULL_QUERY));
    expect(buildKeyTags(ctx, ["claude-code", "other-aider"])).toEqual([
      "cli",
      "scope:project",
      "path:/Users/paul/dev/acme app",
      "harness:claude-code",
      "harness:other-aider",
      "launcher:claude-code",
      "host:Pauls-MBP.local",
      "os:darwin",
      "os-version:25.2.0",
      "arch:arm64",
      "user:paul",
      "device:6f1c0b1e-1111-4222-8333-944444444444",
      "cli-version:1.56.0",
    ]);
  });

  it("defaults to global scope and omits every missing field", () => {
    const ctx = parseInstallContext(new URLSearchParams("?port=1&state=s"));
    expect(buildKeyTags(ctx, [])).toEqual(["cli", "scope:global"]);
  });

  it("never exceeds the backend limits", () => {
    const ctx = parseInstallContext(new URLSearchParams("?port=1&state=s"));
    const many = Array.from({ length: 40 }, (_, i) => `h${i}`);
    expect(buildKeyTags(ctx, many).length).toBe(32);
    const long = parseInstallContext(new URLSearchParams(`?port=1&state=s&scope=project&path=${"a".repeat(600)}`));
    expect(buildKeyTags(long, []).some((t) => t.startsWith("path:"))).toBe(false);
  });
});

describe("defaultKeyName", () => {
  it("names the harnesses and the project folder", () => {
    const ctx = parseInstallContext(new URLSearchParams(FULL_QUERY));
    expect(defaultKeyName(ctx, ["claude-code", "cursor"])).toBe("CLI · Claude Code, Cursor · acme app");
  });

  it("falls back to global and skips the harness segment", () => {
    const ctx = parseInstallContext(new URLSearchParams("?port=1&state=s"));
    expect(defaultKeyName(ctx, [])).toBe("CLI · global");
  });

  it("handles Windows paths and caps the length", () => {
    const ctx = parseInstallContext(new URLSearchParams("?port=1&state=s&scope=project&path=C%3A%5CUsers%5Cjane%5Cproj"));
    expect(defaultKeyName(ctx, [])).toBe("CLI · proj");
    expect(defaultKeyName(ctx, ["other-" + "x".repeat(200)]).length).toBeLessThanOrEqual(120);
  });
});

describe("osLabel + callback urls", () => {
  it("humanizes platforms", () => {
    expect(osLabel("darwin", "25.2.0")).toBe("macOS 25.2.0");
    expect(osLabel("win32", null)).toBe("Windows");
    expect(osLabel(null, null)).toBeNull();
  });

  it("builds the callback with a base64 key, state and name", () => {
    const ctx = parseInstallContext(new URLSearchParams("?port=51234&state=a%20b"));
    const url = new URL(cliCallbackUrl(ctx, { accessKey: "sk_live_x", name: "CLI · acme" }));
    expect(url.origin + url.pathname).toBe("http://localhost:51234/callback");
    expect(atob(url.searchParams.get("s")!)).toBe("sk_live_x");
    expect(url.searchParams.get("state")).toBe("a b");
    expect(url.searchParams.get("name")).toBe("CLI · acme");
  });

  it("builds the cancel callback", () => {
    const ctx = parseInstallContext(new URLSearchParams("?port=7&state=z"));
    expect(cliCancelUrl(ctx)).toBe("http://localhost:7/callback?error=cancelled&state=z");
  });
});
```

`lib/cli-auth/__tests__/pending.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI_AUTH_PENDING_KEY, stashPendingCliAuth, takePendingCliAuth } from "@/lib/cli-auth/pending";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

describe("pending CLI auth stash", () => {
  let storage: MemoryStorage;
  beforeEach(() => {
    storage = new MemoryStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("round-trips the full query string and clears it on take", () => {
    stashPendingCliAuth("?port=1&state=s&scope=project");
    expect(takePendingCliAuth()).toBe("?port=1&state=s&scope=project");
    expect(takePendingCliAuth()).toBeNull();
  });

  it("accepts the legacy {port,state} shape written by the old page", () => {
    storage.setItem(CLI_AUTH_PENDING_KEY, JSON.stringify({ port: "9", state: "a b" }));
    expect(takePendingCliAuth()).toBe("?port=9&state=a%20b");
  });

  it("drops garbage instead of throwing", () => {
    storage.setItem(CLI_AUTH_PENDING_KEY, "{not json");
    expect(takePendingCliAuth()).toBeNull();
    expect(storage.getItem(CLI_AUTH_PENDING_KEY)).toBeNull();
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npx vitest run lib/cli-auth`
Expected: both files fail to import (modules missing).

- [ ] **Step 5: Implement `lib/cli-auth/install-context.ts`**

```ts
import type {
  CliInstallContext,
  CliInstallScope,
  HarnessOption,
} from "@/types/cli-auth-ui";

/** Key-name cap on the consent form; the column itself is unbounded. */
export const MAX_KEY_NAME_LENGTH = 120;
/** Backend limits on `tags` (core/src/domain/event_access.rs). */
export const MAX_KEY_TAGS = 32;
export const MAX_KEY_TAG_LENGTH = 512;
/** Picker id for the free-text entry; never sent as-is. */
export const OTHER_HARNESS_ID = "other";

/** Ids match the CLI's agent registry (src/lib/agents.ts) where one exists. */
export const HARNESS_CATALOG: HarnessOption[] = [
  { id: "claude-code", label: "Claude Code", logo: "/agents/claude-code.svg" },
  { id: "codex", label: "Codex", logo: "/agents/codex.svg" },
  { id: "cursor", label: "Cursor", logo: "/agents/cursor.svg" },
  { id: "windsurf", label: "Windsurf", logo: "/agents/windsurf.svg" },
  { id: "claude-desktop", label: "Claude Desktop", logo: "/agents/claude-desktop.svg" },
  { id: "kiro", label: "Kiro", logo: "/agents/kiro.svg" },
  { id: "gemini-cli", label: "Gemini CLI", logo: "/agents/gemini.svg" },
  { id: "openclaw", label: "OpenClaw", logo: "/agents/openclaw.svg" },
  { id: "hermes", label: "Hermes Agent", logo: "/agents/hermes.svg" },
  { id: "devin", label: "Devin", logo: "/agents/devin-color.svg" },
];

type ParamReader = { get(name: string): string | null } | null | undefined;

function read(params: ParamReader, key: string): string | null {
  const value = params?.get(key)?.trim();
  return value ? value : null;
}

export function parseInstallContext(params: ParamReader): CliInstallContext {
  const rawScope = read(params, "scope");
  const scope: CliInstallScope | null =
    rawScope === "global" || rawScope === "project" ? rawScope : null;
  const detectedHarnesses = (read(params, "harnesses") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base = {
    port: read(params, "port"),
    state: read(params, "state"),
    scope,
    path: scope === "project" ? read(params, "path") : null,
    host: read(params, "host"),
    os: read(params, "os"),
    osVersion: read(params, "osv"),
    arch: read(params, "arch"),
    user: read(params, "user"),
    device: read(params, "device"),
    cliVersion: read(params, "cli"),
    detectedHarnesses,
    launcher: read(params, "launcher"),
  };
  const hasInstallContext =
    [base.scope, base.host, base.os, base.device, base.cliVersion].some(Boolean) ||
    detectedHarnesses.length > 0;
  return { ...base, hasInstallContext };
}

export function slugifyHarness(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** Catalog ids the person ticked, plus `other-<slug>` for the free-text entry. */
export function resolveHarnessIds(selected: string[], otherLabel: string): string[] {
  const ids = selected.filter(
    (id) => id !== OTHER_HARNESS_ID && HARNESS_CATALOG.some((h) => h.id === id),
  );
  if (selected.includes(OTHER_HARNESS_ID)) {
    const slug = slugifyHarness(otherLabel);
    if (slug) ids.push(`other-${slug}`);
  }
  return Array.from(new Set(ids));
}

export function harnessLabel(id: string): string {
  const known = HARNESS_CATALOG.find((h) => h.id === id);
  if (known) return known.label;
  const slug = id.startsWith("other-") ? id.slice("other-".length) : id;
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Preselect what the CLI found installed plus whatever launched it, in catalog order. */
export function initialHarnessSelection(ctx: CliInstallContext): string[] {
  const wanted = new Set([...ctx.detectedHarnesses, ...(ctx.launcher ? [ctx.launcher] : [])]);
  return HARNESS_CATALOG.filter((h) => wanted.has(h.id)).map((h) => h.id);
}

/** The one place the tag vocabulary is composed. Keep in sync with the spec table. */
export function buildKeyTags(ctx: CliInstallContext, harnesses: string[]): string[] {
  const tags: string[] = ["cli", `scope:${ctx.scope ?? "global"}`];
  if (ctx.scope === "project" && ctx.path) tags.push(`path:${ctx.path}`);
  for (const h of harnesses) tags.push(`harness:${h}`);
  if (ctx.launcher) tags.push(`launcher:${ctx.launcher}`);
  if (ctx.host) tags.push(`host:${ctx.host}`);
  if (ctx.os) tags.push(`os:${ctx.os}`);
  if (ctx.osVersion) tags.push(`os-version:${ctx.osVersion}`);
  if (ctx.arch) tags.push(`arch:${ctx.arch}`);
  if (ctx.user) tags.push(`user:${ctx.user}`);
  if (ctx.device) tags.push(`device:${ctx.device}`);
  if (ctx.cliVersion) tags.push(`cli-version:${ctx.cliVersion}`);
  const unique = Array.from(
    new Set(
      tags
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= MAX_KEY_TAG_LENGTH),
    ),
  );
  return unique.slice(0, MAX_KEY_TAGS);
}

export function projectFolderName(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function defaultKeyName(ctx: CliInstallContext, harnesses: string[]): string {
  const who = harnesses.map(harnessLabel).filter(Boolean).join(", ");
  const where =
    ctx.scope === "project" ? (projectFolderName(ctx.path) ?? "project") : "global";
  return ["CLI", who || null, where]
    .filter(Boolean)
    .join(" · ")
    .slice(0, MAX_KEY_NAME_LENGTH);
}

export function osLabel(os: string | null, osVersion: string | null): string | null {
  if (!os) return null;
  const names: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
  const name = names[os] ?? os;
  return osVersion ? `${name} ${osVersion}` : name;
}

export function cliCallbackUrl(
  ctx: CliInstallContext,
  key: { accessKey: string; name: string },
): string {
  const params = new URLSearchParams({
    s: btoa(key.accessKey),
    state: ctx.state ?? "",
    name: key.name,
  });
  return `http://localhost:${ctx.port}/callback?${params.toString()}`;
}

export function cliCancelUrl(ctx: CliInstallContext): string {
  const params = new URLSearchParams({ error: "cancelled", state: ctx.state ?? "" });
  return `http://localhost:${ctx.port}/callback?${params.toString()}`;
}
```

- [ ] **Step 6: Implement `lib/cli-auth/pending.ts`**

```ts
/** localStorage slot the sign-in bounce uses to get back to /cli/auth. */
export const CLI_AUTH_PENDING_KEY = "cli_auth_pending";

interface PendingCliAuth {
  /** The full /cli/auth query string, leading "?" included. */
  search?: string;
  /** Shape written by the previous page version. */
  port?: string;
  state?: string;
}

export function stashPendingCliAuth(search: string): void {
  try {
    localStorage.setItem(CLI_AUTH_PENDING_KEY, JSON.stringify({ search }));
  } catch {
    /* private mode or blocked storage: the person retries from the CLI */
  }
}

/** Returns the stashed query string (and clears it), or null. */
export function takePendingCliAuth(): string | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(CLI_AUTH_PENDING_KEY);
    if (raw !== null) localStorage.removeItem(CLI_AUTH_PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PendingCliAuth;
    if (parsed.search?.startsWith("?")) return parsed.search;
    if (parsed.port && parsed.state) {
      return `?port=${encodeURIComponent(parsed.port)}&state=${encodeURIComponent(parsed.state)}`;
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run lib/cli-auth`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add types/cli-auth-ui.ts types/cli-auth.ts lib/cli-auth
git commit -m "feat(cli-auth): install-context parsing, tag vocabulary and pending stash helpers"
```

### Task B2: Endpoints and hooks

**Files:**
- Modify: `endpoints/settings.ts:10-37`, `endpoints/organizations.ts:443-480` and `:501-540`
- Modify: `hooks/organizations/useListOrganizations.ts`
- Create: `hooks/cli-auth/useCliAuthSpaces.ts`, `hooks/cli-auth/useCreateCliKey.ts`, `hooks/ux/cli-auth/useCreateCliKeyUx.ts`

**Interfaces:**
- Consumes: `CreateCliKeyInput`, `EventAccess` (`types/secrets.ts`), `ConnectOrganizationView` (`types/oauth-connect.ts`).
- Produces: `useCliAuthSpaces({ selectedOrganizationId, enabled }) → { organizations: ConnectOrganizationView[]; isLoading; isError; projectsLoading }`; `useCreateCliKeyUx() → { trigger(input): Promise<EventAccess | null>; isLoading; error: string | null }`.

- [ ] **Step 1: Add `tags` to the three create endpoints**

`endpoints/settings.ts`:

```ts
export const createSecretKeyApi = ({
  name,
  env = "test",
  hide = false,
  tags,
}: {
  name: string;
  env?: "test" | "live";
  hide?: boolean;
  tags?: string[];
}) =>
  apiWithToken({
    url: apiKeys["secrets"],
    method: "POST",
    env,
    payload: {
      name,
      group: name,
      connectionType: "custom",
      platform: "pica",
      environment: env,
      paths: {
        id: null,
        event: null,
        payload: null,
        secret: null,
        signature: null,
      },
      hide,
      ...(tags && tags.length > 0 ? { tags } : {}),
    },
  });
```

`endpoints/organizations.ts` — in both `createOrganizationSecretApi` and `createProjectSecretApi`, add `tags,` to the destructured args, `tags?: string[];` to the type, and `...(tags && tags.length > 0 ? { tags } : {}),` after `hide: false,` in the payload.

- [ ] **Step 2: Let the org list be gated**

`hooks/organizations/useListOrganizations.ts`:

```ts
export default function useListOrganizations({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery<OrganizationsList>({
    queryKey: [keys["list.organizations"]],
    queryFn: () => listOrganizationsApi(),
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: false,
    enabled,
  });
}
```
(Every existing caller calls it with no arguments, so nothing else changes.)

- [ ] **Step 3: Spaces hook**

`hooks/cli-auth/useCliAuthSpaces.ts`:

```ts
"use client";

import { useMemo } from "react";

import useListOrganizations from "@/hooks/organizations/useListOrganizations";
import useListProjects from "@/hooks/projects/useListProjects";
import type { ConnectOrganizationView } from "@/types/oauth-connect";

/** Projects the link-token flow creates for itself; never a home for a CLI key. */
const LINK_TOKEN_PROJECT_DESCRIPTION = "Auto-created by link token";

/**
 * Organizations (and the selected one's projects) in the shape
 * ConnectSpaceCards renders. Projects load lazily for the selected org.
 */
export default function useCliAuthSpaces({
  selectedOrganizationId,
  enabled,
}: {
  selectedOrganizationId: string | null;
  enabled: boolean;
}) {
  const orgs = useListOrganizations({ enabled });
  const projects = useListProjects({
    organizationId: selectedOrganizationId ?? "",
    enabled: enabled && !!selectedOrganizationId,
  });

  const organizations: ConnectOrganizationView[] = useMemo(
    () =>
      (orgs.data?.rows ?? []).map((org) => ({
        id: org.id,
        name: org.name,
        projects:
          org.id === selectedOrganizationId
            ? (projects.data?.rows ?? [])
                .filter((p) => p.description !== LINK_TOKEN_PROJECT_DESCRIPTION)
                .map((p) => ({ id: p.id, name: p.name }))
            : [],
      })),
    [orgs.data, projects.data, selectedOrganizationId],
  );

  return {
    organizations,
    isLoading: enabled && orgs.isLoading,
    isError: orgs.isError,
    projectsLoading: projects.isLoading,
  };
}
```

- [ ] **Step 4: Mutation hook + UX hook**

`hooks/cli-auth/useCreateCliKey.ts`:

```ts
"use client";

import { useMutation } from "@tanstack/react-query";

import {
  createOrganizationSecretApi,
  createProjectSecretApi,
} from "@/endpoints/organizations";
import { createSecretKeyApi } from "@/endpoints/settings";
import type { CreateCliKeyInput } from "@/types/cli-auth";
import type { EventAccess } from "@/types/secrets";

export default function useCreateCliKey() {
  const mutation = useMutation<EventAccess, Error, CreateCliKeyInput>({
    mutationFn: ({ target, name, tags }) => {
      if (target.organizationId && target.projectId) {
        return createProjectSecretApi({
          organizationId: target.organizationId,
          projectId: target.projectId,
          name,
          platform: "pica",
          connectionType: "custom",
          env: "live",
          tags,
        }) as Promise<EventAccess>;
      }
      if (target.organizationId) {
        return createOrganizationSecretApi({
          organizationId: target.organizationId,
          name,
          platform: "pica",
          connectionType: "custom",
          env: "live",
          tags,
        }) as Promise<EventAccess>;
      }
      return createSecretKeyApi({ name, env: "live", hide: false, tags }) as Promise<EventAccess>;
    },
  });

  return {
    trigger: mutation.mutateAsync,
    isLoading: mutation.isPending,
  };
}
```

`hooks/ux/cli-auth/useCreateCliKeyUx.ts`:

```ts
"use client";

import { useState } from "react";
import axios from "axios";
import { toast } from "sonner";

import useCreateCliKey from "@/hooks/cli-auth/useCreateCliKey";
import type { CreateCliKeyInput } from "@/types/cli-auth";
import type { EventAccess } from "@/types/secrets";

function messageFrom(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string; error?: string } | undefined;
    return data?.message ?? data?.error ?? error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong";
}

export default function useCreateCliKeyUx() {
  const { trigger: create, isLoading } = useCreateCliKey();
  const [error, setError] = useState<string | null>(null);

  const trigger = async (input: CreateCliKeyInput): Promise<EventAccess | null> => {
    setError(null);
    try {
      return await create(input);
    } catch (err) {
      const message = messageFrom(err);
      setError(message);
      toast.error("Couldn't create the key", { description: message });
      return null;
    }
  };

  return { trigger, isLoading, error };
}
```

- [ ] **Step 5: Typecheck and commit**

Run: `NODE_OPTIONS=--max-old-space-size=10240 npx tsc --noEmit`
Expected: clean.

```bash
git add endpoints/settings.ts endpoints/organizations.ts hooks/organizations/useListOrganizations.ts hooks/cli-auth hooks/ux/cli-auth
git commit -m "feat(cli-auth): tags on the create-key endpoints and hooks for the consent flow"
```

### Task B3: Stateless components (and the rail's client mark)

**Files:**
- Modify: `components/oauth-connect/hosted/ConnectRail.tsx:12-25,47-63`, `components/oauth-connect/hosted/ConnectHostedShell.tsx:7-20,51-62,66-80`
- Create: `components/cli-auth/CliClientMark.tsx`, `components/cli-auth/CliInstallSummary.tsx`, `components/cli-auth/HarnessPicker.tsx`, `components/cli-auth/KeyNameField.tsx`, `components/cli-auth/CliAuthDone.tsx`

**Interfaces:**
- Produces: `ConnectRail`/`ConnectHostedShell` prop `clientMark?: ReactNode`; `CliInstallSummary({ ctx })`; `HarnessPicker({ options, selected, onToggle, otherId, otherLabel, onOtherLabelChange })`; `KeyNameField({ value, defaultValue, onChange })`; `CliAuthDone({ keyName, accountLabel, harnessLabels, machineLabel, countdown, onReturnNow })`.

- [ ] **Step 1: Add `clientMark` to the rail and shell**

`ConnectRail.tsx` props: add `/** Rendered in the client tile when there is no logo URL. */ clientMark?: ReactNode;` (import `ReactNode` from react) and change the tile fallback:

```tsx
          {clientLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img ... />
          ) : clientMark ? (
            clientMark
          ) : (
            <span className="text-sm font-semibold text-foreground">
              {clientName.charAt(0).toUpperCase()}
            </span>
          )}
```

`ConnectHostedShell.tsx`: add the same `clientMark?: ReactNode` prop, pass `clientMark={clientMark}` to `<ConnectRail>`, and apply the same three-way fallback in the mobile bar tile.

- [ ] **Step 2: `CliClientMark.tsx`**

```tsx
import { TerminalWindowIcon } from "@phosphor-icons/react";

/** The "client" of the CLI auth page is the terminal itself. */
export function CliClientMark() {
  return <TerminalWindowIcon className="h-[18px] w-[18px] text-foreground" weight="fill" />;
}
```

- [ ] **Step 3: `CliInstallSummary.tsx`**

```tsx
"use client";

import {
  DesktopIcon,
  FolderIcon,
  GlobeIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { harnessLabel, osLabel } from "@/lib/cli-auth/install-context";
import type { CliInstallContext } from "@/types/cli-auth-ui";

function Row({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <div className="flex items-start gap-3 border-t border-border px-3.5 py-3 first:border-t-0">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-9 uppercase tracking-[0.12em] text-text-muted">
          {label}
        </span>
        <span className="mt-0.5 block text-sm font-medium text-foreground">
          {value}
        </span>
        {detail ? (
          <span className="mt-0.5 block break-all font-mono text-2xs text-muted-foreground">
            {detail}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** What the key will record about this install — the disclosure itself. */
export function CliInstallSummary({ ctx }: { ctx: CliInstallContext }) {
  if (!ctx.hasInstallContext) {
    return (
      <div className="rounded-panel border border-dashed border-border-strong px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
        This CLI didn&apos;t say where it&apos;s installed. Update it with{" "}
        <code className="font-mono text-foreground">npm i -g @withone/cli</code>{" "}
        to record the machine and project next time.
      </div>
    );
  }

  const machine = [ctx.host, osLabel(ctx.os, ctx.osVersion), ctx.arch]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="overflow-hidden rounded-panel border border-border bg-card">
      {ctx.scope === "project" ? (
        <Row
          detail={ctx.path}
          icon={<FolderIcon className="h-4 w-4" />}
          label="Scope"
          value="This project only"
        />
      ) : (
        <Row
          detail="Every folder on this machine"
          icon={<GlobeIcon className="h-4 w-4" />}
          label="Scope"
          value="Global"
        />
      )}
      {machine ? (
        <Row
          detail={ctx.user ? `signed in as ${ctx.user}` : null}
          icon={<DesktopIcon className="h-4 w-4" />}
          label="Machine"
          value={machine}
        />
      ) : null}
      {ctx.cliVersion ? (
        <Row
          detail={ctx.launcher ? `launched by ${harnessLabel(ctx.launcher)}` : null}
          icon={<TerminalWindowIcon className="h-4 w-4" />}
          label="CLI"
          value={`@withone/cli ${ctx.cliVersion}`}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: `HarnessPicker.tsx`**

```tsx
"use client";

import { CheckIcon, PlusIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { Input } from "@/components/ui/shadcn/input";
import { FORM_INPUT_CLASS } from "@/lib/utils/form-styles";
import { cn } from "@/lib/utils";
import type { HarnessOption } from "@/types/cli-auth-ui";

interface Props {
  options: HarnessOption[];
  selected: string[];
  onToggle: (id: string) => void;
  otherId: string;
  otherLabel: string;
  onOtherLabelChange: (label: string) => void;
}

/** Multi-select logo tiles; the same checked treatment as the account cards. */
export function HarnessPicker({
  options,
  selected,
  onToggle,
  otherId,
  otherLabel,
  onOtherLabelChange,
}: Props) {
  const otherOn = selected.includes(otherId);

  const tile = (opts: { id: string; label: string; icon: ReactNode; on: boolean }) => (
    <button
      aria-checked={opts.on}
      className={cn(
        "flex items-center gap-2.5 rounded-panel border p-2.5 text-left transition-all",
        opts.on
          ? "border-foreground bg-background-secondary shadow-[inset_0_0_0_1px_hsl(var(--foreground))]"
          : "border-border-strong bg-card hover:border-muted-foreground",
      )}
      key={opts.id}
      onClick={() => onToggle(opts.id)}
      role="checkbox"
      type="button"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
        {opts.icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {opts.label}
      </span>
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border-[1.5px] transition-colors",
          opts.on ? "border-foreground bg-foreground text-background" : "border-border-strong",
        )}
      >
        {opts.on ? <CheckIcon className="h-2.5 w-2.5" weight="bold" /> : null}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <div aria-label="Harnesses" className="grid grid-cols-2 gap-2" role="group">
        {options.map((option) =>
          tile({
            id: option.id,
            label: option.label,
            on: selected.includes(option.id),
            icon: (
              // eslint-disable-next-line @next/next/no-img-element
              <img alt="" className="h-[18px] w-[18px] object-contain" src={option.logo} />
            ),
          }),
        )}
        {tile({
          id: otherId,
          label: "Other",
          on: otherOn,
          icon: <PlusIcon className="h-4 w-4 text-muted-foreground" />,
        })}
      </div>
      {otherOn ? (
        <Input
          aria-label="Other harness name"
          className={cn(FORM_INPUT_CLASS, "h-9 text-sm")}
          maxLength={40}
          onChange={(e) => onOtherLabelChange(e.target.value)}
          placeholder="Name the tool, e.g. Aider"
          value={otherLabel}
        />
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: `KeyNameField.tsx`**

```tsx
"use client";

import { Input } from "@/components/ui/shadcn/input";
import { MAX_KEY_NAME_LENGTH } from "@/lib/cli-auth/install-context";
import { FORM_INPUT_CLASS } from "@/lib/utils/form-styles";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  defaultValue: string;
  onChange: (value: string) => void;
}

export function KeyNameField({ value, defaultValue, onChange }: Props) {
  const edited = value !== defaultValue;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label
          className="font-mono text-2xs uppercase tracking-[0.08em] text-text-muted"
          htmlFor="cli-key-name"
        >
          Key name
        </label>
        {edited ? (
          <button
            className="text-2xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
            onClick={() => onChange(defaultValue)}
            type="button"
          >
            Reset
          </button>
        ) : null}
      </div>
      <Input
        className={cn(FORM_INPUT_CLASS, "h-10 text-sm")}
        id="cli-key-name"
        maxLength={MAX_KEY_NAME_LENGTH}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        value={value}
      />
      <p className="text-2xs leading-relaxed text-text-muted">
        Shown in Settings → API keys so you can find and revoke this install later.
      </p>
    </div>
  );
}
```

- [ ] **Step 6: `CliAuthDone.tsx`**

```tsx
"use client";

import { CheckCircleIcon } from "@phosphor-icons/react";

import { Button } from "@/components/ui/shadcn/button";

interface Props {
  keyName: string;
  accountLabel: string;
  harnessLabels: string[];
  machineLabel: string | null;
  countdown: number;
  onReturnNow: () => void;
}

/** The hosted "You're all set" beat, listing what the key recorded. */
export function CliAuthDone({
  keyName,
  accountLabel,
  harnessLabels,
  machineLabel,
  countdown,
  onReturnNow,
}: Props) {
  const rows = [
    { label: "Key", value: keyName },
    { label: "Account", value: accountLabel },
    { label: "Used by", value: harnessLabels.length ? harnessLabels.join(", ") : "Not specified" },
    ...(machineLabel ? [{ label: "Machine", value: machineLabel }] : []),
  ];

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-muted">
        <CheckCircleIcon className="h-7 w-7 text-success" weight="fill" />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          You&apos;re all set
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The CLI is receiving its key now. Close this tab once you&apos;re back in the terminal.
        </p>
      </div>
      <div className="w-full overflow-hidden rounded-panel border border-border text-left">
        {rows.map((row) => (
          <div
            className="flex items-start gap-3 border-t border-border px-3.5 py-2.5 first:border-t-0"
            key={row.label}
          >
            <span className="w-16 shrink-0 pt-1 font-mono text-9 uppercase tracking-[0.12em] text-text-muted">
              {row.label}
            </span>
            <span className="min-w-0 flex-1 break-words text-sm font-medium text-foreground">
              {row.value}
            </span>
          </div>
        ))}
      </div>
      <Button className="w-full" onClick={onReturnNow} size="lg" variant="default">
        Return to the terminal now
      </Button>
      <p className="text-xs text-text-muted">
        Sending the key in{" "}
        <span className="font-mono font-medium text-muted-foreground">
          {Math.max(countdown, 1)}
        </span>{" "}
        {countdown === 1 ? "second" : "seconds"}…
      </p>
    </div>
  );
}
```

- [ ] **Step 7: Typecheck, lint the new files, commit**

```bash
NODE_OPTIONS=--max-old-space-size=10240 npx tsc --noEmit
npx eslint components/cli-auth components/oauth-connect/hosted/ConnectRail.tsx components/oauth-connect/hosted/ConnectHostedShell.tsx
git add components/cli-auth components/oauth-connect/hosted/ConnectRail.tsx components/oauth-connect/hosted/ConnectHostedShell.tsx
git commit -m "feat(cli-auth): install summary, harness picker, name field and done components"
```

### Task B4: Controlled flow, page, and the sign-in bounce

**Files:**
- Create: `controlled-components/cli-auth/ControlledCliAuthFlow.tsx`
- Modify: `app/cli/auth/page.tsx` (replace), `app/(main)/page.tsx:31-46`

**Interfaces:**
- Consumes: everything from B1–B3; `useAuth()` (`user`, `isAuthenticated()`, `isLoading`, `logout()`), `useConfig()`.

- [ ] **Step 1: Check the `User` type has `email`**

Run: `grep -n "email" types/user.ts`
Expected: an `email: string` field. If the field is named differently, use that name below.

- [ ] **Step 2: Write the controlled component**

`controlled-components/cli-auth/ControlledCliAuthFlow.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon, InfoIcon } from "@phosphor-icons/react";

import { CliAuthDone } from "@/components/cli-auth/CliAuthDone";
import { CliClientMark } from "@/components/cli-auth/CliClientMark";
import { CliInstallSummary } from "@/components/cli-auth/CliInstallSummary";
import { HarnessPicker } from "@/components/cli-auth/HarnessPicker";
import { KeyNameField } from "@/components/cli-auth/KeyNameField";
import { ConnectAccountChip } from "@/components/oauth-connect/hosted/ConnectAccountChip";
import { ConnectHostedShell } from "@/components/oauth-connect/hosted/ConnectHostedShell";
import { ConnectHostedSkeleton } from "@/components/oauth-connect/hosted/ConnectHostedSkeleton";
import type { ConnectRailStep } from "@/components/oauth-connect/hosted/ConnectRail";
import { ConnectSpaceCards } from "@/components/oauth-connect/hosted/ConnectSpaceCards";
import { HostedHeading } from "@/components/oauth-connect/hosted/HostedHeading";
import { Button } from "@/components/ui/shadcn/button";
import { useAuth } from "@/contexts/AuthContext";
import useCliAuthSpaces from "@/hooks/cli-auth/useCliAuthSpaces";
import { useConfig } from "@/hooks/useConfig";
import useCreateCliKeyUx from "@/hooks/ux/cli-auth/useCreateCliKeyUx";
import {
  buildKeyTags,
  cliCallbackUrl,
  cliCancelUrl,
  defaultKeyName,
  HARNESS_CATALOG,
  harnessLabel,
  initialHarnessSelection,
  OTHER_HARNESS_ID,
  osLabel,
  parseInstallContext,
  resolveHarnessIds,
} from "@/lib/cli-auth/install-context";
import { stashPendingCliAuth } from "@/lib/cli-auth/pending";
import type { CliAuthStep } from "@/types/cli-auth-ui";
import type { ConnectSpaceChoice } from "@/types/oauth-connect-ui";

const CLIENT_NAME = "One CLI";
const RETURN_COUNTDOWN_SECONDS = 3;

/**
 * The CLI browser-auth consent flow on the Connect hosted shell:
 * account (when the person has organizations) → describe this install
 * (machine facts, harness picker, key name) → mint → hand the key to the
 * CLI's localhost callback.
 */
export function ControlledCliAuthFlow() {
  const params = useSearchParams();
  const router = useRouter();
  const { isAuthenticated, user, isLoading: isAuthLoading, logout } = useAuth();
  const { isLoading: isConfigLoading } = useConfig();

  const ctx = useMemo(() => parseInstallContext(params), [params]);
  const hasCallback = !!ctx.port && !!ctx.state;

  const [authReady, setAuthReady] = useState(false);
  const [space, setSpace] = useState<ConnectSpaceChoice>({
    organizationId: null,
    projectId: null,
  });
  const [spaceConfirmed, setSpaceConfirmed] = useState(false);
  // null = not touched yet; seeded from what the CLI detected on first render.
  const [selectedHarnesses, setSelectedHarnesses] = useState<string[] | null>(null);
  const [otherHarness, setOtherHarness] = useState("");
  // null = follow the computed default.
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [created, setCreated] = useState<{ accessKey: string; name: string } | null>(null);
  const [countdown, setCountdown] = useState(RETURN_COUNTDOWN_SECONDS);
  const redirectedRef = useRef(false);

  // Session gate. Not signed in → stash the whole query and bounce to
  // sign-in; app/(main)/page.tsx brings the person back here.
  useEffect(() => {
    if (isConfigLoading || isAuthLoading || !hasCallback) return;
    if (!isAuthenticated()) {
      stashPendingCliAuth(window.location.search);
      router.push("/sign-in");
      return;
    }
    setAuthReady(true);
  }, [isConfigLoading, isAuthLoading, isAuthenticated, hasCallback, router]);

  const {
    organizations,
    isLoading: orgsLoading,
    isError: orgsError,
  } = useCliAuthSpaces({
    selectedOrganizationId: space.organizationId,
    enabled: authReady,
  });
  const { trigger: createKey, isLoading: isCreating, error: createError } =
    useCreateCliKeyUx();

  const hasOrgs = organizations.length > 0;
  const harnesses = selectedHarnesses ?? initialHarnessSelection(ctx);
  const harnessIds = resolveHarnessIds(harnesses, otherHarness);
  const computedDefaultName = defaultKeyName(ctx, harnessIds);
  const keyName = nameOverride ?? computedDefaultName;

  const step: CliAuthStep = (() => {
    if (!hasCallback) return "error";
    if (!authReady || orgsLoading) return "loading";
    if (created) return "done";
    if (hasOrgs && !spaceConfirmed && !orgsError) return "space";
    return "describe";
  })();

  const redirectToCli = (url: string) => {
    if (redirectedRef.current) return;
    redirectedRef.current = true;
    window.location.href = url;
  };

  const toggleHarness = (id: string) =>
    setSelectedHarnesses((prev) => {
      const base = prev ?? initialHarnessSelection(ctx);
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });

  const handleCancel = () => redirectToCli(cliCancelUrl(ctx));

  const handleCreate = async () => {
    const name = keyName.trim() || computedDefaultName;
    const key = await createKey({
      target: { organizationId: space.organizationId, projectId: space.projectId },
      name,
      tags: buildKeyTags(ctx, harnessIds),
    });
    if (!key?.accessKey) return;
    setCreated({ accessKey: key.accessKey, name });
  };

  const handleReturnNow = () => {
    if (created) redirectToCli(cliCallbackUrl(ctx, created));
  };

  const handleSignOut = async () => {
    stashPendingCliAuth(window.location.search);
    await logout();
    router.push("/sign-in");
  };

  useEffect(() => {
    if (!created) return;
    setCountdown(RETURN_COUNTDOWN_SECONDS);
    const timer = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(timer);
          redirectToCli(cliCallbackUrl(ctx, created));
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
    // redirectToCli is stable in effect (ref-guarded); ctx/created are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [created, ctx]);

  const railLabels = [
    ...(hasOrgs ? ["Choose an account"] : []),
    "Describe this install",
    "Create key",
  ];
  const stepIndex =
    step === "space" ? 0 : step === "describe" ? railLabels.length - 2 : railLabels.length - 1;
  const railSteps: ConnectRailStep[] = railLabels.map((label, i) => ({
    label,
    state:
      step === "done" ? "done" : i < stepIndex ? "done" : i === stepIndex ? "now" : "todo",
  }));
  const eyebrow = `Step ${stepIndex + 1} of ${railLabels.length}`;

  const selectedOrg = organizations.find((o) => o.id === space.organizationId);
  const accountLabel = space.organizationId
    ? `${selectedOrg?.name ?? "Organization"}${
        space.projectId
          ? ` · ${selectedOrg?.projects.find((p) => p.id === space.projectId)?.name ?? ""}`
          : ""
      }`
    : "Personal";
  const machineLabel =
    [ctx.host, osLabel(ctx.os, ctx.osVersion)].filter(Boolean).join(" · ") || null;

  if (step === "error") {
    return (
      <div className="connect-widget-theme flex min-h-screen w-full flex-col items-center justify-center gap-3 bg-background px-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          This link isn&apos;t valid
        </h1>
        <p className="max-w-[44ch] text-sm leading-relaxed text-muted-foreground">
          The CLI didn&apos;t include a callback. Go back to your terminal and run{" "}
          <code className="font-mono text-foreground">one login</code> again.
        </p>
      </div>
    );
  }

  if (step === "loading") {
    return <ConnectHostedSkeleton clientName={CLIENT_NAME} />;
  }

  const chipActions = [
    {
      label: "Sign out and use another account",
      description: "You'll sign in again and land right back here.",
      onSelect: () => void handleSignOut(),
    },
    ...(hasOrgs && step === "describe"
      ? [
          {
            label: "Change where this key lives",
            description: "Personal or one of your organizations.",
            onSelect: () => setSpaceConfirmed(false),
          },
        ]
      : []),
    {
      label: "Cancel and return to the terminal",
      description: "No key is created.",
      onSelect: handleCancel,
      danger: true,
    },
  ];

  const content =
    step === "done" && created ? (
      <CliAuthDone
        accountLabel={accountLabel}
        countdown={countdown}
        harnessLabels={harnessIds.map(harnessLabel)}
        keyName={created.name}
        machineLabel={machineLabel}
        onReturnNow={handleReturnNow}
      />
    ) : step === "space" ? (
      <>
        <HostedHeading
          eyebrow={eyebrow}
          sub="The key can only reach connections in the account you pick. Anyone who can manage that account can see and revoke it."
          title="Where should this key live?"
        />
        <ConnectSpaceCards
          onSpaceChange={setSpace}
          organizations={organizations}
          space={space}
        />
      </>
    ) : (
      <>
        <HostedHeading
          eyebrow={eyebrow}
          sub="This is recorded on the key so you can tell your installs apart later."
          title="Where is this CLI running?"
        />
        <div className="flex flex-col gap-5">
          <CliInstallSummary ctx={ctx} />
          <section className="flex flex-col gap-2">
            <p className="font-mono text-2xs uppercase tracking-[0.08em] text-text-muted">
              Used by
            </p>
            <HarnessPicker
              onOtherLabelChange={setOtherHarness}
              onToggle={toggleHarness}
              options={HARNESS_CATALOG}
              otherId={OTHER_HARNESS_ID}
              otherLabel={otherHarness}
              selected={harnesses}
            />
          </section>
          <KeyNameField
            defaultValue={computedDefaultName}
            onChange={(v) => setNameOverride(v === computedDefaultName ? null : v)}
            value={keyName}
          />
          {createError ? (
            <p className="rounded-panel border border-destructive/30 bg-destructive-muted px-3 py-2 text-xs text-destructive">
              {createError}
            </p>
          ) : null}
        </div>
      </>
    );

  const actions =
    step === "space" ? (
      <Button
        className="w-full"
        onClick={() => setSpaceConfirmed(true)}
        size="lg"
        variant="default"
      >
        Continue
      </Button>
    ) : step === "describe" ? (
      <div className="flex flex-col">
        <p className="mb-4 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
          <span>
            The key is shown once to the CLI and stored on this machine. Revoke it any
            time from Settings → API keys.
          </span>
        </p>
        <Button
          className="w-full"
          disabled={isCreating}
          onClick={() => void handleCreate()}
          size="lg"
          variant="default"
        >
          {isCreating ? "Creating key..." : "Create key"}
        </Button>
        <Button
          className="mt-1.5 self-center"
          disabled={isCreating}
          onClick={handleCancel}
          size="sm"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
    ) : null;

  return (
    <ConnectHostedShell
      blurb="The CLI gets its own API key, tagged with where it's installed so you can find and revoke it later."
      cancelLabel="Cancel and return to the terminal"
      chip={
        <ConnectAccountChip
          actions={chipActions}
          email={user?.email ?? ""}
          scopeLabel={step === "describe" || step === "done" ? accountLabel : null}
          verified
        />
      }
      clientLogoUrl={null}
      clientMark={<CliClientMark />}
      clientName={CLIENT_NAME}
      connectors={[]}
      headline="Connect the One CLI to your account"
      onCancel={handleCancel}
      steps={railSteps}
    >
      {step === "describe" && hasOrgs ? (
        <button
          className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setSpaceConfirmed(false)}
          type="button"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5" />
          Back
        </button>
      ) : null}
      {content}
      {actions ? <div className="mt-5">{actions}</div> : null}
    </ConnectHostedShell>
  );
}
```

- [ ] **Step 3: Replace the page**

`app/cli/auth/page.tsx`:

```tsx
"use client";

import { Suspense } from "react";

import { ConnectHostedSkeleton } from "@/components/oauth-connect/hosted/ConnectHostedSkeleton";
import { ControlledCliAuthFlow } from "@/controlled-components/cli-auth/ControlledCliAuthFlow";

/**
 * Browser half of `one login` / `one init --auth browser`. The CLI opens
 * this with ?port&state plus its install context; the flow mints a key
 * and redirects to the CLI's localhost callback.
 */
export default function CliAuth() {
  return (
    <Suspense fallback={<ConnectHostedSkeleton clientName="One CLI" />}>
      <ControlledCliAuthFlow />
    </Suspense>
  );
}
```

- [ ] **Step 4: Restore the full query after sign-in**

In `app/(main)/page.tsx`, import `takePendingCliAuth` from `@/lib/cli-auth/pending` and replace the body of the `useEffect` (lines 31–46) with:

```tsx
  useEffect(() => {
    if (typeof window === "undefined") return;
    const search = takePendingCliAuth();
    if (search) window.location.href = `/cli/auth${search}`;
  }, []);
```

- [ ] **Step 5: Typecheck, lint, test, commit**

```bash
NODE_OPTIONS=--max-old-space-size=10240 npx tsc --noEmit
npx eslint controlled-components/cli-auth app/cli/auth/page.tsx "app/(main)/page.tsx"
npx vitest run lib/cli-auth
git add controlled-components/cli-auth app/cli/auth/page.tsx "app/(main)/page.tsx"
git commit -m "feat(cli-auth): rebuild /cli/auth on the Connect hosted shell with install context and harness picker"
```

---

# Part C — CLI (`/Users/paulkrishnamurthy/Documents/One-Development/cli`)

Branch `feat/cli-auth-install-context` already exists (holds the spec). Tests run with `npm test` (all) or `node --import tsx --test src/lib/install-context.test.ts` (one file). Typecheck: `npm run typecheck`. Build: `npm run build`.

### Task C1: Install-context collector

**Files:**
- Create: `src/lib/install-context.ts`
- Test: `src/lib/install-context.test.ts`

**Interfaces:**
- Consumes: `homeDir()` (`lib/home.ts`), `detectInstalledAgents()` (`lib/agents.ts`), `getDeviceId()`, `getProjectRoot()`, `ConfigScope` (`lib/config.ts`), `cliVersion()` (`lib/version.ts`).
- Produces: `InstallContext`, `collectInstallContext({ scope, projectRoot?, env? })`, `detectInstalledHarnesses()`, `detectLauncher(env)`, `installContextToParams(ctx)`, `describeInstallContext(ctx)`.

- [ ] **Step 1: Write the failing tests**

`src/lib/install-context.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectInstallContext,
  describeInstallContext,
  detectInstalledHarnesses,
  detectLauncher,
  installContextToParams,
} from './install-context.js';
import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';

// Every call passes an explicit `env` — the process running this suite may
// itself be launched by an agent (CLAUDECODE=1 is set under Claude Code),
// which would leak into the launcher detection.
const NO_ENV: NodeJS.ProcessEnv = {};

describe('detectLauncher', () => {
  it('maps agent env markers to harness ids, most specific first', () => {
    assert.equal(detectLauncher({ CLAUDECODE: '1' }), 'claude-code');
    assert.equal(detectLauncher({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'claude-code');
    assert.equal(detectLauncher({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
    assert.equal(detectLauncher({ GEMINI_CLI: '1' }), 'gemini-cli');
    assert.equal(detectLauncher({ CURSOR_AGENT: '1' }), 'cursor');
  });

  it('returns undefined for a plain shell', () => {
    assert.equal(detectLauncher(NO_ENV), undefined);
    assert.equal(detectLauncher({ TERM_PROGRAM: 'iTerm.app' }), undefined);
  });
});

describe('detectInstalledHarnesses', () => {
  const home = withTempHome();
  beforeEach(() => home.setup());
  afterEach(() => home.teardown());

  it('reports agents from the registry and the extra harness dirs, sorted and unique', () => {
    assertHomeIsSandboxed();
    fs.mkdirSync(path.join(home.dir, '.claude'));
    fs.mkdirSync(path.join(home.dir, '.gemini'));
    const found = detectInstalledHarnesses();
    assert.deepEqual(found, ['claude-code', 'gemini-cli']);
  });

  it('is empty on a bare machine', () => {
    assertHomeIsSandboxed();
    assert.deepEqual(detectInstalledHarnesses(), []);
  });
});

describe('collectInstallContext', () => {
  const home = withTempHome();
  beforeEach(() => home.setup());
  afterEach(() => home.teardown());

  it('omits the path for global scope and includes it for project scope', () => {
    assertHomeIsSandboxed();
    const global = collectInstallContext({ scope: 'global', projectRoot: '/tmp/acme', env: NO_ENV });
    assert.equal(global.scope, 'global');
    assert.equal(global.path, undefined);

    const project = collectInstallContext({ scope: 'project', projectRoot: '/tmp/acme', env: NO_ENV });
    assert.equal(project.scope, 'project');
    assert.equal(project.path, '/tmp/acme');
  });

  it('fills machine facts, the CLI version and a stable device id', () => {
    assertHomeIsSandboxed();
    const a = collectInstallContext({ scope: 'global', env: NO_ENV });
    const b = collectInstallContext({ scope: 'global', env: NO_ENV });
    assert.ok(a.host && a.host.length > 0, 'host');
    assert.equal(a.os, process.platform);
    assert.equal(a.arch, process.arch);
    assert.ok(a.osVersion && a.osVersion.length > 0, 'osVersion');
    assert.ok(a.user && a.user.length > 0, 'user');
    assert.match(a.device ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(a.device, b.device, 'device id is stable across calls');
    assert.match(a.cli ?? '', /^\d+\.\d+\.\d+/);
    assert.deepEqual(a.harnesses, []);
    assert.equal(a.launcher, undefined);
  });

  it('records the launching agent from env', () => {
    assertHomeIsSandboxed();
    const ctx = collectInstallContext({ scope: 'global', env: { CLAUDECODE: '1' } });
    assert.equal(ctx.launcher, 'claude-code');
  });
});

describe('installContextToParams', () => {
  it('encodes every present field under the documented names and skips absent ones', () => {
    const params = installContextToParams({
      scope: 'project',
      path: '/Users/paul/dev/acme app',
      host: 'Pauls-MBP.local',
      os: 'darwin',
      osVersion: '25.2.0',
      arch: 'arm64',
      user: 'paul',
      device: '6f1c0b1e-1111-4222-8333-944444444444',
      cli: '1.56.0',
      harnesses: ['claude-code', 'cursor'],
      launcher: 'claude-code',
    });
    const roundTrip = new URLSearchParams(params.toString());
    assert.equal(roundTrip.get('scope'), 'project');
    assert.equal(roundTrip.get('path'), '/Users/paul/dev/acme app');
    assert.equal(roundTrip.get('host'), 'Pauls-MBP.local');
    assert.equal(roundTrip.get('os'), 'darwin');
    assert.equal(roundTrip.get('osv'), '25.2.0');
    assert.equal(roundTrip.get('arch'), 'arm64');
    assert.equal(roundTrip.get('user'), 'paul');
    assert.equal(roundTrip.get('device'), '6f1c0b1e-1111-4222-8333-944444444444');
    assert.equal(roundTrip.get('cli'), '1.56.0');
    assert.equal(roundTrip.get('harnesses'), 'claude-code,cursor');
    assert.equal(roundTrip.get('launcher'), 'claude-code');
  });

  it('leaves out undefined fields and an empty harness list', () => {
    const params = installContextToParams({ scope: 'global', harnesses: [] });
    assert.equal(params.toString(), 'scope=global');
  });
});

describe('describeInstallContext', () => {
  it('summarizes what the consent page will record, one fact per line', () => {
    const text = describeInstallContext({
      scope: 'project',
      path: '/tmp/acme',
      host: 'box',
      os: 'linux',
      osVersion: '6.1',
      arch: 'x64',
      user: 'jane',
      cli: '1.56.0',
      harnesses: ['codex'],
    });
    assert.equal(
      text,
      ['scope: project', 'path: /tmp/acme', 'machine: box (linux 6.1, x64)', 'user: jane', 'harnesses: codex', 'cli: 1.56.0'].join('\n'),
    );
  });
});
```

- [ ] **Step 2: Run to see the failure**

Run: `node --import tsx --test src/lib/install-context.test.ts`
Expected: fails — module not found.

- [ ] **Step 3: Implement `src/lib/install-context.ts`**

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir } from './home.js';
import { detectInstalledAgents } from './agents.js';
import { getDeviceId, getProjectRoot, type ConfigScope } from './config.js';
import { cliVersion } from './version.js';

/**
 * What the CLI tells the browser consent page about where it lives. Every
 * field except `scope` is best-effort: a value that cannot be read is
 * simply absent, and login never fails because of it. The page turns these
 * into tags on the minted key (see the spec's tag vocabulary).
 */
export interface InstallContext {
  scope: ConfigScope;
  /** Project root; only for project scope. */
  path?: string;
  host?: string;
  /** process.platform: darwin / linux / win32. */
  os?: string;
  /** os.release(), e.g. 25.2.0 on macOS 26. */
  osVersion?: string;
  arch?: string;
  /** OS account name on this machine. */
  user?: string;
  /** Stable per-install id from ~/.one/device-id. */
  device?: string;
  cli?: string;
  /** Harness ids found installed on this machine. */
  harnesses: string[];
  /** Harness that spawned this CLI process, when an agent ran it. */
  launcher?: string;
}

/**
 * Harnesses the CLI can notice on disk beyond the MCP-capable agents in
 * agents.ts. Ids are the shared vocabulary the consent page's catalog uses.
 * Dirs are relative to the home directory and resolved per call.
 */
const EXTRA_HARNESS_DIRS: ReadonlyArray<{ id: string; dir: string }> = [
  { id: 'gemini-cli', dir: '.gemini' },
  { id: 'openclaw', dir: '.openclaw' },
  { id: 'hermes', dir: '.hermes' },
  { id: 'devin', dir: '.devin' },
];

/**
 * Env markers agents export to the processes they spawn. Checked in order;
 * the first hit wins, so more specific tools sit above generic ones.
 */
const LAUNCHER_ENV: ReadonlyArray<{ id: string; vars: string[] }> = [
  { id: 'claude-code', vars: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] },
  { id: 'codex', vars: ['CODEX_SANDBOX', 'CODEX_CI', 'CODEX_THREAD_ID'] },
  { id: 'gemini-cli', vars: ['GEMINI_CLI'] },
  { id: 'cursor', vars: ['CURSOR_AGENT', 'CURSOR_TRACE_ID'] },
  { id: 'windsurf', vars: ['WINDSURF_AGENT'] },
  { id: 'kiro', vars: ['KIRO_AGENT'] },
  { id: 'openclaw', vars: ['OPENCLAW_AGENT', 'OPENCLAW_SESSION'] },
  { id: 'hermes', vars: ['HERMES_AGENT', 'HERMES_SESSION'] },
  { id: 'devin', vars: ['DEVIN_SESSION_ID'] },
];

/** The harness that launched this process, if an agent did. */
export function detectLauncher(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const entry of LAUNCHER_ENV) {
    if (entry.vars.some(v => env[v] !== undefined && env[v] !== '')) return entry.id;
  }
  return undefined;
}

/** Harness ids whose config directory exists under the home directory. */
export function detectInstalledHarnesses(): string[] {
  const ids = new Set<string>(detectInstalledAgents().map(a => a.id));
  for (const { id, dir } of EXTRA_HARNESS_DIRS) {
    if (fs.existsSync(path.join(homeDir(), dir))) ids.add(id);
  }
  return [...ids].sort();
}

function tryRead<T>(read: () => T): T | undefined {
  try {
    const value = read();
    return value === null || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

export function collectInstallContext(opts: {
  scope: ConfigScope;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}): InstallContext {
  const env = opts.env ?? process.env;
  const ctx: InstallContext = {
    scope: opts.scope,
    harnesses: tryRead(() => detectInstalledHarnesses()) ?? [],
  };
  if (opts.scope === 'project') {
    ctx.path = opts.projectRoot ?? tryRead(() => getProjectRoot());
  }
  ctx.host = tryRead(() => os.hostname());
  ctx.os = process.platform;
  ctx.osVersion = tryRead(() => os.release());
  ctx.arch = process.arch;
  ctx.user = tryRead(() => os.userInfo().username);
  ctx.device = tryRead(() => getDeviceId());
  ctx.cli = tryRead(() => cliVersion());
  ctx.launcher = detectLauncher(env);
  return ctx;
}

/** Query-string encoding of the context, under the names the page reads. */
export function installContextToParams(ctx: InstallContext): URLSearchParams {
  const params = new URLSearchParams();
  const set = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== '') params.set(key, value);
  };
  set('scope', ctx.scope);
  set('path', ctx.path);
  set('host', ctx.host);
  set('os', ctx.os);
  set('osv', ctx.osVersion);
  set('arch', ctx.arch);
  set('user', ctx.user);
  set('device', ctx.device);
  set('cli', ctx.cli);
  if (ctx.harnesses.length > 0) params.set('harnesses', ctx.harnesses.join(','));
  set('launcher', ctx.launcher);
  return params;
}

/** Terminal-friendly summary of what the consent page will record. */
export function describeInstallContext(ctx: InstallContext): string {
  const lines: string[] = [`scope: ${ctx.scope}`];
  if (ctx.path) lines.push(`path: ${ctx.path}`);
  if (ctx.host || ctx.os) {
    const osPart = [ctx.os, ctx.osVersion].filter(Boolean).join(' ');
    const detail = [osPart, ctx.arch].filter(Boolean).join(', ');
    lines.push(`machine: ${ctx.host ?? 'unknown'}${detail ? ` (${detail})` : ''}`);
  }
  if (ctx.user) lines.push(`user: ${ctx.user}`);
  if (ctx.harnesses.length > 0) lines.push(`harnesses: ${ctx.harnesses.join(', ')}`);
  if (ctx.launcher) lines.push(`launched by: ${ctx.launcher}`);
  if (ctx.cli) lines.push(`cli: ${ctx.cli}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/lib/install-context.test.ts`
Expected: all pass. (`tsx` is a devDependency; if `--import tsx` is not available on this Node, use `npx tsx --test src/lib/install-context.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/install-context.ts src/lib/install-context.test.ts
git commit -m "feat(login): collect where the CLI is installed for the browser consent page

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C2: Auth URL with context and an app-URL override

**Files:**
- Modify: `src/lib/browser.ts` (replace)
- Test: `src/lib/browser.test.ts`

**Interfaces:**
- Produces: `oneAppUrl()`, `getCliAuthUrl(port, state, context?)`, `openCliAuthPage(port, state, context?)`; `ONE_APP_URL` env override.

- [ ] **Step 1: Write the failing tests**

`src/lib/browser.test.ts`:

```ts
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApiKeyUrl, getCliAuthUrl, getConnectionUrl, oneAppUrl } from './browser.js';

describe('oneAppUrl', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.ONE_APP_URL; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ONE_APP_URL;
    else process.env.ONE_APP_URL = saved;
  });

  it('defaults to the hosted dashboard', () => {
    delete process.env.ONE_APP_URL;
    assert.equal(oneAppUrl(), 'https://app.withone.ai');
  });

  it('honours ONE_APP_URL lazily and strips a trailing slash', () => {
    process.env.ONE_APP_URL = 'http://localhost:4202/';
    assert.equal(oneAppUrl(), 'http://localhost:4202');
    assert.equal(getApiKeyUrl(), 'http://localhost:4202/settings/api-keys');
    assert.equal(getConnectionUrl('gmail'), 'http://localhost:4202/#open=gmail');
  });
});

describe('getCliAuthUrl', () => {
  beforeEach(() => { delete process.env.ONE_APP_URL; });

  it('keeps the legacy shape when no context is given', () => {
    assert.equal(getCliAuthUrl(51234, 'a b'), 'https://app.withone.ai/cli/auth?port=51234&state=a%20b');
  });

  it('appends the install context after port and state', () => {
    const url = new URL(getCliAuthUrl(51234, 'st', {
      scope: 'project',
      path: '/Users/paul/dev/acme app',
      host: 'box',
      os: 'darwin',
      arch: 'arm64',
      harnesses: ['claude-code'],
    }));
    assert.equal(url.pathname, '/cli/auth');
    assert.equal(url.searchParams.get('port'), '51234');
    assert.equal(url.searchParams.get('state'), 'st');
    assert.equal(url.searchParams.get('scope'), 'project');
    assert.equal(url.searchParams.get('path'), '/Users/paul/dev/acme app');
    assert.equal(url.searchParams.get('harnesses'), 'claude-code');
    assert.equal(url.searchParams.get('user'), null);
  });
});
```

- [ ] **Step 2: Run to see the failure**

Run: `node --import tsx --test src/lib/browser.test.ts`
Expected: fails — `oneAppUrl` is not exported.

- [ ] **Step 3: Rewrite `src/lib/browser.ts`**

```ts
import open from 'open';
import { installContextToParams, type InstallContext } from './install-context.js';

const DEFAULT_APP_URL = 'https://app.withone.ai';

/**
 * The dashboard origin the CLI opens for browser flows. `ONE_APP_URL`
 * overrides it so the login and connect pages can be exercised against a
 * local frontend (`http://localhost:4202`). Resolved per call, never cached.
 */
export function oneAppUrl(): string {
  const override = process.env.ONE_APP_URL?.trim();
  return (override && override.length > 0 ? override : DEFAULT_APP_URL).replace(/\/+$/, '');
}

export interface ConnectionUrlParams {
  orgId?: string;
  projectId?: string;
  env?: 'live' | 'test';
}

export function getConnectionUrl(platform: string, params?: ConnectionUrlParams): string {
  const searchParams = new URLSearchParams();
  if (params?.orgId) searchParams.set('orgId', params.orgId);
  if (params?.projectId) searchParams.set('projectId', params.projectId);
  if (params?.env) searchParams.set('env', params.env);

  const qs = searchParams.toString();
  return `${oneAppUrl()}/${qs ? `?${qs}` : ''}#open=${platform}`;
}

export function getApiKeyUrl(): string {
  return `${oneAppUrl()}/settings/api-keys`;
}

export async function openConnectionPage(platform: string, params?: ConnectionUrlParams): Promise<void> {
  await open(getConnectionUrl(platform, params));
}

export async function openApiKeyPage(): Promise<void> {
  await open(getApiKeyUrl());
}

/**
 * The browser consent page for `one login`. `port` + `state` drive the
 * localhost callback; the install context (when given) becomes tags on the
 * key the page mints. Order is fixed so the printed URL reads the same way
 * every time.
 */
export function getCliAuthUrl(port: number, state: string, context?: InstallContext): string {
  const params = new URLSearchParams();
  params.set('port', String(port));
  params.set('state', state);
  if (context) {
    for (const [key, value] of installContextToParams(context)) params.set(key, value);
  }
  return `${oneAppUrl()}/cli/auth?${params.toString()}`;
}

export async function openCliAuthPage(port: number, state: string, context?: InstallContext): Promise<void> {
  await open(getCliAuthUrl(port, state, context));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/lib/browser.test.ts`
Expected: pass. Note `URLSearchParams` encodes a space as `+` in `toString()`; the first assertion expects `a%20b` — if Node produces `state=a+b`, change the expected string to `port=51234&state=a+b` (both decode identically; the frontend reads them through `URLSearchParams`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/browser.ts src/lib/browser.test.ts
git commit -m "feat(login): pass install context in the auth URL and allow ONE_APP_URL override

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C3: Callback server learns the key name and a cancel signal

**Files:**
- Modify: `src/commands/login.ts` (callback server, `browserLogin`, `saveCredentials`, `loginCommand`)
- Modify: `src/lib/types.ts:103-129` (`Config.apiKeyName`)
- Test: `src/commands/login.test.ts`

**Interfaces:**
- Produces: `export type CallbackOutcome = { kind: 'key'; apiKey: string; keyName?: string } | { kind: 'cancelled' }`; `export function startCallbackServer(expectedState): Promise<{ server; port; result: Promise<CallbackOutcome> }>`; `export interface BrowserLoginOptions { scope: ConfigScope; projectRoot?: string }`; `browserLogin(opts: BrowserLoginOptions): Promise<BrowserLoginResult | null>` where `BrowserLoginResult` gains `keyName?: string`.

- [ ] **Step 1: Add the config field**

In `src/lib/types.ts`, inside `Config` after `apiKey: string;`:

```ts
  /**
   * Display name of the key the browser consent page minted, echoed back on
   * the callback. Lets `one whoami` / `one logout` say which key this is.
   */
  apiKeyName?: string;
```

- [ ] **Step 2: Write the failing tests**

`src/commands/login.test.ts`:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startCallbackServer } from './login.js';

async function withServer<T>(state: string, run: (port: number, result: Promise<unknown>) => Promise<T>): Promise<T> {
  const { server, port, result } = await startCallbackServer(state);
  try {
    return await run(port, result);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe('startCallbackServer', () => {
  it('rejects a state mismatch with 403 and keeps waiting', async () => {
    await withServer('expected', async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/callback?s=${Buffer.from('sk_live_x').toString('base64')}&state=wrong`);
      assert.equal(res.status, 403);
    });
  });

  it('resolves the key and its name', async () => {
    await withServer('st', async (port, result) => {
      const s = Buffer.from('sk_live_x').toString('base64');
      const res = await fetch(`http://127.0.0.1:${port}/callback?s=${s}&state=st&name=${encodeURIComponent('CLI · acme')}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await result, { kind: 'key', apiKey: 'sk_live_x', keyName: 'CLI · acme' });
    });
  });

  it('resolves cancelled when the page reports error=cancelled', async () => {
    await withServer('st', async (port, result) => {
      const res = await fetch(`http://127.0.0.1:${port}/callback?error=cancelled&state=st`);
      assert.equal(res.status, 200);
      assert.deepEqual(await result, { kind: 'cancelled' });
    });
  });

  it('answers 400 when neither a key nor an error is present', async () => {
    await withServer('st', async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/callback?state=st`);
      assert.equal(res.status, 400);
    });
  });
});
```

- [ ] **Step 3: Run to see the failure**

Run: `node --import tsx --test src/commands/login.test.ts`
Expected: fails — `startCallbackServer` is not exported.

- [ ] **Step 4: Rework the callback server and `browserLogin`**

In `src/commands/login.ts`:

Imports — add:
```ts
import { collectInstallContext, describeInstallContext } from '../lib/install-context.js';
```

Add a cancelled page next to `SUCCESS_HTML`:
```ts
const CANCELLED_HTML = `<!DOCTYPE html>
<html><head><title>One CLI</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa">
<div style="text-align:center">
<h1 style="font-size:20px;margin:0 0 8px">Login cancelled</h1>
<p style="color:#a1a1aa;font-size:14px">No key was created. You can close this tab and run <code>one login</code> again.</p>
</div></body></html>`;
```

Replace `interface CallbackPayload` with:
```ts
export type CallbackOutcome =
  | { kind: 'key'; apiKey: string; keyName?: string }
  | { kind: 'cancelled' };
```

Make `startCallbackServer` exported, typed on `CallbackOutcome`, and replace its request handler body from `const encodedKey = ...` through `resolveResult({ apiKey, state });` with:

```ts
        const state = url.searchParams.get('state');
        if (!state) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing state');
          return;
        }
        if (state !== expectedState) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('State mismatch');
          return;
        }

        // The page reports a cancel with ?error=cancelled so the CLI can stop
        // waiting instead of sitting out the 5-minute timeout.
        if (url.searchParams.get('error')) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(CANCELLED_HTML);
          resolveResult({ kind: 'cancelled' });
          return;
        }

        const encodedKey = url.searchParams.get('s');
        const apiKey = encodedKey ? Buffer.from(encodedKey, 'base64').toString('utf-8') : null;
        if (!apiKey) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing required parameters');
          return;
        }
        const keyName = url.searchParams.get('name')?.trim() || undefined;

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(SUCCESS_HTML);
        resolveResult({ kind: 'key', apiKey, keyName });
```

Replace the `BrowserLoginResult` interface and `browserLogin` signature/body:

```ts
export interface BrowserLoginOptions {
  /** Where the credentials will be stored; the page records it as a tag. */
  scope: ConfigScope;
  /** Project root for project scope; defaults to the detected root. */
  projectRoot?: string;
}

export interface BrowserLoginResult {
  apiKey: string;
  whoami: WhoAmIResponse;
  /** Name the consent page gave the key, when the page sent one. */
  keyName?: string;
}

export async function browserLogin(opts: BrowserLoginOptions): Promise<BrowserLoginResult | null> {
  const state = crypto.randomUUID();
  const spin = p.spinner();

  let server: http.Server;
  let port: number;
  let resultPromise: Promise<CallbackOutcome>;

  try {
    ({ server, port, result: resultPromise } = await startCallbackServer(state));
  } catch {
    output.error('Could not start local server. Try: one init');
    return null;
  }

  const context = collectInstallContext({ scope: opts.scope, projectRoot: opts.projectRoot });
  const authUrl = getCliAuthUrl(port, state, context);

  p.note(
    `If the browser doesn't open, visit:\n${authUrl}\n\nThe consent page records this on the key so you can find the install later:\n${describeInstallContext(context)}`,
    'Opening browser for authentication...'
  );

  try {
    await openCliAuthPage(port, state, context);
  } catch {
    // Browser open failed — URL is already displayed above
  }

  spin.start('Waiting for authentication... (timeout: 5 min)');

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
  });

  try {
    const outcome = await Promise.race([resultPromise, timeout]);
    if (outcome.kind === 'cancelled') {
      spin.stop('Login cancelled in the browser.');
      return null;
    }
    spin.stop('Authentication received!');

    const apiBase = getApiBase();
    const api = new OneApi(outcome.apiKey, apiBase);
    const whoami = await api.whoami();

    return { apiKey: outcome.apiKey, whoami, keyName: outcome.keyName };
  } catch (err) {
    spin.stop('Authentication failed.');
    if (err instanceof Error && err.message === 'timeout') {
      output.error('Authentication timed out (5 min). Try again with: one login');
    } else if (err instanceof ApiError) {
      output.error(`Authentication failed: ${err.message}`);
    } else {
      output.error('Authentication failed. Try: one init');
    }
    return null;
  } finally {
    server!.closeAllConnections();
    server!.close();
  }
}
```

Update `saveCredentials` and `loginCommand`:

```ts
function saveCredentials(apiKey: string, scope: ConfigScope, keyName?: string): void {
  const existing = scope === 'project' ? readProjectConfig() : readGlobalConfig();
  writeConfig({
    apiKey,
    apiKeyName: keyName,
    installedAgents: existing?.installedAgents ?? [],
    createdAt: new Date().toISOString(),
    accessControl: existing?.accessControl,
    cacheTtl: existing?.cacheTtl,
    apiBase: existing?.apiBase,
  }, scope);
}
```

In `loginCommand`: `const result = await browserLogin({ scope: targetScope });`, then `const { apiKey, whoami, keyName } = result;` and `saveCredentials(apiKey, targetScope, keyName);`. In the "Logged in" note, after the user line add:

```ts
  if (keyName) infoLines.push(`${pc.dim('Key:')} ${keyName}`);
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
node --import tsx --test src/commands/login.test.ts
npm run typecheck
```
Expected: login tests pass; typecheck reports the three `browserLogin()` call sites in `src/commands/init.ts` as missing an argument — Task C4 fixes them.

- [ ] **Step 6: Commit**

```bash
git add src/commands/login.ts src/commands/login.test.ts src/lib/types.ts
git commit -m "feat(login): send install context to the consent page; accept key name and cancel on the callback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C4: Callers, `whoami`, `logout`

**Files:**
- Modify: `src/commands/init.ts:120-122,150-162` (non-interactive), `:466-472,553-566` (update key), `:1104-1130` (fresh setup)
- Modify: `src/cli.ts:799-830` (whoami), `src/commands/logout.ts:14-32` (`formatWhoami`)

- [ ] **Step 1: Pass the scope at every call site and persist the name**

`nonInteractiveInit` (~line 120):
```ts
    const result = await browserLogin({ scope });
    if (!result) {
      output.error('Browser login did not complete. Try again: one init --auth browser');
    }
    apiKey = result.apiKey;
    whoami = result.whoami;
    keyName = result.keyName;
```
Declare `let keyName: string | undefined;` next to `let apiKey: string;` and add `apiKeyName: keyName,` to the `writeConfig({...})` call that follows (after `apiKey,`).

`handleUpdateKey` (~line 466): `const result = await browserLogin({ scope });`, capture `keyName = result.keyName;` (declare `let keyName: string | undefined;` beside `let newKey: string;`), and add `apiKeyName: keyName,` to the `writeConfig` at ~line 555.

`freshSetup` (~line 1104): `const result = await browserLogin({ scope });` and in its `writeConfig` add `apiKeyName: result.keyName,`.

- [ ] **Step 2: Show the key name in `whoami` and `logout`**

`src/cli.ts` whoami action — after `const apiBase = getApiBase();` add `const keyName = resolved.config?.apiKeyName;`; include `keyName` in the `outputJson({...})` object; in the human output, after the user line:

```ts
    if (keyName) console.log(`  ${pc.dim('Key:')} ${keyName}`);
```

`src/commands/logout.ts` `formatWhoami` — after the user/email line inside the `if (whoami)` branch:

```ts
    if (config.apiKeyName) lines.push(`${pc.dim('Key:')} ${config.apiKeyName}`);
```

- [ ] **Step 3: Typecheck, run the whole suite, build**

```bash
npm run typecheck
npm test
npm run build
```
Expected: all green; `dist/index.js` rebuilt.

- [ ] **Step 4: Commit**

```bash
git add src/commands/init.ts src/cli.ts src/commands/logout.ts
git commit -m "feat(login): thread the login scope from init and show the key name in whoami and logout

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task C5: Docs and version bump

**Files:**
- Modify: `src/cli.ts:76` (help line), `src/lib/guide-content.ts:12-23`, `skills/one/SKILL.md:30-36`, `README.md:44-49,150-163`
- Modify: `package.json` `"version"`, `package-lock.json` (both `"version"` fields)

- [ ] **Step 1: Help + guide + skill + README**

`src/cli.ts:76`:
```
    one login                             Authenticate via browser; the consent page records where this CLI is installed
```

`src/lib/guide-content.ts` — after the sentence ending "…manage authentication separately (global or per-directory)." add:

```
Browser login opens a consent page that names the key and tags it with where the CLI runs (scope, project path, machine, OS user, CLI version, and the agent harnesses you pick), so the dashboard can show every install. Set \`ONE_APP_URL\` to point the page at a different dashboard origin (local development).
```

`skills/one/SKILL.md` — after the paragraph starting "`one login` opens the browser…" add:

```
The consent page asks which harness will use the key (Claude Code, Codex, Cursor, …) and records the install location as tags on the key (`scope:global` / `scope:project`, `path:`, `host:`, `harness:`, …). `one whoami` shows the key's name once it is stored.
```

`README.md` — under the `one login` code block add one sentence: "The browser consent page names the key and tags it with where this CLI is installed (scope, project path, machine, chosen harnesses) so you can find and revoke it from Settings → API keys." In the `one init` flag table add a row:

```
| `ONE_APP_URL` (env) | Dashboard origin the browser flows open (default `https://app.withone.ai`); use `http://localhost:4202` against a local frontend. |
```

- [ ] **Step 2: Version bump by hand**

```bash
sed -i '' 's/"version": "1.55.4"/"version": "1.56.0"/' package.json
sed -i '' '1,12s/"version": "1.55.4"/"version": "1.56.0"/' package-lock.json
grep -n '"version": "1.56.0"' package.json package-lock.json
```
Expected: one hit in `package.json`, two hits in `package-lock.json` (root and `packages[""]`), and `git diff package-lock.json` shows only those two lines.

- [ ] **Step 3: Verify and commit**

```bash
npm run typecheck && npm test && npm run build
git add src/cli.ts src/lib/guide-content.ts skills/one/SKILL.md README.md package.json package-lock.json
git commit -m "docs(login): describe the consent page and install tags; bump to 1.56.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

# Part D — Local end-to-end test (before any PR)

### Task D1: Run the stack

- [ ] **Step 1: Backend services**

```bash
cd /Users/paulkrishnamurthy/Documents/One-Development/starter/pica
docker compose ls; docker ps --format '{{.Names}}'
```
`pica-postgres-1` and `redis` are already up. Mailpit (sign-in codes) lives in `docker-compose.yml`; bring it up with `docker compose -f docker-compose.yml up -d mailpit` if `docker ps` does not list it.

- [ ] **Step 2: Migrations, then core**

```bash
mise x -- just --list | grep -i -E "core-dev|migrate"
cd migrator && direnv allow . && cd ..
mise x -- just migrate-all
mise x -- just core-dev
```
Expected: core listens on `:5005` (`curl -s localhost:5005/health` or whatever `core-dev` prints). If `migrate-all` cannot find a database URL, read `migrator/src/main.rs` for the env var it expects and export it to `postgres://postgres:postgres@localhost:5432/postgres`.

- [ ] **Step 3: Frontend**

```bash
cd /Users/paulkrishnamurthy/Documents/One-Development/starter/core-ui
mise x -- yarn dev
```
Expected: `http://localhost:4202` serves; `.env` already points `NEXT_PUBLIC_API_URL` at `http://localhost:5005`.

- [ ] **Step 4: CLI against the local stack, sandboxed home**

```bash
cd /Users/paulkrishnamurthy/Documents/One-Development/cli
export ONE_HOME=/tmp/one-cli-e2e && rm -rf "$ONE_HOME" && mkdir -p "$ONE_HOME/.one"
cat > "$ONE_HOME/.one/config.json" <<'JSON'
{ "apiKey": "sk_live_placeholder", "installedAgents": [], "createdAt": "2026-09-09T00:00:00.000Z", "apiBase": "http://localhost:5005" }
JSON
ONE_APP_URL=http://localhost:4202 node bin/cli.js login
```
Pick "This directory" (project scope). The printed URL must contain `scope=project`, `path=`, `host=`, `harnesses=`.

### Task D2: Drive the browser and verify

- [ ] **Step 1: Sign in and walk the flow**

Use the `/browse` skill against the printed URL. Sign in with an email code (read it from mailpit at `http://localhost:8025`). Confirm: rail shows "One CLI" with the terminal mark and the step list; account cards (if the test user has orgs); "Where is this CLI running?" with Scope/Machine/CLI rows; Claude Code pre-selected (this shell is launched by Claude Code); the default name `CLI · Claude Code · cli`; "Create key"; the "You're all set" panel; the redirect back.

- [ ] **Step 2: Terminal and DB checks**

```bash
ONE_APP_URL=http://localhost:4202 node bin/cli.js whoami
docker exec pica-postgres-1 psql -U postgres -d postgres -c "select id, name, tags from event_access order by id desc limit 1"
```
Expected: `whoami` prints the key name; the row shows `name = CLI · Claude Code · cli` and tags `{cli,scope:project,path:/Users/…/cli,harness:claude-code,launcher:claude-code,host:…,os:darwin,os-version:…,arch:arm64,user:paulkrishnamurthy,device:…,cli-version:1.56.0}`.

- [ ] **Step 3: Old-CLI fallback and cancel**

Open `http://localhost:4202/cli/auth?port=1&state=x` directly: the install summary shows the "update the CLI" note, no rows, and the default name is `CLI · global`. Then run `one login` again and press Cancel on the page: the terminal prints "Login cancelled in the browser." within a second.

- [ ] **Step 4: Screenshots for design review**

Capture the describe step in light and dark (toggle the dashboard theme) with `/browse` and save them under the scratchpad for the final report.

Only after every check above passes: push the three branches and open the three PRs in the order backend → frontend → CLI, with Conventional Commit titles and no session URLs.
