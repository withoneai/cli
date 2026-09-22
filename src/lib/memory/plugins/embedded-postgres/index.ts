import { homeDir } from '../../../home.js';
/**
 * Embedded Postgres backend plugin — bootstraps a real Postgres process
 * via pgserve (Postgres 18), then talks to it over node-pg. Default
 * backend for new installs.
 *
 * pgserve is normally consumed via its Bun-based SDK, but the SDK
 * statically imports `bun` so it can't be loaded on Node. Instead we
 * spawn `node_modules/.bin/pgserve` as a detached child process and
 * recover the connection details from a small PID/port file we manage
 * ourselves. The child stays running across CLI invocations — every
 * later call finds it via the PID file and reuses it once the Postgres
 * behind that port proves it serves this cluster. See daemon.ts.
 *
 * pgvector caveat: pgserve advertises pgvector but its bundled binaries
 * don't actually include the extension's `.so` / `.control` files, so on
 * a true cold-start `CREATE EXTENSION vector` fails. We probe at runtime
 * and downgrade `vectorSearch` to false when pgvector isn't loadable —
 * memory still works (FTS-only) and the per-command `_upgrade` hint
 * tells the user how to enable semantic search (`brew install pgvector`,
 * or point at a remote Postgres that has it). Shipping pgvector binaries
 * with the CLI is tracked as deferred work.
 */

import path from 'node:path';

import type {
  MemBackend,
  MemBackendPlugin,
  BackendCapabilities,
  ParsedBackendConfig,
} from '../../backend.js';
import { SCHEMA_VERSION } from '../../schema.js';
import { CoreBackend } from '../postgres-core/index.js';
import type { PgClient, PgQueryResult } from '../postgres-core/index.js';
import { ensureRunning, nodeDaemonDeps } from './daemon.js';
import type { PgClientCtor } from './daemon.js';

interface EmbeddedPostgresConfig extends ParsedBackendConfig {
  dataDir: string;
  database: string;
  schema: string;
  pgvector: boolean;
  host: string;
  port: number;
  /** Set from the user's config; a taken explicit port errors instead of moving. */
  portExplicit: boolean;
  user: string;
  password: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  startupTimeoutMs: number;
}

const BASE_CAPABILITIES: BackendCapabilities = {
  vectorSearch: true,
  fullTextSearch: true,
  partialIndexes: true,
  jsonPathQuery: true,
  triggers: true,
  concurrentWriters: true,
  maxVectorDims: 2000,
  rawSql: true,
};

const DEFAULTS: EmbeddedPostgresConfig = {
  // Getter, not a bound value: DEFAULTS is built at module load, so a plain
  // `path.join(homeDir(), ...)` here would capture the home directory before
  // ONE_HOME could take effect. See lib/home.ts.
  get dataDir() { return path.join(homeDir(), '.one', 'pg'); },
  database: 'one_mem',
  schema: 'public',
  pgvector: true,
  host: '127.0.0.1',
  port: 5434,
  portExplicit: false,
  // pgserve auto-provisions databases; the bundled superuser is `postgres`
  // with no password by default. We don't expose the password to the user
  // since the daemon only listens on 127.0.0.1.
  user: 'postgres',
  password: '',
  logLevel: 'warn',
  startupTimeoutMs: 30000,
};

function parseConfig(raw: unknown): EmbeddedPostgresConfig {
  const r = (raw ?? {}) as Partial<EmbeddedPostgresConfig>;
  return {
    dataDir: r.dataDir ?? DEFAULTS.dataDir,
    database: r.database ?? DEFAULTS.database,
    schema: r.schema ?? DEFAULTS.schema,
    pgvector: r.pgvector ?? DEFAULTS.pgvector,
    host: r.host ?? DEFAULTS.host,
    port: r.port ?? DEFAULTS.port,
    portExplicit: r.port !== undefined,
    user: r.user ?? DEFAULTS.user,
    password: r.password ?? DEFAULTS.password,
    logLevel: r.logLevel ?? DEFAULTS.logLevel,
    startupTimeoutMs: r.startupTimeoutMs ?? DEFAULTS.startupTimeoutMs,
  };
}

// ─── pg pool wrapper ────────────────────────────────────────────────────────

interface PgPool {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number }>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

interface PgPoolClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number }>;
  release(): void;
}

interface PgPoolCtor {
  new (opts: Record<string, unknown>): PgPool;
}

