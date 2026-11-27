# Flows

Multi-step workflows that chain actions across platforms. Part of the [One CLI reference](./README.md).

Chain actions across platforms into reusable workflows:

```bash
# Create a flow that looks up a Stripe customer and sends a Gmail welcome email
one flow create welcome-customer --definition '{
  "key": "welcome-customer",
  "name": "Welcome New Customer",
  "version": "1",
  "inputs": {
    "stripeKey": { "type": "string", "required": true, "connection": { "platform": "stripe" } },
    "gmailKey": { "type": "string", "required": true, "connection": { "platform": "gmail" } },
    "email": { "type": "string", "required": true }
  },
  "steps": [
    { "id": "find", "name": "Find customer", "type": "action",
      "action": { "platform": "stripe", "actionId": "<actionId>", "connectionKey": "$.input.stripeKey",
        "data": { "query": "email:'\''{{$.input.email}}'\''" } } },
    { "id": "send", "name": "Send email", "type": "action",
      "if": "$.steps.find.response.data.length > 0",
      "action": { "platform": "gmail", "actionId": "<actionId>", "connectionKey": "$.input.gmailKey",
        "data": { "to": "{{$.input.email}}", "subject": "Welcome!", "body": "Thanks for joining." } } }
  ]
}'

# Validate it
one flow validate welcome-customer

# Run it - connection keys auto-resolve if you have one connection per platform
one flow execute welcome-customer -i email=jane@example.com
```

Workflows live under `.one/flows/<key>/flow.json` with an optional `lib/` subfolder for `.mjs` code modules — create new flows in this folder layout. In agent mode, a flow with write steps needs `--confirm-write`, bash steps need `--allow-bash`, and `code.module` steps need `--allow-code`. Flows can be organized into subdirectory groups: `.one/flows/<group>/<key>/flow.json`. Reference them as `group/key` or just the bare key if unique. (The legacy single-file layout `.one/flows/<key>.flow.json` is deprecated but still loads for backward compatibility.) Flows support conditions, loops, while loops, parallel steps, transforms, sub-flows, pagination, bash steps, and external `.mjs` code modules. Run `one guide flows` for the full reference.

## `one flow create [key]`

Create a workflow from a JSON definition. New workflows are saved to the folder layout at `.one/flows/<key>/flow.json` (with a `lib/` subfolder scaffolded for code modules), unless you pass `-o` or a legacy `<key>.flow.json` already exists, which is then updated in place. A positional key overrides the definition's `key`. Use `group/key` to place flows in a subdirectory group (e.g. `.one/flows/research/company-research/flow.json`). The legacy `.one/flows/<key>.flow.json` single-file layout is deprecated; existing legacy files continue to load and run unchanged for backward compatibility.

```bash
# From a --definition flag
one flow create welcome-customer --definition '{"key":"welcome-customer","name":"Welcome","version":"1","inputs":{},"steps":[]}'

# Create in a subdirectory group
one flow create research/company-research --definition @flow.json

# From stdin
cat flow.json | one flow create

# Custom output path
one flow create my-flow --definition '...' -o ./custom/path.json
```

| Option | What it does |
|--------|-------------|
| `--definition <json>` | Workflow definition as a JSON string |
| `-o, --output <path>` | Custom output path (default: `.one/flows/<key>/flow.json`) |

## `one flow execute <key>`

Execute a workflow by key or file path. Pass inputs with repeatable `-i` flags.

```bash
# Execute with inputs (values are parsed as JSON when they can be: -i n=5 is a number)
one flow execute welcome-customer \
  -i email=jane@example.com

# Dry run - resolve every step's interpolations and show what they evaluate to,
# without executing any step (catches wiring bugs without burning API credits)
one flow execute welcome-customer --dry-run -i email=jane@example.com

# Stop after a specific step (isolate where a long flow breaks)
one flow execute welcome-customer --stop-after find -i email=jane@example.com

# Combine: run steps up to a point for real, then dry-resolve the suspect step
# against the REAL accumulated output (so $.steps.* references resolve too)
one flow execute welcome-customer --dry-run --stop-after send -i email=jane@example.com

# Verbose - print each step as it starts and finishes
one flow execute welcome-customer -v -i email=jane@example.com
```

Connection inputs with a `connection` field in the workflow definition are auto-resolved when the user has exactly one connection for that platform (top-level runs only, not sub-flows or resumes).

Press Ctrl+C to pause a run: it stops before the next step and prints the `one flow resume <runId>` command (with the `--allow-*`/`--confirm-write` flags it needs). A bash or code step that the Ctrl+C interrupts runs again on resume. Press Ctrl+C again to quit at once; the run is still saved as paused. A run that fails can also be resumed with `one flow resume <runId>`.

