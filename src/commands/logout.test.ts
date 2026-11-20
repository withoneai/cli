import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from 'commander';

import { program } from '../cli.js';
import { resolveLogoutTargets } from './logout.js';

// `one --agent logout` deleted the project AND the global config with no
// confirmation. Agent mode now needs --force, and clears only the config in
// effect (project if there is one, else global) unless --scope says otherwise.

function sub(parent: Command, name: string): Command {
  const found = parent.commands.find(c => c.name() === name);
  assert.ok(found, `expected a "${name}" command`);
  return found;
}

const P = '/home/u/.one/projects/app/config.json';
const G = '/home/u/.one/config.json';

describe('logout flags', () => {
  it('registers --force and --scope', () => {
    const logout = sub(program, 'logout');
    assert.ok(logout.options.find(o => o.long === '--force'));
    assert.ok(logout.options.find(o => o.long === '--scope'));
  });
});

describe('resolveLogoutTargets', () => {
  it('defaults to the project config when there is one', () => {
    assert.deepEqual(resolveLogoutTargets({ projectPath: P, globalPath: G }), {
      targets: [{ scope: 'project', path: P }],
    });
  });

  it('falls back to the global config', () => {
    assert.deepEqual(resolveLogoutTargets({ projectPath: null, globalPath: G }), {
      targets: [{ scope: 'global', path: G }],
    });
  });

  it('clears both only with --scope both', () => {
    assert.deepEqual(resolveLogoutTargets({ scope: 'both', projectPath: P, globalPath: G }), {
      targets: [{ scope: 'project', path: P }, { scope: 'global', path: G }],
    });
  });

  it('honours an explicit --scope global even when a project config exists', () => {
    assert.deepEqual(resolveLogoutTargets({ scope: 'global', projectPath: P, globalPath: G }), {
      targets: [{ scope: 'global', path: G }],
    });
  });

  it('errors when the requested scope has no config file', () => {
    const r = resolveLogoutTargets({ scope: 'project', projectPath: null, globalPath: G });
    assert.ok('error' in r);
  });

  it('errors on an unknown scope', () => {
    const r = resolveLogoutTargets({ scope: 'everything', projectPath: P, globalPath: G });
    assert.ok('error' in r);
  });

  it('returns no targets when there is no config file at all', () => {
    assert.deepEqual(resolveLogoutTargets({ projectPath: null, globalPath: null }), { targets: [] });
  });
});
