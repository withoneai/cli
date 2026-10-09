import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { OneApi } from './api.js';
import { callerHeaders } from './caller.js';

const realFetch = globalThis.fetch;
const LAUNCHER_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'CODEX_THREAD_ID', 'GEMINI_CLI', 'CURSOR_AGENT', 'WINDSURF_AGENT', 'KIRO_AGENT', 'OPENCLAW_AGENT', 'OPENCLAW_SESSION', 'HERMES_AGENT', 'HERMES_SESSION', 'DEVIN_SESSION_ID'];
const saved: Record<string, string | undefined> = {};

// The suite itself may run under an agent (CLAUDECODE=1 under Claude Code),
// so every launcher marker is cleared and set per test.
beforeEach(() => { for (const v of LAUNCHER_VARS) { saved[v] = process.env[v]; delete process.env[v]; } });
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const v of LAUNCHER_VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
});

const action = { _id: 'conn_mod_def::1', title: 'List customers', method: 'GET', path: '/v1/customers', tags: [] } as never;

function capture(): { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls };
}

describe('callerHeaders', () => {
  it('always names the CLI as the surface', () => {
    assert.deepEqual(callerHeaders({}), { 'x-one-source': 'cli' });
  });

  it('names the harness that launched the process, without a version', () => {
    assert.deepEqual(callerHeaders({ CLAUDECODE: '1' }), { 'x-one-source': 'cli', 'x-one-agent': 'claude-code' });
    assert.deepEqual(callerHeaders({ CURSOR_AGENT: '1' }), { 'x-one-source': 'cli', 'x-one-agent': 'cursor' });
  });

  it('sends no agent for a plain terminal', () => {
    assert.equal(callerHeaders({ CURSOR_TRACE_ID: 'editor-only' })['x-one-agent'], undefined);
  });
});

describe('OneApi.executePassthroughRequest caller headers', () => {
  it('sends the source and the launching harness on a passthrough call', async () => {
    process.env.CLAUDECODE = '1';
    const { calls } = capture();
    await new OneApi('sk_live_k', 'https://api.test/v1').executePassthroughRequest({ platform: 'stripe', actionId: 'conn_mod_def::1', connectionKey: 'live::stripe::default::s' }, action);
    assert.equal(calls[0].url, 'https://api.test/v1/passthrough/v1/customers');
    assert.equal(calls[0].headers['x-one-source'], 'cli');
    assert.equal(calls[0].headers['x-one-agent'], 'claude-code');
    assert.equal(calls[0].headers['x-one-secret'], 'sk_live_k');
  });

  it('sends only the source when no harness launched it', async () => {
    const { calls } = capture();
    await new OneApi('k', 'https://api.test/v1').executePassthroughRequest({ platform: 'stripe', actionId: 'conn_mod_def::1', connectionKey: 'live::stripe::default::s' }, action);
    assert.equal(calls[0].headers['x-one-source'], 'cli');
    assert.equal(calls[0].headers['x-one-agent'], undefined);
  });

  it('lets an explicit --headers value win over the detected harness', async () => {
    process.env.CLAUDECODE = '1';
    const { calls } = capture();
    await new OneApi('k', 'https://api.test/v1').executePassthroughRequest({ platform: 'stripe', actionId: 'conn_mod_def::1', connectionKey: 'live::stripe::default::s', headers: { 'x-one-agent': 'my-bot/1.0' } }, action);
    assert.equal(calls[0].headers['x-one-agent'], 'my-bot/1.0');
  });

  it('does not touch non-passthrough requests', async () => {
    process.env.CLAUDECODE = '1';
    const { calls } = capture();
    await new OneApi('k', 'https://api.test/v1').getOwnAccess().catch(() => undefined);
    assert.equal(calls[0].headers['x-one-source'], undefined);
    assert.equal(calls[0].headers['x-one-agent'], undefined);
  });
});
