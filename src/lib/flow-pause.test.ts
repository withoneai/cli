import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeFlow, FlowPauseSignal } from './flow-engine.js';
import { FlowRunner } from './flow-runner.js';
import type { OneApi } from './api.js';
import type { Flow, FlowStep } from './flow-types.js';

// Ctrl+C during `flow execute` printed "Pausing after current step
// completes..." but nothing ever stopped the run: it ran to the end and was
// saved as completed. In a terminal the same SIGINT also killed bash/code
// child processes, so the step failed and the run was saved as failed.

const fakeApi = {} as unknown as OneApi;

const transform = (id: string): FlowStep =>
  ({ id, name: id, type: 'transform', transform: { expression: `'${id}'` } }) as unknown as FlowStep;

const flowOf = (steps: FlowStep[]): Flow =>
  ({ key: 'pausetest', name: 'Pause test', version: '1', inputs: {}, steps }) as unknown as Flow;

describe('executeFlow pause', () => {
  it('stops before the next top-level step once a pause is requested', async () => {
    let pause = false;
    await assert.rejects(
      executeFlow(flowOf([transform('one'), transform('two'), transform('three')]), {}, fakeApi, 'write', [], {
        pauseRequested: () => pause,
        onEvent: e => { if (e.event === 'step:complete' && e.stepId === 'one') pause = true; },
      }),
      (err: unknown) => err instanceof FlowPauseSignal && err.stepId === 'two',
    );
  });

  it('treats a step that fails while pausing as interrupted, without retrying it', async () => {
    let pause = false;
    let attempts = 0;
    const failing = {
      id: 'flaky', name: 'flaky', type: 'code',
      code: { source: 'throw new Error("killed by SIGINT")' },
      onError: { strategy: 'retry', retries: 3, retryDelayMs: 1 },
    } as unknown as FlowStep;
    await assert.rejects(
      executeFlow(flowOf([failing, transform('after')]), {}, fakeApi, 'write', [], {
        pauseRequested: () => pause,
        onEvent: e => {
          if (e.event === 'step:start' && e.stepId === 'flaky') { attempts++; pause = true; }
          if (e.event === 'step:retry') attempts++;
        },
      }),
      (err: unknown) => err instanceof FlowPauseSignal && err.stepId === 'flaky',
    );
    assert.equal(attempts, 1, 'a paused run must not retry the interrupted step');
  });
});

describe('FlowRunner pause and resume', () => {
  let dir: string;
  let prevCwd: string;
  before(() => {
    prevCwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pause-'));
    process.chdir(dir);
  });
  after(() => {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('saves the run as paused, then resume finishes only the remaining steps', async () => {
    const flow = flowOf([transform('one'), transform('two'), transform('three')]);
    const runner = new FlowRunner(flow, {});
    await assert.rejects(
      runner.execute(flow, fakeApi, 'write', [], {
        onEvent: e => { if (e.event === 'step:complete' && e.stepId === 'one') runner.requestPause(); },
      }),
      FlowPauseSignal,
    );
    const paused = FlowRunner.loadRunState(runner.getRunId())!;
    assert.equal(paused.status, 'paused');
    assert.ok(paused.pausedAt);
    assert.deepEqual(paused.completedSteps, ['one']);

    const resumed = FlowRunner.fromRunState(paused);
    const started: string[] = [];
    const context = await resumed.resume(flow, fakeApi, 'write', [], {
      onEvent: e => { if (e.event === 'step:start') started.push(e.stepId as string); },
    });
    assert.deepEqual(started, ['two', 'three']);
    assert.equal(context.steps.three.output, 'three');
    assert.equal(FlowRunner.loadRunState(runner.getRunId())!.status, 'completed');
  });
});
