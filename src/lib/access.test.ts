import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UNRESTRICTED,
  computeConnectionAccess,
  formatAccess,
  keyAccessActionIds,
  parseKeyAccess,
  resolveAllowedActions,
  serverEnvelope,
} from './access.js';
import type { ActionDetails, KeyAccess, ResolvedAllowedAction } from './types.js';
import {
  assertHomeIsSandboxed,
  setHomeTo,
  snapshotHomeEnv,
  restoreHomeEnv,
  type HomeEnvSnapshot,
} from '../test-support/home.js';

const granted: ResolvedAllowedAction[] = [
  { actionId: 'a1', title: 'Send Email', method: 'POST', envelopeMethod: 'POST', platform: 'gmail' },
  { actionId: 'a2', title: 'List Messages', method: 'GET', envelopeMethod: 'GET', platform: 'gmail' },
  { actionId: 'a3', title: 'Post Message', method: 'POST', envelopeMethod: 'POST', platform: 'slack' },
  { actionId: 'a4', title: 'Search Messages', method: 'POST', envelopeMethod: 'GET', platform: 'gmail' },
];

const local = (permissions: 'read' | 'write' | 'admin', localActionIds: string[] = ['*']) => ({
  permissions,
  localActionIds,
  resolved: granted,
});

describe('computeConnectionAccess with no rules on One (local config only)', () => {
  it('reports full access for admin with no action allowlist', () => {
    assert.deepEqual(
      computeConnectionAccess({ platform: 'gmail', envelope: UNRESTRICTED, ...local('admin') }),
      { policy: 'full' }
    );
  });

  it('reports the method set for a non-admin permission level', () => {
    assert.deepEqual(
      computeConnectionAccess({ platform: 'gmail', envelope: UNRESTRICTED, ...local('read') }),
      { policy: 'methods', methods: ['GET'] }
    );
    assert.deepEqual(
      computeConnectionAccess({ platform: 'gmail', envelope: UNRESTRICTED, ...local('write') }),
      { policy: 'methods', methods: ['GET', 'POST', 'PUT', 'PATCH'] }
    );
  });

  it('lets an action allowlist win over the permission level, scoped to the platform', () => {
    assert.deepEqual(
      computeConnectionAccess({ platform: 'gmail', envelope: UNRESTRICTED, ...local('admin', ['a1', 'a2', 'a3']) }),
      {
        policy: 'actions',
        actions: [
          { actionId: 'a1', title: 'Send Email', method: 'POST' },
          { actionId: 'a2', title: 'List Messages', method: 'GET' },
        ],
      }
    );
  });

  it('drops allowlisted actions the permission level forbids', () => {
    assert.deepEqual(
      computeConnectionAccess({ platform: 'gmail', envelope: UNRESTRICTED, ...local('read', ['a1', 'a2']) }),
      { policy: 'actions', actions: [{ actionId: 'a2', title: 'List Messages', method: 'GET' }] }
    );
  });

  it('reports an empty action list for a platform the allowlist does not cover', () => {
    assert.deepEqual(
      computeConnectionAccess({ platform: 'shopify', envelope: UNRESTRICTED, ...local('admin', ['a1']) }),
      { policy: 'actions', actions: [] }
    );
  });
});

describe('parseKeyAccess', () => {
  it('reads a null body as no restrictions', () => {
    assert.equal(parseKeyAccess(null), null);
  });

  it('reads the rules the access route returns', () => {
    assert.deepEqual(parseKeyAccess({ methods: null, rules: [{ type: 'connection', connectionKey: 'k', methods: ['GET'] }] }), {
      methods: null,
      rules: [{ type: 'connection', connectionKey: 'k', methods: ['GET'] }],
    });
  });

  it('refuses any other body rather than reading it as unrestricted', () => {
    assert.throws(() => parseKeyAccess({}));
    assert.throws(() => parseKeyAccess({ data: { methods: ['GET'], rules: null } }));
    assert.throws(() => parseKeyAccess('null'));
  });

  it('refuses rules of the wrong shape instead of failing later', () => {
    assert.throws(() => parseKeyAccess({ methods: null, rules: {} }));
    assert.throws(() => parseKeyAccess({ methods: 'GET', rules: null }));
    assert.throws(() => parseKeyAccess({ methods: null, rules: [{ type: 'connection' }] }));
    assert.throws(() => parseKeyAccess({ methods: null, rules: [{ type: 'platform', systemId: 'x' }] }));
    assert.throws(() =>
      parseKeyAccess({ methods: null, rules: [{ type: 'connection', connectionKey: 'k', actionIds: 'a1' }] })
    );
  });
});