function wrapClient(pool: PgPool): PgClient {
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<PgQueryResult<T>> {
      const res = await pool.query<T>(text, params);
      return { rows: res.rows, rowCount: res.rowCount ?? undefined };
    },
    async transaction<T>(fn: (tx: PgClient) => Promise<T>): Promise<T> {
      const tx = await pool.connect();
      const txClient: PgClient = {
        async query<U = Record<string, unknown>>(text: string, params?: unknown[]): Promise<PgQueryResult<U>> {
          const res = await tx.query<U>(text, params);
          return { rows: res.rows, rowCount: res.rowCount ?? undefined };
        },
        async transaction() {
          throw new Error('Nested transactions are not supported.');
        },
        async close() {
          tx.release();
        },
      };
      try {
        await tx.query('BEGIN');
        const result = await fn(txClient);
        await tx.query('COMMIT');
        return result;
      } catch (err) {
        try { await tx.query('ROLLBACK'); } catch { /* swallow */ }
        throw err;
      } finally {
        tx.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Probe whether pgvector is loadable on this Postgres. The bundled
 * Postgres binaries shipped by `embedded-postgres` (and re-used by
 * pgserve) don't include pgvector, but the user can install it
 * separately (`brew install pgvector`, point the data dir at a real
 * cluster, etc). Probing at runtime lets the same plugin code path
 * work whether vector is available or not — semantic-search-capable
 * when present, FTS-only when absent. Idempotent: `CREATE EXTENSION IF
 * NOT EXISTS` is a no-op when already loaded.
 */
async function probePgvector(client: PgClient): Promise<boolean> {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    return true;
  } catch {
    return false;
  }
}

class LazyEmbeddedPostgresBackend implements MemBackend {
  private backend: CoreBackend | null = null;
  private config: EmbeddedPostgresConfig;
  private resolvedCaps: BackendCapabilities = BASE_CAPABILITIES;

  constructor(config: EmbeddedPostgresConfig) { this.config = config; }

  private async ensure(): Promise<CoreBackend> {
    if (this.backend) return this.backend;

    const pgMod = await import('pg').catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`pg is not installed. Run \`npm i pg\` or pick a different backend. (${msg})`);
    });
    type PgExports = { Pool: PgPoolCtor; Client: PgClientCtor };
    const pgExports = (pgMod as unknown as Partial<PgExports>).Pool
      ? (pgMod as unknown as PgExports)
      : (pgMod as unknown as { default: PgExports }).default;
    const PoolCtor = pgExports.Pool;

    // The daemon check connects to whatever answers on the port, so it
    // needs pg loaded first. It returns the port the verified daemon uses,
    // which can differ from the configured default when that was taken.
    this.config.port = await ensureRunning(
      this.config,
      nodeDaemonDeps(this.config, pgExports.Client, {
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
      }),
    );

    // pgserve auto-provisions: connecting to a non-existent database
    // creates it on the fly. pgvector availability is detected once
    // here — see probePgvector + the vectorSearch downgrade below.
    const pool = new PoolCtor({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
    });
    const client = wrapClient(pool);

    const hasVector = await probePgvector(client);
    this.resolvedCaps = hasVector
      ? BASE_CAPABILITIES
      : { ...BASE_CAPABILITIES, vectorSearch: false, maxVectorDims: null };

    this.backend = new CoreBackend(client, this.resolvedCaps);
    return this.backend;
  }

  capabilities(): BackendCapabilities { return this.resolvedCaps; }

  async init(): Promise<void> { await this.ensure(); }
  async close(): Promise<void> { if (this.backend) await this.backend.close(); this.backend = null; }
  async ensureSchema(): Promise<void> { return (await this.ensure()).ensureSchema(); }
  async getSchemaVersion(): ReturnType<MemBackend['getSchemaVersion']> { return (await this.ensure()).getSchemaVersion(); }

  async insert(...a: Parameters<MemBackend['insert']>): ReturnType<MemBackend['insert']> { return (await this.ensure()).insert(...a); }
  async upsertByKeys(...a: Parameters<MemBackend['upsertByKeys']>): ReturnType<MemBackend['upsertByKeys']> { return (await this.ensure()).upsertByKeys(...a); }
  async getById(...a: Parameters<MemBackend['getById']>): ReturnType<MemBackend['getById']> { return (await this.ensure()).getById(...a); }
  async update(...a: Parameters<MemBackend['update']>): ReturnType<MemBackend['update']> { return (await this.ensure()).update(...a); }
  async updateKeys(...a: Parameters<MemBackend['updateKeys']>): ReturnType<MemBackend['updateKeys']> { return (await this.ensure()).updateKeys(...a); }
  async remove(...a: Parameters<MemBackend['remove']>): ReturnType<MemBackend['remove']> { return (await this.ensure()).remove(...a); }
  async archive(...a: Parameters<MemBackend['archive']>): ReturnType<MemBackend['archive']> { return (await this.ensure()).archive(...a); }
  async unarchive(...a: Parameters<MemBackend['unarchive']>): ReturnType<MemBackend['unarchive']> { return (await this.ensure()).unarchive(...a); }
  async list(...a: Parameters<MemBackend['list']>): ReturnType<MemBackend['list']> { return (await this.ensure()).list(...a); }
  async count(...a: Parameters<MemBackend['count']>): ReturnType<MemBackend['count']> { return (await this.ensure()).count(...a); }
  async listForReindex(...a: Parameters<MemBackend['listForReindex']>): ReturnType<MemBackend['listForReindex']> { return (await this.ensure()).listForReindex(...a); }
  async listKeysByType(...a: Parameters<MemBackend['listKeysByType']>): ReturnType<MemBackend['listKeysByType']> { return (await this.ensure()).listKeysByType(...a); }
  async listForSearchableBackfill(...a: Parameters<MemBackend['listForSearchableBackfill']>): ReturnType<MemBackend['listForSearchableBackfill']> { return (await this.ensure()).listForSearchableBackfill(...a); }
  async updateEmbedding(...a: Parameters<MemBackend['updateEmbedding']>): ReturnType<MemBackend['updateEmbedding']> { return (await this.ensure()).updateEmbedding(...a); }
  async updateSearchableText(...a: Parameters<MemBackend['updateSearchableText']>): ReturnType<MemBackend['updateSearchableText']> { return (await this.ensure()).updateSearchableText(...a); }
  async raw(sql: string, params?: unknown[]): ReturnType<NonNullable<MemBackend['raw']>> {
    const b = await this.ensure();
    if (!b.raw) throw new Error('Backend does not support raw SQL');
    return b.raw(sql, params);
  }

  async search(...a: Parameters<MemBackend['search']>): ReturnType<MemBackend['search']> { return (await this.ensure()).search(...a); }
  async context(...a: Parameters<MemBackend['context']>): ReturnType<MemBackend['context']> { return (await this.ensure()).context(...a); }
  async trackAccess(...a: Parameters<MemBackend['trackAccess']>): ReturnType<MemBackend['trackAccess']> { return (await this.ensure()).trackAccess(...a); }

  async link(...a: Parameters<MemBackend['link']>): ReturnType<MemBackend['link']> { return (await this.ensure()).link(...a); }
  async unlink(...a: Parameters<MemBackend['unlink']>): ReturnType<MemBackend['unlink']> { return (await this.ensure()).unlink(...a); }
  async linked(...a: Parameters<MemBackend['linked']>): ReturnType<MemBackend['linked']> { return (await this.ensure()).linked(...a); }

  async addSource(...a: Parameters<MemBackend['addSource']>): ReturnType<MemBackend['addSource']> { return (await this.ensure()).addSource(...a); }
  async removeSource(...a: Parameters<MemBackend['removeSource']>): ReturnType<MemBackend['removeSource']> { return (await this.ensure()).removeSource(...a); }
  async findBySource(...a: Parameters<MemBackend['findBySource']>): ReturnType<MemBackend['findBySource']> { return (await this.ensure()).findBySource(...a); }
  async findByKeys(...a: Parameters<MemBackend['findByKeys']>): ReturnType<MemBackend['findByKeys']> { return (await this.ensure()).findByKeys(...a); }
  async listSources(...a: Parameters<MemBackend['listSources']>): ReturnType<MemBackend['listSources']> { return (await this.ensure()).listSources(...a); }

  async getSyncState(...a: Parameters<MemBackend['getSyncState']>): ReturnType<MemBackend['getSyncState']> { return (await this.ensure()).getSyncState(...a); }
  async setSyncState(...a: Parameters<MemBackend['setSyncState']>): ReturnType<MemBackend['setSyncState']> { return (await this.ensure()).setSyncState(...a); }
  async listSyncStates(): ReturnType<MemBackend['listSyncStates']> { return (await this.ensure()).listSyncStates(); }
  async removeSyncState(...a: Parameters<MemBackend['removeSyncState']>): ReturnType<MemBackend['removeSyncState']> { return (await this.ensure()).removeSyncState(...a); }

  async ensureHotColumn(...a: Parameters<MemBackend['ensureHotColumn']>): ReturnType<MemBackend['ensureHotColumn']> { return (await this.ensure()).ensureHotColumn(...a); }
  async dropHotColumn(...a: Parameters<MemBackend['dropHotColumn']>): ReturnType<MemBackend['dropHotColumn']> { return (await this.ensure()).dropHotColumn(...a); }

  async vacuum(): ReturnType<MemBackend['vacuum']> { return (await this.ensure()).vacuum(); }
  async stats(): ReturnType<MemBackend['stats']> { return (await this.ensure()).stats(); }
}

export const embeddedPostgresPlugin: MemBackendPlugin = {
  name: 'embedded-postgres',
  description: 'Local Postgres 18 bootstrapped on-demand via pgserve. Default backend for new installs. Semantic search (pgvector) auto-enables when the extension is locally installed; otherwise FTS-only with an upgrade hint.',
  version: '0.1.0',
  schemaVersion: SCHEMA_VERSION,
  capabilities: BASE_CAPABILITIES,
  parseConfig,
  create(config) {
    return new LazyEmbeddedPostgresBackend(config as EmbeddedPostgresConfig);
  },
};
