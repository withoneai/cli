import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fitSpinnerMessage, silenceWarningsInAgentMode } from './output.js';

// #88: in --agent mode, process warnings (e.g. Node's experimental-feature
// warnings) must not be emitted, so they can't interleave with the JSON a
// machine consumer parses off stdout/stderr.

describe('silenceWarningsInAgentMode (#88)', () => {
  let origArgv: string[];
  let origAgentEnv: string | undefined;
  let origNoWarn: string | undefined;
  let origEmit: typeof process.emitWarning;

  beforeEach(() => {
    origArgv = process.argv;
    origAgentEnv = process.env.ONE_AGENT;
    origNoWarn = process.env.NODE_NO_WARNINGS;
    origEmit = process.emitWarning;
    delete process.env.ONE_AGENT;
    delete process.env.NODE_NO_WARNINGS;
  });

  afterEach(() => {
    process.argv = origArgv;
    if (origAgentEnv === undefined) delete process.env.ONE_AGENT; else process.env.ONE_AGENT = origAgentEnv;
    if (origNoWarn === undefined) delete process.env.NODE_NO_WARNINGS; else process.env.NODE_NO_WARNINGS = origNoWarn;
    process.emitWarning = origEmit;
  });

  it('is a no-op in human mode — warnings still fire', () => {
    process.argv = ['node', 'one', 'actions', 'search', 'gmail', 'x'];
    silenceWarningsInAgentMode();
    assert.equal(process.emitWarning, origEmit, 'emitWarning must be untouched in human mode');
    assert.equal(process.env.NODE_NO_WARNINGS, undefined);
  });

  it('suppresses emitWarning when --agent is in argv', () => {
    process.argv = ['node', 'one', '--agent', 'actions', 'execute', 'x', 'y', 'z'];
    let fired = false;
    process.on('warning', () => { fired = true; });
    silenceWarningsInAgentMode();
    process.emitWarning('Fetch API is an experimental feature');
    process.removeAllListeners('warning');
    assert.equal(fired, false, 'no warning should propagate after suppression');
    assert.equal(process.env.NODE_NO_WARNINGS, '1');
  });

  it('suppresses when ONE_AGENT=1 even without the flag', () => {
    process.argv = ['node', 'one', 'actions', 'execute', 'x', 'y', 'z'];
    process.env.ONE_AGENT = '1';
    silenceWarningsInAgentMode();
    assert.notEqual(process.emitWarning, origEmit, 'emitWarning must be replaced under ONE_AGENT=1');
    assert.equal(process.env.NODE_NO_WARNINGS, '1');
  });
});

describe('fitSpinnerMessage', () => {
  it('leaves a message that fits one row alone', () => {
    assert.equal(fitSpinnerMessage('Waiting for browser sign-in (5 min timeout)', 80), 'Waiting for browser sign-in (5 min timeout)');
    assert.equal(fitSpinnerMessage('Loading platforms', undefined), 'Loading platforms');
  });

  it('cuts a message that would wrap, so the whole frame stays on one row', () => {
    const fitted = fitSpinnerMessage('Waiting for browser sign-in (5 min timeout)', 30);
    assert.equal(fitted, 'Waiting for browser sig…');
    assert.ok(Array.from(fitted).length + 6 <= 30);
  });
});

describe('createSpinner without a terminal', () => {
  it('prints the message once instead of a frame per tick', () => {
    const script = `
      import { createSpinner } from ${JSON.stringify(new URL('./output.ts', import.meta.url).href)};
      const spin = createSpinner();
      spin.start('Waiting for browser sign-in (5 min timeout)');
      setTimeout(() => spin.stop('Authentication received!'), 400);
    `;
    const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, ONE_AGENT: '' },
    });
    assert.equal(out.split('Waiting for browser sign-in').length - 1, 1);
    assert.ok(out.includes('Authentication received!'));
  });
});
