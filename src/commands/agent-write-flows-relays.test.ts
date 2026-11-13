import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { flowExecuteCommand } from './flow.js';
import { relayActivateCommand, relayUpdateCommand } from './relay.js';
import { flowWritesOf } from '../lib/flow-runner.js';
import { relayWritesOf, AccessDeniedError } from '../lib/access-gate.js';
import { OneApi } from '../lib/api.js';
import type { Flow } from '../lib/flow-types.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv, type HomeEnvSnapshot } from '../test-support/home.js';

// Flows and relays run writes the agent doesn't spell out one command at a
// time: a flow file's steps, or relay actions One runs later when webhook
// events arrive. In agent mode they need --confirm-write, like actions execute.

const SEND = 'conn_mod_def::TEST::send';
const LIST = 'conn_mod_def::TEST::list';
const METHODS: Record<string, string> = { [SEND]: 'POST', [LIST]: 'GET' };
const methodOf = async (id: string) => METHODS[id] ?? 'GET';

const step = (id: string, actionId: string, extra: Record<string, unknown> = {}) => ({
  id, name: id, type: 'action',
  action: { platform: 'plat', actionId, connectionKey: 'plat::key', ...extra },
});

function flowOf(key: string, steps: unknown[]): Flow {
  return { key, name: key, inputs: {}, steps } as unknown as Flow;
}

describe('flowWritesOf', () => {
  it('lists action steps that write and skips reads', async () => {
    const writes = await flowWritesOf(flowOf('f', [step('read', LIST), step('send', SEND)]), methodOf);
    assert.deepEqual(writes, [{ where: 'send', actionId: SEND, method: 'POST' }]);
  });

  it('counts a method-override header and finds steps nested in a loop and in paginate', async () => {
    const flow = flowOf('f', [
      step('override', LIST, { headers: { 'X-HTTP-Method-Override': 'DELETE' } }),
      { id: 'loop', name: 'loop', type: 'loop', loop: { over: '$.input.items', as: 'x', steps: [step('inner', SEND)] } },
      { id: 'pages', name: 'pages', type: 'paginate', paginate: { action: { platform: 'plat', actionId: SEND, connectionKey: 'k' }, pageTokenField: 'a', resultsField: 'b', inputTokenParam: 'c' } },
    ]);
    const writes = await flowWritesOf(flow, methodOf);
    assert.deepEqual(writes.map(w => [w.where, w.method]), [['override', 'DELETE'], ['inner', 'POST'], ['pages', 'POST']]);
  });

  it('counts an action or sub-flow chosen at run time as a write', async () => {
    const flow = flowOf('f', [
      step('dyn', '$.input.actionId'),
      { id: 'sub', name: 'sub', type: 'flow', flow: { key: '{{ $.input.which }}' } },
    ]);
    const writes = await flowWritesOf(flow, methodOf);
    assert.deepEqual(writes.map(w => w.where), ['dyn', 'sub']);
    assert.ok(writes.every(w => w.reason));
  });

  it('follows sub-flows into their own files, once each', async () => {
    const child = flowOf('child', [step('send', SEND), { id: 'back', name: 'back', type: 'flow', flow: { key: 'parent' } }]);
    const parent = flowOf('parent', [{ id: 'sub', name: 'sub', type: 'flow', flow: { key: 'child' } }, step('read', LIST)]);
    const writes = await flowWritesOf(parent, methodOf, key => (key === 'child' ? child : parent));
    assert.deepEqual(writes, [{ where: 'child/send', actionId: SEND, method: 'POST' }]);
  });
});

describe('relayWritesOf', () => {
  it('lists passthrough writes and every url or agent action', async () => {
    const writes = await relayWritesOf([
      { type: 'passthrough', actionId: LIST, connectionKey: 'k' },
      { type: 'passthrough', actionId: SEND, connectionKey: 'k' },
      { type: 'url', url: 'https://example.com/hook' },
      { type: 'agent', agentId: 'a' },
    ], methodOf);
    assert.deepEqual(writes.map(w => w.where), ['actions[1]', 'actions[2]', 'actions[3]']);
    assert.equal(writes[0].method, 'POST');
  });

  it('returns nothing for no actions', async () => {
    assert.deepEqual(await relayWritesOf(undefined, methodOf), []);
  });
});

// ── Commands, against a throwaway server ──

const ACTIONS: Record<string, object> = {
  [SEND]: { _id: SEND, title: 'Send', tags: [], knowledge: '# Send', path: '/v1/send', method: 'POST', ioSchema: { inputSchema: { properties: {} } } },
  [LIST]: { _id: LIST, title: 'List', tags: [], knowledge: '# List', path: '/v1/list', method: 'GET', ioSchema: { inputSchema: { properties: {} } } },
};

interface Harness { server: http.Server; port: number; passthrough: string[]; relayWrites: string[] }

