import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OneApi, replacePathVariables } from './api.js';
import { AccessDeniedError, checkPassthroughAccess } from './access-gate.js';
import { getAccessControlFromAllSources } from './config.js';
import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';
import type { AccessControlSettings } from './types.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const GET_ACTION = { _id: 'act_get', title: 'List customers', method: 'GET', path: '/v1/customers', tags: [] } as never;
const DELETE_ACTION = { _id: 'act_del', title: 'Delete customer', method: 'DELETE', path: '/v1/customers/{id}', tags: [] } as never;
const DEEP_ACTION = { _id: 'act_deep', title: 'Get record', method: 'GET', path: '/v0/{{baseId}}/{{tableId}}/{{recordId}}', tags: [] } as never;

function capture(): { calls: { url: string; method?: string; headers: Record<string, string> }[] } {
  const calls: { url: string; method?: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls };
}

function api(settings: AccessControlSettings): OneApi {
  return new OneApi('sk_test_k', 'https://api.test/v1', settings);
}

const BASE = { platform: 'stripe', actionId: 'act_get', connectionKey: 'conn_ok' };

describe('checkPassthroughAccess', () => {
  it('allows everything under the default settings', () => {
    checkPassthroughAccess({}, { actionId: 'a', connectionKey: 'c', method: 'DELETE' });
  });

  it('refuses under knowledge-only, outside an allowlist, or above the level', () => {
    const req = { actionId: 'a', connectionKey: 'c', method: 'POST' };
    assert.throws(() => checkPassthroughAccess({ knowledgeAgent: true }, req), AccessDeniedError);
    assert.throws(() => checkPassthroughAccess({ actionIds: ['b'] }, req), /allowed action list/);
    assert.throws(() => checkPassthroughAccess({ connectionKeys: ['d'] }, req), /Connection key "c" is not allowed/);
    assert.throws(() => checkPassthroughAccess({ permissions: 'read' }, req), /"POST" is not allowed under "read"/);
  });

  it('refuses caller copies of the identity headers in any letter case', () => {
    for (const name of ['x-one-connection-key', 'X-One-Action-Id', 'X-ONE-SECRET']) {
      assert.throws(
        () => checkPassthroughAccess({}, { actionId: 'a', connectionKey: 'c', method: 'GET', headers: { [name]: 'other' } }),
        /set by the CLI/,
        name,
      );
    }
  });

  it('judges a method-override header like the method it asks for', () => {
    const req = (value: string) => ({ actionId: 'a', connectionKey: 'c', method: 'GET', headers: { 'X-HTTP-Method-Override': value } });
    assert.throws(() => checkPassthroughAccess({ permissions: 'read' }, req('DELETE')), /asks for a method/);
    assert.throws(() => checkPassthroughAccess({ permissions: 'write' }, req('delete')), /asks for a method/);
    checkPassthroughAccess({ permissions: 'write' }, req('PATCH'));
    checkPassthroughAccess({ permissions: 'admin' }, req('DELETE'));
  });
});