describe('serverEnvelope', () => {
  const gmail = { key: 'live::gmail::default::g1' };
  const stripe = { key: 'live::stripe::default::s1' };

  it('leaves a key with no restrictions unbounded', () => {
    assert.deepEqual(serverEnvelope(null, gmail), UNRESTRICTED);
  });

  it('bounds every connection by the global methods when there are no rules', () => {
    assert.deepEqual(serverEnvelope({ methods: ['GET'], rules: null }, gmail), { methods: ['GET'], actionIds: null });
  });

  it('reaches nothing on a connection no rule names, including under an empty rule list', () => {
    const access: KeyAccess = {
      methods: null,
      rules: [{ type: 'connection', connectionKey: stripe.key, methods: ['GET'] }],
    };
    assert.equal(serverEnvelope(access, gmail), null);
    assert.equal(serverEnvelope({ methods: null, rules: [] }, gmail), null);
  });

  it("uses a rule's own methods over the global ones, and inherits them when it lists none", () => {
    const access: KeyAccess = {
      methods: ['GET'],
      rules: [
        { type: 'connection', connectionKey: gmail.key, methods: ['GET', 'POST'] },
        { type: 'connection', connectionKey: stripe.key, actionIds: ['x1'] },
      ],
    };
    assert.deepEqual(serverEnvelope(access, gmail), { methods: ['GET', 'POST'], actionIds: null });
    assert.deepEqual(serverEnvelope(access, stripe), { methods: ['GET'], actionIds: ['x1'] });
  });

  it("keeps a rule's empty method list empty rather than inheriting", () => {
    const access: KeyAccess = {
      methods: ['GET'],
      rules: [{ type: 'connection', connectionKey: gmail.key, methods: [] }],
    };
    assert.deepEqual(serverEnvelope(access, gmail), { methods: [], actionIds: null });
  });

  it('treats a method list covering every CRUD verb as unbounded (the dashboard\'s "Full access")', () => {
    const access: KeyAccess = {
      methods: null,
      rules: [
        {
          type: 'connection',
          connectionKey: gmail.key,
          methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'TRACE'],
        },
      ],
    };
    assert.deepEqual(serverEnvelope(access, gmail), UNRESTRICTED);
  });

  it('collects every action id the rules name', () => {
    const access: KeyAccess = {
      methods: null,
      rules: [
        { type: 'connection', connectionKey: gmail.key, actionIds: ['a1'] },
        { type: 'connection', connectionKey: stripe.key, methods: ['GET'] },
        { type: 'connection', connectionKey: 'live::slack::default::k1', actionIds: ['a2', 'a3'] },
      ],
    };
    assert.deepEqual(keyAccessActionIds(access), ['a1', 'a2', 'a3']);
    assert.deepEqual(keyAccessActionIds(null), []);
  });
});

