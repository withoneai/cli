import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from 'commander';

import { program } from '../../../cli.js';
import { resolveSyncEmbed } from './mem-writer.js';
import type { SyncProfile } from './types.js';

// `sync run` registered `--embed` with a default of `false`, so commander
// always handed the runner `embed: false` when neither flag was passed. That
// "override" beat the profile's `memory.embed`, and `deriveEmbedFlag` turned
// a missing `memory.embed` into an explicit `false`, so `defaults.embedOnSync`
// was never read either. A profile with `memory.embed: true` only embedded
// when `--embed` was passed by hand.

function sub(parent: Command, name: string): Command {
  const found = parent.commands.find(c => c.name() === name);
  assert.ok(found, `expected a "${name}" command`);
  return found;
}

const profile = (memory?: SyncProfile['memory']): SyncProfile =>
  ({ platform: 'stripe', model: 'customers', ...(memory ? { memory } : {}) }) as SyncProfile;

describe('sync run embedding precedence', () => {
  it('leaves `embed` undefined when neither --embed nor --no-embed is passed', () => {
    const run = sub(sub(program, 'sync'), 'run');
    const embed = run.options.find(o => o.long === '--embed');
    assert.ok(embed);
    assert.equal(embed.defaultValue, undefined);
  });

  it("uses the profile's memory.embed when no flag overrides it", () => {
    assert.equal(resolveSyncEmbed(undefined, profile({ embed: true } as SyncProfile['memory'])), true);
    assert.equal(resolveSyncEmbed(undefined, profile({ embed: false } as SyncProfile['memory'])), false);
  });

  it('defers to defaults.embedOnSync when the profile does not say', () => {
    assert.equal(resolveSyncEmbed(undefined, profile()), undefined);
  });

  it('lets --embed / --no-embed win over the profile', () => {
    assert.equal(resolveSyncEmbed(true, profile({ embed: false } as SyncProfile['memory'])), true);
    assert.equal(resolveSyncEmbed(false, profile({ embed: true } as SyncProfile['memory'])), false);
  });
});
