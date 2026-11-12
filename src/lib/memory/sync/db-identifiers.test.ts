import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadSqlite } from './sqlite-loader.js';
import { ensureTable, evolveSchema, upsertRecords, rebuildFtsIndex, getTableColumns, quoteIdent } from './db.js';

// Record keys come from API responses. A key with a `"` in it used to close
// the identifier quote and run more SQL through db.exec (DROP, ATTACH).

type Db = InstanceType<Awaited<ReturnType<typeof loadSqlite>>>;

let Database: Awaited<ReturnType<typeof loadSqlite>> | null = null;
let tmp: string;

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-sqlite-ids-')));
  try { Database = await loadSqlite(); } catch { Database = null; }
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function open(): Db {
  const db = new Database!(':memory:');
  db.exec('CREATE TABLE victim (x INTEGER); INSERT INTO victim VALUES (1);');
  return db;
}

function victimRows(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM victim').get() as { n: number }).n;
}

describe('quoteIdent', () => {
  it('doubles embedded quotes and refuses NUL', () => {
    assert.equal(quoteIdent('plain'), '"plain"');
    assert.equal(quoteIdent('a"b'), '"a""b"');
    assert.throws(() => quoteIdent('a\u0000b'), /NUL/);
  });
});

describe('sync SQLite column names from record keys', () => {
  it('ensureTable stores a hostile key as one literal column', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const db = open();
    const attached = path.join(tmp, 'attached-by-ensure.db');
    const key = `x" TEXT); ATTACH DATABASE '${attached}' AS p; DROP TABLE victim; --`;
    ensureTable(db, 'threads', { id: '1', [key]: 'v' }, 'id');
    assert.ok(!fs.existsSync(attached), 'ATTACH ran');
    assert.equal(victimRows(db), 1);
    assert.ok(getTableColumns(db, 'threads').some(c => c.name === key));
    db.close();
  });

  it('evolveSchema adds a hostile key as one literal column', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const db = open();
    ensureTable(db, 'threads', { id: '1' }, 'id');
    const attached = path.join(tmp, 'attached-by-evolve.db');
    const key = `y" TEXT; ATTACH DATABASE '${attached}' AS p; DROP TABLE victim; --`;
    evolveSchema(db, 'threads', { id: '1', [key]: 'v' });
    assert.ok(!fs.existsSync(attached), 'ATTACH ran');
    assert.equal(victimRows(db), 1);
    assert.ok(getTableColumns(db, 'threads').some(c => c.name === key));
    db.close();
  });

  it('upsertRecords writes and updates a record whose key has a quote, and FTS rebuilds', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const db = open();
    const key = `we"ird`;
    ensureTable(db, 'threads', { id: '1' }, 'id');
    upsertRecords(db, 'threads', [{ id: '1', [key]: 'first' }], 'id');
    upsertRecords(db, 'threads', [{ id: '1', [key]: 'second' }], 'id');
    const row = db.prepare(`SELECT ${quoteIdent(key)} AS v FROM threads WHERE id = '1'`).get() as { v: string };
    assert.equal(row.v, 'second');
    assert.doesNotThrow(() => rebuildFtsIndex(db, 'threads'));
    assert.equal(victimRows(db), 1);
    db.close();
  });
});
