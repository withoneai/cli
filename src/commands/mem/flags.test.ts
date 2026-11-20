import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from 'commander';

import { program } from '../../cli.js';
import { addEmbedOption, shouldTrackSearchAccess } from './records.js';

// Commander turns `--no-track` into `track: false` and `--no-embed` into
// `embed: false`. The handlers read `noTrack` / `noEmbed`, which commander
// never sets, so both flags did nothing: searches always bumped access
// counts, and `mem add --no-embed` still embedded under `embedOnAdd`.

function sub(parent: Command, name: string): Command {
  const found = parent.commands.find(c => c.name() === name);
  assert.ok(found, `expected a "${name}" command`);
  return found;
}

const mem = sub(program, 'mem');

function parse(cmdName: string, argv: string[]): Record<string, unknown> {
  const cmd = sub(mem, cmdName);
  // Reset option values from any earlier parse, then parse flags only.
  for (const o of cmd.options) cmd.setOptionValue(o.attributeName(), o.defaultValue);
  cmd.parseOptions(argv);
  return cmd.opts();
}

describe('mem search --no-track', () => {
  it('tracks access by default when the config says so', () => {
    assert.equal(shouldTrackSearchAccess(parse('search', []), true), true);
  });
  it('does not track when --no-track is passed', () => {
    assert.equal(shouldTrackSearchAccess(parse('search', ['--no-track']), true), false);
  });
  it('never tracks when the config default is off', () => {
    assert.equal(shouldTrackSearchAccess(parse('search', []), false), false);
  });
});

describe('mem add --embed / --no-embed', () => {
  it('defers to defaults.embedOnAdd with no flag', () => {
    assert.deepEqual(addEmbedOption(parse('add', [])), {});
  });
  it('forces embedding with --embed', () => {
    assert.deepEqual(addEmbedOption(parse('add', ['--embed'])), { embed: true });
  });
  it('skips embedding with --no-embed', () => {
    assert.deepEqual(addEmbedOption(parse('add', ['--no-embed'])), { embed: false });
  });
});
