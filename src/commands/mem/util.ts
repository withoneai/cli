/**
 * Shared helpers for `one mem` command handlers.
 */

import * as output from '../../lib/output.js';
import { memoryConfigExists } from '../../lib/memory/index.js';

export function requireMemoryInit(): void {
  if (!memoryConfigExists()) {
    output.error('Memory is not configured. Run `one mem init` first.');
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
