import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { memFindByKeyCommand } from './records.js';
import { getBackend, resetBackendSingleton } from '../../lib/memory/runtime.js';
import { registerBackend } from '../../lib/memory/plugins.js';
import { pglitePlugin } from '../../lib/memory/plugins/pglite/index.js';
import { updateMemoryConfig, DEFAULT_MEMORY_CONFIG } from '../../lib/memory/config.js';
import { writeConfig } from '../../lib/config.js';

// #131: `one mem find-by-key <key> [<key2>]` — exercises the full command path
// (getBackend → findByKeys → group-by-type → agent JSON) against a real PGlite
// backend seeded with identity_keys.

/** Force --agent mode and capture the JSON the command writes to stdout. */
async function runAgent(fn: () => Promise<void>): Promise<any> {
  const prev = process.env.ONE_AGENT;
  process.env.ONE_AGENT = '1';
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  (process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) => { buf += chunk; return true; };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
    if (prev === undefined) delete process.env.ONE_AGENT; else process.env.ONE_AGENT = prev;
  }
  const lines = buf.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

describe('mem find-by-key command (#131)', () => {
  let tmpHome: string;

  before(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'find-by-key-test-'));
    process.env.HOME = tmpHome;
    fs.mkdirSync(path.join(tmpHome, '.one'), { mode: 0o700 });
    writeConfig({ apiKey: 'sk_test_dummy', installedAgents: [], createdAt: new Date().toISOString() });
    registerBackend(pglitePlugin);
    updateMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, backend: 'pglite', pglite: { dbPath: path.join(tmpHome, 'mem.pglite') } });
    resetBackendSingleton();
    const backend = await getBackend();

    const now = new Date().toISOString();
    await backend.upsertByKeys({ type: 'attio/people', data: { name: 'Jane Smith' }, keys: ['attio/people:J1'], identity_keys: ['email:jane@acme.com'], sources: { 'attio/people:J1': { last_synced_at: now } } });
    await backend.upsertByKeys({ type: 'gmail/gmailThreads', data: { subject: 'Q2 pricing' }, keys: ['gmail/gmailThreads:T1'], identity_keys: ['email:jane@acme.com', 'email:bob@acme.com'], sources: { 'gmail/gmailThreads:T1': { last_synced_at: now } } });
    await backend.upsertByKeys({ type: 'gmail/gmailThreads', data: { subject: 'intro' }, keys: ['gmail/gmailThreads:T2'], identity_keys: ['email:jane@acme.com'], sources: { 'gmail/gmailThreads:T2': { last_synced_at: now } } });
  });

  after(async () => {
    const backend = await getBackend();
    await backend.close();
    resetBackendSingleton();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('groups records by type with counts (single key)', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', undefined, {}));
    assert.deepEqual(out.keys, ['email:jane@acme.com']);
    assert.equal(out.total, 3);
    assert.equal(out.byType['attio/people'].count, 1);
    assert.equal(out.byType['gmail/gmailThreads'].count, 2);
    assert.equal(out.byType['gmail/gmailThreads'].items.length, 2);
  });

  it('--type filters to one record type', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', undefined, { type: 'gmail/gmailThreads' }));
    assert.equal(out.total, 2);
    assert.deepEqual(Object.keys(out.byType), ['gmail/gmailThreads']);
  });

  it('two keys return the intersection', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', 'email:bob@acme.com', {}));
    assert.deepEqual(out.keys, ['email:jane@acme.com', 'email:bob@acme.com']);
    assert.equal(out.total, 1);
    assert.equal(out.byType['gmail/gmailThreads'].count, 1);
  });

  it('--limit caps items shown per type (count stays accurate)', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:jane@acme.com', undefined, { type: 'gmail/gmailThreads', limit: '1' }));
    assert.equal(out.byType['gmail/gmailThreads'].count, 2, 'true count preserved');
    assert.equal(out.byType['gmail/gmailThreads'].items.length, 1, 'items capped by --limit');
  });

  it('returns empty for an unknown key', async () => {
    const out = await runAgent(() => memFindByKeyCommand('email:nobody@nowhere.com', undefined, {}));
    assert.equal(out.total, 0);
    assert.deepEqual(out.byType, {});
  });
});
