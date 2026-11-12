import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FlowRunner, persistableState } from './flow-runner.js';
import type { Flow, FlowStep } from './flow-types.js';
import type { OneApi } from './api.js';

const SECRET_VAR = 'ONE_FLOW_STATE_TEST_SECRET';
const SECRET = 'sk_live_must_not_be_written_to_disk';

let origCwd: string;
let tmp: string;

before(() => {
  origCwd = process.cwd();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'one-flow-state-')));
  process.chdir(tmp);
  process.env[SECRET_VAR] = SECRET;
});

after(() => {
  delete process.env[SECRET_VAR];
  process.chdir(origCwd);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const flow: Flow = {
  key: 'state-env',
  name: 'State env',
  inputs: {},
  steps: [
    { id: 'shape', name: 'Shape', type: 'transform', transform: { expression: '({ ok: true, env: "step output keeps its own env key" })' } },
  ] as unknown as FlowStep[],
};

describe('flow run-state files', () => {
  it('never write the process environment to disk', async () => {
    const runner = new FlowRunner(flow, {});
    const ctx = await runner.execute(flow, {} as OneApi, 'admin', ['*']);
    // The live context still has the environment for the steps that ran.
    assert.equal(ctx.env[SECRET_VAR], SECRET);

    const raw = fs.readFileSync(runner.getStatePath(), 'utf-8');
    assert.ok(!raw.includes(SECRET), 'secret value written to state file');
    assert.ok(!raw.includes(SECRET_VAR), 'env var name written to state file');
    const saved = JSON.parse(raw);
    assert.deepEqual(saved.context.env, {});
    assert.equal(saved.context.steps.shape.output.env, 'step output keeps its own env key');

    assert.ok(!fs.readFileSync(runner.getLogPath(), 'utf-8').includes(SECRET));
  });

  it('creates state and log files readable by the owner only', { skip: process.platform === 'win32' }, async () => {
    const runner = new FlowRunner(flow, {});
    await runner.execute(flow, {} as OneApi, 'admin', ['*']);
    assert.equal(fs.statSync(runner.getStatePath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(runner.getLogPath()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(runner.getStatePath())).mode & 0o777, 0o700);
  });

  it('persistableState drops only the top-level env', () => {
    const state = {
      runId: 'r', flowKey: 'k', status: 'running', startedAt: '', inputs: {}, completedSteps: [],
      context: { input: {}, env: { A: 'b' }, steps: { s: { output: { env: { keep: 1 } } } }, loop: {} },
    } as never;
    const out = persistableState(state) as unknown as { context: { env: object; steps: { s: { output: { env: object } } } } };
    assert.deepEqual(out.context.env, {});
    assert.deepEqual(out.context.steps.s.output.env, { keep: 1 });
    assert.deepEqual((state as { context: { env: object } }).context.env, { A: 'b' }, 'live state untouched');
  });
});
