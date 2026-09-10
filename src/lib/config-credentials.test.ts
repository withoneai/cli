import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getProjectConfigPath,
  readGlobalConfig,
  readProjectConfig,
  saveCredentials,
} from './config.js';
import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';
import type { WhoAmIResponse } from './types.js';

const WHOAMI: WhoAmIResponse = {
  user: { id: 'u1', name: 'Jane', email: 'jane@example.com' },
  organization: null,
  project: null,
};

describe('saveCredentials', () => {
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

  it('keeps every unrelated field of the existing config and replaces the key, its name and whoami', () => {
    assertHomeIsSandboxed();
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({
        apiKey: 'sk_live_old',
        apiKeyName: 'old key',
        openaiApiKey: 'sk-openai',
        installedAgents: ['claude-code'],
        createdAt: '2026-01-01T00:00:00.000Z',
        accessControl: { permissions: 'read' },
        cacheTtl: 120,
        apiBase: 'http://localhost:5005',
        memory: { provider: 'postgres' },
        telemetry: 'off',
        whoami: { ...WHOAMI, user: { ...WHOAMI.user, id: 'stale' } },
      }),
    );

    saveCredentials('sk_live_new', 'global', { keyName: 'CLI · acme', whoami: WHOAMI });

    const config = readGlobalConfig();
    assert.ok(config);
    assert.equal(config.apiKey, 'sk_live_new');
    assert.equal(config.apiKeyName, 'CLI · acme');
    assert.deepEqual(config.whoami, WHOAMI);
    assert.equal(config.whoamiApiBase, 'http://localhost:5005/v1');
    assert.equal(config.openaiApiKey, 'sk-openai');
    assert.deepEqual(config.installedAgents, ['claude-code']);
    assert.equal(config.createdAt, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(config.accessControl, { permissions: 'read' });
    assert.equal(config.cacheTtl, 120);
    assert.equal(config.apiBase, 'http://localhost:5005');
    assert.deepEqual(config.memory, { provider: 'postgres' });
    assert.equal(config.telemetry, 'off');
  });

  it('drops the previous name when the new key has none, and starts a fresh file when none exists', () => {
    assertHomeIsSandboxed();
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk_live_old', apiKeyName: 'old key', installedAgents: [], createdAt: 'then' }),
    );
    saveCredentials('sk_live_pasted', 'global', { whoami: WHOAMI });
    const replaced = readGlobalConfig();
    assert.equal(replaced?.apiKey, 'sk_live_pasted');
    assert.equal('apiKeyName' in (replaced ?? {}), false);

    fs.unlinkSync(path.join(home.oneDir, 'config.json'));
    saveCredentials('sk_live_first', 'global', { whoami: WHOAMI });
    const fresh = readGlobalConfig();
    assert.equal(fresh?.apiKey, 'sk_live_first');
    assert.deepEqual(fresh?.installedAgents, []);
    assert.ok(fresh?.createdAt);
  });

  it('writes the requested scope even when a project config exists for cwd', () => {
    assertHomeIsSandboxed();
    const projectPath = getProjectConfigPath();
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(
      projectPath,
      JSON.stringify({ apiKey: 'sk_live_project', apiKeyName: 'project key', installedAgents: [], createdAt: 'then' }),
    );

    saveCredentials('sk_live_global', 'global', { keyName: 'global key', whoami: WHOAMI });

    assert.equal(readGlobalConfig()?.apiKey, 'sk_live_global');
    assert.equal(readGlobalConfig()?.apiKeyName, 'global key');
    assert.equal(readProjectConfig()?.apiKey, 'sk_live_project', 'project config is untouched');
  });
});
