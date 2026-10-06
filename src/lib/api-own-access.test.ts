import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OneApi, ApiError } from './api.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function answer(status: number, body: string): { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls };
}

describe('OneApi.getOwnAccess (GET /v1/access/me)', () => {
  it('asks /access/me with the key, nothing else', async () => {
    const { calls } = answer(200, 'null');
    await new OneApi('sk_live_k', 'https://api.test/v1').getOwnAccess();
    assert.equal(calls[0].url, 'https://api.test/v1/access/me');
    assert.equal(calls[0].headers['x-one-secret'], 'sk_live_k');
  });

  it('reads a null body as an unrestricted key', async () => {
    answer(200, 'null');
    assert.equal(await new OneApi('k', 'https://api.test/v1').getOwnAccess(), null);
  });

  it('keeps absent, empty and populated rules apart', async () => {
    answer(200, JSON.stringify({ methods: null, rules: [] }));
    assert.deepEqual(await new OneApi('k', 'https://api.test/v1').getOwnAccess(), { methods: null, rules: [] });
    answer(200, JSON.stringify({ rules: [{ type: 'connection', connectionKey: 'live::gmail::default::g', methods: ['GET'] }] }));
    assert.deepEqual(await new OneApi('k', 'https://api.test/v1').getOwnAccess(), {
      methods: null,
      rules: [{ type: 'connection', connectionKey: 'live::gmail::default::g', methods: ['GET'] }],
    });
  });

  it('throws when the API cannot answer it (an older backend answers 400 for "me")', async () => {
    answer(400, "Invalid URL: Cannot parse `id` with value `me`: expected prefix 'evt_ac' in 'me'");
    await assert.rejects(new OneApi('k', 'https://api.test/v1').getOwnAccess(), (e: unknown) => e instanceof ApiError && e.status === 400);
  });

  it('throws on an answer that is not an access document', async () => {
    answer(200, JSON.stringify({ hello: 'world' }));
    await assert.rejects(new OneApi('k', 'https://api.test/v1').getOwnAccess(), ApiError);
  });
});
