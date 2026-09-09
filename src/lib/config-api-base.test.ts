import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getApiBase } from './config.js';
import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';

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
});
