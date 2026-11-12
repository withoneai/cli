import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getApiBase, getWhoAmI, updateWhoAmI } from './config.js';
import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';
import type { WhoAmIResponse } from './types.js';

const WHOAMI: WhoAmIResponse = {
  user: { id: 'u1', name: 'Jane', email: 'jane@example.com' },
  organization: { id: 'org1', name: 'Acme' },
  project: { id: 'p1', name: 'Site' },
};

describe('getApiBase', () => {
  const home = withTempHome();
  let savedEnv: string | undefined;
  beforeEach(() => {
    home.setup();
    savedEnv = process.env.ONE_API_BASE;
    delete process.env.ONE_API_BASE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ONE_API_BASE;
    else process.env.ONE_API_BASE = savedEnv;
    home.teardown();
  });

  it('defaults to the hosted API', () => {
    assertHomeIsSandboxed();
    assert.equal(getApiBase(), 'https://api.withone.ai/v1');
  });

  it('uses the configured apiBase and appends /v1', () => {
    assertHomeIsSandboxed();
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk_test_x', installedAgents: [], createdAt: 'now', apiBase: 'http://localhost:5005' }),
    );
    assert.equal(getApiBase(), 'http://localhost:5005/v1');
  });

  it('lets ONE_API_BASE override the config, tolerating a trailing slash or /v1', () => {
    assertHomeIsSandboxed();
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk_test_x', installedAgents: [], createdAt: 'now', apiBase: 'http://localhost:5005' }),
    );
    process.env.ONE_API_BASE = 'http://localhost:5006/';
    assert.equal(getApiBase(), 'http://localhost:5006/v1');
    process.env.ONE_API_BASE = 'http://localhost:5006/v1';
    assert.equal(getApiBase(), 'http://localhost:5006/v1');
  });

  it('honours ONE_API_BASE from .onerc below the env var and above config', () => {
    assertHomeIsSandboxed();
    const cwd = process.cwd();
    const project = path.join(home.dir, 'proj');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.onerc'), '# local\nONE_API_BASE=https://development-api.withone.ai\n');
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk_test_x', installedAgents: [], createdAt: 'now', apiBase: 'http://localhost:5005' }),
    );
    process.chdir(project);
    try {
      assert.equal(getApiBase(), 'https://development-api.withone.ai/v1');
      process.env.ONE_API_BASE = 'http://localhost:5006';
      assert.equal(getApiBase(), 'http://localhost:5006/v1');
    } finally {
      process.chdir(cwd);
    }
  });

  it('ignores a .onerc ONE_API_BASE that is not a hosted One origin', () => {
    assertHomeIsSandboxed();
    const cwd = process.cwd();
    const project = path.join(home.dir, 'proj');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk_test_x', installedAgents: [], createdAt: 'now', apiBase: 'http://localhost:5005' }),
    );
    const hostile = [
      'https://evil.example',
      'http://api.withone.ai',
      'https://api.withone.ai.evil.example',
      'https://api.withone.ai:8443',
      'https://user@api.withone.ai',
      'https://evil.example/https://api.withone.ai',
      'http://localhost:5005',
      'not a url',
    ];
    process.chdir(project);
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      for (const value of hostile) {
        fs.writeFileSync(path.join(project, '.onerc'), `ONE_API_BASE=${value}\n`);
        assert.equal(getApiBase(), 'http://localhost:5005/v1', value);
      }
      fs.rmSync(path.join(home.oneDir, 'config.json'));
      fs.writeFileSync(path.join(project, '.onerc'), 'ONE_API_BASE=https://evil.example\n');
      assert.equal(getApiBase(), 'https://api.withone.ai/v1');
    } finally {
      process.stderr.write = write;
      process.chdir(cwd);
    }
  });
});

describe('getWhoAmI', () => {
  const home = withTempHome();
  let savedEnv: string | undefined;
  beforeEach(() => {
    home.setup();
    savedEnv = process.env.ONE_API_BASE;
    delete process.env.ONE_API_BASE;
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk_test_x', installedAgents: [], createdAt: 'now', whoami: WHOAMI }),
    );
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.ONE_API_BASE;
    else process.env.ONE_API_BASE = savedEnv;
    home.teardown();
  });

  it('serves a record written before whoamiApiBase existed against the configured base', () => {
    assertHomeIsSandboxed();
    assert.deepEqual(getWhoAmI(), WHOAMI);
  });

  it('withholds the cache while an ONE_API_BASE override points elsewhere, in both directions', () => {
    assertHomeIsSandboxed();
    process.env.ONE_API_BASE = 'http://localhost:5005';
    assert.equal(getWhoAmI(), null, 'hosted record must not serve a local backend');

    const local: WhoAmIResponse = { ...WHOAMI, organization: { id: 'local-org', name: 'Local' } };
    updateWhoAmI(local);
    assert.deepEqual(getWhoAmI(), local);

    delete process.env.ONE_API_BASE;
    assert.equal(getWhoAmI(), null, 'local record must not serve the hosted API');
  });
});
