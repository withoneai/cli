# Agents

Agent mode, the built-in guide, onboarding and how the CLI maps to the MCP server. Part of the [One CLI reference](./README.md).

## `--agent` (machine-readable mode)

Put `--agent` right after `one` (or set `ONE_AGENT=1`) for JSON on stdout with no colours, spinners or prompts. A failure prints `{"error": "..."}` and exits 1; a refused write or delete adds `"status": "confirmation_required"`. Interactive-only commands (`init` without `--auth`, `login`, `add`, `config`) return an error in agent mode.

## `one guide [topic]`

Get the full CLI usage guide, designed for AI agents that only have the binary (no MCP, no IDE skills).

```bash
one guide                 # full guide (all topics)
one guide overview        # setup, --agent flag, discovery workflow
one guide actions         # find, load, and execute
one guide flows           # multi-step API workflows

one --agent guide         # full guide as structured JSON
one --agent guide flows   # single topic as JSON
```

Topics: `overview`, `actions`, `flows`, `relay`, `cache`, `memory`, `sync`, `all` (default).

In agent mode (`--agent`), the JSON response includes the guide content and an `availableTopics` array so agents can discover what sections exist.

## `one onboard`

A three-step onboarding script written for an AI agent: it teaches the agent what the CLI can do and which apps you have connected. Needs a configured API key. Each step names the next command.

```bash
one onboard             # step 1
one onboard --step 2    # then 2 and 3 (JSON with --agent)
```

## The workflow

The power of One is in the workflow. Every interaction follows the same pattern:

```
one list                    → What am I connected to?
one actions find            → What do I run, and how?
one actions execute         → Do it.
```

This is the same workflow whether you're sending emails, creating CRM contacts, processing payments, managing inventory, or posting to Slack. One pattern, any platform.

For multi-step workflows that chain actions across platforms:

```
one actions find            → Find each action, with its schema
one flow create             → Define the workflow as JSON
one flow validate           → Check it
one flow execute            → Run it
```

Workflows support conditions, loops, while loops, parallel execution, transforms, code steps, sub-flows, pagination, bash steps, and file I/O. Run `one guide flows` for the full schema reference and examples.

## For AI agents

If you're an AI agent with only the `one` binary (no MCP server or IDE skills), start with `one --agent guide` to get the full usage guide as structured JSON. This teaches you the complete workflow, JSON schemas, selector syntax, and more - everything you need to bootstrap yourself.

If you're an AI agent using the One MCP server, the tools map directly:

| MCP Tool | CLI Command |
|----------|------------|
| `list_one_integrations` | `one list` + `one platforms` |
| `find_one_actions` | `one actions find` (and `one actions load` for its `load`) |
| `execute_one_action` | `one actions execute` |

The workflow is the same: list → find → execute. Never execute without reading the docs find returns - they contain required parameter info and platform-specific details that are critical for building correct requests.
