/**
 * Postgres backend plugin — Supabase, self-hosted, Neon, any Postgres.
 *
 * Thin adapter over node-pg. Most of the work lives in postgres-core
 * (shared between this plugin and the PGlite plugin).
 *
 * Implementation is stubbed pending the postgres-core shared query layer.
 */

import type {
  MemBackend,
  MemBackendPlugin,
  BackendCapabilities,
  ParsedBackendConfig,
} from '../../backend.js';
import { SCHEMA_VERSION } from '../../schema.js';

interface PostgresConfig extends ParsedBackendConfig {
  connectionString: string;
  schema: string;
}

const CAPABILITIES: BackendCapabilities = {
  vectorSearch: true,
  fullTextSearch: true,
  partialIndexes: true,
  jsonPathQuery: true,
  triggers: true,
  concurrentWriters: true,
  maxVectorDims: 2000,
};

function parseConfig(raw: unknown): PostgresConfig {
  const r = (raw ?? {}) as Partial<PostgresConfig>;
  const envOverride = process.env.MEM_DATABASE_URL;
  const connectionString = envOverride ?? r.connectionString ?? '';
  if (!connectionString) {
    throw new Error(
      'Postgres backend requires a connection string. ' +
      'Set MEM_DATABASE_URL, or run `one mem config set memory.postgres.connectionString <url>`.'
    );
  }
  const schema = typeof r.schema === 'string' && r.schema ? r.schema : 'public';
  return { connectionString, schema };
}

class PostgresBackend implements MemBackend {
  constructor(_config: PostgresConfig) {
    // Connection wired in a follow-up commit against postgres-core.
  }

  private notImplemented(method: string): never {
    throw new Error(`PostgresBackend.${method} not yet implemented (scaffolding stage).`);
  }

  async init(): Promise<void> { this.notImplemented('init'); }
  async close(): Promise<void> { this.notImplemented('close'); }
  async ensureSchema(): Promise<void> { this.notImplemented('ensureSchema'); }
  async getSchemaVersion(): Promise<string | null> { return null; }

  async insert(): Promise<never> { this.notImplemented('insert'); }
  async upsertByKeys(): Promise<never> { this.notImplemented('upsertByKeys'); }
  async getById(): Promise<never> { this.notImplemented('getById'); }
  async update(): Promise<never> { this.notImplemented('update'); }
  async remove(): Promise<never> { this.notImplemented('remove'); }
  async archive(): Promise<never> { this.notImplemented('archive'); }
  async unarchive(): Promise<never> { this.notImplemented('unarchive'); }
  async list(): Promise<never> { this.notImplemented('list'); }

  async search(): Promise<never> { this.notImplemented('search'); }
  async context(): Promise<never> { this.notImplemented('context'); }
  async trackAccess(): Promise<never> { this.notImplemented('trackAccess'); }

  async link(): Promise<never> { this.notImplemented('link'); }
  async unlink(): Promise<never> { this.notImplemented('unlink'); }
  async linked(): Promise<never> { this.notImplemented('linked'); }

  async addSource(): Promise<never> { this.notImplemented('addSource'); }
  async removeSource(): Promise<never> { this.notImplemented('removeSource'); }
  async findBySource(): Promise<never> { this.notImplemented('findBySource'); }
  async listSources(): Promise<never> { this.notImplemented('listSources'); }

  async getSyncState(): Promise<never> { this.notImplemented('getSyncState'); }
  async setSyncState(): Promise<never> { this.notImplemented('setSyncState'); }
  async listSyncStates(): Promise<never> { this.notImplemented('listSyncStates'); }

  async ensureHotColumn(): Promise<never> { this.notImplemented('ensureHotColumn'); }
  async dropHotColumn(): Promise<never> { this.notImplemented('dropHotColumn'); }

  async vacuum(): Promise<never> { this.notImplemented('vacuum'); }
  async stats(): Promise<never> { this.notImplemented('stats'); }

  capabilities(): BackendCapabilities {
    return CAPABILITIES;
  }
}

export const postgresPlugin: MemBackendPlugin = {
  name: 'postgres',
  description: 'Postgres over node-pg. Works with Supabase, Neon, self-hosted.',
  version: '0.1.0',
  schemaVersion: SCHEMA_VERSION,
  capabilities: CAPABILITIES,
  parseConfig,
  create(config) {
    return new PostgresBackend(config as PostgresConfig);
  },
};

export default postgresPlugin;
