/**
 * Shared helpers for `one mem` command handlers.
 */

import * as output from '../../lib/output.js';
import { readConfig, getOpenAiApiKey } from '../../lib/config.js';
import { getMemoryConfigOrDefault } from '../../lib/memory/index.js';

/**
 * Precondition check for every `one mem` command. We no longer require
 * `mem init` — memory auto-bootstraps with pglite defaults on first use
 * (see runtime.ts:getBackend). The one thing we still insist on is the
 * base One config, because memory writes live in the same config.json
 * alongside `apiKey` and nothing should run without that anchor.
 */
export function requireMemoryInit(): void {
  if (!readConfig()) {
    output.error('No One config found. Run `one init` first.');
  }
}

export function parseJsonArg(arg: string, field = 'data'): Record<string, unknown> {
  try {
    const parsed = JSON.parse(arg);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      output.error(`${field} must be a JSON object, not ${Array.isArray(parsed) ? 'an array' : typeof parsed}.`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    output.error(`Invalid JSON for ${field}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function parseCsv(value?: string): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function parsePositiveInt(value: string | undefined, fallback: number, label = 'value'): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    output.error(`${label} must be a positive integer`);
  }
  return n;
}

export function printRecord(record: Record<string, unknown>): void {
  if (output.isAgentMode()) {
    output.json(record);
    return;
  }
  console.log(JSON.stringify(record, null, 2));
}

export function printList(items: unknown[]): void {
  if (output.isAgentMode()) {
    output.json({ items, total: items.length });
    return;
  }
  if (items.length === 0) {
    console.log('(no results)');
    return;
  }
  console.log(JSON.stringify(items, null, 2));
}

export function okJson(payload: Record<string, unknown>): void {
  if (output.isAgentMode()) {
    output.json(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

/**
 * Shape of the upgrade hint surfaced to agents + humans when a capability
 * is available but not currently active. Mirrors the pattern called out in
 * feedback_ux_and_ax.md: "Upgrade hints on every surface — when a subsystem
 * is running in a degraded mode, structured output should tell the agent
 * (so they can tell their user) that a better mode exists."
 */
export interface UpgradeHint {
  capability: string;
  available: boolean;
  currentMode: string;
  how: string;
  benefit: string;
}

/**
 * Returns a structured hint if semantic search is inactive (FTS-only).
 * Call from any command whose output would be richer with embeddings
 * (`mem search`, `mem status`, `mem context`).
 *
 * The hint is intentionally short and actionable — agents shouldn't have
 * to translate a paragraph of prose into a user-facing instruction.
 */
export function semanticSearchUpgradeHint(): UpgradeHint | null {
  const cfg = getMemoryConfigOrDefault();
  const keyPresent = !!getOpenAiApiKey();
  const providerOn = cfg.embedding.provider === 'openai';

  if (providerOn && keyPresent) return null;

  if (!keyPresent) {
    return {
      capability: 'semantic_search',
      available: true,
      currentMode: 'fts_only',
      how: 'Add an OpenAI key: `one init` (then "Add OpenAI key"), or `one mem config set embedding.apiKey sk-...`',
      benefit: 'Ranks memories by meaning, not just keyword overlap — finds relevant records even when the query and the data use different words.',
    };
  }

  // Key is present but provider is still `none` — likely a legacy config.
  return {
    capability: 'semantic_search',
    available: true,
    currentMode: 'fts_only',
    how: 'Flip the provider on: `one mem config set embedding.provider openai`',
    benefit: 'Ranks memories by meaning, not just keyword overlap.',
  };
}

/**
 * Human-facing one-liner for the same hint. Call from TTY output paths.
 * Returns empty string when there's nothing to say.
 */
export function semanticSearchUpgradeLine(): string {
  const hint = semanticSearchUpgradeHint();
  if (!hint) return '';
  return `tip: semantic search available — ${hint.how}`;
}
