import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { memMigrateCommand, keysHeldByOtherTypes } from './migrate.js';
import { getBackend, resetBackendSingleton } from '../../lib/memory/runtime.js';
import { registerBackend } from '../../lib/memory/plugins.js';
import { pglitePlugin } from '../../lib/memory/plugins/pglite/index.js';
import { updateMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../../lib/memory/config.js';
import { writeConfig } from '../../lib/config.js';
import { getModelState } from '../../lib/memory/sync/state.js';
import { loadSqlite } from '../../lib/memory/sync/sqlite-loader.js';
import { setAgentMode } from '../../lib/output.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv } from '../../test-support/home.js';

/** Swallow the command's stdout report; pass binary chunks (test runner) through. */
async function quiet(fn: () => Promise<void>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout);
  let captured = '';
  (process.stdout as unknown as { write: (c: unknown, ...rest: unknown[]) => boolean }).write = (chunk, ...rest) => {
    if (typeof chunk === 'string') { captured += chunk; return true; }
    return (orig as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  try { await fn(); } finally { (process.stdout as unknown as { write: typeof orig }).write = orig; }
  return captured;
}

/**
 * PICA-1568: `.one/sync/data/<platform>.db` and `.one/sync/state/...` sit in
 * the project folder, so a cloned repo can ship crafted ones. `mem migrate`
 * must never let a legacy row update a record of another type, and progress
 * files must only be imported by `mem migrate`.
 */
describe('mem migrate — same app only (PICA-1568)', () => {
  let tmpHome: string;
  let project: string;
  let cwd: string;
  let homeSnapshot: ReturnType<typeof snapshotHomeEnv>;

  before(async () => {
    homeSnapshot = snapshotHomeEnv();
    cwd = process.cwd();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-migrate-same-app-'));
    project = path.join(tmpHome, 'project');
    fs.mkdirSync(project);
    setHomeTo(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
    writeConfig({ apiKey: 'sk_test_dummy', installedAgents: [], createdAt: new Date().toISOString() });
    registerBackend(pglitePlugin);
    updateMemoryConfig({
      ...DEFAULT_MEMORY_CONFIG,
      backend: 'pglite',
      pglite: { dbPath: path.join(tmpHome, 'store.pglite') },
    });
    resetBackendSingleton();
    setAgentMode(true);
    process.chdir(project);

    // The crafted repo: a legacy gmail.db plus the profile migrate reads.
    fs.mkdirSync(path.join('.one', 'sync', 'data'), { recursive: true });
    fs.mkdirSync(path.join('.one', 'sync', 'profiles'), { recursive: true });
    fs.writeFileSync(
      path.join('.one', 'sync', 'profiles', 'gmail_messages.json'),
      JSON.stringify({ platform: 'gmail', model: 'messages', idField: 'id', identityKey: 'email' }),
    );
    const Database = await loadSqlite();
    const db = new Database(path.join('.one', 'sync', 'data', 'gmail.db'));
    db.exec('CREATE TABLE "messages" (id TEXT, email TEXT, name TEXT, _synced_at TEXT)');
    const ins = db.prepare('INSERT INTO "messages" VALUES (?, ?, ?, ?)');
    // m1: identity matches the user's real Attio contact.
    ins.run('m1', 'jane@acme.com', 'ATTACKER NAME', '2026-01-01T00:00:00Z');
    // m2: its own source key was already merged into the Attio contact by a
    //     regular sync, so writing it would update that contact.
    ins.run('m2', 'bob@acme.com', 'ATTACKER BOB', '2026-01-01T00:00:00Z');
    // m3: identity matches an older gmail/messages row → same-type merge still works.
    ins.run('m3', 'carol@acme.com', 'Carol New', '2026-01-01T00:00:00Z');
    // m4: nothing to collide with → plain insert.
    ins.run('m4', 'dave@acme.com', 'Dave', '2026-01-01T00:00:00Z');
    db.close();

    // A crafted progress file.
    fs.mkdirSync(path.join('.one', 'sync', 'state', 'gmail'), { recursive: true });
    fs.writeFileSync(
      path.join('.one', 'sync', 'state', 'gmail', 'messages.json'),
      JSON.stringify({ lastSync: '2099-01-01T00:00:00Z', lastCursor: 'crafted', totalRecords: 1, pagesProcessed: 1, since: null, status: 'idle' }),
    );

    // The user's real memory store.
    const backend = await getBackend();
    await backend.upsertByKeys({
      type: 'attio/attioPeople',
      data: { name: 'Jane Real' },
      keys: ['attio/attioPeople:rec_jane', 'email:jane@acme.com'],
    });
    await backend.upsertByKeys({
      type: 'attio/attioPeople',
      data: { name: 'Bob Real' },
      keys: ['attio/attioPeople:rec_bob', 'email:bob@acme.com', 'gmail/messages:m2'],
    });
    await backend.upsertByKeys({
      type: 'gmail/messages',
      data: { id: 'old', email: 'carol@acme.com', name: 'Carol Old' },
      keys: ['gmail/messages:garbage-old-key'],
    });
  });

  after(async () => {
    process.chdir(cwd);
    setAgentMode(false);
    const backend = await getBackend();
    await backend.close();
    resetBackendSingleton();
    restoreHomeEnv(homeSnapshot);
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('does not import progress files when sync state is read', async () => {
    assert.equal(await getModelState('gmail', 'messages'), null);
    assert.ok(fs.existsSync(path.join('.one', 'sync', 'state', 'gmail', 'messages.json')), 'file must be left alone');
  });

  it('keysHeldByOtherTypes reports only keys another type holds', async () => {
    const backend = await getBackend();
    const held = await keysHeldByOtherTypes(backend, 'gmail/messages', [
      'gmail/messages:m1', 'email:jane@acme.com', 'gmail/messages:m2', 'gmail/messages:garbage-old-key',
    ]);
    assert.deepEqual([...held].sort(), ['email:jane@acme.com', 'gmail/messages:m2']);
  });

  it('never changes another app\'s records and still merges within the same type', async () => {
    const out = await quiet(() => memMigrateCommand({}));
    const result = JSON.parse(out.trim().split('\n').pop()!);
    const backend = await getBackend();

    const people = await backend.raw!(
      `SELECT data->>'name' AS name, keys FROM mem_records WHERE type = 'attio/attioPeople' ORDER BY data->>'name'`,
    );
    assert.deepEqual(people.rows.map(r => r.name), ['Bob Real', 'Jane Real'], 'Attio contacts keep their data');
    for (const r of people.rows) {
      assert.ok(!(r.keys as string[]).includes('gmail/messages:m1'), 'Attio contact gains no gmail keys');
    }

    const gmail = await backend.raw!(
      `SELECT data->>'name' AS name, keys FROM mem_records WHERE type = 'gmail/messages' ORDER BY data->>'name'`,
    );
    const byName = new Map(gmail.rows.map(r => [r.name as string, r.keys as string[]]));
    // m1 imported as its own record, without the email key Attio owns.
    assert.deepEqual(byName.get('ATTACKER NAME'), ['gmail/messages:m1']);
    // m2 skipped: its source key belongs to the Attio contact.
    assert.ok(!byName.has('ATTACKER BOB'));
    // m3 merged into the older gmail row (same type).
    assert.ok(!byName.has('Carol Old'), 'same-type identity merge must still replace the old row');
    assert.ok(byName.get('Carol New')!.includes('gmail/messages:garbage-old-key'));
    assert.ok(byName.get('Carol New')!.includes('email:carol@acme.com'));
    // m4 plain insert keeps its identity key.
    assert.deepEqual(byName.get('Dave')!.sort(), ['email:dave@acme.com', 'gmail/messages:m4']);

    assert.equal(result.totals.skippedOtherType, 1);
    assert.equal(result.totals.keptSeparate, 1);
    assert.equal(result.totals.mergedByIdentity, 1);
    assert.equal(result.totals.inserted, 2);
    assert.deepEqual(result.syncState, { imported: 1, skippedExisting: 0 });

    const state = await getModelState('gmail', 'messages');
    assert.equal(state?.lastCursor, 'crafted', 'mem migrate imports progress files');
  });

  it('never overwrites existing progress with a progress file', async () => {
    fs.writeFileSync(
      path.join('.one', 'sync', 'state', 'gmail', 'messages.json'),
      JSON.stringify({ lastSync: null, lastCursor: 'second', totalRecords: 0, pagesProcessed: 0, since: null, status: 'idle' }),
    );
    const out = await quiet(() => memMigrateCommand({ dryRun: true }));
    const result = JSON.parse(out.trim().split('\n').pop()!);
    assert.deepEqual(result.syncState, { imported: 0, skippedExisting: 1 });
    assert.equal((await getModelState('gmail', 'messages'))?.lastCursor, 'crafted');
  });
});
