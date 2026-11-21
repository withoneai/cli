import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OneApi } from './api.js';
import { checkPassthroughAccess } from './access-gate.js';
import { grantAccessDocument, serverEnvelope } from './access.js';
import { getConnectUserId, getWhoAmI, updateWhoAmI } from './config.js';
import { withTempHome, assertHomeIsSandboxed } from '../test-support/home.js';
import type { ReachableConnection, WhoAmIResponse } from './types.js';

const CONNECT_USER = `cu_${'a'.repeat(64)}`;
const realFetch = globalThis.fetch;
const action = { _id: 'conn_mod_def::1', title: 'List customers', method: 'GET', path: '/v1/customers', tags: [] } as never;

function serve(bodies: Record<string, unknown> = {}): { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const body = Object.entries(bodies).find(([prefix]) => String(url).includes(prefix))?.[1] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls };
}

afterEach(() => { globalThis.fetch = realFetch; });

describe('OneApi under a Connect grant', () => {
  it('sends the Connect user beside the key on API, knowledge and passthrough calls', async () => {
    const { calls } = serve({ '/knowledge': { rows: [action] } });
    const api = new OneApi('sk_live_connect', 'https://api.test/v1', {}, CONNECT_USER);
    await api.whoami();
    await api.getActionDetailsWithMeta('conn_mod_def::1');
    await api.executePassthroughRequest({ platform: 'stripe', actionId: 'conn_mod_def::1', connectionKey: 'live::stripe::default::s' }, action);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.headers['x-one-secret'], 'sk_live_connect');
      assert.equal(call.headers['x-one-connect-user-id'], CONNECT_USER);
    }
  });

  it('sends no Connect user for an ordinary key', async () => {
    const { calls } = serve();
    await new OneApi('sk_live_k', 'https://api.test/v1', {}, null).whoami();
    assert.equal(calls[0].headers['x-one-connect-user-id'], undefined);
  });

  it('lists the connections the grant reaches, every page, rather than the vault', async () => {
    const pages: Record<string, unknown> = {
      'reachable?page=1': { rows: [{ key: 'live::gmail::default::g', platform: 'gmail', name: 'Work', access: { policy: 'full' } }], pages: 2 },
      'reachable?page=2': { rows: [{ key: 'live::slack::default::s', platform: 'slack', access: { policy: 'full' } }], pages: 2 },
    };
    const { calls } = serve(pages);
    const connections = await new OneApi('sk_live_connect', 'https://api.test/v1', {}, CONNECT_USER).listConnections();
    assert.deepEqual(calls.map(c => new URL(c.url).pathname), ['/v1/connections/reachable', '/v1/connections/reachable']);
    assert.deepEqual(connections, [
      { id: 'live::gmail::default::g', platform: 'gmail', key: 'live::gmail::default::g', state: 'unknown', name: 'Work' },
      { id: 'live::slack::default::s', platform: 'slack', key: 'live::slack::default::s', state: 'unknown' },
    ]);
  });

  it('refuses a caller-supplied Connect user on a passthrough call', () => {
    assert.throws(
      () => checkPassthroughAccess({}, { actionId: 'a', connectionKey: 'k', method: 'GET', headers: { 'X-One-Connect-User-Id': CONNECT_USER } }),
      /is set by the CLI and cannot be passed/,
    );
  });
});

describe('grantAccessDocument', () => {
  const reachable: ReachableConnection[] = [
    { key: 'full', platform: 'gmail', access: { policy: 'full' } },
    { key: 'reads', platform: 'slack', access: { policy: 'methods', methods: ['GET'], access: ['read'] } },
    { key: 'listed', platform: 'linear', access: { policy: 'actions', actions: [{ actionId: 'conn_mod_def::x', title: 'List issues', method: 'POST' }] } },
  ];

  it('holds each connection to what the grant confers on it, and reaches nothing else', () => {
    const doc = grantAccessDocument(reachable);
    assert.deepEqual(serverEnvelope(doc, 'full'), { reachable: true, methods: null, actionIds: null });
    assert.deepEqual(serverEnvelope(doc, 'reads'), { reachable: true, methods: ['GET'], actionIds: null });
    assert.deepEqual(serverEnvelope(doc, 'listed'), { reachable: true, methods: null, actionIds: ['conn_mod_def::x'] });
    assert.equal(serverEnvelope(doc, 'other').reachable, false);
  });
});

describe('getConnectUserId and the whoami cache', () => {
  const home = withTempHome();
  const WHOAMI: WhoAmIResponse = { user: { id: 'u1', name: 'Jane', email: 'jane@example.com' } } as WhoAmIResponse;
  let saved: string | undefined;
  beforeEach(() => {
    home.setup();
    saved = process.env.ONE_CONNECT_USER_ID;
    delete process.env.ONE_CONNECT_USER_ID;
    fs.writeFileSync(
      path.join(home.oneDir, 'config.json'),
      JSON.stringify({ apiKey: 'sk_test_x', installedAgents: [], createdAt: 'now', whoami: WHOAMI }),
    );
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ONE_CONNECT_USER_ID;
    else process.env.ONE_CONNECT_USER_ID = saved;
    home.teardown();
  });

  it('reads the env above .onerc', () => {
    assertHomeIsSandboxed();
    const cwd = process.cwd();
    const project = path.join(home.dir, 'proj');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.onerc'), `ONE_CONNECT_USER_ID=${CONNECT_USER}\n`);
    process.chdir(project);
    try {
      assert.equal(getConnectUserId(), CONNECT_USER);
      process.env.ONE_CONNECT_USER_ID = 'cu_env';
      assert.equal(getConnectUserId(), 'cu_env');
    } finally {
      process.chdir(cwd);
    }
  });

  it('serves the cache only to the credential it was fetched for', () => {
    assertHomeIsSandboxed();
    process.env.ONE_CONNECT_USER_ID = CONNECT_USER;
    assert.equal(getWhoAmI(), null, "the key's record must not describe a Connect user");

    const connected: WhoAmIResponse = { user: { id: 'u2', name: 'Sam', email: 'sam@example.com' } } as WhoAmIResponse;
    updateWhoAmI(connected);
    assert.deepEqual(getWhoAmI(), connected);

    process.env.ONE_CONNECT_USER_ID = 'cu_other';
    assert.equal(getWhoAmI(), null, 'one Connect user must not be reported as another');
    delete process.env.ONE_CONNECT_USER_ID;
    assert.equal(getWhoAmI(), null, "a Connect user's record must not describe the key");
  });
});
