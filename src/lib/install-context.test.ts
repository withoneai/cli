import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  collectInstallContext,
  describeInstallContext,
  detectInstalledHarnesses,
  detectLauncher,
  installContextToParams,
} from './install-context.js';
import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';

// Every call passes an explicit `env` — the process running this suite may
// itself be launched by an agent (CLAUDECODE=1 is set under Claude Code),
// which would leak into the launcher detection.
const NO_ENV: NodeJS.ProcessEnv = {};

describe('detectLauncher', () => {
  it('maps agent env markers to harness ids, most specific first', () => {
    assert.equal(detectLauncher({ CLAUDECODE: '1' }), 'claude-code');
    assert.equal(detectLauncher({ CLAUDE_CODE_ENTRYPOINT: 'cli' }), 'claude-code');
    assert.equal(detectLauncher({ CODEX_SANDBOX: 'seatbelt' }), 'codex');
    assert.equal(detectLauncher({ GEMINI_CLI: '1' }), 'gemini-cli');
    assert.equal(detectLauncher({ CURSOR_AGENT: '1' }), 'cursor');
  });

  it('returns undefined for a plain shell', () => {
    assert.equal(detectLauncher(NO_ENV), undefined);
    assert.equal(detectLauncher({ TERM_PROGRAM: 'iTerm.app' }), undefined);
  });

  it("ignores Cursor's editor-terminal marker, which is not an agent", () => {
    assert.equal(detectLauncher({ TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'c0ffee' }), undefined);
  });
});

describe('detectInstalledHarnesses', () => {
  const home = withTempHome();
  beforeEach(() => home.setup());
  afterEach(() => home.teardown());

  it('reports agents from the registry and the extra harness dirs, sorted and unique', () => {
    assertHomeIsSandboxed();
    fs.mkdirSync(path.join(home.dir, '.claude'));
    fs.mkdirSync(path.join(home.dir, '.gemini'));
    assert.deepEqual(detectInstalledHarnesses(), ['claude-code', 'gemini-cli']);
  });

  it('is empty on a bare machine', () => {
    assertHomeIsSandboxed();
    assert.deepEqual(detectInstalledHarnesses(), []);
  });
});

// Telemetry opt-out signals decide whether a device id is sent, and CI sets
// one of them; each test states the telemetry state it wants.
const TELEMETRY_VARS = ['ONE_NO_TELEMETRY', 'ONE_DISABLE_TELEMETRY', 'DO_NOT_TRACK', 'CI'] as const;

describe('collectInstallContext', () => {
  const home = withTempHome();
  const savedTelemetry: Partial<Record<(typeof TELEMETRY_VARS)[number], string | undefined>> = {};
  beforeEach(() => {
    home.setup();
    for (const v of TELEMETRY_VARS) {
      savedTelemetry[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of TELEMETRY_VARS) {
      if (savedTelemetry[v] === undefined) delete process.env[v];
      else process.env[v] = savedTelemetry[v];
    }
    home.teardown();
  });

  it('omits the path for global scope and includes it for project scope', () => {
    assertHomeIsSandboxed();
    const global = collectInstallContext({ scope: 'global', projectRoot: '/tmp/acme', env: NO_ENV });
    assert.equal(global.scope, 'global');
    assert.equal(global.path, undefined);

    const project = collectInstallContext({ scope: 'project', projectRoot: '/tmp/acme', env: NO_ENV });
    assert.equal(project.scope, 'project');
    assert.equal(project.path, '/tmp/acme');
  });

  it('fills machine facts, the CLI version and a stable device id', () => {
    assertHomeIsSandboxed();
    const a = collectInstallContext({ scope: 'global', env: NO_ENV });
    const b = collectInstallContext({ scope: 'global', env: NO_ENV });
    assert.ok(a.host && a.host.length > 0, 'host');
    assert.equal(a.os, process.platform);
    assert.equal(a.arch, process.arch);
    assert.ok(a.osVersion && a.osVersion.length > 0, 'osVersion');
    // os.userInfo() throws for a uid with no passwd entry; the field is best-effort.
    assert.ok(a.user === undefined || a.user.length > 0, 'user');
    assert.match(a.device ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(a.device, b.device, 'device id is stable across calls');
    assert.match(a.cli ?? '', /^\d+\.\d+\.\d+/);
    assert.deepEqual(a.harnesses, []);
    assert.equal(a.launcher, undefined);
  });

  it('sends no device id, and mints none, when telemetry is opted out', () => {
    assertHomeIsSandboxed();
    process.env.DO_NOT_TRACK = '1';
    const ctx = collectInstallContext({ scope: 'global', env: NO_ENV });
    assert.equal(ctx.device, undefined);
    assert.equal(fs.existsSync(path.join(home.oneDir, 'device-id')), false, 'device-id file must not be created');
  });

  it('records the launching agent from env', () => {
    assertHomeIsSandboxed();
    const ctx = collectInstallContext({ scope: 'global', env: { CLAUDECODE: '1' } });
    assert.equal(ctx.launcher, 'claude-code');
  });
});

describe('installContextToParams', () => {
  it('encodes every present field under the documented names and skips absent ones', () => {
    const params = installContextToParams({
      scope: 'project',
      path: '/Users/paul/dev/acme app',
      host: 'Pauls-MBP.local',
      os: 'darwin',
      osVersion: '25.2.0',
      arch: 'arm64',
      user: 'paul',
      device: '6f1c0b1e-1111-4222-8333-944444444444',
      cli: '1.56.0',
      harnesses: ['claude-code', 'cursor'],
      launcher: 'claude-code',
    });
    const roundTrip = new URLSearchParams(params.toString());
    assert.equal(roundTrip.get('scope'), 'project');
    assert.equal(roundTrip.get('path'), '/Users/paul/dev/acme app');
    assert.equal(roundTrip.get('host'), 'Pauls-MBP.local');
    assert.equal(roundTrip.get('os'), 'darwin');
    assert.equal(roundTrip.get('osv'), '25.2.0');
    assert.equal(roundTrip.get('arch'), 'arm64');
    assert.equal(roundTrip.get('user'), 'paul');
    assert.equal(roundTrip.get('device'), '6f1c0b1e-1111-4222-8333-944444444444');
    assert.equal(roundTrip.get('cli'), '1.56.0');
    assert.equal(roundTrip.get('harnesses'), 'claude-code,cursor');
    assert.equal(roundTrip.get('launcher'), 'claude-code');
  });

  it('leaves out undefined fields and an empty harness list', () => {
    const params = installContextToParams({ scope: 'global', harnesses: [] });
    assert.equal(params.toString(), 'scope=global');
  });
});

describe('describeInstallContext', () => {
  it('summarizes what the consent page will record, one fact per line', () => {
    const text = describeInstallContext({
      scope: 'project',
      path: '/tmp/acme',
      host: 'box',
      os: 'linux',
      osVersion: '6.1',
      arch: 'x64',
      user: 'jane',
      cli: '1.56.0',
      harnesses: ['codex'],
    });
    assert.equal(
      text,
      ['scope: project', 'path: /tmp/acme', 'machine: box (linux 6.1, x64)', 'user: jane', 'harnesses: codex', 'cli: 1.56.0'].join('\n'),
    );
  });

  it('discloses the device id when one will be sent', () => {
    const text = describeInstallContext({
      scope: 'global',
      user: 'jane',
      device: '6f1c0b1e-1111-4222-8333-944444444444',
      harnesses: [],
    });
    assert.equal(text, ['scope: global', 'user: jane', 'device: 6f1c0b1e-1111-4222-8333-944444444444'].join('\n'));
  });
});
