# One Workflows — Multi-Step API Workflows

Workflows chain actions across platforms. Like n8n/Zapier but file-based.

## Before you execute a flow you did NOT author — READ THIS

Nothing about a flow's runtime requirements is guessable from its name. Before `flow execute`, do one of these:

1. **Recommended:** `one --agent flow list` — the JSON output includes `requiresBash`, `usesCodeModules`, `inputs` (with `autoResolvable`), `stepTypes`, and the flow's `description`. Fastest path to knowing what you need.
2. Read the flow's `description` field from the JSON. Authors are required (see "Author conventions" below) to state `--allow-bash` requirements and non-auto-resolving inputs there.
3. `one --agent flow execute <key> --dry-run` to resolve every step's interpolations and see what they evaluate to, without running any step (see "Debugging a flow" below). A dry run still needs every required input and the same `--allow-bash`/`--allow-code` flags as a real run, and it records a run under `.one/flows/.runs/`.

If you skip this, you will hit errors like *"Workflow X contains bash steps. Re-run with --allow-bash."* (or the same for `code.module` steps and `--allow-code`) — the CLI pre-flights and fails fast, but the error is entirely avoidable by reading first.

## Author conventions — write flows that are safe to execute blind

The `description` field is the contract with future executors. It MUST state:

- **`--allow-bash` if any step is type `bash`.** e.g. *"Fetches recent Gmail and summarizes with Claude Haiku. Requires `--allow-bash`."*
- **`--allow-code` if any code step uses `code.module`.** Modules run with full Node access, so they are gated like bash.
- **Every input that does NOT have a `connection` hint.** Connection inputs auto-resolve when exactly one matching connection exists; everything else must be passed via `-i name=value`.
- **Any files/directories the flow writes to.**

If a flow's description doesn't tell you how to run it, treat that as a bug in the flow and fix it.

**Storage layout:**

- **Folder layout (REQUIRED for new flows):** `.one/flows/<key>/flow.json`, with an optional `lib/` subfolder for `.mjs` code modules. Like a skill — the folder groups the spec with its helper code, so the whole flow is shareable. **Always create new flows here.**
- **Legacy single-file layout (DEPRECATED):** `.one/flows/<key>.flow.json`. Still loads and runs for backward compatibility, but do not create new flows in this layout. When touching an existing single-file flow, migrate it: move `<key>.flow.json` to `<key>/flow.json`. Move a `code.source` block into a `<key>/lib/*.mjs` module only if it needs files, network or timers: modules run with full Node access and make the flow require `--allow-code`.

`one flow create` writes the folder layout (`.one/flows/<key>/flow.json` plus an empty `lib/`), unless `-o <path>` is given or a legacy `<key>.flow.json` already exists, which is then updated in place.

**Groups:** `.one/flows/<group>/<key>/flow.json`, referenced as `group/key` or by the bare key. Only one level of grouping is found by `flow list` and key lookup. A bare key that exists in several groups resolves to the first match without an error, so use `group/key` when keys repeat.

## Building a Workflow

### Step 0: Design first

Before touching CLI commands:
1. Clarify the end goal — what output does the user need?
2. Map every step required to deliver that output
3. Identify where AI analysis is needed (summarization, scoring, classification)
4. Write the step sequence as a plain list before constructing JSON

Common mistake: jumping straight to `actions find` and building a raw data pipe. Design first.

### Step 1: Discover connections

```bash
one --agent connection list
```

### Step 2: Find EVERY action, with its docs, in one call

```bash
one --agent actions find <platform> "<intent>" [<platform> "<intent>" ...] --task "<what the flow does, in general terms>" -t knowledge
one --agent actions load <actionId> --section "<name>"   # a section a digest left out, or --full
```

You MUST read the docs of every action in the workflow — they tell you the exact body structure, required fields, and path variables. `-t knowledge` searches the catalog that includes the platform's own (passthrough) endpoints, which flows should prefer.

### Step 3: Build the workflow JSON

### Step 4: Create

```bash
one --agent flow create <key> --definition '<json>'
one --agent flow create <key> --definition @flow.json     # from a file
cat flow.json | one --agent flow create <key>             # from stdin
```

A positional `<key>` overrides the definition's `key`. Or write directly to `.one/flows/<key>/flow.json`.

### Code modules (`lib/` folder)

A `code` step can reference an external `.mjs` module instead of inlining JS as a JSON string:

```
.one/flows/my-flow/
├── flow.json
└── lib/
    └── process-data.mjs
```

```js
// lib/process-data.mjs
const $ = JSON.parse(await new Response(process.stdin).text());
const items = $.steps.fetch.response.data ?? [];
process.stdout.write(JSON.stringify(items.filter(i => i.active)));
```

```json
{
  "id": "processData",
  "name": "Process",
  "type": "code",
  "code": { "module": "lib/process-data.mjs" }
}
```

The module runs as a child `node` process: the flow context `$` is piped to stdin as JSON, and stdout is parsed as JSON and used as the step's output. Modules have full Node APIs available (unlike inline `code.source`, which is sandboxed), so **a flow with any `code.module` step only runs with `--allow-code`**, the same way bash steps need `--allow-bash`. Say so in the flow's `description`. Use `code.module` when you need files, network or timers; keep pure data shaping in `code.source`.

#### Sandbox for inline JavaScript

Every piece of JavaScript written inside `flow.json` runs in a sandbox: `transform.expression`, `condition.expression`, `while.condition`, step-level `if`/`unless`, and `code.source`. A flow file can come from anywhere (a cloned repo, a shared folder, another agent), so this code cannot start programs or read or write files.

