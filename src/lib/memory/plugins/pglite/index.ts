/**
 * PGlite backend plugin — default for local, embedded Postgres.
 *
 * PGlite bundles pgvector + pg_trgm in WASM, so schema parity with hosted
 * Postgres is exact. Single-writer, per-project filesystem directory.
 *
 * Implementation is stubbed pending the postgres-core shared query layer.
 */

import path from 'node:path';
import os from 'node:os';
import type {
  MemBackend,
  MemBackendPlugin,
  BackendCapabilities,
  ParsedBackendConfig,
} from '../../backend.js';
import { SCHEMA_VERSION } from '../../schema.js';

interface PgliteConfig extends ParsedBackendConfig {
  dbPath: string;
}

const CAPABILITIES: BackendCapabilities = {
  vectorSearch: true,
  fullTextSearch: true,
  partialIndexes: true,
  jsonPathQuery: true,
  triggers: true,
  concurrentWriters: false,
  maxVectorDims: 2000,
};

function defaultDbPath(): string {
  return path.join(os.homedir(), '.one', 'mem.pglite');
}

function parseConfig(raw: unknown): PgliteConfig {
  const r = (raw ?? {}) as Partial<PgliteConfig>;
  const dbPath = typeof r.dbPath === 'string' && r.dbPath ? expandHome(r.dbPath) : defaultDbPath();
  return { dbPath };
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p === '~') return os.homedir();
  return p;
}

class PgliteBackend implements MemBackend {
  constructor(_config: PgliteConfig) {
    // Connection wired in a follow-up commit against postgres-core.
  }

  private notImplemented(method: string): never {
    throw new Error(`PgliteBackend.${method} not yet implemented (scaffolding stage).`);
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

export const pglitePlugin: MemBackendPlugin = {
  name: 'pglite',
  description: 'Embedded Postgres via PGlite (default). Zero external deps.',
  version: '0.1.0',
  schemaVersion: SCHEMA_VERSION,
  capabilities: CAPABILITIES,
  parseConfig,
  create(config) {
    return new PgliteBackend(config as PgliteConfig);
  },
};

export default pglitePlugin;
