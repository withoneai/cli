import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { OneApi } from './api.js';
import type { ActionDetails } from './types.js';

const SECRET = 'sk_test_redirect_only';
const CONNECTION = 'test_connection';
const action = { _id: 'test-action', title: 'Test action', method: 'POST', path: '/items', tags: [] } as ActionDetails;

type SeenRequest = { method: string; headers: http.IncomingHttpHeaders; body: string };

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

function origin(server: http.Server): string {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function readRequest(req: IncomingMessage): Promise<SeenRequest> {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  return { method: req.method ?? '', headers: req.headers, body };
}

describe('OneApi redirect credentials', () => {
  it('does not send metadata credentials to a different origin after a redirect', async () => {
    const received: SeenRequest[] = [];
    const other = await listen((req, res) => {
      void readRequest(req).then(value => { received.push(value); res.end('{}'); });
    });
    const apiServer = await listen((_req, res) => {
      res.writeHead(302, { Location: `${origin(other)}/capture` });
      res.end();
    });
    try {
      const api = new OneApi(SECRET, `${origin(apiServer)}/v1`, {});
      let error: unknown;
      try { await api.whoami(); } catch (caught) { error = caught; }
      assert.equal(received.length, 0, 'a foreign origin must not receive a request');
      assert.match(String(error), /redirect|origin/i);
      assert.ok(String(error).includes(origin(other)), 'the error names the refused origin');
      assert.ok(!String(error).includes('/capture'), 'but never its path, which can carry tokens');
    } finally {
      await close(apiServer);
      await close(other);
    }
  });

  it('does not send passthrough credentials or caller headers to a different origin', async () => {
    const received: SeenRequest[] = [];
    const other = await listen((req, res) => {
      void readRequest(req).then(value => { received.push(value); res.end('{}'); });
    });
    const apiServer = await listen((_req, res) => {
      res.writeHead(307, { Location: `${origin(other)}/capture` });
      res.end();
    });
    try {
      const api = new OneApi(SECRET, `${origin(apiServer)}/v1`, {});
      let error: unknown;
      try {
        await api.executePassthroughRequest({
          platform: 'test', actionId: action._id, connectionKey: CONNECTION,
          data: { value: 1 }, headers: { 'x-client-note': 'dummy' },
        }, action);
      } catch (caught) { error = caught; }
      assert.equal(received.length, 0, 'a foreign origin must not receive a request');
      assert.match(String(error), /redirect|origin/i);
    } finally {
      await close(apiServer);
      await close(other);
    }
  });

  it('follows same-origin metadata redirects with the credential intact', async () => {
    const received: SeenRequest[] = [];
    const server = await listen((req, res) => {
      if (req.url === '/v1/users/whoami') {
        res.writeHead(302, { Location: '/v1/users/current' });
        res.end();
      } else {
        void readRequest(req).then(value => { received.push(value); res.end('{"ok":true}'); });
      }
    });
    try {
      const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
      assert.deepEqual(await api.whoami(), { ok: true });
      assert.equal(received.length, 1);
      assert.equal(received[0].headers['x-one-secret'], SECRET);
    } finally {
      await close(server);
    }
  });

  it('preserves an action request signal across a same-origin redirect', async (t) => {
    const controller = new AbortController();
    const signals: (AbortSignal | null | undefined)[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return signals.length === 1
        ? new Response(null, { status: 307, headers: { Location: '/v1/passthrough/moved' } })
        : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const api = new OneApi(SECRET, 'https://api.example.test/v1', {});
    await api.executePassthroughRequest({
      platform: 'test', actionId: action._id, connectionKey: CONNECTION,
      signal: controller.signal,
    }, action);
    assert.deepEqual(signals, [controller.signal, controller.signal]);
  });

  it('aborts an in-flight passthrough fetch on a local server', async () => {
    let received!: () => void;
    const entered = new Promise<void>(resolve => { received = resolve; });
    const server = await listen((_req, _res) => { received(); });
    try {
      const controller = new AbortController();
      const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
      const pending = api.executePassthroughRequest({
        platform: 'test', actionId: action._id, connectionKey: CONNECTION,
        signal: controller.signal,
      }, action);
      await entered;
      controller.abort();
      await assert.rejects(pending);
    } finally {
      await close(server);
    }
  });

  it('does not call fetch when cancellation precedes passthrough dispatch', async (t) => {
    let fetches = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetches++;
      return new Response('{}');
    });
    const controller = new AbortController();
    controller.abort();
    const api = new OneApi(SECRET, 'https://api.example.test/v1', {});
    await assert.rejects(api.executePassthroughRequest({
      platform: 'test', actionId: action._id, connectionKey: CONNECTION,
      signal: controller.signal,
    }, action));
    assert.equal(fetches, 0);
  });

  it('aborts while reading a passthrough response body', async (t) => {
    let readingStarted!: () => void;
    const reading = new Promise<void>(resolve => { readingStarted = resolve; });
    const server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"incomplete":');
      res.flushHeaders();
    });
    try {
      const nativeFetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
        const response = await nativeFetch(url, init);
        const read = response.text.bind(response);
        response.text = () => {
          readingStarted();
          return read();
        };
        return response;
      });
      const controller = new AbortController();
      const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
      const pending = api.executePassthroughRequest({
        platform: 'test', actionId: action._id, connectionKey: CONNECTION,
        signal: controller.signal,
      }, action);
      await reading;
      controller.abort();
      await assert.rejects(pending);
    } finally {
      await close(server);
    }
  });

  it('does not follow a redirect if the signal was aborted while closing the first response', async (t) => {
    const controller = new AbortController();
    let fetches = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      fetches++;
      return new Response(new ReadableStream({ cancel: () => controller.abort() }), {
        status: 307, headers: { Location: '/v1/passthrough/moved' },
      });
    });
    const api = new OneApi(SECRET, 'https://api.example.test/v1', {});
    await assert.rejects(api.executePassthroughRequest({
      platform: 'test', actionId: action._id, connectionKey: CONNECTION,
      signal: controller.signal,
    }, action));
    assert.equal(fetches, 1);
  });

  it('resolves relative redirects against the current URL', async () => {
    const paths: string[] = [];
    const server = await listen((req, res) => {
      paths.push(req.url ?? '');
      if (req.url === '/v1/users/whoami') {
        res.writeHead(302, { Location: '../users/current?view=short' });
        res.end();
      } else {
        res.end('{"ok":true}');
      }
    });
    try {
      const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
      assert.deepEqual(await api.whoami(), { ok: true });
      assert.deepEqual(paths, ['/v1/users/whoami', '/v1/users/current?view=short']);
    } finally {
      await close(server);
    }
  });

  it('rejects URL-embedded credentials before a second request', async () => {
    let requests = 0;
    const server = await listen((_req, res) => {
      requests++;
      res.writeHead(302, { Location: `http://user:pass@127.0.0.1:${new URL(origin(server)).port}/capture` });
      res.end();
    });
    try {
      const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
      await assert.rejects(api.whoami(), /credentialed API redirect/);
      assert.equal(requests, 1);
    } finally {
      await close(server);
    }
  });

  it('rejects malformed Location values', async () => {
    let requests = 0;
    const server = await listen((_req, res) => {
      requests++;
      res.writeHead(302, { Location: 'http://[' });
      res.end();
    });
    try {
      const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
      await assert.rejects(api.whoami(), /Invalid API redirect URL/);
      assert.equal(requests, 1);
    } finally {
      await close(server);
    }
  });

  it('stops a redirect loop after the native fetch limit', async () => {
    let requests = 0;
    const server = await listen((_req, res) => {
      requests++;
      res.writeHead(302, { Location: '/v1/users/whoami' });
      res.end();
    });
    try {
      const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
      await assert.rejects(api.whoami(), /Too many API redirects/);
      assert.equal(requests, 21, 'the original request plus 20 redirects, as native fetch does');
    } finally {
      await close(server);
    }
  });

  it('rejects a hostname hidden behind URL userinfo', async () => {
    let received = 0;
    const other = await listen((_req, res) => { received++; res.end('{}'); });
    const apiServer = await listen((_req, res) => {
      res.writeHead(302, { Location: `//127.0.0.1:${new URL(origin(apiServer)).port}@127.0.0.1:${new URL(origin(other)).port}/capture` });
      res.end();
    });
    try {
      const api = new OneApi(SECRET, `${origin(apiServer)}/v1`, {});
      await assert.rejects(api.whoami(), /redirect/);
      assert.equal(received, 0);
    } finally {
      await close(apiServer);
      await close(other);
    }
  });

  it('blocks an HTTPS-to-HTTP downgrade before fetch sees the target', async (t) => {
    const calls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(null, { status: 302, headers: { Location: 'http://api.example.test/v1/users/current' } });
    });
    const api = new OneApi(SECRET, 'https://api.example.test/v1', {});
    await assert.rejects(api.whoami(), /cross-origin/);
    assert.deepEqual(calls, ['https://api.example.test/v1/users/whoami']);
  });

  it('keeps headers on a GET redirected with 303', async () => {
    let received: SeenRequest | undefined;
    const server = await listen((req, res) => {
      if (req.url === '/v1/users/whoami') {
        res.writeHead(303, { Location: '/v1/users/current' });
        res.end();
      } else {
        void readRequest(req).then(value => { received = value; res.end('{}'); });
      }
    });
    try {
      const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
      await api.whoami();
      assert.equal(received?.method, 'GET');
      assert.equal(received?.headers['content-type'], 'application/json');
      assert.equal(received?.headers['x-one-secret'], SECRET);
    } finally {
      await close(server);
    }
  });

  for (const [status, expectedMethod, expectedBody] of [
    [301, 'GET', ''], [302, 'GET', ''], [303, 'GET', ''],
    [307, 'POST', '{"value":1}'], [308, 'POST', '{"value":1}'],
  ] as const) {
    it(`preserves same-origin POST redirect semantics for ${status}`, async () => {
      const received: SeenRequest[] = [];
      const server = await listen((req, res) => {
        if (req.url === '/v1/passthrough/items') {
          res.writeHead(status, { Location: '/v1/passthrough/moved' });
          res.end();
        } else {
          void readRequest(req).then(value => { received.push(value); res.end('{"ok":true}'); });
        }
      });
      try {
        const api = new OneApi(SECRET, `${origin(server)}/v1`, {});
        const result = await api.executePassthroughRequest({
          platform: 'test', actionId: action._id, connectionKey: CONNECTION,
          data: { value: 1 }, headers: { 'x-client-note': 'dummy' },
        }, action);
        assert.deepEqual(result.responseData, { ok: true });
        assert.equal(received.length, 1);
        assert.equal(received[0].method, expectedMethod);
        assert.equal(received[0].body, expectedBody);
        assert.equal(received[0].headers['content-type'], expectedMethod === 'POST' ? 'application/json' : undefined);
        assert.equal(received[0].headers['x-one-secret'], SECRET);
        assert.equal(received[0].headers['x-one-connection-key'], CONNECTION);
        assert.equal(received[0].headers['x-client-note'], 'dummy');
      } finally {
        await close(server);
      }
    });
  }
});
