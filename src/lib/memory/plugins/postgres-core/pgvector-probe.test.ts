import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { CoreBackend } from './backend.js';
import { probePgvector } from './client.js';
import type { PgClient, PgQueryResult } from './client.js';
import { pglitePlugin } from '../pglite/index.js';

/**
 * Issue #193: the `postgres` backend claimed vectorSearch unconditionally,
 * so a server without pgvector failed `mem init` on `CREATE EXTENSION
 * vector`, and a store stamped while FTS-only skipped the vector DDL forever
 * once pgvector appeared, failing on `column "embedding" does not exist`.
 */

function fakeClient(handlers: { installed: boolean | 'throws'; create: 'ok' | 'throws' }, log: string[]): PgClient {
  const c: PgClient = {
    async query<T>(text: string): Promise<PgQueryResult<T>> {
      log.push(text);
      if (text.includes('pg_extension')) {
        if (handlers.installed === 'throws') throw new Error('permission denied');
        return { rows: [{ ok: handlers.installed }] as T[] };
      }
      if (text.includes('CREATE EXTENSION')) {
        if (handlers.create === 'throws') throw new Error('extension "vector" is not available');
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async transaction(fn) { return fn(c); },
    async close() {},
  };
  return c;
}

describe('probePgvector', () => {
  it('is true when the extension is already installed, without trying to create it', async () => {
    const log: string[] = [];
    assert.equal(await probePgvector(fakeClient({ installed: true, create: 'throws' }, log)), true);
    assert.ok(!log.some(q => q.includes('CREATE EXTENSION')), 'a login without CREATE rights can still use an installed extension');
  });

  it('is true when the extension is available and can be created', async () => {
    assert.equal(await probePgvector(fakeClient({ installed: false, create: 'ok' }, [])), true);
  });

  it('is false when the server does not have pgvector', async () => {
    assert.equal(await probePgvector(fakeClient({ installed: false, create: 'throws' }, [])), false);
  });

  it('still tries to create it when the catalog lookup fails', async () => {
    assert.equal(await probePgvector(fakeClient({ installed: 'throws', create: 'ok' }, [])), true);
  });
});

function pgliteClient(db: PGlite): PgClient {
  const run = async <T>(text: string, params?: unknown[]): Promise<PgQueryResult<T>> => {
    if (params && params.length > 0) {
      const res = await db.query<T>(text, params);
      return { rows: res.rows, rowCount: res.affectedRows };
    }
    const results = await db.exec(text);
    const last = results[results.length - 1];
    return { rows: (last?.rows as T[] | undefined) ?? [], rowCount: last?.affectedRows };
  };
  const client: PgClient = {
    query: run,
    async transaction(fn) {
      await run('BEGIN');
      try { const r = await fn(client); await run('COMMIT'); return r; } catch (e) { await run('ROLLBACK'); throw e; }
    },
    async close() { await db.close(); },
  };
  return client;
}

describe('schema fast path when pgvector appears after the store was stamped', () => {
  it('adds the vector columns instead of trusting the version stamp', async () => {
    const db = await PGlite.create({ extensions: { vector } });
    const client = pgliteClient(db);
    const ftsOnly = { ...pglitePlugin.capabilities, vectorSearch: false, maxVectorDims: null };
    await new CoreBackend(client, ftsOnly).ensureSchema();

    const hasEmbedding = async () => (await client.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass('mem_records') AND attname = 'embedding' AND NOT attisdropped) AS ok`,
    )).rows[0].ok;
    assert.equal(await hasEmbedding(), false, 'an FTS-only store has no embedding column');

    const withVector = new CoreBackend(client, pglitePlugin.capabilities);
    await withVector.ensureSchema();
    assert.equal(await hasEmbedding(), true, 'the vector DDL ran once pgvector was available');

    // A write and a stats call touch the embedding column.
    await withVector.upsertByKeys({ type: 'note', data: { text: 'hi' }, keys: ['note:1'] });
    const stats = await withVector.stats();
    assert.equal(stats.recordCount, 1);
    assert.equal(stats.embeddedCount, 0);
    await db.close();
  });
});
