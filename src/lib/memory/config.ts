/**
 * Memory config shape + helpers.
 *
 * Storage lives in the existing ~/.one/config.json (mode 0600), alongside
 * ONE_SECRET. Same scope resolution as other config (project > global),
 * same env-var override chain.
 */

import {
  readConfig,
  writeConfig,
  getOpenAiApiKey as getOpenAiApiKeyFromCore,
  setOpenAiApiKey as setOpenAiApiKeyInCore,
} from '../config.js';
import type { Config } from '../types.js';

export type EmbeddingProvider = 'openai' | 'none';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  /**
   * @deprecated Read-only legacy field. The canonical home for the OpenAI
   * key is top-level `config.openaiApiKey`. Older installs may still have
   * a value here — we read it once as a fallback, then `mem config` writes
   * promote it to the top level and clear this field.
   */
  apiKey?: string;
}

export interface MemoryDefaults {
  trackAccessOnSearch: boolean;
  embedOnAdd: boolean;
  embedOnSync: boolean;
}

/**
 * Top-level memory config block. Per-backend config lives keyed by plugin
 * name (e.g. `memory.pglite`, `memory.postgres`, `memory.turso`). Unknown
 * keys are preserved on write so third-party plugins don't get clobbered.
 */
export interface MemoryConfig {
  backend: string;
  plugins: string[];
  embedding: EmbeddingConfig;
  defaults: MemoryDefaults;
  [backendName: string]: unknown;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  backend: 'pglite',
  plugins: [],
  embedding: {
    provider: 'none',
    model: 'text-embedding-3-small',
    dimensions: 1536,
  },
  defaults: {
    trackAccessOnSearch: true,
    embedOnAdd: true,
    embedOnSync: false,
  },
};

export function getMemoryConfig(): MemoryConfig | null {
  const config = readConfig();
  return (config?.memory as MemoryConfig | undefined) ?? null;
}

export function getMemoryConfigOrDefault(): MemoryConfig {
  return getMemoryConfig() ?? DEFAULT_MEMORY_CONFIG;
}

export function memoryConfigExists(): boolean {
  return getMemoryConfig() !== null;
}

export function updateMemoryConfig(patch: Partial<MemoryConfig>): MemoryConfig {
  const config = readConfig();
  if (!config) {
    throw new Error('No One config found. Run `one init` first.');
  }
  const current = (config.memory as MemoryConfig | undefined) ?? DEFAULT_MEMORY_CONFIG;
  const next: MemoryConfig = { ...current, ...patch };
  (config as Config & { memory?: MemoryConfig }).memory = next;
  writeConfig(config);
  return next;
}

/**
 * Read the OpenAI key with the full precedence chain (env > .onerc >
 * project > global). Falls back to the legacy `memory.embedding.apiKey`
 * field one last time so pre-migration installs keep working.
 *
 * The canonical home is top-level `config.openaiApiKey` — same level as
 * `config.apiKey`. See lib/config.ts:getOpenAiApiKey.
 */
export function getEmbeddingApiKey(): string | null {
  const fromCore = getOpenAiApiKeyFromCore();
  if (fromCore) return fromCore;
  const mem = getMemoryConfig();
  return mem?.embedding.apiKey ?? null;
}

/**
 * Persist the OpenAI key at the top level of the active config scope.
 * Re-exported from the core config module so memory-facing code has a
 * single import surface.
 */
export const setOpenAiApiKey = setOpenAiApiKeyInCore;

/**
 * Read the Postgres connection string with env-var override.
 */
export function getPostgresConnectionString(): string | null {
  if (process.env.MEM_DATABASE_URL) return process.env.MEM_DATABASE_URL;
  const mem = getMemoryConfig();
  const pg = (mem?.postgres ?? {}) as { connectionString?: string };
  return pg.connectionString ?? null;
}
