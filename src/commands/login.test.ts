import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startCallbackServer, wrapForNote, type CallbackOutcome } from './login.js';

async function withServer<T>(
  state: string,
  run: (port: number, result: Promise<CallbackOutcome>) => Promise<T>,
): Promise<T> {
  const { server, port, result } = await startCallbackServer(state);
  try {
    return await run(port, result);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe('startCallbackServer', () => {
  it('rejects a state mismatch with 403 and keeps waiting', async () => {
    await withServer('expected', async (port) => {
      const s = Buffer.from('sk_live_x').toString('base64');
      const res = await fetch(`http://127.0.0.1:${port}/callback?s=${s}&state=wrong`);
      assert.equal(res.status, 403);
    });
  });

  it('resolves the key and its name', async () => {
    await withServer('st', async (port, result) => {
      const s = Buffer.from('sk_live_x').toString('base64');
      const res = await fetch(`http://127.0.0.1:${port}/callback?s=${s}&state=st&name=${encodeURIComponent('CLI · acme')}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await result, { kind: 'key', apiKey: 'sk_live_x', keyName: 'CLI · acme' });
    });
  });

  it('resolves cancelled when the page reports error=cancelled', async () => {
    await withServer('st', async (port, result) => {
      const res = await fetch(`http://127.0.0.1:${port}/callback?error=cancelled&state=st`);
      assert.equal(res.status, 200);
      assert.deepEqual(await result, { kind: 'cancelled' });
    });
  });

  it('answers 400 when neither a key nor an error is present', async () => {
    await withServer('st', async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/callback?state=st`);
      assert.equal(res.status, 400);
      const empty = await fetch(`http://127.0.0.1:${port}/callback?state=st&error=`);
      assert.equal(empty.status, 400);
    });
  });

  it('reports any other error value as a failure with its reason', async () => {
    await withServer('st', async (port, result) => {
      const res = await fetch(`http://127.0.0.1:${port}/callback?state=st&error=create_failed`);
      assert.equal(res.status, 200);
      assert.deepEqual(await result, { kind: 'failed', reason: 'create_failed' });
    });
  });

  it('keeps a minted key even when an error value rides along', async () => {
    await withServer('st', async (port, result) => {
      const s = Buffer.from('sk_live_x').toString('base64');
      await fetch(`http://127.0.0.1:${port}/callback?s=${s}&state=st&error=cancelled`);
      assert.deepEqual(await result, { kind: 'key', apiKey: 'sk_live_x', keyName: undefined });
    });
  });

  it('strips control characters from the key name and caps its length', async () => {
    await withServer('st', async (port, result) => {
      const s = Buffer.from('sk_live_x').toString('base64');
      const name = encodeURIComponent('bad\u001b[31mname\r\n' + 'x'.repeat(200));
      await fetch(`http://127.0.0.1:${port}/callback?s=${s}&state=st&name=${name}`);
      const outcome = await result;
      assert.equal(outcome.kind, 'key');
      if (outcome.kind !== 'key') return;
      assert.equal(outcome.keyName?.length, 120);
      assert.ok(outcome.keyName?.startsWith('bad[31mname'));
    });
  });
});

describe('wrapForNote', () => {
  it('breaks a line longer than the width at a space', () => {
    const wrapped = wrapForNote('harnesses: claude-code, codex, cursor, windsurf', 20);
    assert.deepEqual(wrapped.split('\n'), ['harnesses:', 'claude-code, codex,', 'cursor, windsurf']);
    assert.ok(wrapped.split('\n').every((l) => l.length <= 20));
  });

  it('leaves short lines and blank lines alone', () => {
    assert.equal(wrapForNote('scope: project\n\nuser: jane', 40), 'scope: project\n\nuser: jane');
  });

  it('hard-cuts a run with no space in it, so a long path still fits the box', () => {
    const path = `path: /Users/jane/${'deep/'.repeat(20)}project`;
    const wrapped = wrapForNote(path, 30);
    assert.ok(wrapped.split('\n').every((l) => l.length <= 30), 'every line fits the width');
    assert.equal(wrapped.split('\n').join('').replace('path:', 'path: '), path);
  });
});
