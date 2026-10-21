import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nodeHasTlsFix, unpatchedNodeMessage } from './node-check.js';

describe('nodeHasTlsFix', () => {
  it('knows the first fixed patch of each supported line', () => {
    assert.equal(nodeHasTlsFix('22.23.4'), true);
    assert.equal(nodeHasTlsFix('22.23.3'), false);
    assert.equal(nodeHasTlsFix('22.24.0'), true);
    assert.equal(nodeHasTlsFix('24.22.1'), true);
    assert.equal(nodeHasTlsFix('24.22.0'), false);
    assert.equal(nodeHasTlsFix('24.14.0'), false);
    assert.equal(nodeHasTlsFix('26.12.1'), true);
    assert.equal(nodeHasTlsFix('26.12.0'), false);
  });

  it('treats end-of-life lines as unfixed and later lines as fixed', () => {
    for (const v of ['18.20.8', '20.19.5', '23.11.1', '25.9.0']) {
      assert.equal(nodeHasTlsFix(v), false, v);
    }
    assert.equal(nodeHasTlsFix('27.0.0'), true);
    assert.equal(nodeHasTlsFix('garbage'), false);
  });
});

describe('unpatchedNodeMessage', () => {
  it('names the running version and the versions to update to', () => {
    const message = unpatchedNodeMessage('20.19.5');
    assert.match(message, /Node\.js v20\.19\.5/);
    assert.match(message, /22\.23\.4, 24\.22\.1 or 26\.12\.1/);
  });
});
