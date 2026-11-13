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
import { registerBackend } from '../plugins.js';
import { pglitePlugin } from '../plugins/pglite/index.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv } from '../../../test-support/home.js';

/**
 * PICA-1583: sync must never update a record of another type. The upsert
 * matches on any shared key and sync writes with `replace: true`, so an
 * upstream record carrying `email:jane@acme.com` used to replace the data of
 * whatever record held that key: another app's contact, or a note the user
 * wrote. Records whose identity belongs to another type are now stored
 * separately and linked through `identity_keys[]`.
 */
describe('sync mem-writer — never updates a record of another type (PICA-1583)', () => {
  let tmpHome: string;
  let homeSnapshot: ReturnType<typeof snapshotHomeEnv>;

  const stripe: SyncProfile = {
    platform: 'stripe',
    model: 'customers',
    connectionKey: 'live::stripe::default::abc',
    actionId: 'conn_mod_def::xxx::yyy',
    resultsPath: 'data',
    idField: 'id',
    pagination: { type: 'cursor' },
    identityKey: 'email',
  };

  const rows = async (where: string) => {
    const backend = await getBackend();
    const res = await backend.raw!(
      `SELECT type, status, data, keys, identity_keys, weight FROM mem_records WHERE ${where} ORDER BY type, created_at`,
    );
    return res.rows as Array<{ type: string; status: string; data: Record<string, unknown>; keys: string[]; identity_keys: string[] | null; weight: number }>;
  };

  before(async () => {
    homeSnapshot = snapshotHomeEnv();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-writer-cross-type-'));
    setHomeTo(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
    writeConfig({ apiKey: 'sk_test_dummy', installedAgents: [], createdAt: new Date().toISOString() });
    registerBackend(pglitePlugin);
    updateMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, backend: 'pglite', pglite: { dbPath: path.join(tmpHome, 'mem.pglite') } });
    resetBackendSingleton();
    const backend = await getBackend();

    // A note the user wrote, tagged with Jane's email.
    await backend.upsertByKeys({
      type: 'note',
      data: { text: 'Jane prefers calls on Tuesdays' },
      keys: ['note:n1', 'email:jane@acme.com'],
      weight: 9,
    });
    // An Attio contact for Bob, and an archived Attio contact for Carol.
    await backend.upsertByKeys({
      type: 'attio/attioPeople',
      data: { name: 'Bob Real' },
      keys: ['attio/attioPeople:rec_bob', 'email:bob@acme.com'],
    });
    const carol = await backend.upsertByKeys({
      type: 'attio/attioPeople',
      data: { name: 'Carol Archived' },
      keys: ['attio/attioPeople:rec_carol', 'email:carol@acme.com'],
    });
    await backend.archive(carol.record.id, 'test');
    // A record an older CLI already merged: Dave's Attio contact holds the
    // Stripe source key.
    await backend.upsertByKeys({
      type: 'attio/attioPeople',
      data: { name: 'Dave Real' },
      keys: ['attio/attioPeople:rec_dave', 'email:dave@acme.com', 'stripe/customers:cus_dave'],
    });
  });

  after(async () => {
    const backend = await getBackend();
    await backend.close();
    resetBackendSingleton();
    restoreHomeEnv(homeSnapshot);
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('stores upstream records separately instead of replacing other types\' records', async () => {
    const report = await writePageToMemory(stripe, [
      { id: 'cus_jane', email: 'jane@acme.com', name: 'UPSTREAM JANE' },
      { id: 'cus_bob', email: 'bob@acme.com', name: 'UPSTREAM BOB' },
      { id: 'cus_carol', email: 'carol@acme.com', name: 'UPSTREAM CAROL' },
      { id: 'cus_dave', email: 'dave@acme.com', name: 'UPSTREAM DAVE' },
      { id: 'cus_erin', email: 'erin@acme.com', name: 'Erin' },
    ]);

    const [note] = await rows(`type = 'note'`);
    assert.deepEqual(note.data, { text: 'Jane prefers calls on Tuesdays' }, 'the note keeps its text');
    assert.equal(note.weight, 9);

    const attio = await rows(`type = 'attio/attioPeople'`);
    assert.deepEqual(
      attio.map(r => [r.data.name, r.status]),
      [['Bob Real', 'active'], ['Carol Archived', 'archived'], ['Dave Real', 'active']],
      'Attio contacts keep their data, and the archived one stays archived',
    );
    for (const r of attio) {
      assert.ok(!r.keys.some(k => k.startsWith('stripe/customers:') && k !== 'stripe/customers:cus_dave'), 'no Stripe key lands on an Attio contact');
    }

    const customers = await rows(`type = 'stripe/customers'`);
    const byId = new Map(customers.map(r => [r.data.id as string, r]));
    for (const [id, email] of [['cus_jane', 'jane'], ['cus_bob', 'bob'], ['cus_carol', 'carol']]) {
      const r = byId.get(id)!;
      assert.ok(r, `${id} is stored as its own record`);
      assert.deepEqual(r.keys, [`stripe/customers:${id}`], 'the merge key another type holds is left out of keys[]');
      assert.deepEqual(r.identity_keys, [`email:${email}@acme.com`], 'and kept as a non-merging link');
    }
    assert.ok(!byId.has('cus_dave'), 'a source key already merged into another type is not written');
    assert.deepEqual(byId.get('cus_erin')!.keys.sort(), ['email:erin@acme.com', 'stripe/customers:cus_erin'], 'no collision → normal merge key');

    assert.equal(report.keptSeparate, 3);
    assert.equal(report.skippedOtherType, 1);
    assert.equal(report.inserted, 4);
    assert.equal(report.skipped, 0, 'cross-type cases must not count as rejected rows');
  });

  it('re-syncs the separate record in place and keeps the link', async () => {
    const report = await writePageToMemory(stripe, [
      { id: 'cus_jane', email: 'jane@acme.com', name: 'Jane v2' },
    ]);
    assert.equal(report.updated, 1);
    const jane = (await rows(`type = 'stripe/customers' AND data->>'id' = 'cus_jane'`));
    assert.equal(jane.length, 1);
    assert.equal(jane[0].data.name, 'Jane v2');
    assert.deepEqual(jane[0].identity_keys, ['email:jane@acme.com']);
    const [note] = await rows(`type = 'note'`);
    assert.deepEqual(note.data, { text: 'Jane prefers calls on Tuesdays' });
  });

  it('find-by-key still returns both records for the shared email', async () => {
    const backend = await getBackend();
    const res = await backend.raw!(
      `SELECT type FROM mem_records WHERE keys && $1::text[] OR identity_keys && $1::text[] ORDER BY type`,
      [['email:jane@acme.com']],
    );
    assert.deepEqual(res.rows.map(r => r.type), ['note', 'stripe/customers']);
  });

  it('same-type re-sync still replaces data (a field removed upstream disappears)', async () => {
    await writePageToMemory(stripe, [{ id: 'cus_erin', email: 'erin@acme.com', name: 'Erin', phone: '555' }]);
    await writePageToMemory(stripe, [{ id: 'cus_erin', email: 'erin@acme.com', name: 'Erin' }]);
    const [erin] = await rows(`type = 'stripe/customers' AND data->>'id' = 'cus_erin'`);
    assert.equal(erin.data.phone, undefined);
  });
});

/**
 * Issue #194: a singular identityKey on a value that several upstream
 * records share (calendar events from one organizer) merged them into one
 * record, keeping only the last one's data under every source key.
 */
describe('sync mem-writer — never merges two upstream records of the same type (#194)', () => {
  let tmpHome: string;
  let homeSnapshot: ReturnType<typeof snapshotHomeEnv>;

  const events: SyncProfile = {
    platform: 'google-calendar',
    model: 'events',
    connectionKey: 'live::google-calendar::default::abc',
    actionId: 'conn_mod_def::xxx::yyy',
    resultsPath: 'items',
    idField: 'id',
    pagination: { type: 'cursor' },
    identityKey: 'organizer.email',
  };
  const attioCompanies: SyncProfile = {
    platform: 'attio',
    model: 'attioCompanies',
    connectionKey: 'live::attio::default::abc',
    actionId: 'conn_mod_def::xxx::zzz',
    resultsPath: 'data',
    idField: 'id',
    pagination: { type: 'cursor' },
    identityKey: 'domain',
  };

  const rows = async (where: string) => {
    const backend = await getBackend();
    const res = await backend.raw!(
      `SELECT type, data, keys, identity_keys FROM mem_records WHERE ${where} ORDER BY created_at`,
    );
    return res.rows as Array<{ type: string; data: Record<string, unknown>; keys: string[]; identity_keys: string[] | null }>;
  };

  before(async () => {
    homeSnapshot = snapshotHomeEnv();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-writer-same-type-'));
    setHomeTo(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
    writeConfig({ apiKey: 'sk_test_dummy', installedAgents: [], createdAt: new Date().toISOString() });
    registerBackend(pglitePlugin);
    updateMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, backend: 'pglite', pglite: { dbPath: path.join(tmpHome, 'mem.pglite') } });
    resetBackendSingleton();
    const backend = await getBackend();
    // A company record the user curates, cross-referenced to Attio by domain.
    await backend.upsertByKeys({
      type: 'company',
      data: { name: 'Acme', attio_id: 'rec_acme', tier: 'gold' },
      keys: ['company:acme', 'domain:acme.com'],
    });
    // A same-type record with no source key (written by hand): still mergeable.
    await backend.upsertByKeys({
      type: 'google-calendar/events',
      data: { summary: 'hand-written placeholder' },
      keys: ['email:carol@acme.com'],
    });
  });

  after(async () => {
    const backend = await getBackend();
    await backend.close();
    resetBackendSingleton();
    restoreHomeEnv(homeSnapshot);
    try { fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* ignore */ }
  });

  it('keeps each event as its own record when they share an organizer', async () => {
    const report = await writePageToMemory(events, [
      { id: 'ev1', summary: 'one', organizer: { email: 'bob@acme.com' } },
      { id: 'ev2', summary: 'two', organizer: { email: 'bob@acme.com' } },
      { id: 'ev3', summary: 'three', organizer: { email: 'bob@acme.com' } },
    ]);
    const evs = await rows(`type = 'google-calendar/events' AND data ? 'id'`);
    assert.deepEqual(evs.map(r => r.data.summary), ['one', 'two', 'three'], 'every event keeps its own data');
    assert.deepEqual(evs[0].keys.sort(), ['email:bob@acme.com', 'google-calendar/events:ev1']);
    for (const [i, r] of evs.slice(1).entries()) {
      assert.deepEqual(r.keys, [`google-calendar/events:ev${i + 2}`]);
      assert.deepEqual(r.identity_keys, ['email:bob@acme.com'], 'linked by the shared value');
    }
    assert.equal(report.inserted, 3);
    assert.equal(report.keptSeparate, 2);

    const backend = await getBackend();
    const linked = await backend.findByKeys(['email:bob@acme.com']);
    assert.equal(linked.length, 3, 'find-by-key returns all three');
  });

  it('re-syncs each event in place', async () => {
    const report = await writePageToMemory(events, [
      { id: 'ev2', summary: 'two v2', organizer: { email: 'bob@acme.com' } },
      { id: 'ev1', summary: 'one v2', organizer: { email: 'bob@acme.com' } },
    ]);
    assert.equal(report.updated, 2);
    assert.equal(report.inserted, 0);
    const evs = await rows(`type = 'google-calendar/events' AND data ? 'id'`);
    assert.deepEqual(evs.map(r => r.data.summary), ['one v2', 'two v2', 'three']);
  });

  it('still merges into a same-type record that has no source key', async () => {
    const report = await writePageToMemory(events, [
      { id: 'ev9', summary: 'nine', organizer: { email: 'carol@acme.com' } },
    ]);
    assert.equal(report.updated, 1);
    const [r] = await rows(`type = 'google-calendar/events' AND 'email:carol@acme.com' = ANY(keys)`);
    assert.equal(r.data.summary, 'nine');
    assert.ok(r.keys.includes('google-calendar/events:ev9'));
  });

  it('leaves a curated company alone when Attio syncs the same domain', async () => {
    const report = await writePageToMemory(attioCompanies, [
      { id: 'rec_acme', domain: 'acme.com', name: 'Acme Inc (Attio)' },
    ]);
    const [company] = await rows(`type = 'company'`);
    assert.deepEqual(company.data, { name: 'Acme', attio_id: 'rec_acme', tier: 'gold' }, 'attio_id and every other field survive');
    const [attio] = await rows(`type = 'attio/attioCompanies'`);
    assert.deepEqual(attio.keys, ['attio/attioCompanies:rec_acme']);
    assert.deepEqual(attio.identity_keys, ['domain:acme.com']);
    assert.equal(report.keptSeparate, 1);
  });
});