- It runs in a separate `node` process started with Node's permission model (`--permission`), an empty environment, and `eval`/`new Function` turned off. The process has no environment of its own, but `$.env` (part of the flow context) still carries the CLI's environment variables, so flow code can read them.
- `process`, `require` (outside `code.source`), `fetch`, `WebSocket`, `setTimeout`/`setInterval`, `__dirname` and `__filename` are not defined.
- Inside `code.source`, `require` is async: `const crypto = await require('crypto')`. It loads only these built-ins: `buffer`, `crypto`, `url`, `path` (with or without `node:`). `fs`, `http`, `https`, `net`, `child_process`, `process`, `os`, `cluster`, `dgram`, `tls`, `vm` and `worker_threads` throw `Module "<name>" is blocked in code steps`; any other name throws `Module "<name>" not available. Allowed: buffer, crypto, url, path`.
- `$` is a copy of the flow context. Read from it and `return` a result; changing `$` inside a step does not change what later steps see.
- Values cross into and out of the sandbox by structured clone: `Date`, `Map`, `Set`, `RegExp`, typed arrays and `undefined` survive; functions and symbols cannot be returned and fail the step.
- Each evaluation has a 30-second limit for synchronous work and 60 seconds overall. A step that runs longer fails with `timed out`.

These steps need no flag. If you need files, network calls or timers, use a `code.module` step, which requires `--allow-code`.

When an inline `code.source` step throws at runtime, the error message reports the user-relative line and column plus the offending line of source — e.g. `Code step "blowup" failed at line 3:34\n  const c = $.steps.mk.output.data.score;\n  Cannot read properties of null (reading 'score')`. No need to bisect the step manually.

Whatever JSON a module writes to stdout becomes both `$.steps.<id>.output` and `$.steps.<id>.response` (aliases). Downstream steps can reference either. Empty stdout gives `undefined`.

