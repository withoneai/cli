import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessLevel,
  envelopeToAccess,
  intersectEnvelopes,
  localEnvelope,
  serverEnvelope,
} from './access.js';
import type { KeyAccessDocument, ResolvedAllowedAction } from './types.js';

// Each case is a document `GET /v1/access/me` can answer, written the way the
// consent page and the dashboard's access editor store it.
const GMAIL = 'live::gmail::default::g1';
const STRIPE = 'live::stripe::default::s1';
const SLACK = 'live::slack::default::k1';

const resolved: ResolvedAllowedAction[] = [
  { actionId: 'a-send', title: 'Send Email', method: 'POST', platform: 'gmail' },
  { actionId: 'a-list', title: 'List Messages', method: 'GET', platform: 'gmail' },
];

const levelOf = (doc: KeyAccessDocument | null, key: string) =>
  accessLevel(envelopeToAccess(serverEnvelope(doc, key), resolved).access);

describe('serverEnvelope + accessLevel: what One enforces, named as the consent page names it', () => {
  it('no rule row (null): every connection at Full access', () => {
    assert.equal(levelOf(null, GMAIL), 'full');
  });

  it('a row with neither methods nor rules: Full access', () => {
    assert.equal(levelOf({ methods: null, rules: null }, GMAIL), 'full');
  });

  it('key-level methods with no rules bound every connection', () => {
    assert.equal(levelOf({ methods: ['GET'], rules: null }, GMAIL), 'read-only');
  });

  it('the consent page levels, one per connection', () => {
    const doc: KeyAccessDocument = {
      methods: null,
      rules: [
        { type: 'connection', connectionKey: GMAIL, methods: ['GET'] },
        { type: 'connection', connectionKey: STRIPE, methods: ['GET', 'POST', 'PUT', 'PATCH'] },
        { type: 'connection', connectionKey: SLACK },
      ],
    };
    assert.equal(levelOf(doc, GMAIL), 'read-only');
    assert.equal(levelOf(doc, STRIPE), 'read-write');
    assert.equal(levelOf(doc, SLACK), 'full');
  });

  it('a connection the rules do not name is not reachable', () => {
    const doc: KeyAccessDocument = { methods: null, rules: [{ type: 'connection', connectionKey: GMAIL }] };
    assert.equal(serverEnvelope(doc, STRIPE).reachable, false);
    assert.equal(levelOf(doc, STRIPE), 'none');
  });

  it('rules: [] (knowledge only, or every app unticked) reaches nothing', () => {
    const doc: KeyAccessDocument = { methods: null, rules: [] };
    assert.equal(serverEnvelope(doc, GMAIL).reachable, false);
  });

  it('the dashboard\'s No access row (methods: []) is reachable but allows nothing', () => {
    const doc: KeyAccessDocument = { methods: null, rules: [{ type: 'connection', connectionKey: GMAIL, methods: [] }] };
    assert.equal(levelOf(doc, GMAIL), 'none');
  });

  it('a rule\'s own methods win over the key-level ones', () => {
    const doc: KeyAccessDocument = { methods: ['GET'], rules: [{ type: 'connection', connectionKey: GMAIL, methods: ['GET', 'POST', 'PUT', 'PATCH'] }] };
    assert.equal(levelOf(doc, GMAIL), 'read-write');
  });

  it('a rule with no methods falls back to the key-level ones', () => {
    const doc: KeyAccessDocument = { methods: ['GET'], rules: [{ type: 'connection', connectionKey: GMAIL }] };
    assert.equal(levelOf(doc, GMAIL), 'read-only');
  });

  it('Custom: the exact actions, resolved to titles; unknown ids are reported, not dropped', () => {
    const doc: KeyAccessDocument = { methods: null, rules: [{ type: 'connection', connectionKey: GMAIL, actionIds: ['a-send', 'a-missing'] }] };
    const { access, unresolved } = envelopeToAccess(serverEnvelope(doc, GMAIL), resolved);
    assert.deepEqual(access, { policy: 'actions', actions: [{ actionId: 'a-send', title: 'Send Email', method: 'POST' }] });
    assert.deepEqual(unresolved, ['a-missing']);
    assert.equal(accessLevel(access), 'custom');
  });

  it('Custom with an empty action list allows nothing', () => {
    const doc: KeyAccessDocument = { methods: null, rules: [{ type: 'connection', connectionKey: GMAIL, actionIds: [] }] };
    assert.equal(levelOf(doc, GMAIL), 'none');
  });
});

describe('the CLI\'s own settings only narrow what One allows', () => {
  const local = (perm: 'read' | 'write' | 'admin', ids = ['*'], keys = ['*'], key = GMAIL) => localEnvelope(perm, ids, keys, key);

  it('server Full + local read = Read only', () => {
    const env = intersectEnvelopes(serverEnvelope(null, GMAIL), local('read'));
    assert.equal(accessLevel(envelopeToAccess(env, resolved).access), 'read-only');
  });

  it('server Read only + local admin = Read only (local never widens)', () => {
    const doc: KeyAccessDocument = { methods: null, rules: [{ type: 'connection', connectionKey: GMAIL, methods: ['GET'] }] };
    const env = intersectEnvelopes(serverEnvelope(doc, GMAIL), local('admin'));
    assert.equal(accessLevel(envelopeToAccess(env, resolved).access), 'read-only');
  });

  it('a connection outside the local connection list is unreachable', () => {
    const env = intersectEnvelopes(serverEnvelope(null, GMAIL), local('admin', ['*'], [STRIPE]));
    assert.equal(env.reachable, false);
  });

  it('server actions ∩ local actions; local read hides a POST action', () => {
    const doc: KeyAccessDocument = { methods: null, rules: [{ type: 'connection', connectionKey: GMAIL, actionIds: ['a-send', 'a-list'] }] };
    const env = intersectEnvelopes(serverEnvelope(doc, GMAIL), local('read', ['a-send', 'a-list']));
    const { access } = envelopeToAccess(env, resolved, ['GET']);
    assert.deepEqual(access, { policy: 'actions', actions: [{ actionId: 'a-list', title: 'List Messages', method: 'GET' }] });
  });
});
