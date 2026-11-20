import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { relayCreateCommand, relayMetadataCommand } from './relay.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv, type HomeEnvSnapshot } from '../test-support/home.js';

// `relay metadata` reads the setup fields One stores per platform (the list the
// dashboard's Configuration step shows), and `relay create --create-webhook`
// stops before creating anything when a required one is missing. Without the
// check the endpoint is created and the webhook never registers.

const CONNECTORS: Record<string, string> = { github: 'conn_def::GH', stripe: 'conn_def::ST' };
const CONFIGS: Record<string, unknown> = {
  'conn_def::GH': {
    formData: [
      { name: 'GITHUB_OWNER', type: 'input', label: 'Repository Owner', placeholder: 'acme', options: [], optional: null },
      { name: 'GITHUB_REPOSITORY', type: 'input', label: 'Repository Name', placeholder: 'api', options: [], optional: null },
      { name: 'GITHUB_SIGNING_SECRET', type: 'password', label: 'Signing secret', placeholder: 'a1b2c3-not-for-output', options: [], optional: true },
    ],
  },
};

interface Harness { server: http.Server; port: number; requests: string[]; created: unknown[]; failConfig: boolean }

function startServer(): Promise<Harness> {
  const h = { requests: [] as string[], created: [] as unknown[], failConfig: false } as Harness;
  h.server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      h.requests.push(`${req.method} ${url.pathname}`);
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/v1/available-connectors') {
        const platform = url.searchParams.get('platform') ?? '';
        const id = CONNECTORS[platform];
        res.end(JSON.stringify({ rows: id ? [{ id, platform }] : [], total: id ? 1 : 0, pages: 1, page: 1 }));
        return;
      }
      if (url.pathname.startsWith('/v1/webhooks/relay/config/')) {
        if (h.failConfig) { res.statusCode = 500; res.end('{"message":"boom"}'); return; }
        const config = CONFIGS[decodeURIComponent(url.pathname.slice('/v1/webhooks/relay/config/'.length))];
        if (!config) { res.statusCode = 404; res.end('{"message":"Webhook relay config not found"}'); return; }
        res.end(JSON.stringify(config));
        return;
      }
      if (url.pathname === '/v1/webhooks/relay' && req.method === 'POST') {
        h.created.push(JSON.parse(raw));
        res.end(JSON.stringify({ id: 'r1', url: 'https://example.test/in', active: true }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise(resolve => h.server.listen(0, () => {
    h.port = (h.server.address() as AddressInfo).port;
    resolve(h);
  }));
}

class Exit extends Error { constructor(public code?: number) { super(`exit(${code})`); } }

describe('relay --metadata fields', () => {
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
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-relay-metadata-'));
    setHomeTo(tmp);
    process.env.ONE_AGENT = '1';
    h = await startServer();
    fs.mkdirSync(path.join(tmp, '.one'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.one', 'config.json'),
      JSON.stringify({ apiKey: 'sk_test', apiBase: `http://localhost:${h.port}` }));

    lines = [];
    write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
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

  const last = () => JSON.parse(lines[lines.length - 1]);

  async function exitCode(fn: () => Promise<void>): Promise<number | undefined> {
    try { await fn(); return undefined; } catch (e) { if (e instanceof Exit) return e.code; throw e; }
  }

  const GITHUB = 'live::github::default::abc123';

  it('relay metadata lists the stored fields with which are required', async () => {
    await relayMetadataCommand('github');
    const out = last();
    assert.equal(out.platform, 'github');
    assert.deepEqual(out.fields.map((f: any) => [f.key, f.required, f.secret]), [
      ['GITHUB_OWNER', true, false],
      ['GITHUB_REPOSITORY', true, false],
      ['GITHUB_SIGNING_SECRET', false, true],
    ]);
    assert.equal(out.fields[0].placeholder, 'acme');
    assert.ok(!JSON.stringify(out).includes('not-for-output'), 'a secret field\'s placeholder is not repeated');
  });

  it('relay metadata says when One lists no fields for a platform', async () => {
    await relayMetadataCommand('stripe');
    const out = last();
    assert.deepEqual(out.fields, []);
    assert.match(out._hint, /lists no --metadata fields/);
  });

  it('relay create --create-webhook stops before creating when a required key is missing', async () => {
    const code = await exitCode(() => relayCreateCommand({
      connectionKey: GITHUB, createWebhook: true, metadata: '{"GITHUB_OWNER":"acme","GITHUB_REPOSITORY":"  "}',
    }));
    assert.equal(code, 1);
    const out = last();
    assert.equal(out.status, 'metadata_required');
    assert.deepEqual(out.missing.map((f: any) => f.key), ['GITHUB_REPOSITORY']);
    assert.deepEqual(h.created, []);
    assert.equal(lines.length, 1, 'prints the refusal once');
  });

  it('relay create goes through when the required keys are there, optional ones aside', async () => {
    await relayCreateCommand({
      connectionKey: GITHUB, createWebhook: true, metadata: '{"GITHUB_OWNER":"acme","GITHUB_REPOSITORY":"api"}',
    });
    assert.equal(h.created.length, 1);
    assert.equal(last().id, 'r1');
  });

  it('relay create without --create-webhook does not look the fields up', async () => {
    await relayCreateCommand({ connectionKey: GITHUB });
    assert.equal(h.created.length, 1);
    assert.ok(!h.requests.some(r => r.includes('/webhooks/relay/config/')));
  });

  it('relay create goes through for a platform with no stored fields', async () => {
    await relayCreateCommand({ connectionKey: 'live::stripe::default::abc123', createWebhook: true });
    assert.equal(h.created.length, 1);
  });

  it('relay create goes through when the field list cannot be read', async () => {
    h.failConfig = true;
    await relayCreateCommand({ connectionKey: GITHUB, createWebhook: true });
    assert.equal(h.created.length, 1);
  });
});
