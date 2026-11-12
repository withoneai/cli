import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccessDeniedError, checkManagementAccess, checkRelayActions } from './access-gate.js';

const GET = async () => 'GET';
const POST = async () => 'POST';

describe('checkManagementAccess', () => {
  it('allows writes and deletes under the default settings', () => {
    checkManagementAccess({}, 'write', 'x');
    checkManagementAccess({}, 'delete', 'x');
  });

  it('needs write for a write and admin for a delete', () => {
    assert.throws(() => checkManagementAccess({ permissions: 'read' }, 'write', 'Creating'), /needs the "write" or "admin"/);
    checkManagementAccess({ permissions: 'write' }, 'write', 'Creating');
    assert.throws(() => checkManagementAccess({ permissions: 'write' }, 'delete', 'Deleting'), /needs the "admin"/);
    checkManagementAccess({ permissions: 'admin' }, 'delete', 'Deleting');
  });

  it('refuses both under knowledge-only', () => {
    assert.throws(() => checkManagementAccess({ knowledgeAgent: true }, 'write', 'Creating'), AccessDeniedError);
    assert.throws(() => checkManagementAccess({ knowledgeAgent: true }, 'delete', 'Deleting'), /knowledge-only/);
  });
});

describe('checkRelayActions', () => {
  const pass = (actionId: string, connectionKey: string, headers?: Record<string, string>) => ({ type: 'passthrough', actionId, connectionKey, headers });

  it('judges passthrough actions like actions execute', async () => {
    const s = { actionIds: ['act_a'], connectionKeys: ['conn_a'], permissions: 'read' as const };
    await checkRelayActions(s, [pass('act_a', 'conn_a')], GET);
    await assert.rejects(checkRelayActions(s, [pass('act_b', 'conn_a')], GET), /allowed action list/);
    await assert.rejects(checkRelayActions(s, [pass('act_a', 'conn_b')], GET), /Connection key "conn_b"/);
    await assert.rejects(checkRelayActions(s, [pass('act_a', 'conn_a')], POST), /"POST" is not allowed under "read"/);
    await assert.rejects(checkRelayActions(s, [pass('act_a', 'conn_a', { 'X-One-Connection-Key': 'conn_b' })], GET), /set by the CLI/);
    await assert.rejects(checkRelayActions(s, [pass('act_a', 'conn_a', { 'x-http-method-override': 'DELETE' })], GET), /asks for a method/);
  });

  it('looks up no method for an action the allowlists refuse', async () => {
    let lookups = 0;
    await assert.rejects(checkRelayActions({ actionIds: ['act_a'] }, [pass('act_b', 'c')], async () => { lookups++; return 'GET'; }));
    assert.equal(lookups, 0);
  });

  it('allows url and agent actions only when both allowlists are *', async () => {
    const url = { type: 'url', url: 'https://hooks.example/x' };
    const agent = { type: 'agent', agentId: 'ag_1' };
    await checkRelayActions({ permissions: 'write' }, [url, agent], GET);
    await checkRelayActions({ actionIds: ['*'], connectionKeys: ['*'] }, [url], GET);
    await assert.rejects(checkRelayActions({ connectionKeys: ['conn_a'] }, [url], GET), /type "url".*only when both are "\*"/);
    await assert.rejects(checkRelayActions({ actionIds: ['act_a'] }, [agent], GET), /type "agent"/);
    await assert.rejects(checkRelayActions({ actionIds: ['act_a'] }, [{ type: 'other' }], GET), /type "other"/);
  });

  it('refuses a passthrough action missing its ids and a non-array', async () => {
    await assert.rejects(checkRelayActions({}, [{ type: 'passthrough', actionId: 'a' }], GET), /needs an actionId and a connectionKey/);
    await assert.rejects(checkRelayActions({}, { type: 'url' }, GET), /JSON array/);
    await checkRelayActions({}, undefined, GET);
  });
});
