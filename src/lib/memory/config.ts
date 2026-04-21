/**
 * Memory config shape + helpers.
 *
 * Storage lives in the existing ~/.one/config.json (mode 0600), alongside
 * ONE_SECRET. Same scope resolution as other config (project > global),
 * same env-var override chain.
 */

import { readConfig, writeConfig } from '../config.js';
import type { Config } from '../types.js';

export type EmbeddingProvider = 'openai' | 'none';

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  apiKey?: string;
  model: string;
  dimensions: number;
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
    throw new Error('No One config found. Run `one init` first, then `one mem init`.');
  }
  const current = (config.memory as MemoryConfig | undefined) ?? DEFAULT_MEMORY_CONFIG;
  const next: MemoryConfig = { ...current, ...patch };
  (config as Config & { memory?: MemoryConfig }).memory = next;
  writeConfig(config);
  return next;
}

/**
 * Read the OpenAI key using the same precedence as ONE_SECRET:
 *   env var > .onerc > project > global config.
 */
export function getEmbeddingApiKey(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  // .onerc support mirrors ONE_SECRET; fold in later if needed
  const mem = getMemoryConfig();
  return mem?.embedding.apiKey ?? null;
}

/**
 * Read the Postgres connection string with env-var override.
 */
export function getPostgresConnectionString(): string | null {
  if (process.env.MEM_DATABASE_URL) return process.env.MEM_DATABASE_URL;
  const mem = getMemoryConfig();
  const pg = (mem?.postgres ?? {}) as { connectionString?: string };
  return pg.connectionString ?? null;
}