describe('computeConnectionAccess with rules on One', () => {
  it('reports the dashboard grant: read/write calendar, read-only gmail, one stripe action', () => {
    const access: KeyAccess = {
      methods: null,
      rules: [
        { type: 'connection', connectionKey: 'cal', methods: ['GET', 'POST', 'PUT', 'PATCH'] },
        { type: 'connection', connectionKey: 'gm', methods: ['GET'] },
        { type: 'connection', connectionKey: 'st', actionIds: ['s1'] },
      ],
    };
    const resolved: ResolvedAllowedAction[] = [
      { actionId: 's1', title: 'List Invoices', method: 'GET', envelopeMethod: 'GET', platform: 'stripe' },
    ];
    const accessOn = (platform: string, key: string) =>
      computeConnectionAccess({
        platform,
        envelope: serverEnvelope(access, { key }),
        permissions: 'admin',
        localActionIds: ['*'],
        resolved,
      });

    assert.deepEqual(accessOn('google-calendar', 'cal'), { policy: 'methods', methods: ['GET', 'POST', 'PUT', 'PATCH'] });
    assert.deepEqual(accessOn('gmail', 'gm'), { policy: 'methods', methods: ['GET'] });
    assert.deepEqual(accessOn('stripe', 'st'), {
      policy: 'actions',
      actions: [{ actionId: 's1', title: 'List Invoices', method: 'GET' }],
    });
  });

  it('reports no access on a connection no rule names', () => {
    assert.deepEqual(
      computeConnectionAccess({ platform: 'gmail', envelope: null, ...local('admin') }),
      { policy: 'actions', actions: [] }
    );
  });

  it("judges a rule's actions by their CRUD verb, not the HTTP method", () => {
    assert.deepEqual(
      computeConnectionAccess({
        platform: 'gmail',
        envelope: { methods: ['GET'], actionIds: ['a1', 'a2', 'a4'] },
        ...local('admin'),
      }),
      {
        policy: 'actions',
        actions: [
          { actionId: 'a2', title: 'List Messages', method: 'GET' },
          { actionId: 'a4', title: 'Search Messages', method: 'POST' },
        ],
      }
    );
  });

  it('narrows the rules by the local permission level and allowlist, never widening them', () => {
    assert.deepEqual(
      computeConnectionAccess({ platform: 'gmail', envelope: { methods: ['GET', 'POST'], actionIds: null }, ...local('read') }),
      { policy: 'methods', methods: ['GET'] }
    );
    assert.deepEqual(
      computeConnectionAccess({ platform: 'gmail', envelope: { methods: null, actionIds: ['a1', 'a2'] }, ...local('admin', ['a2', 'a3']) }),
      { policy: 'actions', actions: [{ actionId: 'a2', title: 'List Messages', method: 'GET' }] }
    );
  });

  it('reports an empty method list as reaching nothing', () => {
    const access = computeConnectionAccess({ platform: 'gmail', envelope: { methods: [], actionIds: null }, ...local('admin') });
    assert.deepEqual(access, { policy: 'methods', methods: [] });
    assert.equal(formatAccess(access), 'none');
  });
});

describe('formatAccess', () => {
  it('renders each policy for the table', () => {
    assert.equal(formatAccess({ policy: 'full' }), 'full');
    assert.equal(formatAccess({ policy: 'unknown' }), 'unknown');
    assert.equal(formatAccess({ policy: 'methods', methods: ['GET', 'POST'] }), 'GET, POST');
    assert.equal(formatAccess({ policy: 'actions', actions: [] }), 'none');
  });

  it('truncates long action lists', () => {
    const actions = granted.slice(0, 3).map(({ actionId, title, method }) => ({ actionId, title, method }));
    assert.equal(
      formatAccess({ policy: 'actions', actions }),
      'Send Email (POST), List Messages (GET) +1 more'
    );
  });
});

