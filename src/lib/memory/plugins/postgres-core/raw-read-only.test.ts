import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pglitePlugin } from '../pglite/index.js';
import { CoreBackend } from './backend.js';
import { READER_SETUP_SQL, READER_ROLE } from '../embedded-postgres/index.js';
import type { MemBackend } from '../../backend.js';
import type { PgClient } from './client.js';

// `one mem sql` / `one sync sql` are documented as read-only. The keyword
// guard can't see SELECT INTO or server functions, so Postgres itself has to
// refuse writes: raw() runs in a READ ONLY transaction, and embedded-postgres
// runs it as a role without superuser or file-read rights.

describe('raw SQL cannot change the store', () => {
  let backend: MemBackend;
  before(async () => {
    backend = pglitePlugin.create(pglitePlugin.parseConfig({ dbPath: ':memory:' }));
    await backend.init();
    await backend.ensureSchema();
  });
  after(async () => { await backend.close(); });

  it('still runs ordinary reads', async () => {
    const res = await backend.raw!('SELECT count(*)::int AS n FROM mem_records');
    assert.deepEqual(res.rows, [{ n: 0 }]);
  });

  it('refuses SELECT INTO, which the keyword guard lets through', async () => {
    await assert.rejects(backend.raw!('SELECT 1 AS a INTO guard_bypass_table'), /read-only transaction/);
    const t = await backend.raw!("SELECT to_regclass('guard_bypass_table') AS t");
    assert.equal(t.rows[0].t, null);
  });

  it('refuses large-object writes', async () => {
    await assert.rejects(backend.raw!("SELECT lo_from_bytea(0, 'x'::bytea)"), /read-only transaction/);
  });

  it('leaves the connection usable after a refused query', async () => {
    await assert.rejects(backend.raw!('SELECT 1 AS a INTO again_table'));
    const res = await backend.raw!('SELECT 1 AS ok');
    assert.deepEqual(res.rows, [{ ok: 1 }]);
  });
});

describe('raw SQL uses the plugin-provided connection', () => {
  it('sends the query to rawClient inside a read-only transaction, not to the main client', async () => {
    const mainCalls: string[] = [];
    const rawCalls: string[] = [];
    const fake = (log: string[]): PgClient => {
      const c: PgClient = {
        async query(text: string) { log.push(text); return { rows: [{ ok: 1 }] as never[] }; },
        async transaction(fn) { log.push('BEGIN'); const r = await fn(c); log.push('COMMIT'); return r; },
        async close() {},
      };
      return c;
    };
    const main = fake(mainCalls);
    const reader = fake(rawCalls);
    const b = new CoreBackend(main, pglitePlugin.capabilities, async () => reader);
    await b.raw('SELECT 1 AS ok');
    assert.deepEqual(mainCalls, []);
    assert.deepEqual(rawCalls, ['BEGIN', 'SET TRANSACTION READ ONLY', 'SELECT 1 AS ok', 'COMMIT']);
  });
});

describe('embedded-postgres reader role', () => {
  it('can read the store but not read files or switch to a superuser', async () => {
    // PGlite is single-session, so this checks the role's grants with
    // SET ROLE rather than a second login. The live embedded daemon was
    // checked separately with a real login as the role.
    const db = pglitePlugin.create(pglitePlugin.parseConfig({ dbPath: ':memory:' }));
    await db.init();
    await db.ensureSchema();
    // The plugin's main (superuser) client, reached past `private`.
    const core = (db as unknown as { backend: { client: PgClient } }).backend;
    const c = core.client;
    await c.query(READER_SETUP_SQL);
    await c.query(READER_SETUP_SQL); // idempotent
    const role = await c.query<{ rolsuper: boolean; rolcanlogin: boolean }>(
      `SELECT rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1`, [READER_ROLE],
    );
    assert.deepEqual(role.rows, [{ rolsuper: false, rolcanlogin: true }]);
    const priv = await c.query<{ sel: boolean; files: boolean }>(
      `SELECT has_table_privilege($1, 'mem_records', 'SELECT') AS sel,
              pg_has_role($1, 'pg_read_server_files', 'USAGE') AS files`, [READER_ROLE],
    );
    assert.deepEqual(priv.rows, [{ sel: true, files: false }]);
    await db.close();
  });
});
