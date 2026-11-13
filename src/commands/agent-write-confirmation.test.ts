import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { actionsExecuteCommand, actionsExecuteParallelCommand } from './actions.js';
import { connectionDeleteCommand } from './connection.js';
import { writeMethodOf } from '../lib/access-gate.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv, type HomeEnvSnapshot } from '../test-support/home.js';

// In agent mode the CLI cannot tell a write the user asked for from one an
// agent was talked into by fetched content, so writes need an explicit flag
// that the harness's approval prompt then shows. These run the real command
// functions against a throwaway HTTP server and count what reached it.

const SEND_ID = 'conn_mod_def::TEST::send';
const LIST_ID = 'conn_mod_def::TEST::list';

const ACTIONS: Record<string, object> = {
  [SEND_ID]: { _id: SEND_ID, title: 'Send', tags: [], knowledge: '# Send', path: '/v1/send', method: 'POST', ioSchema: { inputSchema: { properties: {} } } },
  [LIST_ID]: { _id: LIST_ID, title: 'List', tags: [], knowledge: '# List', path: '/v1/list', method: 'GET', ioSchema: { inputSchema: { properties: {} } } },
};

const CONNECTION = { id: 'conn_1', key: 'live::gmail::default::abc', platform: 'gmail', state: 'operational' };

interface Harness { server: http.Server; port: number; passthrough: string[]; deletes: number }

function startServer(): Promise<Harness> {
  const h = { passthrough: [] as string[], deletes: 0 } as Harness;
  h.server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/knowledge')) {
      const id = url.searchParams.get('_id') ?? '';
      const row = ACTIONS[id];
      res.end(JSON.stringify({ rows: row ? [row] : [] }));
      return;
    }
    if (url.pathname.includes('/passthrough/')) {
      h.passthrough.push(`${req.method} ${req.headers['x-http-method-override'] ?? ''}`.trim());
      req.resume();
      req.on('end', () => res.end(JSON.stringify({ ok: true })));
      return;
    }
    if (url.pathname.endsWith('/vault/connections') && req.method === 'GET') {
      res.end(JSON.stringify({ rows: [CONNECTION], total: 1, pages: 1, page: 1 }));
      return;
    }
    if (url.pathname.includes('/vault/connections/') && req.method === 'DELETE') {
      h.deletes++;
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => h.server.listen(0, () => {
    h.port = (h.server.address() as AddressInfo).port;
    resolve(h);
  }));
}

class Exit extends Error { constructor(public code?: number) { super(`exit(${code})`); } }

describe('writeMethodOf', () => {
  it('treats GET, HEAD and OPTIONS as reads and everything else as a write', () => {
    assert.equal(writeMethodOf('GET'), null);
    assert.equal(writeMethodOf('head'), null);
    assert.equal(writeMethodOf('OPTIONS'), null);
    assert.equal(writeMethodOf('post'), 'POST');
    assert.equal(writeMethodOf('DELETE'), 'DELETE');
  });

  it('judges a method-override header like the method it asks for', () => {
    assert.equal(writeMethodOf('GET', { 'X-HTTP-Method-Override': 'delete' }), 'DELETE');
    assert.equal(writeMethodOf('GET', { 'x-method-override': 'GET' }), null);
    assert.equal(writeMethodOf('GET', { 'x-other': 'DELETE' }), null);
  });
});

