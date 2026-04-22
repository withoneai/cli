/**
 * `one mem config get|set [key] [value]`
 *
 * Dot-path access against the memory config block. Secret fields are
 * redacted by default on `get` unless `--show-secrets` is passed.
 */

import * as output from '../../lib/output.js';
import {
  getMemoryConfigOrDefault,
  memoryConfigExists,
  updateMemoryConfig,
} from '../../lib/memory/index.js';
import type { MemoryConfig } from '../../lib/memory/index.js';

const SECRET_PATHS = new Set([
  'embedding.apiKey',
  'postgres.connectionString',
]);

interface ConfigFlags {
  showSecrets?: boolean;
}

export async function memConfigCommand(
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
  flags: ConfigFlags,
): Promise<void> {
  const act = action ?? 'get';

  if (act === 'get') {
    const cfg = memoryConfigExists() ? getMemoryConfigOrDefault() : null;
    if (!cfg) {
      output.error('Memory is not configured. Run `one mem init` first.');
    }
    const view = flags.showSecrets ? cfg! : redactSecrets(cfg!);
    const result = key ? getPath(view as unknown as Record<string, unknown>, key) : view;
    if (output.isAgentMode()) {
      output.json({ config: result });
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return;
  }

  if (act === 'set') {
    if (!key) output.error('`set` requires a key (e.g. embedding.provider)');
    if (value === undefined) output.error('`set` requires a value');
    const current = getMemoryConfigOrDefault();
    const next = setPath({ ...current } as unknown as Record<string, unknown>, key, parseValue(value!));
    const updated = updateMemoryConfig(next as unknown as Partial<MemoryConfig>);
    if (output.isAgentMode()) {
      output.json({ status: 'ok', updated: redactSecrets(updated) });
    } else {
      console.log(JSON.stringify(redactSecrets(updated), null, 2));
    }
    return;
  }

  if (act === 'unset') {
    if (!key) output.error('`unset` requires a key');
    const current = getMemoryConfigOrDefault();
    const next = unsetPath({ ...current } as unknown as Record<string, unknown>, key);
    const updated = updateMemoryConfig(next as unknown as Partial<MemoryConfig>);
    if (output.isAgentMode()) {
      output.json({ status: 'ok', updated: redactSecrets(updated) });
    } else {
      console.log(JSON.stringify(redactSecrets(updated), null, 2));
    }
    return;
  }

  output.error(`Unknown action "${act}". Use get, set, or unset.`);
}

function redactSecrets<T extends Record<string, unknown>>(cfg: T): T {
  const copy = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
  for (const path of SECRET_PATHS) {
    const val = getPath(copy, path);
    if (typeof val === 'string' && val.length > 0) {
      setPath(copy, path, `${val.slice(0, 6)}…(redacted, use --show-secrets)`);
    }
  }
  return copy as T;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function unsetPath(obj: Record<string, unknown>, path: string): Record<string, unknown> {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] == null || typeof cur[part] !== 'object') return obj;
    cur = cur[part] as Record<string, unknown>;
  }
  delete cur[parts[parts.length - 1]];
  return obj;
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch { /* fall through as string */ }
  }
  return raw;
}
