import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';

import { program } from '../../../cli.js';
import { existingProfileGuard } from './index.js';

// `sync init <p> <m>` without --config wrote a fresh draft over an existing
// profile, silently dropping connection.tag, memory settings and hooks. Now it
// refuses unless --force (re-seed) or --config (merge) is passed.

function sub(parent: Command, name: string): Command {
  const found = parent.commands.find(c => c.name() === name);
  assert.ok(found, `expected a "${name}" command`);
  return found;
}

describe('sync init overwrite guard', () => {
  let dir: string;
  let prevCwd: string;
  before(() => {
    prevCwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-init-guard-'));
    process.chdir(dir);
  });
  after(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers --force on sync init', () => {
    const init = sub(sub(program, 'sync'), 'init');
    assert.ok(init.options.find(o => o.long === '--force'));
  });

  it('allows init when no profile exists', () => {
    assert.equal(existingProfileGuard('stripe', 'customers', {}), null);
  });

  describe('with an existing profile', () => {
    before(() => {
      fs.mkdirSync(path.join('.one', 'sync', 'profiles'), { recursive: true });
      fs.writeFileSync(
        path.join('.one', 'sync', 'profiles', 'stripe_customers.json'),
        JSON.stringify({ platform: 'stripe', model: 'customers', connection: { platform: 'stripe', tag: 'eu' } }),
      );
    });

    it('refuses without --force or --config', () => {
      const refusal = existingProfileGuard('stripe', 'customers', {});
      assert.ok(refusal);
      assert.match(refusal.profilePath, /stripe_customers\.json$/);
      assert.match(refusal._hint, /--force/);
      assert.match(refusal._hint, /--config/);
    });

    it('allows --force (re-seed) and --config (merge)', () => {
      assert.equal(existingProfileGuard('stripe', 'customers', { force: true }), null);
      assert.equal(existingProfileGuard('stripe', 'customers', { config: '{}' }), null);
    });

    it('treats an unreadable profile file as existing', () => {
      fs.writeFileSync(path.join('.one', 'sync', 'profiles', 'stripe_charges.json'), '{not json');
      assert.ok(existingProfileGuard('stripe', 'charges', {}));
    });
  });
});
