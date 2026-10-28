import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseConnectCallback, startConnectCallbackServer } from './connect-callback.js';

const at = (query: string, path = '/callback') => new URL(`http://localhost:1${path}?${query}`);

describe('parseConnectCallback', () => {
  it('reads an approved app: outcome, client id and ask id', () => {
    assert.deepEqual(parseConnectCallback(at('state=s&outcome=created&clientId=f305b9fc&permissionSetId=ps-1'), 's'), {
      status: 200,
      outcome: { kind: 'done', outcome: 'created', clientId: 'f305b9fc', permissionSetId: 'ps-1' },
    });
    assert.deepEqual(parseConnectCallback(at('state=s&outcome=updated&clientId=f305b9fc'), 's').outcome, {
      kind: 'done',
      outcome: 'updated',
      clientId: 'f305b9fc',
      permissionSetId: null,
    });
  });

  it('refuses a wrong state, another path, and ids that are not plain ids', () => {
    assert.equal(parseConnectCallback(at('state=x&outcome=created&clientId=a'), 's').status, 403);
    assert.equal(parseConnectCallback(at('state=s', '/other'), 's').status, 404);
    assert.equal(parseConnectCallback(at('state=s&outcome=created&clientId=a%0AONE_X%3D1'), 's').status, 400);
    assert.equal(parseConnectCallback(at('state=s&outcome=created&clientId=a&permissionSetId=b%20c'), 's').status, 400);
    assert.equal(parseConnectCallback(at('state=s&outcome=deleted&clientId=a'), 's').status, 400);
  });

  it('reports a cancel and a failure', () => {
    assert.deepEqual(parseConnectCallback(at('state=s&error=cancelled'), 's').outcome, { kind: 'cancelled' });
    assert.deepEqual(parseConnectCallback(at('state=s&error=No%20access'), 's').outcome, {
      kind: 'failed',
      reason: 'No access',
    });
  });
});

describe('startConnectCallbackServer', () => {
  it('sends the browser to the summary and hands the outcome to the command', async () => {
    const { server, port, result } = await startConnectCallbackServer('s', (done) => `https://app.test/cli/connect/${done.clientId}`);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/callback?state=s&outcome=created&clientId=f305b9fc&permissionSetId=ps-1`,
        { redirect: 'manual' }
      );
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('location'), 'https://app.test/cli/connect/f305b9fc');
      assert.deepEqual(await result, { kind: 'done', outcome: 'created', clientId: 'f305b9fc', permissionSetId: 'ps-1' });
    } finally {
      server.close();
    }
  });
});