describe('OneApi.executePassthroughRequest gate', () => {
  it('sends nothing when the settings refuse the call', async () => {
    const { calls } = capture();
    const cases: [AccessControlSettings, object, unknown][] = [
      [{ knowledgeAgent: true }, BASE, GET_ACTION],
      [{ connectionKeys: ['conn_other'] }, BASE, GET_ACTION],
      [{ actionIds: ['act_other'] }, BASE, GET_ACTION],
      [{ permissions: 'write' }, { ...BASE, actionId: 'act_del', pathVariables: { id: '1' } }, DELETE_ACTION],
      [{ permissions: 'read' }, { ...BASE, headers: { 'x-http-method-override': 'DELETE' } }, GET_ACTION],
      [{ connectionKeys: ['conn_ok'] }, { ...BASE, headers: { 'x-one-connection-key': 'conn_denied' } }, GET_ACTION],
      [{ actionIds: ['act_get'] }, { ...BASE, headers: { 'x-one-action-id': 'act_denied' } }, GET_ACTION],
    ];
    for (const [settings, args, action] of cases) {
      await assert.rejects(api(settings).executePassthroughRequest(args as never, action as never), AccessDeniedError, JSON.stringify(settings));
    }
    assert.equal(calls.length, 0);
  });

  it('refuses a dry run the settings would refuse', async () => {
    await assert.rejects(
      api({ knowledgeAgent: true }).executePassthroughRequest({ ...BASE, dryRun: true }, GET_ACTION),
      AccessDeniedError,
    );
  });

  it('sends the approved identity when the call is allowed', async () => {
    const { calls } = capture();
    await api({ permissions: 'read', connectionKeys: ['conn_ok'], actionIds: ['act_get'] }).executePassthroughRequest(
      { ...BASE, headers: { 'x-custom': 'kept' } },
      GET_ACTION,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.test/v1/passthrough/v1/customers');
    assert.equal(calls[0].headers['x-one-connection-key'], 'conn_ok');
    assert.equal(calls[0].headers['x-one-action-id'], 'act_get');
    assert.equal(calls[0].headers['x-one-secret'], 'sk_test_k');
    assert.equal(calls[0].headers['x-custom'], 'kept');
  });

  it('reads the settings from config when none are passed', async () => {
    const home = withTempHome();
    home.setup();
    try {
      assertHomeIsSandboxed();
      fs.writeFileSync(
        path.join(home.oneDir, 'config.json'),
        JSON.stringify({ apiKey: 'sk_test_x', installedAgents: [], createdAt: 'now', accessControl: { connectionKeys: ['conn_other'] } }),
      );
      const { calls } = capture();
      await assert.rejects(new OneApi('sk_test_k', 'https://api.test/v1').executePassthroughRequest(BASE, GET_ACTION), AccessDeniedError);
      assert.equal(calls.length, 0);
    } finally {
      home.teardown();
    }
  });
});

describe('action paths stay on /v1/passthrough', () => {
  it('refuses . and .. as a path variable', () => {
    assert.throws(() => replacePathVariables('/v0/{{baseId}}', { baseId: '..' }), /cannot be "\.\."/);
    assert.throws(() => replacePathVariables('/v0/{baseId}', { baseId: '.' }), /cannot be "\."/);
    assert.equal(replacePathVariables('/v0/{{baseId}}', { baseId: '..x' }), '/v0/..x');
    assert.equal(replacePathVariables('/v0/{{baseId}}', { baseId: 'a/../b' }), '/v0/a%2F..%2Fb');
  });

  it('never sends a request whose path leaves the passthrough route', async () => {
    const { calls } = capture();
    await assert.rejects(
      api({}).executePassthroughRequest(
        { ...BASE, actionId: 'act_deep', pathVariables: { baseId: '..', tableId: '..', recordId: 'connections' } },
        DEEP_ACTION,
      ),
      /cannot be "\.\."/,
    );
    const escaping = { ...(GET_ACTION as object), path: '/../../connections' } as never;
    await assert.rejects(api({}).executePassthroughRequest(BASE, escaping), /resolves outside \/v1\/passthrough/);
    assert.equal(calls.length, 0);
  });
});

describe('.onerc can only narrow the access settings', () => {
  const home = withTempHome();
  let cwd: string;
  let project: string;
  const write = process.stderr.write;
  beforeEach(() => {
    home.setup();
    cwd = process.cwd();
    project = path.join(home.dir, 'proj');
    fs.mkdirSync(project);
    process.chdir(project);
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = write;
    process.chdir(cwd);
    home.teardown();
  });

  function setConfig(accessControl: AccessControlSettings): void {
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk_test_x', installedAgents: [], createdAt: 'now', accessControl }),
    );
  }
  function setRc(lines: string[]): void {
    fs.writeFileSync(path.join(project, '.onerc'), lines.join('\n') + '\n');
  }

  it('cannot widen a restricted config', () => {
    assertHomeIsSandboxed();
    setConfig({ permissions: 'read', connectionKeys: ['conn_a'], actionIds: ['act_a'], knowledgeAgent: true });
    setRc(['ONE_PERMISSIONS=admin', 'ONE_CONNECTION_KEYS=*', 'ONE_ACTION_IDS=*', 'ONE_KNOWLEDGE_AGENT=false']);
    assert.deepEqual(getAccessControlFromAllSources(), {
      permissions: 'read',
      connectionKeys: ['conn_a'],
      actionIds: ['act_a'],
      knowledgeAgent: true,
    });
  });

  it('keeps only allowlist entries the config also allows', () => {
    assertHomeIsSandboxed();
    setConfig({ connectionKeys: ['conn_a', 'conn_b'] });
    setRc(['ONE_CONNECTION_KEYS=conn_b,conn_c']);
    assert.deepEqual(getAccessControlFromAllSources().connectionKeys, ['conn_b']);
  });

  it('can tighten an unrestricted config', () => {
    assertHomeIsSandboxed();
    setConfig({});
    setRc(['ONE_PERMISSIONS=write', 'ONE_CONNECTION_KEYS=conn_a', 'ONE_ACTION_IDS=act_a', 'ONE_KNOWLEDGE_AGENT=true']);
    assert.deepEqual(getAccessControlFromAllSources(), {
      permissions: 'write',
      connectionKeys: ['conn_a'],
      actionIds: ['act_a'],
      knowledgeAgent: true,
    });
  });

  it('ignores an unknown permission level', () => {
    assertHomeIsSandboxed();
    setConfig({ permissions: 'write' });
    setRc(['ONE_PERMISSIONS=root']);
    assert.equal(getAccessControlFromAllSources().permissions, 'write');
  });
});
