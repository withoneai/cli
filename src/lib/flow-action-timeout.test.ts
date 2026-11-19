import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeSingleStep } from './flow-engine.js';
import type { OneApi } from './api.js';
import type { FlowContext, FlowStep, FlowStepErrorConfig } from './flow-types.js';
import type { ActionDetails } from './types.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv, type HomeEnvSnapshot } from '../test-support/home.js';

let originalHome: HomeEnvSnapshot;
let temporaryHome: string;
let nextId = 0;

before(() => {
  originalHome = snapshotHomeEnv();
  temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'one-flow-timeout-'));
  setHomeTo(temporaryHome);
});

after(() => {
  restoreHomeEnv(originalHome);
  fs.rmSync(temporaryHome, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const context = (): FlowContext => ({ input: {}, env: {}, steps: {}, loop: {} });

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout handling waited indefinitely')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function setup(overrides: {
  details?: (signal?: AbortSignal) => Promise<ActionDetails>;
  execute?: (signal?: AbortSignal) => Promise<{ responseData: unknown }>;
}, onError: FlowStep['onError'] = { strategy: 'continue' }) {
  const actionId = `timeout-test-${++nextId}`;
  const details = { _id: actionId, title: 'Test', method: 'POST', path: '/items', tags: [] } as ActionDetails;
  const step: FlowStep = {
    id: 'write', name: 'Write', type: 'action', timeoutMs: 75, onError,
    action: { platform: 'test', actionId, connectionKey: 'test-connection' },
  };
  const api = {
    getActionDetailsWithMeta: async (_id: string, _etag?: string, signal?: AbortSignal) => ({
      data: overrides.details ? await overrides.details(signal) : details,
      status: 200, etag: null,
    }),
    executePassthroughRequest: async (args: { signal?: AbortSignal }) =>
      overrides.execute ? overrides.execute(args.signal) : { responseData: { ok: true } },
  } as unknown as OneApi;
  return { step, api, details };
}

describe('flow action timeout cancellation', () => {
  it('aborts the in-flight action and preserves TIMEOUT status', async () => {
    let signal: AbortSignal | undefined;
    const { step, api } = setup({ execute: async received => {
      signal = received;
      return new Promise((_resolve, reject) => received?.addEventListener('abort', () => reject(received.reason), { once: true }));
    } });
    const result = await executeSingleStep(step, context(), api, 'admin', ['*'], { skipValidation: true });
    assert.equal(result.status, 'timeout');
    assert.equal(result.errorCode, 'TIMEOUT');
    assert.equal(signal?.aborted, true);
  });

  it('does not dispatch a write when preflight completes after timeout', async () => {
    const preflight = deferred<ActionDetails>();
    let dispatched = 0;
    const { step, api, details } = setup({
      details: () => preflight.promise,
      execute: async () => { dispatched++; return { responseData: {} }; },
    });
    const result = await executeSingleStep(step, context(), api, 'admin', ['*'], { skipValidation: true });
    assert.equal(result.status, 'timeout');
    preflight.resolve(details);
    await nextTurn();
    assert.equal(dispatched, 0);
  });

  it('lets a cooperative request settle during the configured retry delay', async () => {
    const cleanup = deferred<void>();
    const aborted = deferred<void>();
    let calls = 0;
    let active = false;
    let retryEvents = 0;
    const { step, api } = setup({ execute: async signal => {
      calls++;
      if (calls > 1) {
        assert.equal(active, false, 'retry overlapped the previous request');
        return { responseData: { ok: true } };
      }
      active = true;
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => {
        aborted.resolve();
        void cleanup.promise.then(() => { active = false; reject(signal.reason); });
      }, { once: true }));
    } }, { strategy: 'retry', retries: 1, retryDelayMs: 40 });
    const running = executeSingleStep(step, context(), api, 'admin', ['*'], {
      skipValidation: true,
      onEvent: event => {
        if (event.event === 'step:retry') {
          retryEvents++;
          assert.equal(event.delayMs, 40);
          assert.equal(active, true);
          cleanup.resolve();
        }
      },
    });
    await bounded(aborted.promise, 1000);
    const result = await running;
    assert.equal(result.status, 'success');
    assert.equal(result.retries, 1);
    assert.equal(calls, 2);
    assert.equal(retryEvents, 1);
  });

  it('returns a timeout promptly without a retry even if the operation never settles', async () => {
    const aborted = deferred<void>();
    const { step, api } = setup({ execute: async signal =>
      new Promise(() => signal?.addEventListener('abort', () => aborted.resolve(), { once: true })),
    });
    const running = executeSingleStep(step, context(), api, 'admin', ['*'], { skipValidation: true });
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    await bounded(aborted.promise, 1000);
    await nextTurn();
    assert.equal(settled, true, 'timeout should not wait for an unsettled request');
    assert.equal((await running).status, 'timeout');
  });

  it('does not let a late response overwrite the timeout result', async () => {
    const late = deferred<{ responseData: unknown }>();
    const { step, api } = setup({ execute: () => late.promise });
    const ctx = context();
    const result = await executeSingleStep(step, ctx, api, 'admin', ['*'], { skipValidation: true });
    assert.equal(result.status, 'timeout');
    late.resolve({ responseData: { late: true } });
    await nextTurn();
    assert.equal(ctx.steps.write.status, 'timeout');
  });

  it('observes a late rejection after the timeout result', async () => {
    const late = deferred<{ responseData: unknown }>();
    const { step, api } = setup({ execute: () => late.promise });
    const result = await executeSingleStep(step, context(), api, 'admin', ['*'], { skipValidation: true });
    assert.equal(result.status, 'timeout');
    late.reject(new Error('late abort failure'));
    await nextTurn();
  });

  it('reports TIMEOUT when the request resolves synchronously during abort', async () => {
    const { step, api } = setup({ execute: async signal =>
      new Promise(resolve => signal?.addEventListener('abort', () => resolve({ responseData: { late: true } }), { once: true })),
    });
    const result = await executeSingleStep(step, context(), api, 'admin', ['*'], { skipValidation: true });
    assert.equal(result.status, 'timeout');
    assert.equal(result.errorCode, 'TIMEOUT');
  });

  it('does not cache a connection lookup that completes after cancellation', async () => {
    const lookup = deferred<never[]>();
    const { step, api } = setup({});
    step.action = { platform: 'test', actionId: step.action!.actionId, connection: { platform: 'test' } };
    (api as unknown as { listConnections: () => Promise<never[]> }).listConnections = () => lookup.promise;
    const ctx = context();
    const result = await executeSingleStep(step, ctx, api, 'admin', ['*'], { skipValidation: true });
    assert.equal(result.status, 'timeout');
    lookup.resolve([]);
    await nextTurn();
    assert.equal(ctx._connections, undefined);
  });

  it('honors retryOn and failFastOn for timeout errors', async () => {
    for (const [config, expectedCalls] of [
      [{ strategy: 'retry', retries: 1, retryDelayMs: 0, retryOn: ['TIMEOUT'] }, 2],
      [{ strategy: 'retry', retries: 1, retryDelayMs: 0, failFastOn: ['TIMEOUT'] }, 1],
    ] as [FlowStepErrorConfig, number][]) {
      let calls = 0;
      const { step, api } = setup({ execute: async signal => {
        calls++;
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      } }, config);
      await assert.rejects(executeSingleStep(step, context(), api, 'admin', ['*'], { skipValidation: true }), /exceeded timeout/);
      assert.equal(calls, expectedCalls);
    }
  });

  it('does not wait indefinitely for an operation that ignores abort', async () => {
    let signal: AbortSignal | undefined;
    const { step, api } = setup({ execute: async received => {
      signal = received;
      return new Promise(() => {});
    } });
    const result = await bounded(
      executeSingleStep(step, context(), api, 'admin', ['*'], { skipValidation: true }), 1000,
    );
    assert.equal(result.status, 'timeout');
    assert.equal(signal?.aborted, true);
  });

  it('applies retryDelayMs: 0 even when an abort-insensitive attempt remains active', async () => {
    let calls = 0;
    let firstActive = true;
    let retryWhileFirstActive = false;
    let retryEvents = 0;
    const { step, api } = setup({ execute: async () => {
      calls++;
      if (calls === 1) return new Promise(() => {});
      retryWhileFirstActive = firstActive;
      return { responseData: { ok: true } };
    } }, { strategy: 'retry', retries: 1, retryDelayMs: 0 });
    const result = await bounded(executeSingleStep(step, context(), api, 'admin', ['*'], {
      skipValidation: true,
      onEvent: event => {
        if (event.event === 'step:retry') {
          retryEvents++;
          assert.equal(event.delayMs, 0);
        }
      },
    }), 1000);
    firstActive = false;
    assert.equal(result.status, 'success');
    assert.equal(result.retries, 1);
    assert.equal(calls, 2);
    assert.equal(retryEvents, 1);
    assert.equal(retryWhileFirstActive, true, 'an abort-insensitive operation can still overlap a retry');
  });

  it('can retry while an abort-aware operation is still settling after a zero delay', async () => {
    const firstSettled = deferred<void>();
    const aborted = deferred<void>();
    let calls = 0;
    let overlapped = false;
    const { step, api } = setup({ execute: async signal => {
      calls++;
      if (calls === 1) {
        return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => {
          aborted.resolve();
          void firstSettled.promise.then(() => reject(signal.reason));
        }, { once: true }));
      }
      overlapped = true;
      return { responseData: { ok: true } };
    } }, { strategy: 'retry', retries: 1, retryDelayMs: 0 });
    const running = executeSingleStep(step, context(), api, 'admin', ['*'], { skipValidation: true });
    await bounded(aborted.promise, 1000);
    try {
      const result = await bounded(running, 1000);
      assert.equal(result.status, 'success');
      assert.equal(result.retries, 1);
      assert.equal(calls, 2);
      assert.equal(overlapped, true);
    } finally {
      firstSettled.resolve();
    }
  });
});
