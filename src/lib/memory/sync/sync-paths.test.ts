import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireSyncLock, SyncLockError } from './lock.js';
import { listProfiles, readProfile } from './profile.js';
import { fireHooks, type ChangeEvent } from './hooks.js';
import { isSafeSyncName } from './names.js';

// Each test runs in <tmp>/project with a sibling <tmp>/victim that must
// survive whatever a hostile profile tries.
let origCwd: string;
let tmp: string;
let project: string;
let victim: string;

const OLD = new Date(Date.now() - 2 * 60 * 60 * 1000); // older than the 30 min stale window

beforeEach(() => {
  origCwd = process.cwd();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-sync-paths-')));
  project = path.join(tmp, 'project');
  victim = path.join(tmp, 'victim');
  fs.mkdirSync(project);
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'important');
  fs.utimesSync(victim, OLD, OLD);
  process.chdir(project);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function victimIntact(): boolean {
  return fs.existsSync(path.join(victim, 'keep.txt'));
}

describe('sync name validation', () => {
  it('accepts every built-in style name and rejects path-like ones', () => {
    for (const ok of ['gmail', 'google-calendar', 'threads', 'events.v2', 'Contacts_1']) {
      assert.ok(isSafeSyncName(ok), ok);
    }
    for (const bad of ['', '..', '../victim', 'a/b', 'a\\b', '.hidden', '-x', 'a..b', 42, null]) {
      assert.ok(!isSafeSyncName(bad), String(bad));
    }
  });
});

describe('sync lock paths', () => {
  it('rejects a model with .. before touching the filesystem outside the project', () => {
    assert.throws(() => acquireSyncLock('gmail', '../../../../../../victim'), SyncLockError);
    assert.ok(victimIntact());
  });

  it('refuses a locks directory that is a symlink out of the project', () => {
    fs.mkdirSync(path.join('.one', 'sync'), { recursive: true });
    fs.symlinkSync(victim, path.join('.one', 'sync', 'locks'), 'dir');
    fs.mkdirSync(path.join(victim, 'gmail_threads'));
    fs.writeFileSync(path.join(victim, 'gmail_threads', 'data'), 'x');
    fs.utimesSync(path.join(victim, 'gmail_threads'), OLD, OLD);
    assert.throws(() => acquireSyncLock('gmail', 'threads'), /outside the project/);
    assert.ok(fs.existsSync(path.join(victim, 'gmail_threads', 'data')));
  });

  it('will not take over a stale path that is not a lock directory', () => {
    const dir = path.join('.one', 'sync', 'locks', 'gmail_threads');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a lock');
    fs.utimesSync(dir, OLD, OLD);
    assert.throws(() => acquireSyncLock('gmail', 'threads'), /not a sync lock/);
    assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
  });

  it('will not take over a symlink sitting where the lock should be', () => {
    fs.mkdirSync(path.join('.one', 'sync', 'locks'), { recursive: true });
    fs.symlinkSync(victim, path.join('.one', 'sync', 'locks', 'gmail_threads'), 'dir');
    assert.throws(() => acquireSyncLock('gmail', 'threads'), SyncLockError);
    assert.ok(victimIntact());
  });

  it('still acquires, releases and takes over a real stale lock', () => {
    const lock = acquireSyncLock('gmail', 'threads');
    const dir = path.join('.one', 'sync', 'locks', 'gmail_threads');
    assert.ok(fs.existsSync(path.join(dir, 'pid')));
    assert.throws(() => acquireSyncLock('gmail', 'threads'), /already running/);
    lock.release();
    assert.ok(!fs.existsSync(dir));

    // A crashed owner: pid file naming a dead process, old mtime.
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'pid'), '999999999');
    fs.utimesSync(dir, OLD, OLD);
    const taken = acquireSyncLock('gmail', 'threads');
    assert.equal(fs.readFileSync(path.join(dir, 'pid'), 'utf-8'), String(process.pid));
    taken.release();
    assert.ok(!fs.existsSync(dir));
  });
});

describe('sync profiles with unsafe names', () => {
  function writeRaw(file: string, body: object): void {
    const dir = path.join('.one', 'sync', 'profiles');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(body));
  }

  it('listProfiles skips a profile whose model escapes the sync directory', () => {
    writeRaw('gmail_evil.json', { platform: 'gmail', model: '../../../victim', actionId: 'x' });
    writeRaw('gmail_threads.json', { platform: 'gmail', model: 'threads', actionId: 'x' });
    const models = listProfiles('gmail').map(p => p.model);
    assert.deepEqual(models, ['threads']);
  });

  it('readProfile ignores a file whose inner model is unsafe', () => {
    writeRaw('gmail_threads.json', { platform: 'gmail', model: '../victim', actionId: 'x' });
    assert.equal(readProfile('gmail', 'threads'), null);
  });

  it('readProfile rejects an unsafe requested name', () => {
    assert.throws(() => readProfile('gmail', '../x'), /Invalid sync model name/);
  });
});

describe('sync event log paths', () => {
  const event = (model: string): ChangeEvent => ({
    type: 'insert', platform: 'gmail', model, record: { id: '1' },
  } as unknown as ChangeEvent);

  it('refuses to build an event-log path from an unsafe model', async () => {
    await assert.rejects(() => fireHooks('log', [event('../../../../../../victim/x')]));
    assert.deepEqual(fs.readdirSync(victim), ['keep.txt']);
  });

  it('refuses to append through a symlinked log file', async () => {
    const dir = path.join('.one', 'sync', 'events');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(victim, 'keep.txt'), path.join(dir, 'gmail_threads.jsonl'));
    await assert.rejects(() => fireHooks('log', [event('threads')]), /symlink/);
    assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf-8'), 'important');
  });

  it('still appends a normal event log', async () => {
    await fireHooks('log', [event('threads')]);
    const log = fs.readFileSync(path.join('.one', 'sync', 'events', 'gmail_threads.jsonl'), 'utf-8');
    assert.equal(log.trim().split('\n').length, 1);
  });
});