Module rules: the path is relative to the flow folder, may not contain `..`, and must end in `.mjs`. The module runs with the flow folder as its working directory. The `$` it reads from stdin has no `env` (the process itself inherits the CLI's environment).

### Migrating a legacy single-file flow

If you touch an existing `.one/flows/<key>.flow.json`, migrate it:

1. `mkdir -p .one/flows/<key>/lib`
2. `mv .one/flows/<key>.flow.json .one/flows/<key>/flow.json`
3. Leave `code.source` inline unless it needs files, network or timers. Inline code runs in the sandbox and needs no flag. Moving it to `lib/<step-id>.mjs` (`{ "module": "lib/<step-id>.mjs" }`) gives it full Node access and makes the flow require `--allow-code`.
4. `one --agent flow validate <key>`
5. Execute and confirm behavior is unchanged.

**Inline source → module translation.** Inline `code.source` is an async function body where `$` is in scope and you `return` the result. A module reads `$` from stdin and writes the result to stdout. Mechanical transform:

Before (inline):
```js
const items = $.steps.fetch.response.data;
return { active: items.filter(i => i.active) };
```

After (`lib/<step-id>.mjs`):
```js
const $ = JSON.parse(await new Response(process.stdin).text());
const items = $.steps.fetch.response.data;
process.stdout.write(JSON.stringify({ active: items.filter(i => i.active) }));
```

Two rules: (1) prepend the stdin-read line, (2) replace `return X` with `process.stdout.write(JSON.stringify(X))`.

### Step 5: Validate

```bash
one --agent flow validate <key>
```

`flow validate` checks the structure (every step has `id`, `name` and `type`; step ids are unique across the whole flow, nested steps included; the key matches `^[a-z0-9][a-z0-9-]*[a-z0-9]$`; numeric fields such as `maxIterations`, `maxConcurrency`, `maxPages` and `timeout` are positive; exactly one of `connection`/`connectionKey` and of `source`/`module`; `requires` entries start with `$.`; no `||`/`&&` in selector fields; `outputSchema` and `fileRead.schema` shapes). It does not check expression syntax in transforms or conditions, pipe names, or whether a sub-flow exists. `--skip-validation` on `flow execute` only skips the action-input checks, not these.

It also parses every inline `code.source` and runs `node --check` on every `code.module` file, so syntax errors (brace/paren mismatches, duplicate `let`, etc.) surface here instead of after upstream steps have already run. It also extracts `$.steps.X` and `$.input.X` references from inside `code.source`, `transform.expression`, **and external `code.module` `.mjs` files**, and reports any reference to an undefined step/input or to a step declared **after** the current one (forward references resolve to `undefined` at runtime — silent data loss). The same checks run automatically at the start of `flow execute` so a broken step in position 15 fails the run immediately rather than 15 minutes in.

### Step 6: Execute

```bash
one --agent flow execute <key> -i connectionKey=xxx -i param=value
```

## Workflow JSON Schema

```json
{
  "key": "welcome-customer",
  "name": "Welcome New Customer",
  "description": "Look up Stripe customer, send welcome email",
  "version": "1",
  "inputs": {
    "stripeConnectionKey": {
      "type": "string",
      "required": true,
      "description": "Stripe connection key",
      "connection": { "platform": "stripe" }
    },
    "customerEmail": {
      "type": "string",
      "required": true
    }
  },
  "steps": [...]
}
```

### Input Fields

| Field | Description |
|---|---|
| `type` | `string`, `number`, `boolean`, `object`, `array` |
| `required` | Whether input must be provided (default: true) |
| `default` | Default value if not provided |
| `description` | Human-readable description |
| `connection` | `{ "platform": "gmail" }` — enables auto-resolution (only `platform` and `tag` keys are allowed) |
| `enum` | Array of allowed values; rejected if input doesn't match (post-coercion) |

Connection inputs with a `connection` field auto-resolve if the user has exactly one connection for that platform. This happens only for a top-level `flow execute`, not for sub-flow inputs or on `flow resume`.

`-i name=value` values are parsed as JSON when they can be, otherwise kept as strings: `-i n=5` is a number, `-i tags='["a","b"]'` an array, `-i name=Jane` a string.

**Validation, coercion, and enums.** At flow start the engine validates every declared input:

1. **Required check** — `required: true` (the default) inputs without a value or `default` cause `Missing required input: "X"`.
2. **Type coercion** — narrow, bidirectional fixes only:
   - `number`: numeric strings (`"5"`) become `5`. Non-numeric strings throw.
   - `boolean`: `"true"`/`"1"`/`1` → `true`; `"false"`/`"0"`/`0` → `false`. Anything else throws.
   - `array` / `object`: JSON strings are parsed. Non-JSON throws.
   - `string`: anything else is `String(value)`-coerced.
3. **Enum check** — if `enum` is set, the (coerced) value must be `===` one of the allowed entries. Errors quote both the allowed list and the actual value.

This eliminates the per-flow `if (!$.input.x) throw ...` boilerplate. Errors look like:

```
Input "tier" must be a number, got string ("lots")
Input "stage" must be one of ["pre_seed","seed","series_a"], got "ipo"
```

The same checks run when a step calls a sub-flow, so type/enum guarantees hold across the call boundary.

## Selector Syntax

| Pattern | Resolves To |
|---|---|
| `$.input.connectionKey` | Input value |
| `$.steps.stepId.response` | Full API response from a step |
| `$.steps.stepId.response.data[0].email` | Nested field with array index |
| `$.steps.stepId.response.data[*].id` | Wildcard — maps array to field |
| `$.env.MY_VAR` | Environment variable |
| `$.loop.item` | Current loop item |
| `$.loop.i` | Current loop index |
| `"Hello {{$.steps.getUser.response.data.name}}"` | String interpolation |

A pure `$.xxx` value resolves to the raw type. A string containing `{{$.xxx}}` does string interpolation.

**Passing objects and arrays:** `{{ }}` interpolation always produces a string — if the resolved value is an object or array it will be JSON-stringified and the engine will log a warning. To pass an object/array as a native value to the next step, use a **direct selector without `{{ }}`**:

```json
// ✗ Wrong — becomes a JSON string, triggers a runtime warning
"files": "{{$.steps.extract.output.allFiles}}"

// ✓ Right — passes the array as an array
"files": "$.steps.extract.output.allFiles"
```

### Context-aware escape pipes (cli#53)

Handlebars interpolations support pipe-based escaping so user-controlled values are safe to embed in shell commands, JSON payloads, URLs, markdown, or HTML without writing per-call escapers:

```json
{
  "command": "curl -d {{$.input.payload | shell}} https://example.com/{{$.input.slug | url}}",
  "env": { "GREETING": { "shell": "$.input.name" } }
}
```

In bash commands use `| shell` (it JSON-encodes objects, then single-quotes the result). `| json` inserts raw JSON text, which the shell would mangle; use it for embedding values inside JSON text.

Available pipes:

| Pipe | Effect | Example |
|------|--------|---------|
| `json` | `JSON.stringify` (handles quotes, newlines, unicode) | `{{$.x \| json}}` → `"O'Brien & Co."` |
| `shell` | POSIX-shell-quote (apostrophes use the `'\''` close-reopen trick) | `{{$.x \| shell}}` → `'O'\''Brien & Co.'` |
| `url` | `encodeURIComponent` | `{{$.x \| url}}` → `O'Brien%20%26%20Co.` |
| `md` | Escape markdown structural characters and backslash (` ` ` * _ { } [ ] ( ) # + - ! \| \\ `) | `{{$.x \| md}}` |
| `html` | Entity-escape `& < > " '` | `{{$.x \| html}}` → `&lt;b&gt;` |

Only `$.`-rooted selectors are interpolated; `{{x | md}}` stays literal text. Pipes can be applied to numbers, booleans, objects, and `null`/`undefined` (which become an empty string for url/md/html, `''` (an empty quoted argument) for shell, and `null` for json). An unknown pipe name throws a clear error at flow execution time. Pipes cannot be combined with the legacy `q` prefix — use the pipe form (`{{$.x | shell}}` instead of `{{q $.x}}`).

### Selectors vs expressions

Selectors in data fields (`data`, `queryParams`, `pathVars`, `connectionKey`) are **dot-path lookups only** — they do not support JavaScript operators like `||` or `&&`. For default values, use the `default` field on the input definition:

```json
{
  "inputs": {
    "maxResults": { "type": "number", "default": 10 }
  }
}
```

The `if`, `unless`, `condition.expression`, `while.condition`, `transform.expression`, and `code.source` fields **do** support full JavaScript expressions (e.g., `$.input.email && $.input.email.length > 0`).

**Condition null-safety:** `if`/`unless`, `while.condition`, and `condition.expression` are null-safe. A condition that walks into a skipped or not-yet-run step's output — e.g. `$.steps.maybeSkipped.output.value` — evaluates to `false` instead of throwing `Cannot read properties of undefined`. (This applies to *conditions* only; `transform.expression` and `code.source` still throw on undefined access, since their output feeds downstream steps and should fail loudly.)

**Large results:** pass `--output-file <path>` to `flow execute` to stream the full result to a file instead of stdout. Use it when a flow aggregates large outputs that would otherwise be truncated on stdout or exceed the JSON string-size limit. stdout (and `--agent` output) then carries `{"event":"workflow:result", ..., "outputFile":"<path>"}` instead of inline `steps` — read the file for the full result.

## Step Types

Every step needs `id`, `name` and `type`, plus the config object for its type. Common optional fields on any step: `if` / `unless` (JS conditions), `onError`, `timeoutMs` (the step fails with `status: "timeout"` and `errorCode: "TIMEOUT"`; the underlying API call or command is not cancelled), `requires` and `outputSchema` (below).

### `action` — Execute a One API action

```json
{
  "id": "findCustomer",
  "name": "Find customer",
  "type": "action",
  "action": {
    "platform": "stripe",
    "actionId": "conn_mod_def::xxx::yyy",
    "connection": { "platform": "stripe" },
    "data": { "query": "email:'{{$.input.customerEmail}}'" }
  }
}
```

**Connection forms.** Each action step sets exactly one of:

- **`connection: { platform: "<name>", "tag"?: "<tag>" }`** (preferred) — late-bound, resolved at flow-execute time. Survives re-auth (which always mints a new key). Use `tag` to disambiguate when a platform has multiple connections (e.g. multi-account Gmail). Both `platform` and `tag` accept `$.input.x` selectors so flows can be parameterised per-execution.
- **`connectionKey: "<literal-or-selector>"`** (legacy) — passes the key string straight through. Still supported for backwards compat, but breaks on re-auth and forces manual edits across every flow that references the stale key. Migrate to `connection` when convenient.

The validator rejects an action that sets both forms (or neither) at `flow validate` and `flow execute` time.

### `transform` — JS expression (implicit return)

```json
{
  "id": "extractNames",
  "name": "Extract names",
  "type": "transform",
  "transform": { "expression": "$.steps.findCustomer.response.data.map(c => c.name)" }
}
```

### `code` — Multi-line JS (explicit return, async, supports await)

```json
{
  "id": "processData",
  "name": "Tier customers",
  "type": "code",
  "code": {
    "source": "const customers = $.steps.list.response.data;\nreturn customers.map(c => ({...c, tier: c.spend > 1000 ? 'gold' : 'silver'}));"
  }
}
```

### `condition` — If/then/else branching

```json
{
  "id": "checkFound",
  "name": "Check customer found",
  "type": "condition",
  "condition": {
    "expression": "$.steps.find.response.data.length > 0",
    "then": [{ "id": "sendEmail", "name": "Send email", "type": "action", "action": {...} }],
    "else": [{ "id": "logNotFound", "name": "Log miss", "type": "transform", "transform": { "expression": "'Not found'" } }]
  }
}
```

Output: `{ conditionResult, stepsExecuted }`.

### `loop` — Iterate over an array

```json
{
  "id": "processOrders",
  "name": "Process each order",
  "type": "loop",
  "loop": {
    "over": "$.steps.listOrders.response.orders",
    "as": "order",
    "maxConcurrency": 5,
    "steps": [...]
  }
}
```

Fields: `over` (selector to an array), `as` (the item is `$.loop.<as>`, and also `$.loop.item`; the index is `$.loop.i`, or `$.loop.<indexAs>` with `indexAs`), `maxIterations` (default 1000; extra items are skipped), `maxConcurrency` (default 1, sequential). The loop's `output` is the array of items it iterated, not the step results; `response` is `{ items, iterations: [{ <stepId>: result }, ...] }`. After the loop, `$.steps.<inner>` holds the last iteration's result. A nested loop replaces `$.loop`, so the outer loop's variables aren't visible inside it.

### `parallel` — Run steps concurrently

Use when fetching from 2+ independent data sources before combining results. Each substep must have the full step schema (`id`, `name`, `type`, and type-specific config).

```json
{
  "id": "fetchAll",
  "name": "Fetch email and calendar data in parallel",
  "type": "parallel",
  "parallel": {
    "maxConcurrency": 5,
    "steps": [
      {
        "id": "fetchEmails",
        "name": "Fetch recent emails",
        "type": "action",
        "action": {
          "platform": "gmail",
          "actionId": "conn_mod_def::GmailListMessages::xxx",
          "connectionKey": "$.input.gmailKey",
          "pathVars": { "userId": "me" },
          "queryParams": { "maxResults": 10 }
        }
      },
      {
        "id": "fetchEvents",
        "name": "Fetch today's calendar events",
        "type": "action",
        "action": {
          "platform": "google-calendar",
          "actionId": "conn_mod_def::CalendarListEvents::xxx",
          "connectionKey": "$.input.calendarKey",
          "pathVars": { "calendarId": "primary" },
          "queryParams": { "maxResults": 10 }
        }
      }
    ]
  }
}
```

`maxConcurrency` defaults to 5. The parallel step's own `output` is the array of substep results. After a parallel step, access each substep's output by its `id`: `$.steps.fetchEmails.response`, `$.steps.fetchEvents.response`. Each substep also carries its own result metadata — `$.steps.<id>.status` (`"success"` | `"failed"` | `"timeout"` | `"skipped"`), `.error`, `.errorCode` (e.g. `"TIMEOUT"`), `.durationMs` — so a downstream gate can tell a timed-out substep (retry-able) from one that genuinely returned nothing: `$.steps.fetchEvents.status === 'timeout'`. These substep references resolve at runtime (the engine stores each child in the context) and `flow validate` recognizes them — referencing a parallel/`loop`/`while`/`condition` child from a later step is not a forward-reference error.

### `file-read` / `file-write` — Filesystem access

```json
{ "id": "read", "name": "Read config", "type": "file-read", "fileRead": { "path": "./data/config.json", "parseJson": true } }
{ "id": "write", "name": "Save results", "type": "file-write", "fileWrite": { "path": "./output/results.json", "content": "$.steps.transform.output" } }
```

Paths resolve against the directory the CLI runs in, not the flow folder. `file-write` creates parent directories, writes non-string content as pretty JSON, takes `"append": true` to append, and outputs `{ path, bytesWritten }`.

**Validate a read config (`fileRead.schema`).** With `parseJson: true` you can add an optional `schema` that is **enforced at runtime** — a mismatch throws (`errorCode: "SCHEMA_VALIDATION"`) and is handled by the step's `onError`, so a bad config file fails fast with a clear message instead of producing garbage downstream. (This is distinct from `step.outputSchema`, which is documentation/wiring only and never checked at runtime.)

```json
{
  "id": "read", "name": "Read config", "type": "file-read",
  "fileRead": {
    "path": "./data/config.json", "parseJson": true,
    "schema": {
      "name": { "type": "string", "required": true },
      "mode": { "type": "string", "required": true, "enum": ["dev", "staging", "prod"] },
      "retries": { "type": "number" },
      "tags": { "type": "array", "items": "string", "minItems": 1, "maxItems": 10 },
      "coords": { "type": "array", "length": 2, "items": "number" },
      "owner": { "type": "object", "required": true,
                 "properties": { "id": "string", "email": { "type": "string", "required": true } } }
    }
  }
}
```

Field rules (a richer field-rule format inspired by `outputSchema`): a value is a bare type string (`"string"`, optional) or `{ type, required, enum, items, minItems, maxItems, length, properties }`. Types: `string`/`number`/`boolean`/`object`/`array`/`null`/`unknown` (`unknown` passes anything). **Array constraints (`items`/`minItems`/`maxItems`/`length`) require `type: "array"`, and `properties` requires `type: "object"`** — `flow validate` rejects them otherwise (so they can't silently no-op). All violations are reported in one error; paths are dotted/indexed (`owner.email`, `tags[3]`); a non-object root reports `expected an object at the root but got <type>`. `flow validate` checks the schema's shape (and that `parseJson:true` is set). With `onError: { strategy: "continue" }` the step lands as `{ status: "failed", errorCode: "SCHEMA_VALIDATION" }` so downstream steps can branch on it; `retry` and `retryOn:["SCHEMA_VALIDATION"]` work too.

### `while` — Condition-driven loop (do-while)

```json
{
  "id": "paginate",
  "name": "Page through results",
  "type": "while",
  "while": {
    "condition": "$['steps'].paginate.output.lastResult.nextPageToken != null",
    "maxIterations": 50,
    "steps": [...]
  }
}
```

The first iteration always runs; the condition is checked before each later one. `maxIterations` defaults to 100. `output` is `{ lastResult, iteration, results }` and `response` is `{ iterations, results }`.

**Write the self-reference as `$['steps'].<id>`.** The validator treats `$.steps.<id>` (the while step itself) and `$.steps.<child>` inside `while.condition` as forward references and rejects the flow; the bracket form passes and evaluates the same at run time.

### `flow` — Execute a sub-flow

```json
{
  "id": "enrich",
  "name": "Enrich customer",
  "type": "flow",
  "flow": { "key": "enrich-customer", "inputs": { "email": "$.steps.get.response.email" } }
}
```

A sub-flow that calls itself, directly or through others, fails with "Circular flow detected".

**Dynamic dispatch (cli#61).** `flow.key` accepts a selector (`"$.input.target"`) or Handlebars interpolation (`"{{$.input.prefix}}-{{$.input.suffix}}"`). The resolved key is loaded at runtime, so you can write a single orchestrator that picks among multiple sub-flows based on inputs or upstream results — no bash workaround required. If the resolved key does not exist, the step fails with the standard "flow not found" error.

**Sub-flow output is flattened.** The sub-flow's final step output is spread onto the parent step's `output`. If sub-flow `enrich-customer` ends with a step `load` that returns `{ TEAM: "acme" }`:

```
$.steps.enrich.output.TEAM                        # preferred (flattened)
$.steps.enrich.output.load.output.TEAM            # nested path, still works
$.steps.enrich.output._steps.load.output.TEAM     # full sub-flow steps map
```

`._finalOutput` holds the final step's output as-is. If a sub-step id collides with a flattened field name, the flattened field wins and the engine emits a `flow:warning` event.

### `paginate` — Auto-collect paginated results

```json
{
  "id": "allMessages",
  "name": "Fetch all messages",
  "type": "paginate",
  "paginate": {
    "action": { "platform": "gmail", "actionId": "...", "connection": { "platform": "gmail" } },
    "pageTokenField": "nextPageToken",
    "resultsField": "messages",
    "inputTokenParam": "queryParams.pageToken",
    "maxPages": 10
  }
}
```

The action is resolved once. From page 2 the token is placed at `inputTokenParam` as literal data (it is never resolved as a selector). Paging stops on a null token or at `maxPages` (default 10). `output` is the concatenated results; `response` is `{ pages, totalResults, results }`.

### `bash` — Shell commands (requires `--allow-bash`)

```json
{
  "id": "analyze",
  "name": "Analyze with Claude",
  "type": "bash",
  "bash": { "command": "cat /tmp/data.json | claude --print 'Analyze this' --output-format json", "timeout": 180000, "parseEnvelope": true }
}
```

`timeout` defaults to 30000 ms; `cwd` defaults to the directory the CLI runs in; `env` is merged over the full process environment; stdout is capped at 10 MB. A non-zero exit fails the step. `output` is the trimmed stdout (or the parsed value); `response` is `{ stdout, stderr, exitCode }`.

**Parsing output.** `parseJson: true` parses stdout as JSON (and strips outer code fences). For **`claude --print --output-format json`** steps use **`parseEnvelope: true`** instead — `claude` wraps the model's answer in a CLI envelope `{ "type": "result", "result": "```json\n{...}\n```" }`, and `parseEnvelope` unwraps `.result`, strips the inner code fences, drops any preamble/trailer text, and parses the inner JSON as `$.steps.<id>.output`. If the unwrapped payload isn't valid JSON the step fails (no silently-broken data). No more hand-rolled `unwrap()` helpers in code steps.

**Safe interpolation.** Plain `{{$.input.x}}` does string substitution and is **unsafe** for bash — values containing quotes, `$`, backticks, `&`, etc. will break the command (or worse). Use the `shell` pipe to POSIX-shell-quote the value:

```json
{ "command": "echo {{$.input.companyName | shell}} | tr '[:upper:]' '[:lower:]'" }
```

`{{$.input.companyName | shell}}` resolves `O'Reilly Media & Co` to `'O'\''Reilly Media & Co'` — a single argv token bash will parse cleanly. Use it for **every** interpolation of user-controlled data into a bash command. (The older `{{q $.x}}` helper does the same and still works.)

Alternatively, pass values as environment variables (also shell-safe) and reference them with `$VAR`:

```json
{
  "id": "lower", "name": "Lowercase name", "type": "bash",
  "bash": {
    "env": { "COMPANY": "$.input.companyName" },
    "command": "echo \"$COMPANY\" | tr '[:upper:]' '[:lower:]'"
  }
}
```

**Structured env vars (cli#54).** A bash step's `env` map also accepts two structured forms that handle JSON and shell escaping safely without writing temp files by hand:

```json
{
  "id": "post", "name": "Post config", "type": "bash",
  "bash": {
    "env": {
      "PAYLOAD_FILE": { "json": "$.steps.buildConfig.output" },
      "COMPANY":      { "shell": "$.input.companyName" }
    },
    "command": "curl -X POST $ENDPOINT -H 'Content-Type: application/json' -d @$PAYLOAD_FILE && echo \"$COMPANY\""
  }
}
```

- `{ "json": <selector|value> }` — the resolved value is JSON-serialized, written to a temp file, and the env var is set to the temp file's path. Use it with `curl -d @$VAR` or `cat $VAR`. The temp file is cleaned up automatically after the step finishes (success OR failure).
- `{ "shell": <selector|value> }` — the resolved value is exposed as a plain string env var. Reference it inside bash double quotes (`"$VAR"`) so bash itself handles word-splitting.
- A plain string value (`"COMPANY": "$.input.companyName"`) is the legacy form — interpolated as-is.

This is the recommended way to pass structured payloads to `curl`, `claude --print`, or any CLI that expects a JSON file, without a separate `file-write` step.

## Step Input Contracts (`requires`)

Declare the data a step depends on so the engine fails fast — with a useful error — when an upstream value is missing. Without `requires`, a skipped or failed upstream step silently leaves `undefined` in the context and the consumer either crashes deep in user code or burns an LLM call on empty input.

```json
{
  "id": "summarizeFounder",
  "name": "Summarize founder",
  "type": "code",
  "requires": [
    "$.steps.fetchProfile.output.bio",
    "$.input.founderName"
  ],
  "code": { "module": "lib/summarize.mjs" }
}
```

Each entry is a `$.input.X` or `$.steps.X.output...` selector. A selector is considered missing when it resolves to `undefined`, `null`, `""`, or `[]` (empty objects are allowed). On a miss, the engine throws **before** the step runs:

```
Step "summarizeFounder" requires $.steps.fetchProfile.output.bio but it
resolved to undefined (upstream step "fetchProfile" was skipped)
```

The "because…" suffix tells you exactly why — skipped, failed, or timed out — so you can fix the upstream wiring instead of guessing.

`requires` failures honor the step's `onError` strategy: pair `requires` with `onError: { strategy: "continue" }` to skip optional consumers gracefully, or leave the default `fail` to halt the flow on contract violations.

Forward references are caught at flow load time: if `requires` points at a step declared after the current step, validation rejects the flow.

## Step Output Contracts (`outputSchema`)

Declare the shape of a step's `output` so the validator can catch field-name typos in downstream selectors at flow load time — long before a misspelled `$.steps.research.output.charCount` silently resolves to `undefined` at runtime:

```json
{
  "id": "research",
  "name": "Research company",
  "type": "flow",
  "flow": { "key": "company-research" },
  "outputSchema": {
    "company": "string",
    "research": "string",
    "charCount": "number",
    "quality": { "confidence": "string", "coverageScore": "number" }
  }
}
```

Field types: `"string"`, `"number"`, `"boolean"`, `"object"`, `"array"`, `"unknown"`. Nest objects to describe sub-fields (`quality.coverageScore` above). Anything not declared is rejected when referenced via `$.steps.<id>.output.<field>` from a downstream step:

```
Selector "$.steps.research.output.chars" references field "chars" which is not
declared in step "research".outputSchema. Either fix the field name or update
the outputSchema declaration.
```

`outputSchema` is purely a documentation / validation aid — the engine does **not** enforce the shape at runtime, so a code step that returns an unexpected field still works (it just won't be discoverable from typed selectors). Schemas declared on a step apply to all references from anywhere in the flow tree (including inside loops, conditions, parallel blocks, code, and transform expressions).

## Error Handling

```json
{ "onError": { "strategy": "retry", "retries": 3, "retryDelayMs": 1000 } }
```

Strategies: `fail` (default), `continue`, `retry`, `fallback`.

- `continue` records the step as failed (`status`, `error`, `errorCode`) and moves on.
- `retry` retries; if it still fails (or `failFastOn` matches, or `retryOn` doesn't), the step fails the flow.
- `fallback` with `fallbackStepId` runs the named step when this one fails. The fallback step must be in the same steps list; it is skipped in normal order and runs only as a fallback. The failed step stays recorded (`status: "failed"`, `fallback: "<id>"`), and the fallback's result is at `$.steps.<fallbackId>`. If the fallback fails too, the flow fails. A fallback can't have a fallback of its own, and `fallback` isn't allowed in `defaultOnError`. The validator requires `fallbackStepId`.

**Flow-level default (cli#93).** Set `defaultOnError` at the top of the flow and every step without its own `onError` inherits it — handy when most steps should `continue` (e.g. rendering/formatting pipelines) and you don't want to repeat it N times. A step opts out by declaring its own `onError`:

```json
{
  "key": "render-report",
  "defaultOnError": { "strategy": "continue" },
  "steps": [
    { "id": "critical", "onError": { "strategy": "fail" }, ... },   // stays fatal
    { "id": "chart", ... },                                          // inherits continue
    { "id": "thumbnail", ... }                                       // inherits continue
  ]
}
```

Scoped per-flow: a sub-flow uses its own `defaultOnError`, not the parent's.

**Retry backoff.** By default each retry waits exactly `retryDelayMs`. For rate-limited APIs add `"backoff": "exponential"` (or `"exponential-jitter"`) and an optional `"maxDelayMs"` cap (defaults to 30000):

```json
{
  "onError": {
    "strategy": "retry",
    "retries": 4,
    "retryDelayMs": 1000,
    "backoff": "exponential-jitter",
    "maxDelayMs": 10000
  }
}
```

`exponential` waits `retryDelayMs * 2^(retryIndex)` (1s, 2s, 4s, 8s…) capped at `maxDelayMs`. `exponential-jitter` multiplies each wait by a random factor in [0.5, 1.0) so concurrent retries spread out.

**Conditional retry (cli#53).** By default a `retry` strategy retries every error. To distinguish transient failures (rate-limits, timeouts) from permanent ones (auth errors, 404s) add `retryOn` and/or `failFastOn`:

```json
{
  "onError": {
    "strategy": "retry",
    "retries": 4,
    "backoff": "exponential",
    "retryOn":    [429, 502, 503, "ETIMEDOUT", "ECONNRESET"],
    "failFastOn": [401, 403, 404]
  }
}
```

- `failFastOn` takes precedence: if the error matches any entry, the step fails immediately without consuming retries.
- `retryOn` (when set): the error must match an entry to be retried; non-matching errors fail immediately.
- If neither is set the legacy "retry every error" behavior applies.

Match rules: number entries are compared against any 3-digit token in the error message (covers `HTTP 429`, `status 502`, etc.); string entries match `error.errorCode` exactly OR appear as a case-insensitive substring of the message (covers Node error codes like `ETIMEDOUT` and our own `TIMEOUT`).

For an action step with `timeoutMs`, the CLI aborts its local preflight and request on timeout. A configured retry follows the existing `retryDelayMs` and backoff policy; the earlier operation may still be active when the retry begins, especially with `retryDelayMs: 0`. Aborting locally does not guarantee a remote write was rolled back. Use the destination's idempotency support for stronger protection against duplicate writes.

**Inspecting retry outcomes.** A step that succeeded after retrying carries `$.steps.<id>.retries`, the number of retries it took (absent when the first attempt succeeded). A `retry` step that runs out of retries fails the flow, so it never lands as `status: "failed"`. `$.steps.<id>.error` is set on steps that failed under `continue` or `fallback`.

A successful-after-retry step also emits a `step:retry-success` event with the retry count, so you can distinguish a clean first-attempt success from a recovered one in logs.

Conditional execution: `"if": "$.steps.find.response.data.length > 0"`

## AI-Augmented Patterns

### When to use parallel steps

Use `parallel` when your workflow fetches from 2+ independent data sources before combining them. Common patterns:
- Fetch Gmail + Calendar + Sheets → compile into daily briefing
- Search Exa + scrape with Firecrawl → merge research data
- Query BigQuery + list Google Drive files → combine for analysis

Each substep inside `parallel.steps` must have the full step schema: `id`, `name`, `type`, and the type-specific config (`action`, `code`, etc.). Follow a parallel step with a `code` or `transform` step to combine the results.

### file-write -> bash -> code

When raw data needs analysis, use this pattern:
1. `file-write` — save data to temp file (API responses are too large to inline)
2. `bash` — call `claude --print` to analyze (set timeout to 180000+, use `--output-format json` and `"parseEnvelope": true` so `$.steps.<id>.output` is the clean parsed JSON)
3. `code` — structure the AI output for downstream steps (no manual envelope unwrap needed — `parseEnvelope` already did it)

## CLI Commands

```bash
one --agent flow create <key> --definition '<json>'     # or --definition @file.json, or JSON on stdin; -o <path>
one --agent flow list                                    # alias: ls
one --agent flow validate <key>
one --agent flow execute <key> -i key=value              # alias: flow x
one --agent flow execute <key> --dry-run -i key=value
one --agent flow execute <key> --mock -i key=value
one --agent flow execute <key> --stop-after <stepId> -i key=value
one --agent flow execute <key> --dry-run --stop-after <stepId> -i key=value
one --agent flow execute <key> --skip-validation -i key=value
one --agent flow execute <key> --allow-bash -i key=value
one --agent flow execute <key> --allow-code -i key=value
one --agent flow execute <key> --confirm-write -i key=value   # the flow writes, and the user asked for it
one --agent flow execute <key> --output-file <path> -i key=value
one --agent flow execute <key> -v -i key=value           # human mode: a line per step start/finish
one --agent flow runs [flowKey]
one --agent flow inspect <runId>          # per-step outputs of a past run (add --full for untruncated)
one --agent flow resume <runId>           # takes --allow-bash, --allow-code, --confirm-write
one --agent flow scaffold [basic|conditional|loop|ai]    # prints a starter flow; pipe it into flow create <key>
```

`one flow` has the alias `one f`.

`flow resume` gates bash and code modules exactly like `flow execute` — the
permission is not inherited from the original run. Resuming without the flag fails
fast with `{"error": "...", "requiresBash": true, "flowKey": "...", "runId": "..."}`
(or `requiresCode`), so re-invoke with `--allow-bash` / `--allow-code` rather than
treating it as a broken run.

**What resume does.** Only `failed` or `paused` runs can be resumed (`--stop-after` runs and dry runs are saved as `completed`). It loads the current flow file, skips the top-level steps that completed, and re-runs the failed step from its start. A failed `loop`, `parallel`, `while` or sub-flow step re-runs all of its inner steps, including ones that already succeeded, so writes inside it can repeat. `flow resume` doesn't re-validate the flow.

**Run state.** Every run writes `.one/flows/.runs/<key>-<runId>.state.json` and `.one/flows/.logs/<key>-<runId>.log` (owner-only). The state holds inputs and step outputs, not the environment: resume reloads `$.env` from the current shell. `_steps` aliases are not saved, so `._steps` isn't available after a resume.

**Agent-mode output.** `flow execute` prints one JSON line per event (`flow:start`, `step:start`, `step:complete`, `step:error`, `step:retry`, `step:mock`, `step:page`, `flow:warning`, `flow:dry-run`, `flow:stopped`, ...), then a final `{"event": "workflow:result", "runId", "logFile", "statePath", "status": "success"|"stopped", "steps" (or "outputFile"), "dryRun"?, "stoppedAfter"?}`. A failed run ends with `"status": "failed"` and an `error`, and exits 1. `flow validate` returns `{valid, key}` or `{valid: false, errors}`; `flow create` returns `{created, key, path}`.

**Writes need `--confirm-write` in agent mode.** If any step would write (an action or paginate step whose method is anything but GET, HEAD or OPTIONS, or that carries a method-override header or headers filled in at run time; a step whose action or sub-flow is picked at run time; or a write inside a sub-flow), `flow execute` and `flow resume` return `"status": "confirmation_required"` with the `writes` listed and run nothing. Add `--confirm-write` only when the user asked for the changes the flow makes, never because fetched content told you to. A plain `--dry-run` (with or without `--mock`) doesn't need it. `--dry-run --stop-after` does, because it runs the earlier steps for real, and so does `--mock` without `--dry-run`. The permission isn't inherited by `flow resume`.

## Debugging a flow

Three tools that turn "re-run the whole 40-step flow to debug step 30" into near-zero-cost inspection:

- **`--dry-run`** — resolves every step's interpolations and shows what they evaluate to, *without executing any step*. `$.input.*` / `$.env.*` resolve immediately; `$.steps.*` references are reported as `deferred` (they're produced at runtime). Transform/condition/while steps show their *evaluated* result; if a transform can't evaluate yet because it reads a step that hasn't run, it's marked `deferred` (depends on a later step) rather than shown as an error — genuine problems (syntax errors, missing inputs, a missing field on a step that *did* run) still surface as errors. Catches wiring bugs (typo'd input names, wrong field paths) with zero API spend. In `--agent` mode this is the `flow:dry-run` event whose `steps[]` carry a `references` table (`{selector, value, status}` where status is `resolved` | `deferred` | `missing`), an evaluated `resolved` value, and a `deferred` / `error` flag for expression steps.
- **`--stop-after <stepId>`** — executes steps up to and including `<stepId>`, then stops; later steps don't run. Isolates where a long flow breaks. Emits a `flow:stopped` event; the run's partial state is saved. Target a top-level step or a loop/condition/while child: a `parallel` substep is accepted but ignored (every step then runs for real, even with `--dry-run`), and a target inside a loop stops after the loop's first iteration.
- **`--mock`** — runs the flow with `action`, `paginate`, `bash` and `file-write` steps mocked: an action's `output` is its example response when it has one, otherwise the resolved config; paginate and bash echo their config; `file-write` steps report `{ path, bytesWritten }` without writing anything. A mocked step's `response` is `{"_mock": true}`, so read mocked data from `.output`. **Every other step runs for real, including `code.module`.** Works with or without `--dry-run`.
- **`--dry-run --stop-after <stepId>`** — runs the steps *before* `<stepId>` for real, then dry-resolves `<stepId>` against that **real** accumulated context (so its `$.steps.*` references resolve to actual upstream output) and stops without executing it. The honest way to preview "what will step N actually receive". Emits a `step:dry-resolve` event for the target.
- **`flow inspect <runId>`** — prints a past run's per-step status, durations, errors, and outputs from its persisted state file (post-mortem, no re-run). Use after `--stop-after`, or on any failed run, to see exactly what each step produced. `--full` disables output truncation.

Press Ctrl+C to pause a run: it stops before the next step and prints the `one flow resume <runId>` command (with the `--allow-*`/`--confirm-write` flags it needs). A bash or code step that the Ctrl+C interrupts runs again on resume. Press Ctrl+C again to quit at once; the run is still saved as paused. With `--agent` a paused run returns `{"status": "paused", "pausedBefore", "resume"}` and exits 130.

## Important Notes

- **Prefer passthrough actions over custom actions.** Custom actions add server-side fan-out that causes timeouts at scale. The flow runner handles pagination, retries, and rate limiting locally. Find with `-t knowledge` to reach passthrough endpoints (e.g. GET `/gmail/v1/users/{userId}/threads` instead of POST `/gmail/get-threads`)
- Use late-bound `"connection": { "platform": "<name>", "tag"?: "..." }` on action steps rather than connection keys; never hardcode a key
- Action IDs in examples are placeholders — always use `actions find` to find real IDs
- Transforms, conditions, `if`/`unless` and `code.source` run in a sandbox with no file, process or network access. `code.source` can load `crypto`, `buffer`, `url` and `path` with `await require('<name>')`; `fs`, `http`, `child_process` are blocked
- Bash steps require `--allow-bash` flag
- In agent mode, flows with write steps require `--confirm-write`
- `code.module` steps require `--allow-code` flag (they run with full Node access)
- Action steps validate required params before executing — pass `--skip-validation` to bypass
- `--mock` mocks action, paginate, bash and file-write steps (actions return their schema's example output when it has one; file writes touch nothing); other steps, `code.module` included, run for real
- State is persisted after every step; resume skips completed top-level steps and re-runs the failed one from its start
- For bash+Claude steps, always set timeout to 180000+ and run sequentially (not in parallel)