| Option | What it does |
|--------|-------------|
| `-i, --input <name=value>` | Input parameter (repeatable) |
| `--dry-run` | Resolve each step's interpolations and show what they evaluate to, without running actions, code, bash or file steps. Transform and condition expressions are evaluated, in the sandbox. `$.input.*`/`$.env.*` resolve up front; `$.steps.*` refs are reported as deferred (they're produced at runtime). Still needs required inputs and `--allow-bash`/`--allow-code`, and records a run. |
| `--mock` | Mock `action`, `paginate`, `bash` and `file-write` steps (an action returns its schema's example response when it has one; `file-write` steps report `{ path, bytesWritten }` without writing anything). Every other step runs for real, `code.module` included. A mocked step's `response` is `{"_mock": true}`; read `.output`. Works with or without `--dry-run` |
| `--stop-after <stepId>` | Execute steps up to and including `<stepId>`, then stop (later steps are not run). Combined with `--dry-run`, runs earlier steps for real and dry-resolves `<stepId>` against their output without executing it. Use a top-level step or a loop/condition/while child; a `parallel` substep is ignored. Inspect what ran with `one flow inspect <runId>`. |
| `--skip-validation` | Skip input validation against action schemas |
| `--allow-bash` | Allow bash step execution (disabled by default for security) |
| `--allow-code` | Allow `code.module` steps, which run a `.mjs` file with full Node access (disabled by default for security) |
| `--confirm-write` | Required in agent mode when any step writes (any method but GET/HEAD/OPTIONS, a method-override header, or an action or sub-flow picked at run time). Without it the command returns `confirmation_required` with the writes listed and runs nothing. A plain `--dry-run` doesn't need it; `--dry-run --stop-after` and `--mock` alone do. Also on `flow resume` |
| `-v, --verbose` | Print each step as it starts and finishes (status, duration, errors); human mode only |
| `--output-file <path>` | Stream the full result to a file instead of stdout — for large results that would otherwise be truncated or exceed the JSON string-size limit. stdout (and `--agent` output) then carries an `outputFile` pointer instead of inline `steps`. |

Inline JavaScript in a flow (transforms, conditions, `if`/`unless`, `code.source`) runs in a sandbox: a separate Node process with no file, child-process or network access and no environment of its own (`$.env` in the flow context still carries the CLI's variables). It needs no flag. `code.module` steps are full Node programs and need `--allow-code`.

Step-level `if`/`unless` conditions (and `while`/`condition` steps) are null-safe: a condition that references a skipped or not-yet-run step's output (e.g. `$.steps.maybeSkipped.output.x`) evaluates to `false` rather than crashing the run.

## `one flow list`

List all workflows saved in `.one/flows/`.

```bash
one flow list
```

## `one flow validate <key>`

Validate a workflow JSON file against the schema.

```bash
one flow validate welcome-customer
```

## `one flow resume <runId>`

Resume a failed or paused workflow run. It skips the top-level steps that completed and re-runs the failed step from its start (a failed loop, parallel, while or sub-flow step re-runs all its inner steps, so writes there can repeat). It uses the current flow file.

```bash
one flow resume abc123
one flow resume abc123 --allow-bash    # required if the flow has bash steps
one flow resume abc123 --allow-code    # required if the flow has code.module steps
```

`--allow-bash`, `--allow-code` and `--confirm-write` are gated the same way as on `flow execute` — resuming doesn't
inherit the permission from the original run, so pass it again. `one flow list`
shows which flows need it.

## `one flow runs [flowKey]`

List workflow runs, optionally filtered by workflow key.

```bash
one flow runs                    # all runs
one flow runs welcome-customer   # runs for a specific workflow
```

## `one flow inspect <runId>`

Inspect a past (or in-progress) run's per-step outputs — post-mortem debugging without re-running the flow. Every run persists a state file that records each step's output as it completes (and is preserved on failure), so this shows exactly how far the run got and what each step produced.

```bash
one flow inspect abc123          # truncates large outputs
one flow inspect abc123 --full   # full, pretty-printed outputs
```

Pairs with `--stop-after`: run up to a step, then `one flow inspect <runId>` to see its output. State files live in `.one/flows/.runs/` (owner-only) and hold inputs and step outputs, never the environment.

## `one flow scaffold [template]`

Print a starter workflow (`basic`, `conditional`, `loop` or `ai`) to stdout; nothing is saved. Pipe it into `one flow create <key>` to save it.

```bash
one flow scaffold loop | one flow create my-loop
```

`one flow` has the alias `one f`; `flow execute` is also `flow x` and `flow list` is `flow ls`.