describe('agent-mode writes need an explicit flag', () => {
  let tmpHome: string;
  let home: HomeEnvSnapshot;
  let agent: string | undefined;
  let argv: string[];
  let write: typeof process.stdout.write;
  let exit: typeof process.exit;
  let lines: string[];
  let h: Harness;

  beforeEach(async () => {
    home = snapshotHomeEnv();
    agent = process.env.ONE_AGENT;
    argv = process.argv;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-confirm-write-'));
    setHomeTo(tmpHome);
    process.env.ONE_AGENT = '1';
    h = await startServer();
    fs.mkdirSync(path.join(tmpHome, '.one'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.one', 'config.json'),
      JSON.stringify({ apiKey: 'sk_test', apiBase: `http://localhost:${h.port}` }));

    lines = [];
    write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      // The command's output is strings; the test runner's own messages are
      // Buffers. Keep the JSON lines, drop the command's human output (in a
      // child test process it lands between the runner's messages and breaks
      // them), and pass the runner's Buffers through untouched.
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
    process.argv = argv;
    restoreHomeEnv(home);
    if (agent === undefined) delete process.env.ONE_AGENT; else process.env.ONE_AGENT = agent;
    h.server.close();
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const last = () => JSON.parse(lines[lines.length - 1]);
  // The commands catch errors, so the test's throwing process.exit can add an
  // error line after the refusal. In a real run the first exit ends the process.
  const refusal = () => lines.map(l => JSON.parse(l)).find(l => l.status === 'confirmation_required');

  async function exitCode(fn: () => Promise<void>): Promise<number | undefined> {
    try { await fn(); return undefined; } catch (e) { if (e instanceof Exit) return e.code; throw e; }
  }

  it('refuses a POST without --confirm-write and sends nothing', async () => {
    const code = await exitCode(() => actionsExecuteCommand('plat', SEND_ID, 'plat::key', { skipValidation: true }));
    assert.equal(code, 1);
    const out = refusal();
    assert.equal(out.status, 'confirmation_required');
    assert.equal(out.request.method, 'POST');
    assert.match(out._hint, /--confirm-write/);
    assert.deepEqual(h.passthrough, []);
  });

  it('runs a POST with --confirm-write', async () => {
    await actionsExecuteCommand('plat', SEND_ID, 'plat::key', { skipValidation: true, confirmWrite: true });
    assert.deepEqual(h.passthrough, ['POST']);
  });

  it('runs a GET without the flag', async () => {
    await actionsExecuteCommand('plat', LIST_ID, 'plat::key', { skipValidation: true });
    assert.deepEqual(h.passthrough, ['GET']);
  });

  it('treats a GET carrying a method-override header as a write', async () => {
    const code = await exitCode(() => actionsExecuteCommand('plat', LIST_ID, 'plat::key', {
      skipValidation: true, headers: '{"X-HTTP-Method-Override":"DELETE"}',
    }));
    assert.equal(code, 1);
    assert.equal(refusal().request.method, 'DELETE');
    assert.deepEqual(h.passthrough, []);
  });

  it('lets a dry run through without the flag', async () => {
    await actionsExecuteCommand('plat', SEND_ID, 'plat::key', { skipValidation: true, dryRun: true });
    assert.equal(last().dryRun, true);
  });

  it('does not ask outside agent mode', async () => {
    delete process.env.ONE_AGENT;
    await actionsExecuteCommand('plat', SEND_ID, 'plat::key', { skipValidation: true });
    assert.deepEqual(h.passthrough, ['POST']);
  });

  it('--parallel runs nothing when any segment writes without the flag', async () => {
    process.argv = ['node', 'one', 'actions', 'execute', '--parallel', '--skip-validation',
      'plat', LIST_ID, 'plat::k1', '--', 'plat', SEND_ID, 'plat::k2', '-d', '{}'];
    const code = await exitCode(() => actionsExecuteParallelCommand());
    assert.equal(code, 1);
    const out = refusal();
    assert.equal(out.status, 'confirmation_required');
    assert.deepEqual(out.writes.map((w: { segment: number }) => w.segment), [2]);
    assert.deepEqual(h.passthrough, []);
  });

  it('--parallel runs every segment with --confirm-write', async () => {
    process.argv = ['node', 'one', 'actions', 'execute', '--parallel', '--skip-validation', '--confirm-write',
      'plat', LIST_ID, 'plat::k1', '--', 'plat', SEND_ID, 'plat::k2', '-d', '{}'];
    await actionsExecuteParallelCommand();
    assert.equal(last().succeeded, 2);
    assert.deepEqual([...h.passthrough].sort(), ['GET', 'POST']);
  });

  it('connection delete refuses without --force and deletes nothing', async () => {
    const code = await exitCode(() => connectionDeleteCommand(CONNECTION.key));
    assert.equal(code, 1);
    const out = refusal();
    assert.equal(out.status, 'confirmation_required');
    assert.equal(out.connection.key, CONNECTION.key);
    assert.match(out._hint, /--force/);
    assert.equal(h.deletes, 0);
  });

  it('connection delete runs with --force', async () => {
    await connectionDeleteCommand(CONNECTION.key, { force: true });
    assert.equal(last().deleted, true);
    assert.equal(h.deletes, 1);
  });
});