function startServer(): Promise<Harness> {
  const h = { passthrough: [] as string[], relayWrites: [] as string[] } as Harness;
  h.server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'application/json');
    req.resume();
    req.on('end', () => {
      if (url.pathname.endsWith('/knowledge')) {
        const row = ACTIONS[url.searchParams.get('_id') ?? ''];
        res.end(JSON.stringify({ rows: row ? [row] : [] }));
        return;
      }
      if (url.pathname.includes('/passthrough/')) {
        h.passthrough.push(req.method ?? '');
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname.includes('/webhooks/relay/')) {
        if (req.method !== 'GET') h.relayWrites.push(`${req.method} ${url.pathname}`);
        res.end(JSON.stringify({ id: 'r1', connectionId: 'c1', active: true, actions: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => h.server.listen(0, () => {
    h.port = (h.server.address() as AddressInfo).port;
    resolve(h);
  }));
}

class Exit extends Error { constructor(public code?: number) { super(`exit(${code})`); } }

describe('agent-mode flows and relays need --confirm-write', () => {
  let tmp: string;
  let home: HomeEnvSnapshot;
  let agent: string | undefined;
  let write: typeof process.stdout.write;
  let exit: typeof process.exit;
  let lines: string[];
  let h: Harness;

  beforeEach(async () => {
    home = snapshotHomeEnv();
    agent = process.env.ONE_AGENT;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-confirm-flow-'));
    setHomeTo(tmp);
    process.env.ONE_AGENT = '1';
    h = await startServer();
    fs.mkdirSync(path.join(tmp, '.one'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.one', 'config.json'),
      JSON.stringify({ apiKey: 'sk_test', apiBase: `http://localhost:${h.port}` }));

    lines = [];
    write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      // Keep the command's JSON lines and drop its other text; the test
      // runner's own messages are Buffers and pass through untouched.
      if (typeof chunk !== 'string') return (write as any)(chunk, ...rest);
      if (chunk.trim().startsWith('{')) lines.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    exit = process.exit;
    process.exit = ((code?: number) => { throw new Exit(code); }) as typeof process.exit;
  });

  afterEach(() => {
    process.stdout.write = write;
    process.exit = exit;
    restoreHomeEnv(home);
    if (agent === undefined) delete process.env.ONE_AGENT; else process.env.ONE_AGENT = agent;
    h.server.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const parsed = () => lines.map(l => JSON.parse(l));
  const refusal = () => parsed().find(l => l.status === 'confirmation_required');

  async function exitCode(fn: () => Promise<void>): Promise<number | undefined> {
    try { await fn(); return undefined; } catch (e) { if (e instanceof Exit) return e.code; throw e; }
  }

  function writeFlow(steps: unknown[]): string {
    const file = path.join(tmp, 'flow.json');
    fs.writeFileSync(file, JSON.stringify({ key: 'test-flow', name: 'Test flow', inputs: {}, steps }));
    return file;
  }

  it('flow execute refuses a flow with a write step and runs none of it', async () => {
    const file = writeFlow([step('read', LIST), step('send', SEND)]);
    const code = await exitCode(() => flowExecuteCommand(file, {}));
    assert.equal(code, 1);
    assert.deepEqual(refusal().writes, [{ where: 'send', actionId: SEND, method: 'POST' }]);
    assert.deepEqual(h.passthrough, []);
  });

  it('flow execute runs it with --confirm-write', async () => {
    const file = writeFlow([step('read', LIST), step('send', SEND)]);
    await exitCode(() => flowExecuteCommand(file, { confirmWrite: true }));
    assert.equal(refusal(), undefined);
    assert.deepEqual(h.passthrough, ['GET', 'POST']);
  });

  it('flow execute runs a read-only flow without the flag', async () => {
    const file = writeFlow([step('read', LIST)]);
    await exitCode(() => flowExecuteCommand(file, {}));
    assert.equal(refusal(), undefined);
    assert.deepEqual(h.passthrough, ['GET']);
  });

  it('the API client refuses a write the pre-run listing could not see', async () => {
    const api = new OneApi('sk_test', `http://localhost:${h.port}`);
    api.requireWriteConfirmation = true;
    await assert.rejects(
      api.executePassthroughRequest({ platform: 'plat', actionId: SEND, connectionKey: 'k' }, ACTIONS[SEND] as never),
      (err: unknown) => err instanceof AccessDeniedError && /--confirm-write/.test(err.message),
    );
    await api.executePassthroughRequest({ platform: 'plat', actionId: LIST, connectionKey: 'k' }, ACTIONS[LIST] as never);
    assert.deepEqual(h.passthrough, ['GET']);
  });

  const relayActions = JSON.stringify([{ type: 'passthrough', actionId: SEND, connectionKey: 'plat::key' }]);

  it('relay activate refuses write actions and changes nothing', async () => {
    const code = await exitCode(() => relayActivateCommand('r1', { actions: relayActions }));
    assert.equal(code, 1);
    assert.equal(refusal().writes[0].method, 'POST');
    assert.deepEqual(h.relayWrites, []);
  });

  it('relay activate goes through with --confirm-write', async () => {
    await relayActivateCommand('r1', { actions: relayActions, confirmWrite: true });
    assert.deepEqual(h.relayWrites, ['POST /v1/webhooks/relay/r1/activate']);
  });

  it('relay update refuses new write actions without the flag', async () => {
    const code = await exitCode(() => relayUpdateCommand('r1', { actions: relayActions }));
    assert.equal(code, 1);
    assert.ok(refusal());
    assert.deepEqual(h.relayWrites, []);
  });

  it('relay update without new actions needs no flag', async () => {
    await relayUpdateCommand('r1', { description: 'renamed' });
    assert.equal(refusal(), undefined);
    assert.equal(h.relayWrites.length, 1);
  });
});
