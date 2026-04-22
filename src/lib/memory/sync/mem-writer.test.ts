import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writePageToMemory } from './mem-writer.js';
import type { SyncProfile } from './types.js';
import { updateMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../config.js';
import { writeConfig } from '../../config.js';
import { getBackend, resetBackendSingleton } from '../runtime.js';

/**
 * Exercises the dual-write helper end-to-end against a live PGlite. Proves
 * that sync pages land as mem_records with the correct keys[] (prefixed +
 * identity-derived), sources map entries, and tags.
 */
describe('sync mem-writer — dual-write into the unified memory store', () => {
  let tmpHome: string;
  let dbDir: string;

  before(async () => {
    // Isolate HOME so we never touch the user's real config file.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-writer-test-'));
    dbDir = path.join(tmpHome, 'mem.pglite');
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
    writeConfig({
      apiKey: 'sk_test_dummy',
      installedAgents: [],
      createdAt: new Date().toISOString(),
    });
    updateMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      backend: 'pglite',
      pglite: { dbPath: dbDir },
    });
    resetBackendSingleton();
    // Warm up the singleton so schema is applied before any writer call.
    await getBackend();
  });

  after(async () => {
    const backend = await getBackend();
    await backend.close();
    resetBackendSingleton();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const profile: SyncProfile = {
    platform: 'attio',
    model: 'people',
    connectionKey: 'live::attio::default::abc',
    actionId: 'conn_mod_def::xxx::yyy',
    resultsPath: 'data',
    idField: 'id',
    pagination: { type: 'cursor' },
    identityKey: 'email',
  };

  it('writes a page and lands records with prefixed keys + sources', async () => {
    const records = [
      { id: 'p1', name: 'Alice', email: 'alice@example.com' },
      { id: 'p2', name: 'Bob', email: 'Bob@Example.com' }, // casing differences
    ];

    const report = await writePageToMemory(profile, records);
    assert.equal(report.attempted, 2);
    assert.equal(report.inserted, 2);
    assert.equal(report.updated, 0);
    assert.equal(report.skipped, 0);

    const backend = await getBackend();

    // Look up each by its source key
    const alice = await backend.findBySource('attio/people:p1');
    assert.ok(alice, 'alice should be found by her source key');
    assert.deepEqual(alice!.data, { id: 'p1', name: 'Alice', email: 'alice@example.com' });
    assert.ok((alice!.keys ?? []).includes('attio/people:p1'));
    assert.ok((alice!.keys ?? []).includes('email:alice@example.com'));
    assert.ok(alice!.sources['attio/people:p1']);
    assert.ok((alice!.tags ?? []).includes('synced'));
    assert.ok((alice!.tags ?? []).includes('attio'));

    // Identity key is lowercased on the way in so Bob and bob merge naturally
    const bob = await backend.findBySource('attio/people:p2');
    assert.ok(bob, 'bob should be found by his source key');
    assert.ok((bob!.keys ?? []).includes('email:bob@example.com'));
  });

  it('re-running the same page updates (not inserts)', async () => {
    const records = [{ id: 'p1', name: 'Alice Updated', email: 'alice@example.com' }];
    const report = await writePageToMemory(profile, records);
    assert.equal(report.updated, 1);
    assert.equal(report.inserted, 0);

    const backend = await getBackend();
    const alice = await backend.findBySource('attio/people:p1');
    assert.ok(alice, 'alice should still exist after update');
    assert.equal(alice!.data.name, 'Alice Updated');
  });

  it('skips records with no id field and never crashes', async () => {
    const report = await writePageToMemory(profile, [
      { name: 'Missing id' }, // no `id`
      { id: '', name: 'Empty id' },
      { id: null as unknown as string, name: 'Null id' },
    ]);
    assert.equal(report.skipped, 3);
    assert.equal(report.inserted, 0);
  });

  it('strips sync-internal fields (leading underscore) from the landed payload', async () => {
    const report = await writePageToMemory(profile, [
      { id: 'p9', name: 'Carol', email: 'carol@example.com', _synced_at: '2026-04-01', _enriched_at: '2026-04-02' },
    ]);
    assert.equal(report.inserted, 1);
    const backend = await getBackend();
    const carol = await backend.findBySource('attio/people:p9');
    assert.ok(carol, 'carol should be found');
    assert.equal(carol!.data._synced_at, undefined);
    assert.equal(carol!.data._enriched_at, undefined);
  });
});