// resolveAllowedActions goes through the on-disk knowledge cache, so sandbox
// $HOME to a temp dir instead of touching the developer's real ~/.one/.
describe('resolveAllowedActions', () => {
  let tmpDir: string;
  let originalHome: HomeEnvSnapshot;

  beforeEach(() => {
    originalHome = snapshotHomeEnv();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-access-test-'));
    setHomeTo(tmpDir);
    assertHomeIsSandboxed();
  });

  afterEach(() => {
    restoreHomeEnv(originalHome);
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function stubApi(byId: Record<string, Partial<ActionDetails> | Error>) {
    const calls: string[] = [];
    const api = {
      async getActionDetailsWithMeta(actionId: string) {
        calls.push(actionId);
        const entry = byId[actionId];
        if (!entry || entry instanceof Error) {
          throw entry ?? new Error(`Action with ID ${actionId} not found`);
        }
        return { data: entry as ActionDetails, etag: null, status: 200 };
      },
    };
    return { api, calls };
  }

  it('makes no API calls for an unrestricted allowlist', async () => {
    const { api, calls } = stubApi({});
    assert.deepEqual(await resolveAllowedActions(api, ['*']), []);
    assert.deepEqual(calls, []);
  });

  it('resolves ids to title, method, CRUD verb, and owning platform', async () => {
    const { api } = stubApi({
      a1: { _id: 'a1', title: 'Send Email', method: 'POST', envelopeMethod: 'POST', path: '/send', connectionPlatform: 'gmail' },
      a4: { _id: 'a4', title: 'Search Messages', method: 'POST', envelopeMethod: 'GET', path: '/search', connectionPlatform: 'gmail' },
      a3: { _id: 'a3', title: 'Post Message', method: 'POST', path: '/post', connectionPlatform: 'slack' },
    });

    assert.deepEqual(await resolveAllowedActions(api, ['a1', 'a4', 'a3']), [
      { actionId: 'a1', title: 'Send Email', method: 'POST', envelopeMethod: 'POST', platform: 'gmail' },
      { actionId: 'a4', title: 'Search Messages', method: 'POST', envelopeMethod: 'GET', platform: 'gmail' },
      { actionId: 'a3', title: 'Post Message', method: 'POST', envelopeMethod: 'POST', platform: 'slack' },
    ]);
  });

  it('skips ids that fail to resolve or carry no platform, keeping the rest', async () => {
    const { api } = stubApi({
      a1: { _id: 'a1', title: 'Send Email', method: 'POST', path: '/send', connectionPlatform: 'gmail' },
      a2: { _id: 'a2', title: 'Orphan', method: 'GET', path: '/x' }, // no connectionPlatform
      a3: new Error('404'),
    });

    const resolved = await resolveAllowedActions(api, ['a1', 'a2', 'a3']);
    assert.deepEqual(resolved.map(a => a.actionId), ['a1']);
  });

  it('resolves each id once even when named twice', async () => {
    const { api, calls } = stubApi({
      a1: { _id: 'a1', title: 'Send Email', method: 'POST', envelopeMethod: 'POST', path: '/send', connectionPlatform: 'gmail' },
    });

    assert.equal((await resolveAllowedActions(api, ['a1', 'a1'])).length, 1);
    assert.deepEqual(calls, ['a1']);
  });

  it('serves repeat lookups from the knowledge cache', async () => {
    const { api, calls } = stubApi({
      a1: { _id: 'a1', title: 'Send Email', method: 'POST', envelopeMethod: 'POST', path: '/send', connectionPlatform: 'gmail' },
    });

    await resolveAllowedActions(api, ['a1']);
    await resolveAllowedActions(api, ['a1']);
    assert.deepEqual(calls, ['a1'], 'second resolution should hit the cache, not the API');
  });

  it('refetches a cached entry that predates envelopeMethod instead of judging it by HTTP method', async () => {
    const before = stubApi({
      a4: { _id: 'a4', title: 'Search Messages', method: 'POST', path: '/search', connectionPlatform: 'gmail' },
    });
    await resolveAllowedActions(before.api, ['a4']);

    const after = stubApi({
      a4: { _id: 'a4', title: 'Search Messages', method: 'POST', envelopeMethod: 'GET', path: '/search', connectionPlatform: 'gmail' },
    });
    const [resolved] = await resolveAllowedActions(after.api, ['a4']);

    assert.equal(resolved.envelopeMethod, 'GET');
    assert.deepEqual(after.calls, ['a4']);
  });

  it('keeps a cached entry that predates envelopeMethod when the refetch fails', async () => {
    const before = stubApi({
      a4: { _id: 'a4', title: 'Search Messages', method: 'POST', path: '/search', connectionPlatform: 'gmail' },
    });
    await resolveAllowedActions(before.api, ['a4']);

    const offline = stubApi({ a4: new Error('network down') });
    const resolved = await resolveAllowedActions(offline.api, ['a4']);

    assert.deepEqual(resolved.map(a => a.actionId), ['a4']);
  });
});
